import { newSecret } from './src/crypto.js';
import { Peer } from './src/p2p.js';
import { BUILD, openSession } from './src/session.js';
import { mountRemote } from './src/remote-client.js';
import { PERMS as RB_PERMS } from './src/remote.js';
import { CFG } from './src/diag.js';
import { canRender, renderedUrl, startBridge } from './src/bridge.js';
import { Jar } from './src/cookies.js';
import { browser } from './src/browse.js';
import { execViaPort } from './src/ext-port.js';

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
const PAGES_URL = 'https://shineshuai.github.io/kinlink/'; // hosted Client page
let session, peer, api, viewer;
const jar = new Jar(); // cookies of the sites we browse, kept in this tab only
const browse = () => api && browser(api, jar);
// The extension host does single hops with Cookie/Referer/Origin (in its service worker, see
// ext-port.js); else plain fetch (see proxy.js).
const hostExec = isExt && !!chrome.runtime.connect;
const state = { sig: 'signaling: -', link: 'new', peer: 'peer: not connected' };
const paint = () => {
  $('status').textContent = `${state.sig} | link: ${state.link} | ${state.peer}`;
};
const showPeer = (m) => {
  const rb = m.remote ? ', remote yes' : '';
  state.peer = `peer: build ${m.build}, serving ${m.serving ? 'yes' : 'no'}${rb}`;
  paint();
};
// ?mqtt=wss://a,wss://b overrides the broker list (tests, own broker).
// ?signaling=bc: BroadcastChannel instead of brokers, only for two tabs of one browser (dev).
const signaling = new URLSearchParams(location.search).get('signaling') ?? 'mqtt';
const brokers = () => new URLSearchParams(location.search).get('mqtt')?.split(',') ?? CFG.mqtt;
// ?relay=<ms>: start the broker relay after that long without a direct path (default 8000,
// 0 = at once, for tests). The relay is slow; a direct path that comes up later takes over.
const relayAfter = Number(new URLSearchParams(location.search).get('relay') ?? 8000);
// ?ice=relay: no direct path at all (iceTransportPolicy relay without TURN), for tests.
const rtc = new URLSearchParams(location.search).get('ice') === 'relay'
  ? { iceTransportPolicy: 'relay' } : undefined;

$('secret').value = location.hash.slice(1) || store('secret') || newSecret();
$('new').onclick = () => { $('secret').value = newSecret(); };

// Serving (extension page only): off, in this tab (Connect, the tab stays open) or in the
// background (an offscreen document serves, background.js and host.js; this tab then only shows
// its status and log).
const bgCap = isExt && !!chrome.storage?.local;
$('serve').disabled = !isExt;
$('serve').querySelector('[value=bg]').disabled = !bgCap;
let mode = 'off'; // what is applied
const bgShow = (r) => {
  if (r?.status) $('status').textContent = r.status;
  if (r?.log !== undefined) $('log').textContent = r.log ? `${r.log}\n` : '';
};
const bgUi = (on) => {
  for (const id of ['connect', 'offer', 'new']) $(id).disabled = on;
  $('secret').readOnly = on;
  if (on) chrome.runtime.sendMessage({ kl: 'who' }).then(bgShow, () => {});
};
if (isExt) {
  (async () => {
    const bg = bgCap ? (await chrome.storage.local.get('bg')).bg : null;
    if (bg?.on) {
      $('secret').value = bg.secret;
      $('serve').value = 'bg';
      bgUi(true);
    } else if (await chrome.permissions.contains(ORIGINS)) {
      $('serve').value = 'tab';
    }
    mode = $('serve').value;
  })();
}
if (bgCap) {
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.kl !== 'bgstat' || $('serve').value !== 'bg') return;
    bgShow({ status: m.status });
    if (m.line) $('log').textContent += `${m.line}\n`;
  });
}
$('serve').onchange = async (e) => {
  const next = e.target.value;
  try {
    if (next !== 'off' && !(await chrome.permissions.request(ORIGINS))) {
      throw new Error('permission denied');
    }
    if (next === 'bg' || mode === 'bg') {
      const secret = $('secret').value.trim();
      const q = new URLSearchParams(location.search).get('mqtt')?.split(',');
      const on = next === 'bg';
      const r = await chrome.runtime.sendMessage({ kl: 'bg', on, secret, brokers: q });
      if (r?.error) throw new Error(r.error);
      if (next === 'bg') {
        store('secret', secret);
        session?.stop();
        viewer?.close();
        session = peer = api = viewer = undefined;
        $('log').textContent = '';
      }
    }
    bgUi(next === 'bg');
    mode = next;
    api?.hello();
  } catch (err) {
    e.target.value = mode;
    log(`err: ${err.message}`);
  }
};

