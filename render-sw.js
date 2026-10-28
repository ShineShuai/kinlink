// Service Worker of the Client page. Requests under <scope>~/<url> are answered by the peer.
// The app tab (the one holding the WebRTC peer) answers over a MessageChannel; see src/bridge.js.
import { render } from './src/render.js';

const ROOT = new URL('./~/', self.registration.scope).pathname; // "/kinlink/~/"
const SEND = ['accept', 'accept-language', 'range'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let owner = null; // client id of the app tab; only a live owner can be replaced

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', async (e) => {
  if (e.data?.type !== 'beat') return;
  if (!owner || owner === e.source.id || !(await self.clients.get(owner))) owner = e.source.id;
});

async function findOwner() {
  const live = owner && await self.clients.get(owner);
  if (live) return live;
  owner = null; // service worker was restarted or the tab is gone: ask the tabs to re-announce
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'who' });
  for (let i = 0; i < 20 && !owner; i++) await sleep(100);
  return owner && self.clients.get(owner);
}

async function ask(url, headers) {
  const tab = await findOwner();
  if (!tab) throw new Error('no connected Kinlink app tab (keep it open)');
  return new Promise((ok, fail) => {
    const { port1, port2 } = new MessageChannel();
    const t = setTimeout(() => fail(new Error('app tab did not answer')), 35000);
    port1.onmessage = ({ data }) => {
      clearTimeout(t);
      if (data.error) fail(new Error(data.error)); else ok(data);
    };
    tab.postMessage({ type: 'req', url, headers }, [port2]);
  });
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || !u.pathname.startsWith(ROOT)) return;
  const headers = Object.fromEntries(
    SEND.map((k) => [k, e.request.headers.get(k)]).filter(([, v]) => v));
  u.hash = ''; // fragments stay in the browser
  const url = u.href.slice(u.origin.length + ROOT.length); // raw path + query, no fragment
  e.respondWith(render({ url, method: e.request.method, headers }, ask, ROOT));
});
