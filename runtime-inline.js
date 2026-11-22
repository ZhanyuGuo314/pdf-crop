let assetIndex, readerPromise, writerPromise;

async function unpack(name) {
  assetIndex ??= JSON.parse($('assets').textContent);
  const encoded = assetIndex[name];
  if (!encoded) throw new Error('缺少离线资源 ' + name);
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function scriptURL(name) {
  return URL.createObjectURL(new Blob([await unpack(name)], {type: 'text/javascript'}));
}
async function reader() {
  readerPromise ??= (async () => {
    const lib = await import(await scriptURL('reader'));
    lib.GlobalWorkerOptions.workerSrc = await scriptURL('worker');
    return lib;
  })();
  return readerPromise;
}
async function writer() {
  writerPromise ??= (async () => {
    const url = await scriptURL('writer');
    try {
      await new Promise((resolve, reject) => {
        const tag = document.createElement('script');
        tag.onload = resolve;
        tag.onerror = () => reject(new Error('无法载入 PDF 写入组件。'));
        tag.src = url; document.head.append(tag);
      });
    } finally { URL.revokeObjectURL(url); }
    return globalThis.PDFLib;
  })();
  return writerPromise;
}
class OfflineCMaps {
  async fetch({name}) { return {cMapData: await unpack(name + '.bcmap'), isCompressed: true}; }
}
class OfflineFonts {
  async fetch({filename}) { return unpack(filename); }
}
