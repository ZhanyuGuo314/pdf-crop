async function reader() {
  const lib = await import('./vendor/pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');
  return lib;
}

async function writer() {
  await import('./vendor/pdf-lib.min.js');
  return globalThis.PDFLib;
}

async function readAsset(directory, filename) {
  if (!/^[\w.-]+$/.test(filename)) throw new Error('无效的 PDF 资源名称。');
  const response = await fetch(chrome.runtime.getURL('vendor/' + directory + '/' + filename));
  if (!response.ok) throw new Error('无法载入 PDF 资源 ' + filename);
  return new Uint8Array(await response.arrayBuffer());
}

class OfflineCMaps {
  async fetch({name}) {
    return {cMapData: await readAsset('cmaps', name + '.bcmap'), isCompressed: true};
  }
}

class OfflineFonts {
  async fetch({filename}) { return readAsset('standard_fonts', filename); }
}
