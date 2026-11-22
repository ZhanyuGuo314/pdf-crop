from pathlib import Path
import io, sys
from tempfile import TemporaryDirectory
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase import pdfmetrics
from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject, NameObject, NumberObject
from playwright.sync_api import expect, sync_playwright

base=Path(__file__).resolve().parent
fixture=base/'test-input.pdf'
raw=io.BytesIO()
c=canvas.Canvas(raw)
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
sizes=[(300,420),(470,310),(330,470),(310,460),(595,842)]
image=Image.new('RGB',(100,45),'#e3ecdf')
draw=ImageDraw.Draw(image);draw.ellipse((13,4,57,36),fill='#578772')
for i,(w,h) in enumerate(sizes):
    c.setPageSize((w,h));c.setFillColorRGB(.04,.28,.2);c.rect(43,58,8,h-110,fill=1,stroke=0)
    c.setFont('Helvetica',18);c.drawString(66,h-105,f'Paper / {i+1}')
    c.setFont('STSong-Light',14);c.drawString(66,h-146,'裁剪保留测试')
    c.drawImage(ImageReader(image),66,65,width=100,height=45)
    c.linkURL('https://example.org',(66,65,166,110))
    c.showPage()
c.save();src=PdfWriter(clone_from=io.BytesIO(raw.getvalue()))
rotations=[0,90,180,270,0]
for i,p in enumerate(src.pages):
    w,h=sizes[i];p.cropbox=RectangleObject([12,15,w-4,h-8])
    if rotations[i]:p.rotate(rotations[i])
    if i==3:p[NameObject('/UserUnit')]=NumberObject(2)
src.write(fixture)

with TemporaryDirectory() as profile, sync_playwright() as api:
    opts=dict(offline=True,viewport={'width':1280,'height':900},accept_downloads=True)
    extension_mode=sys.argv[1:2]==['--extension']
    if extension_mode:
        plugin=Path(sys.argv[2]).resolve()
        context=api.chromium.launch_persistent_context(profile,channel='msedge',headless=True,
            ignore_default_args=['--disable-extensions'],
            args=['--load-extension='+str(plugin),'--disable-extensions-except='+str(plugin)],**opts)
        worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker',timeout=12000)
        assert worker.evaluate('chrome.action.onClicked.hasListener(openEditor)')
        with context.expect_page() as opened:
            worker.evaluate('openEditor().then(tab=>tab.id)')
        page=opened.value
    else:
        browser=api.chromium.launch(channel='chrome',headless=True)
        context=browser.new_context(**opts)
        page=context.new_page()
    page.set_default_timeout(12000)
    errors=[];requests=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda m: print('console',m.type,m.text[:200]) if m.type in ('error','warning') else None)
    page.on('request',lambda r:requests.append(r.url) if r.url.startswith(('http:','https:')) else None)
    if extension_mode:
        assert page.url.startswith('chrome-extension://')
        page.reload()
    else:
        app_path=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else base/'pdf-crop.html'
        page.goto(app_path.as_uri())
    assert page.locator('button:visible').count()==1
    page.screenshot(path=base/'welcome.png')
    page.locator('#file').set_input_files(fixture)
    try: page.locator('#name').wait_for(state='visible')
    except Exception:
        print('open error',page.locator('#status').inner_text(),errors);raise
    expect(page.locator('#cropNotice')).to_be_visible()
    expect(page.locator('#cropNotice')).to_have_text('裁剪改变的是显示范围，原始内容还在。')
    def click(sel): page.locator('#'+sel).click()
    def number(id,value):
        loc=page.locator('#'+id);loc.fill(str(value));loc.press('Tab')
    def download(path):
        with page.expect_download() as result:click('save')
        result.value.save_as(path)
    download(base/'uncropped.pdf')
    assert (base/'uncropped.pdf').read_bytes()==fixture.read_bytes()
    click('auto');assert float(page.locator('#top').input_value())>0
    click('settingsButton');page.locator('#more summary').click();click('undo')
    page.keyboard.press('Escape')
    assert not page.locator('#settings').is_visible()
    rect=page.locator('#paper').bounding_box()
    px=lambda x:rect['x']+rect['width']*x
    py=lambda y:rect['y']+rect['height']*y
    page.mouse.move(px(.10),py(.11));page.mouse.down();page.mouse.move(px(.9),py(.89),steps=4);page.mouse.up()
    assert float(page.locator('#left').input_value())>1
    # Resize then move, even when the document already has a crop box.
    handle=page.locator('[data-part="se"]').bounding_box();cx=handle['x']+7;cy=handle['y']+7
    page.mouse.move(cx,cy);page.mouse.down();page.mouse.move(cx-12,cy-12,steps=3);page.mouse.up()
    before=float(page.locator('#left').input_value())
    page.mouse.move(px(.4),py(.4));page.mouse.down();page.mouse.move(px(.41),py(.41));page.mouse.up()
    assert float(page.locator('#left').input_value())>before
    click('settingsButton')
    for key,v in [('left',8),('top',10),('right',12),('bottom',6)]:number(key,v)
    page.locator('#batch summary').click()
    page.select_option('#scope','range');page.fill('#range','1,3–4');click('apply')
    assert '3 页' in page.inner_text('#summary')
    click('undo');click('redo');assert '3 页' in page.inner_text('#summary')
    page.fill('#range','1,999');click('apply');assert '页码范围' in page.inner_text('#status')
    page.select_option('#scope','all');page.select_option('#units','mm');click('apply')
    expect(page.locator('#summary')).to_contain_text('5 页')
    click('closeSettings')
    click('next')
    expect(page.locator('#pageNum')).to_have_value('2')
    assert abs(float(page.input_value('#top'))-10)<.05
    page.screenshot(path=base/'editor.png');download(base/'cropped.pdf')
    number('pageNum',4);assert abs(float(page.input_value('#right'))-12)<.05
    page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(200)
    expect(page.locator('#cropNotice')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1')
    page.screenshot(path=base/'mobile.png')
    click('settingsButton')
    assert page.locator('#closeSettings').is_visible()
    click('closeSettings')
    assert not errors,errors
    assert not requests,requests
    context.close()
    if not extension_mode:
        browser.close()

# Calculate all expected boxes independently, in raw PDF user-space units.
ref=PdfReader(fixture);out=PdfReader(base/'cropped.pdf')
for i,(a,b) in enumerate(zip(ref.pages,out.pages,strict=True)):
    factor=72/25.4/float(a.get('/UserUnit',1))
    L,T,R,B=[x*factor for x in (8,10,12,6)]
    inc={0:(L,B,R,T),90:(T,L,B,R),180:(R,T,L,B),270:(B,R,T,L)}[rotations[i]]
    x0,y0,x1,y1=a.cropbox
    expected=[float(x0)+inc[0],float(y0)+inc[1],float(x1)-inc[2],float(y1)-inc[3]]
    assert max(abs(float(x)-y) for x,y in zip(b.cropbox,expected))<.002,(i,b.cropbox,expected)
    assert a.mediabox==b.mediabox and a.rotation==b.rotation
    assert a.get_contents().get_data()==b.get_contents().get_data()
    assert a.extract_text()==b.extract_text()
    for key,stream in a['/Resources']['/XObject'].items():
        assert stream.get_object()._data==b['/Resources']['/XObject'][key]._data
    assert a['/Annots'][0].get_object()['/A']['/URI']==b['/Annots'][0].get_object()['/A']['/URI']
print('Verified 5 crop boxes, 4 rotations, UserUnit=2, offset crop boxes, image streams, page content, text and links. Offline browser tests passed.')
