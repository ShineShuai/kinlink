import { BroadcastAdapter } from './src/signaling.js';
import { MqttWssAdapter } from './src/mqtt.js';
import { SealedAdapter, derive, newSecret } from './src/crypto.js';
import { Peer } from './src/p2p.js';
import { attach } from './src/proxy.js';
import { CFG } from './src/diag.js';

const $ = (id) => document.getElementById(id);
const log = (m) => {
  $('log').textContent += `${new Date().toISOString().slice(11, 23)} ${m}\n`;
};
const act = (id, f) => {
  $(id).onclick = () => Promise.resolve().then(f).catch((e) => log(`err: ${e.message}`));
};
const store = (k, v) => {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }
  catch { return null; }
};
const isExt = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
const CSP = '<meta http-equiv="Content-Security-Policy" '
  + 'content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">';
const ORIGINS = { origins: ['<all_urls>'] };
const BUILD = '0005';
let peer, api;
const showPeer = (m) => {
  $('status').textContent = `peer: build ${m.build}, serving ${m.serving ? 'yes' : 'no'}`;
};

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

act('connect', async () => {
  if (!Peer.prototype.tx) throw new Error('src/p2p.js is outdated: apply all patches in order');
  const secret = $('secret').value.trim();
  store('secret', secret);
  const { room, sigKey } = await derive(secret);
  const inner = $('mode').value === 'bc'
    ? new BroadcastAdapter(`kinlink-${room}`)
    : new MqttWssAdapter(CFG.wss[0][0], `kinlink/${room}`);
  const sig = new SealedAdapter(inner, sigKey);
  peer?.pc.close();
  peer = new Peer(sig, CFG.stun.slice(0, 4).map((urls) => ({ urls })));
  peer.onlog = log;
  api = attach(peer, {
    enabled: () => $('host').checked, onlog: log, build: BUILD, onhello: showPeer,
  });
  await sig.open();
  log(`build ${BUILD}, room ${room.slice(0, 8)}. Host waits; client clicks Offer.`);
});
act('offer', () => peer.offer());

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
    // No scripts, no subresources: a safe text preview. Real rendering is M3.
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
