import { frameChunks, size } from './remote.js';
import { fromB64 } from './proxy.js';

const INFLIGHT = 2; // frames sent but not yet shown by the Client
const HOST_OPS = new Set(['rbo', 'rbi', 'rbn', 'rbs', 'rbk', 'rbx']); // the rest is for the viewer

// Host side bridge in the page that owns the peer (app tab or offscreen document): DataChannel ops
// <-> one Port to the service worker (src/remote-sw.js, it has chrome.debugger). Only the newest
// frame is kept: a slow link gets fewer frames, not a growing delay.
// opts: { enabled(): bool, connect(): Port, onlog }. Chains onto peer.onctl / peer.onbin.
export function serveRemote(peer, { enabled, connect, onlog = () => {} }) {
  let port = null;
  let latest = null; // { u8, w, h }
  let inflight = 0;
  let sending = false;
  let n = 0;
  const say = (op, m) => {
    return peer.dc?.readyState === 'open' && peer.dc.send(`${op}:${JSON.stringify(m)}`);
  };

  const end = (tell) => {
    if (!port) return;
    const p = port;
    port = latest = null;
    inflight = 0;
    try { p.disconnect(); } catch { /* already gone */ }
    if (tell) say('rbc', {});
  };

  async function pump() {
    if (sending) return;
    sending = true;
    try {
      while (latest && inflight < INFLIGHT && port) {
        const f = latest;
        latest = null;
        inflight++;
        say('rbf', { n: ++n, len: f.u8.length, w: f.w, h: f.h });
        for (const c of frameChunks(f.u8)) await peer.tx(c);
      }
    } catch (e) {
      onlog(`remote: ${e.message}`);
    } finally {
      sending = false;
    }
  }

  function open(m) {
    end(false);
    const direct = !(peer.dc?.relay && !peer.dc.useAlt);
    if (!enabled()) {
      onlog('remote: refused, not allowed on this host');
      return say('rbe', { message: 'remote browser is off on the host' });
    }
    if (!direct) {
      return say('rbe', { message: 'remote browser needs a direct connection (not the relay)' });
    }
    onlog(`remote: open ${m.url}`);
    port = connect();
    const mine = port;
    mine.onMessage.addListener((r) => {
      if (port !== mine) return;
      if (r.frame) { latest = { u8: fromB64(r.frame), w: r.w, h: r.h }; pump(); }
      else if (r.meta) say('rbm', r.meta);
      else if (r.error) { onlog(`remote: ${r.error}`); say('rbe', { message: r.error }); }
      else if (r.closed) end(true);
    });
    mine.onDisconnect.addListener(() => { if (port === mine) end(true); });
    mine.postMessage({ op: 'open', url: m.url, ...size(m.w, m.h), q: m.q });
  }

  const prevCtl = peer.onctl;
  peer.onctl = (op, arg) => {
    if (!HOST_OPS.has(op)) return prevCtl?.(op, arg);
    let m;
    try { m = JSON.parse(arg); } catch { return undefined; }
    if (op === 'rbo') open(m);
    else if (op === 'rbk') { inflight = Math.max(0, inflight - 1); pump(); }
    else if (op === 'rbx') end(false);
    else if (!port) say('rbe', { message: 'no remote browser is open' });
    else if (op === 'rbi') port.postMessage({ op: 'input', ev: m });
    else if (op === 'rbn') port.postMessage({ op: 'nav', ...m });
    else if (op === 'rbs') port.postMessage({ op: 'size', ...size(m.w, m.h) });
    return undefined;
  };
  return { stop: () => end(false) };
}
