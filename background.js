import { exec } from './src/host-ext.js';
import { servePort } from './src/ext-port.js';
import { servePortRemote } from './src/remote-sw.js';

const open = () => chrome.tabs.create({ url: 'index.html' });
chrome.action.onClicked.addListener(open);

// One-hop executor for the app tab and the background Host (needs APIs only the worker has).
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== chrome.runtime.id) return;
  if (port.name === 'exec') servePort(port, exec);
  else if (port.name === 'rb') servePortRemote(port); // remote browser (src/remote-sw.js)
});

// Background Host: an offscreen document (WebRTC, no tab) runs host.js. Config lives in
// chrome.storage.local ({ bg: { on, secret, brokers? } }); the document asks for it when it loads.
let queue = Promise.resolve();
const applyBg = () => (queue = queue.then(async () => {
  const { bg } = await chrome.storage.local.get('bg');
  await chrome.offscreen.closeDocument().catch(() => {}); // none open is fine; reopen = new config
  if (!bg?.on) return;
  await chrome.offscreen.createDocument({
    url: 'host.html',
    reasons: ['WEB_RTC'],
    justification: 'Serve requests for a paired peer over WebRTC while no Kinlink tab is open',
  });
}).catch((e) => console.error('kinlink bg:', e)));

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (m?.kl === 'bg') {
    const bg = m.on ? { on: true, secret: m.secret, brokers: m.brokers } : { on: false };
    chrome.storage.local.set({ bg }).then(applyBg)
      .then(() => reply({}), (e) => reply({ error: e.message }));
    return true;
  }
  if (m?.kl === 'ready') {
    chrome.storage.local.get(['bg', 'remote']).then(({ bg, remote }) => {
      reply({ ...(bg ?? { on: false }), remote: !!remote?.on });
    });
    return true;
  }
  return false;
});

chrome.runtime.onStartup.addListener(applyBg);
chrome.runtime.onInstalled.addListener(() => { open(); applyBg(); }); // dev: open on install/reload
