import { BroadcastAdapter, FanoutAdapter } from './src/signaling.js';
import { MqttWssAdapter } from './src/mqtt.js';
import { SealedAdapter, derive, newSecret } from './src/crypto.js';
import { Peer } from './src/p2p.js';
import { attach } from './src/proxy.js';
import { CFG } from './src/diag.js';
import { canRender, renderedUrl, startBridge } from './src/bridge.js';

const $ = (id) => document.getElementById(id);
const log = (m) => {
  $('log').textContent += `${new Date().toISOString().slice(11, 23)} ${m}\n`;
};
const act = (id, f) => {
  $(id).onclick = () => Promise.resolve().then(f).catch((e) => log(`err: ${e.message}`));
};
const isExt = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
// Rendered pages share this origin: on the web the secret lives in this tab only.
const store = (k, v) => {
  k = `kinlink.${k}`;
  try {
    const kv = isExt ? localStorage : sessionStorage;
    if (v === undefined) return kv.getItem(k);
    kv.setItem(k, v);
  } catch { return null; }
};
if (!isExt) try { localStorage.removeItem('kinlink.secret'); } catch { /* storage blocked */ }
const CSP = '<meta http-equiv="Content-Security-Policy" '
  + 'content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">';
const ORIGINS = { origins: ['<all_urls>'] };
const BUILD = '0009';
const PAGES_URL = 'https://shineshuai.github.io/kinlink/'; // hosted Client page
let peer, api, sig;
const state = { sig: 'signaling: -', link: 'new', peer: 'peer: not connected' };
const paint = () => {
  $('status').textContent = `${state.sig} | link: ${state.link} | ${state.peer}`;
};
const showPeer = (m) => {
  state.peer = `peer: build ${m.build}, serving ${m.serving ? 'yes' : 'no'}`;
  paint();
};
// ?mqtt=wss://a,wss://b overrides the broker list (tests, own broker)
const brokers = () => new URLSearchParams(location.search).get('mqtt')?.split(',') ?? CFG.mqtt;

$('secret').value = location.hash.slice(1) || store('secret') || newSecret();
$('new').onclick = () => { $('secret').value = newSecret(); };

$('host').disabled = !isExt;
if (isExt) chrome.permissions.contains(ORIGINS).then((ok) => { $('host').checked = ok; });
$('host').onchange = async (e) => {
  if (e.target.checked && !(await chrome.permissions.request(ORIGINS))) {
    e.target.checked = false;
    log('permission denied');
  }
  api?.hello();
};

async function connect() {
  if (!Peer.prototype.tx) throw new Error('src/p2p.js is outdated: apply all patches in order');
  const secret = $('secret').value.trim();
  store('secret', secret);
  const { room, sigKey } = await derive(secret);
  let inner;
  if ($('mode').value === 'bc') {
    inner = new BroadcastAdapter(`kinlink-${room}`);
    state.sig = 'signaling: bc';
  } else {
    inner = new FanoutAdapter(brokers().map(
      (u) => [new URL(u).host, new MqttWssAdapter(u, `kinlink/${room}`)]));
    inner.onlog = log;
    inner.addEventListener('state', () => { state.sig = `signaling: ${inner.status()}`; paint(); });
    state.sig = 'signaling: connecting';
  }
  sig?.close().catch(() => {});
  peer?.pc.close();
  sig = new SealedAdapter(inner, sigKey);
  peer = new Peer(sig, CFG.stun.slice(0, 4).map((urls) => ({ urls })));
  peer.onlog = log;
  peer.pc.addEventListener('connectionstatechange', () => {
    state.link = peer.pc.connectionState;
    paint();
  });
  api = attach(peer, {
    enabled: () => $('host').checked, onlog: log, build: BUILD, onhello: showPeer,
  });
  state.link = 'new';
  state.peer = 'peer: not connected';
  paint();
  try {
    await sig.open();
  } catch (e) {
    peer.pc.close();
    peer = api = undefined; // nothing to talk to: do not leave a half-connected state behind
    state.sig = `signaling failed: ${e.message}`;
    paint();
    throw e;
  }
  log(`build ${BUILD}, room ${room.slice(0, 8)}. Host: wait. Client: Offer.`);
}
act('connect', connect);
act('offer', () => {
  if (!peer) throw new Error('Connect first');
  return peer.offer();
});
// An invite link (#secret) means: be the Client. Connect and offer, no clicks needed.
if (!isExt && location.hash.length > 1 && $('mode').value === 'mqtt') {
  log('invite link: joining');
  connect().then(() => peer.offer()).catch((e) => log(`err: ${e.message}`));
}
const rendering = canRender();
$('open').disabled = !rendering;
if (rendering) startBridge(() => api, log).catch((e) => log(`render: ${e.message}`));
act('open', async () => {
  await navigator.serviceWorker.ready;
  window.open(renderedUrl($('url').value.trim()), '_blank', 'noopener');
});

act('copylog', async () => {
  await navigator.clipboard.writeText(`${$('status').textContent}\n${$('log').textContent}`);
  log('log copied');
});

act('invite', async () => {
  const base = isExt ? PAGES_URL : location.href.split('#')[0];
  await navigator.clipboard.writeText(`${base}#${$('secret').value.trim()}`);
  log('invite link copied');
});

act('go', async () => {
  const t0 = performance.now();
  const r = await api.fetch($('url').value.trim(), { accept: 'text/html,*/*' });
  const type = r.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
  $('meta').textContent = `${r.status} ${r.url} ${type} ${r.body.size} B `
    + `${Math.round(performance.now() - t0)} ms`;
  const view = $('view');
  view.replaceChildren();
  if (type.startsWith('image/')) {
    const img = new Image();
    img.src = URL.createObjectURL(r.body);
    img.style.maxWidth = '100%';
    view.append(img);
  } else if (type.startsWith('text/html')) {
    // No scripts, no subresources: a safe text preview. "Open rendered" is the real view.
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', '');
    f.style.cssText = 'width:100%;height:60vh;border:1px solid gray;background:#fff';
    f.srcdoc = CSP + await r.body.text();
    view.append(f);
  } else {
    const pre = document.createElement('pre');
    pre.textContent = await r.body.slice(0, 20000).text();
    view.append(pre);
  }
});