// The extension's manifest and service worker are read once: new files need "Reload" in
// chrome://extensions. Say so when the page and the manifest are different builds.
const manifestBuild = isExt && chrome.runtime.getManifest?.().version_name;
if (manifestBuild && manifestBuild !== BUILD) {
  log(`warning: the extension is build ${manifestBuild} but this page is build ${BUILD}: `
    + 'click Reload for Kinlink in chrome://extensions, then reload this tab');
}

// Remote browser, Host side (extension page only): the other side may open a window here (see
// src/remote-sw.js). Needs the optional permission "debugger" and a service worker to drive it.
const remoteCap = isExt && !!chrome.storage?.local && !!chrome.runtime.connect;
$('remote').disabled = !remoteCap;
if (remoteCap) {
  chrome.storage.local.get('remote').then(({ remote }) => { $('remote').checked = !!remote?.on; });
}
$('remote').onchange = async (e) => {
  const on = e.target.checked;
  try {
    if (on && !(await chrome.permissions.request({ permissions: RB_PERMS, ...ORIGINS }))) {
      throw new Error('permission denied');
    }
    const { remote } = await chrome.storage.local.get('remote');
    await chrome.storage.local.set({ remote: { ...remote, on } });
    if (mode === 'bg') { // the background host reads the flag when it starts: restart it
      const secret = $('secret').value.trim();
      const q = new URLSearchParams(location.search).get('mqtt')?.split(',');
      await chrome.runtime.sendMessage({ kl: 'bg', on: true, secret, brokers: q });
    }
    api?.hello();
  } catch (err) {
    e.target.checked = !on;
    log(`err: ${err.message}`);
  }
};

async function connect() {
  if (!Peer.prototype.tx) throw new Error('src/p2p.js is outdated: apply all patches in order');
  const secret = $('secret').value.trim();
  store('secret', secret);
  viewer?.close();
  session?.stop();
  session = peer = api = viewer = undefined;
  session = await openSession({
    secret,
    brokers: brokers(),
    stun: CFG.stun.slice(0, 4),
    signaling,
    relayAfter,
    rtc,
    enabled: () => $('serve').value === 'tab',
    remote: remoteCap ? {
      enabled: () => $('remote').checked, connect: () => chrome.runtime.connect({ name: 'rb' }),
    } : undefined,
    exec: hostExec ? execViaPort : undefined,
    onlog: log,
    onhello: showPeer,
    onstate: (p) => { Object.assign(state, p); paint(); },
  });
  ({ peer, api } = session);
}
act('connect', connect);
act('offer', () => {
  if (!peer) throw new Error('Connect first');
  return peer.offer();
});
// An invite link (#secret) means: be the Client. Connect and offer, no clicks needed.
if (!isExt && location.hash.length > 1) {
  log('invite link: joining');
  connect().then(() => peer.offer()).catch((e) => log(`err: ${e.message}`));
}
const rendering = canRender();
$('open').disabled = !rendering;
if (rendering) startBridge(browse, log).catch((e) => log(`render: ${e.message}`));
act('open', async () => {
  await navigator.serviceWorker.ready;
  window.open(renderedUrl($('url').value.trim()), '_blank', 'noopener');
});

act('copylog', async () => {
  await navigator.clipboard.writeText(`${$('status').textContent}\n${$('log').textContent}`);
  log('log copied');
});

$('base').value = store('base') ?? (isExt ? PAGES_URL : location.href.split(/[?#]/)[0]);
$('base').onchange = () => store('base', $('base').value.trim());
act('invite', async () => {
  const base = $('base').value.trim().split('#')[0];
  if (signaling !== 'mqtt') log('note: invite links only work with mqtt signaling');
  await navigator.clipboard.writeText(`${base}#${$('secret').value.trim()}`);
  log(`invite link copied: ${base}#...`);
});

// Remote browser, Client side: the Host's real browser loads the page, we see and control it.
const remoteWhy = () => {
  const info = api?.info();
  if (!info) return 'no hello from the peer yet';
  if (!info.remote) return 'the host has not allowed the remote browser (tick it on the host)';
  if (peer.dc?.relay && !peer.dc.useAlt) {
    return 'the remote browser needs a direct link, not the relay';
  }
  return null;
};
act('ropen', async () => {
  if (!peer) throw new Error('Connect first');
  viewer ??= mountRemote($('rbox'), peer, { can: remoteWhy, onlog: log });
  viewer.open($('url').value.trim());
});

act('go', async () => {
  const t0 = performance.now();
  const b = browse();
  if (!b) throw new Error('Connect first');
  const r = await b.fetch($('url').value.trim(), { headers: { accept: 'text/html,*/*' } });
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
