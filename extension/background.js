function openEditor() {
  return chrome.tabs.create({url: chrome.runtime.getURL('index.html')});
}

chrome.action.onClicked.addListener(openEditor);
