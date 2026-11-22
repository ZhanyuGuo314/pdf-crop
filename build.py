"""Build a portable HTML with verified npm distributions and offline PDF resources."""
from pathlib import Path
import base64
import argparse
import gzip
import hashlib
import html
import io
import json
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
VERSIONS = {'pdfjs-dist': '4.10.38', 'pdf-lib': '1.17.1'}

def dependency(name, version):
    url = f'https://registry.npmjs.org/{name}/{version}'
    with urllib.request.urlopen(url, timeout=30) as response:
        spec = json.load(response)['dist']
    with urllib.request.urlopen(spec['tarball'], timeout=90) as response:
        data = response.read()
    algo, expected = spec['integrity'].split('-', 1)
    if base64.b64encode(hashlib.new(algo, data).digest()).decode() != expected:
        raise ValueError(f'Integrity check failed for {name}')
    with tarfile.open(fileobj=io.BytesIO(data)) as bundle:
        return {m.name.removeprefix('package/'): bundle.extractfile(m).read()
                for m in bundle.getmembers() if m.isfile() and
                (m.name.startswith(('package/cmaps/', 'package/standard_fonts/')) or
                 m.name in {'package/LICENSE','package/LICENSE.md','package/dist/pdf-lib.min.js',
                            'package/build/pdf.min.mjs','package/build/pdf.worker.min.mjs'})}

def build(dest, extension=False):
    packages = {name: dependency(name, version) for name, version in VERSIONS.items()}
    reader = packages['pdfjs-dist']
    writer = packages['pdf-lib']
    resources = {'reader': reader['build/pdf.min.mjs'], 'worker': reader['build/pdf.worker.min.mjs'],
                 'writer': writer['dist/pdf-lib.min.js']}
    for path, data in reader.items():
        if path.endswith(('.bcmap','.ttf','.pfb')):
            resources[Path(path).name] = data
    license_parts = ['PDF.js 4.10.38 · https://github.com/mozilla/pdf.js',
                     'pdf-lib 1.17.1 · https://github.com/Hopding/pdf-lib',
                     'Bootstrap Icons 1.13.1 · https://icons.getbootstrap.com/\n' +
                     (ROOT/'icons-license.txt').read_text(encoding='utf8')]
    for pkg, files in packages.items():
        for path, data in files.items():
            if 'LICENSE' in path and data.strip():
                license_parts.append(f'{pkg} / {path}\n{data.decode("utf-8")}')
    text = (ROOT/'index.html').read_text(encoding='utf8')
    styles = '\n'.join((ROOT/name).read_text(encoding='utf8') for name in ('icons.css', 'style.css'))
    text = text.replace('__LICENSES__', html.escape('\n\n'.join(license_parts)))
    app = (ROOT/'app.js').read_text(encoding='utf8')
    if extension:
        dest.mkdir(parents=True, exist_ok=True)
        for asset in (ROOT/'extension').rglob('*'):
            if asset.is_file() and asset.name != 'runtime.js':
                output = dest/asset.relative_to(ROOT/'extension')
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(asset.read_bytes())
        scripts = {'pdf.min.mjs':resources['reader'], 'pdf.worker.min.mjs':resources['worker'],
                   'pdf-lib.min.js':resources['writer']}
        for path, data in reader.items():
            if path.endswith(('.bcmap','.ttf','.pfb')):
                scripts[path] = data
        for name, data in scripts.items():
            output = dest/'vendor'/name
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(data)
        (dest/'style.css').write_text(styles, encoding='utf8')
        (dest/'app.js').write_text((ROOT/'extension/runtime.js').read_text(encoding='utf8')+'\n'+app, encoding='utf8')
        text = (text.replace('<style>/*STYLE*/</style>', '<link rel="stylesheet" href="style.css">')
                .replace('<script id="assets" type="application/json">__ASSETS__</script>', '')
                .replace('<script type="module">/*APP*/</script>', '<script type="module" src="app.js"></script>'))
        (dest/'index.html').write_text(text, encoding='utf8')
        return
    encoded = {name: base64.b64encode(gzip.compress(data, compresslevel=9, mtime=0)).decode()
               for name, data in resources.items()}
    runtime = (ROOT/'runtime-inline.js').read_text(encoding='utf8')
    text = (text.replace('/*STYLE*/', styles)
            .replace('/*APP*/', runtime+'\n'+app)
            .replace('__ASSETS__', json.dumps(encoded,separators=(',',':'))))
    dest.write_text(text, encoding='utf8')
    print(f'{dest.name}: {dest.stat().st_size:,} bytes')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', nargs='?', type=Path)
    parser.add_argument('--extension', action='store_true')
    args = parser.parse_args()
    dest = args.destination or ROOT/('pdf-crop-extension' if args.extension else 'pdf-crop.html')
    build(dest, args.extension)
