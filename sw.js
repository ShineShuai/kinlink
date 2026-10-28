const open = () => chrome.tabs.create({ url: 'index.html' });
chrome.action.onClicked.addListener(open);
chrome.runtime.onInstalled.addListener(open); // dev build: open on install and on reload
