const $ = id => document.getElementById(id);
const FULL = Object.freeze([0, 0, 1, 1]); // left, top, right, bottom in display order.
const MM = 25.4 / 72;
const edges = ['left', 'top', 'right', 'bottom'];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-8);
let documentFile, pdf, currentPage, view, pageNo = 1, busy = false;
let edits = new Map(), undoStack = [], redoStack = [];
let gesture, drawing = false;

function message(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
async function locked(action) {
  if (busy || gesture) return;
  busy = true;
  $('editor').inert = true;
  $('open').disabled = $('pick').disabled = true;
  try { await action(); }
  catch (error) { message(error.message || String(error), true); }
  finally {
    busy = false;
    $('editor').inert = false;
    $('open').disabled = $('pick').disabled = false;
    if (pdf) $('pageNum').value = pageNo;
  }
}
function readRect(n = pageNo) { return edits.get(n) ?? FULL; }
function putRect(n, rect) {
  if (same(rect, FULL)) edits.delete(n); else edits.set(n, rect);
}
function commit(changes) {
  const delta = [];
  for (const [n, rect] of changes) {
    const old = readRect(n);
    if (!same(old, rect)) { delta.push({n, old, rect}); putRect(n, rect); }
  }
  if (delta.length) {
    undoStack.push(delta); if (undoStack.length > 30) undoStack.shift();
    redoStack = [];
  }
  refresh();
}
function history(back) {
  const batch = (back ? undoStack : redoStack).pop();
  if (!batch) return;
  for (const {n, old, rect} of batch) putRect(n, back ? old : rect);
  (back ? redoStack : undoStack).push(batch);
  refresh(); message(back ? '已撤销。' : '已重做。');
}
function margins(rect, vp) {
  const [l,t,r,b] = rect;
  return [l*vp.width, t*vp.height, (1-r)*vp.width, (1-b)*vp.height].map(x => x*MM);
}
function rectFromMM([l,t,r,b], vp) {
  const w = vp.width * MM, h = vp.height * MM;
  if (![l,t,r,b].every(x => Number.isFinite(x) && x >= 0) || l+r >= w || t+b >= h)
    throw new Error('边距超出页面，宽和高必须保留正值。');
  return [l/w,t/h,1-r/w,1-b/h];
}
function paint(rect) {
  const [l,t,r,b] = rect;
  Object.assign($('box').style, {left:l*100+'%',top:t*100+'%',width:(r-l)*100+'%',height:(b-t)*100+'%'});
  const mm = margins(rect, view);
  edges.forEach((id,i) => $(id).value = +mm[i].toFixed(2));
  $('dims').textContent = '保留尺寸　' + ((r-l)*view.width*MM).toFixed(1) + ' × ' + ((b-t)*view.height*MM).toFixed(1) + ' mm';
}
function refresh() {
  paint(readRect());
  $('pageNum').value = pageNo; $('pageNum').max = pdf.numPages;
  $('total').textContent = '/ ' + pdf.numPages;
  $('summary').textContent = edits.size ? '已调整 ' + edits.size + ' 页' : '';
  $('prev').disabled = pageNo <= 1; $('next').disabled = pageNo >= pdf.numPages;
  $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length;
}
function fit() {
  if (!view || $('editor').hidden) return;
  const stage = $('stage');
  const factor = Number($('zoom').value) * Math.min((stage.clientWidth-50)/view.width,(stage.clientHeight-50)/view.height);
  $('paper').style.width = Math.max(1,view.width*factor)+'px';
  $('paper').style.height = Math.max(1,view.height*factor)+'px';
}
new ResizeObserver(fit).observe($('stage'));
$('zoom').onchange = fit;
async function preparePage(doc, n) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({scale:1});
  const renderView = page.getViewport({scale:1800/Math.max(vp.width,vp.height)});
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1,Math.ceil(renderView.width));
  canvas.height = Math.max(1,Math.ceil(renderView.height)); canvas.id = 'canvas';
  await page.render({canvasContext:canvas.getContext('2d', {willReadFrequently:true}),viewport:renderView,background:'white'}).promise;
  return {page, vp, canvas};
}
function display({page,vp,canvas}, n) {
  if (currentPage && currentPage !== page) currentPage.cleanup();
  currentPage = page; view = vp; pageNo = n;
  $('canvas').replaceWith(canvas); setDrawing(false);
  $('stage').scrollTo(0,0); fit(); refresh();
}
function openFile(file) {
  if (!file) return;
  locked(async () => {
    message('正在读取 PDF…');
    const lib = await reader();
    const task = lib.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,
      useWorkerFetch:false,CMapReaderFactory:OfflineCMaps,StandardFontDataFactory:OfflineFonts});
    let next, first;
    try {
      next = await task.promise;
      const info = await next.getMetadata();
      if (info.info.EncryptFilterName) throw new Error('目前支持未加密的 PDF，请先提供已解除加密的副本。');
      first = await preparePage(next,1);
    } catch (error) {
      await task.destroy();
      if (error.name === 'PasswordException') throw new Error('此 PDF 需要密码，请打开已解除加密的副本。');
      throw error;
    }
    const old = pdf; currentPage = null;
    pdf = next; documentFile = file; edits = new Map(); undoStack = []; redoStack = [];
    $('editor').hidden = false; $('welcome').hidden = true;
    $('settings').close();
    $('batch').open = $('more').open = false;
    $('name').textContent = file.name; $('zoom').value = '1';
    $('scope').value='all'; $('rangeField').hidden=true; $('range').value='';
    display(first,1); message('');
    if (old) await old.destroy();
  });
}
function navigate(target) {
  if (!pdf || !Number.isInteger(target) || target<1 || target>pdf.numPages) {
    $('pageNum').value=pageNo; return;
  }
  if (target===pageNo) return;
  locked(async () => { message('正在读取第 '+target+' 页…'); display(await preparePage(pdf,target),target); message(''); });
}
for (const id of ['open','pick']) $(id).onclick = () => $('file').click();
const settings = $('settings');
$('settingsButton').onclick = () => {
  $('panelStatus').append($('status'));
  message('');
  settings.showModal();
};
$('closeSettings').onclick = () => settings.close();
settings.addEventListener('close', () => {
  $('statusDock').append($('status'));
});
settings.addEventListener('click', event => {
  if (event.target !== settings) return;
  const bounds = settings.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) settings.close();
});
$('file').onchange = e => { const file=e.target.files[0]; e.target.value=''; openFile(file); };
window.addEventListener('dragover',e=>{e.preventDefault();document.body.classList.add('dragover');});
window.addEventListener('dragleave',e=>{if(!e.relatedTarget)document.body.classList.remove('dragover');});
window.addEventListener('drop',e=>{e.preventDefault();document.body.classList.remove('dragover');openFile(e.dataTransfer.files[0]);});
$('prev').onclick=()=>navigate(pageNo-1); $('next').onclick=()=>navigate(pageNo+1);
$('pageNum').onchange=e=>navigate(Number(e.target.value));
for (const [index,id] of edges.entries()) {
  $(id).onchange = () => {
    try {
      const mm=margins(readRect(),view); mm[index]=$(id).valueAsNumber;
      const rect=rectFromMM(mm,view); commit([[pageNo,rect]]); message('');
    } catch(error) { refresh(); message(error.message,true); }
  };
}
function setDrawing(on) {
  drawing=on; $('draw').setAttribute('aria-pressed',String(on));
  $('box').style.cursor=on?'crosshair':'move';
}
$('draw').onclick=()=>{setDrawing(!drawing);message(drawing?'在页面上按住并拖出保留区域。':'');};
$('reset').onclick=()=>{commit([[pageNo,FULL]]);message('已恢复本页打开时的范围。');};
$('undo').onclick=()=>history(true); $('redo').onclick=()=>history(false);
document.addEventListener('keydown',e=>{
  if (!pdf || busy || gesture || e.target.matches('input,select,textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='z') {e.preventDefault();history(!e.shiftKey);}
  if (e.key==='Escape') setDrawing(false);
});
for (const [part,x,y,cursor] of [['nw',0,0,'nwse'],['n',50,0,'ns'],['ne',100,0,'nesw'],['e',100,50,'ew'],['se',100,100,'nwse'],['s',50,100,'ns'],['sw',0,100,'nesw'],['w',0,50,'ew']]) {
  const node=document.createElement('i');node.className='handle';node.dataset.part=part;
  Object.assign(node.style,{left:x+'%',top:y+'%',cursor:cursor+'-resize'});$('box').append(node);
}
function point(e) {
  const bounds=$('paper').getBoundingClientRect();
  return [clamp((e.clientX-bounds.left)/bounds.width,0,1),clamp((e.clientY-bounds.top)/bounds.height,0,1)];
}
$('paper').onpointerdown=e=>{
  if (busy || gesture || e.button!==0) return;
  const canMove = !same(readRect(), FULL) && e.target.closest('#box');
  const part=drawing || e.shiftKey ? 'new' : e.target.dataset.part || (canMove?'move':'new');
  gesture={id:e.pointerId,part,anchor:point(e),old:readRect(),next:readRect(),moved:false};
  $('paper').setPointerCapture(e.pointerId);e.preventDefault();
};
function moveGesture(e) {
  if (!gesture || gesture.id!==e.pointerId) return;
  const {old,anchor,part}=gesture, [x,y]=point(e), [ax,ay]=anchor;
  let [l,t,r,b]=old;
  const dx=x-ax,dy=y-ay;
  if (!dx && !dy && !gesture.moved) return;
  gesture.moved=true;
  if (part==='new') {l=Math.min(x,ax);t=Math.min(y,ay);r=Math.max(x,ax);b=Math.max(y,ay);}
  else if (part==='move') {
    const mx=clamp(dx,-l,1-r),my=clamp(dy,-t,1-b);l+=mx;r+=mx;t+=my;b+=my;
  } else {
    const minW=Math.min(.003,r-l),minH=Math.min(.003,b-t);
    if(part.includes('w'))l=clamp(l+dx,0,r-minW);
    if(part.includes('e'))r=clamp(r+dx,l+minW,1);
    if(part.includes('n'))t=clamp(t+dy,0,b-minH);
    if(part.includes('s'))b=clamp(b+dy,t+minH,1);
  }
  gesture.next=[l,t,r,b];paint(gesture.next);
}
$('paper').onpointermove=moveGesture;
$('paper').onpointerup=e=>{
  if (!gesture || gesture.id!==e.pointerId) return;
  moveGesture(e);const {next,part,moved}=gesture;gesture=null;
  if(moved && next[2]-next[0]>1e-8 && next[3]-next[1]>1e-8) {commit([[pageNo,next]]);message('');}
  else refresh();
  if(part==='new')setDrawing(false);
};
$('paper').onlostpointercapture=()=>{if(gesture){gesture=null;refresh();}};
$('auto').onclick=()=>{
  const canvas=$('canvas'), w=canvas.width,h=canvas.height;
  const data=canvas.getContext('2d').getImageData(0,0,w,h).data;
  let l=w,t=h,r=-1,b=-1;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const i=(y*w+x)*4;
    // A conservative RGB threshold keeps coloured marks as well as black ink.
    if(Math.min(data[i],data[i+1],data[i+2])>=247)continue;
    l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);
  }
  if(r<0){message('这一页未识别到内容，请手动框选。');return;}
  const padX=2/(view.width*MM),padY=2/(view.height*MM);
  commit([[pageNo,[Math.max(0,l/w-padX),Math.max(0,t/h-padY),Math.min(1,(r+1)/w+padX),Math.min(1,(b+1)/h+padY)]]]);
  message('已按可见内容框选，并保留约 2 mm 边距。请检查浅色细节。');
};
function selectedPages() {
  const targets=new Set(), n=pdf.numPages, scope=$('scope').value;
  if(scope==='range'){
    for(const token of $('range').value.replaceAll('，',',').split(',')){
      const m=token.trim().match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
      if(!m)throw new Error('请输入有效页码，例如 1, 3–5, 8。');
      const a=+m[1], b=+(m[2]??m[1]);
      if(a<1 || b<a || b>n)throw new Error('页码范围应在 1 到 '+n+' 之间，且起点应小于或等于终点。');
      for(let p=a;p<=b;p++)targets.add(p);
    }
  }else for(let p=1;p<=n;p++) if(scope==='all'||(scope==='odd' ? p%2===1 : p%2===0))targets.add(p);
  if(!targets.size)throw new Error('没有符合条件的页面。');
  return targets;
}
$('scope').onchange=()=>$('rangeField').hidden=$('scope').value!=='range';
$('apply').onclick=()=>locked(async()=>{
  const targets=selectedPages(), rect=readRect(), mm=margins(rect,view), batch=[];
  for(const n of targets){
    let next=rect;
    if($('units').value==='mm'){
      const vp=(await pdf.getPage(n)).getViewport({scale:1});
      try {next=rectFromMM(mm,vp);} catch {throw new Error('第 '+n+' 页太小，无法容纳这组边距。本次批量设置未应用。');}
    }
    batch.push([n,next]);
  }
  commit(batch);message('已将选框应用到 '+targets.size+' 页。');
});
function download(blob) {
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url;a.download=documentFile.name.replace(/\.pdf$/i,'')+'-已裁剪.pdf';
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
$('save').onclick=()=>locked(async()=>{
  if(!edits.size){download(documentFile);message('已导出原始页面范围。');return;}
  message('正在写入裁剪范围…');
  const {PDFDocument}=await writer();
  const out=await PDFDocument.load(await documentFile.arrayBuffer(),{updateMetadata:false});
  const pages=out.getPages();
  for(const [n,[l,t,r,b]] of edits) {
    const vp=(await pdf.getPage(n)).getViewport({scale:1});
    // PDF.js inverts its own viewing transform, including /Rotate, /UserUnit and box offsets.
    const [x1,y1]=vp.convertToPdfPoint(l*vp.width,t*vp.height);
    const [x2,y2]=vp.convertToPdfPoint(r*vp.width,b*vp.height);
    pages[n-1].setCropBox(Math.min(x1,x2),Math.min(y1,y2),Math.abs(x2-x1),Math.abs(y2-y1));
  }
  const bytes=await out.save({updateFieldAppearances:false});
  download(new Blob([bytes],{type:'application/pdf'}));message('已导出 '+edits.size+' 页的裁剪设置。');
});
