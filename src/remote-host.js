import { frameChunks, size } from './remote.js';
import { fromB64 } from './proxy.js';
import { Rate } from './rbrate.js';

const HOST_OPS = new Set(['rbo', 'rbi', 'rbn', 'rbs', 'rbk', 'rbx']); // the rest is for the viewer

// Host side bridge in the page that owns the peer (app tab or offscreen document): DataChannel ops
// <-> one Port to the service worker (src/remote-sw.js, it has chrome.debugger). Only the newest
// frame is kept: a slow link gets fewer frames, not a growing delay. How many frames may be in
// flight (rate.win, from 2) and the JPEG quality adapt to the link (src/rbrate.js).
// opts: { enabled(): bool, connect(): Port, onlog, onuse(bool): a remote browser is open,
//   tickMs: rate control period }.
// Chains onto peer.onctl / peer.onbin.
export function serveRemote(peer, opts) {
  const { enabled, connect, onlog = () => {}, onuse = () => {}, tickMs = 1000 } = opts;
  let port = null;
  let latest = null; // { u8, w, h }
  let inflight = 0;
  let sending = false;
  let n = 0;
  let rate = new Rate();
  let meter; // once a second: rate.tick
  const sentAt = new Map(); // frame number -> when its sending started
  const say = (op, m) => {
    return peer.dc?.readyState === 'open' && peer.dc.send(`${op}:${JSON.stringify(m)}`);
  };

  const end = (tell) => {
    if (!port) return;
    const p = port;
    port = latest = null;
    inflight = 0;
    clearInterval(meter);
    sentAt.clear();
    onuse(false);
    try { p.disconnect(); } catch { /* already gone */ }
    if (tell) say('rbc', {});
  };

  async function pump() {
    if (sending) return;
    sending = true;
    try {
      while (latest && inflight < rate.win && port) {
        const f = latest;
        latest = null;
        inflight++;
        sentAt.set(n + 1, performance.now());
        say('rbf', { n: ++n, len: f.u8.length, w: f.w, h: f.h, q: rate.q, win: rate.win });
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
    onuse(true);
    const mine = port;
    rate = new Rate(m.q);
    meter = setInterval(() => {
      if (rate.tick(performance.now())) mine.postMessage({ op: 'q', q: rate.q });
    }, tickMs);
    meter.unref?.();
    mine.onMessage.addListener((r) => {
      if (port !== mine) return;
      if (r.frame) {
        if (latest) rate.drop(); // replaced before it got a slot: the window is the limit
        latest = { u8: fromB64(r.frame), w: r.w, h: r.h };
        pump();
      }
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
    else if (op === 'rbk') {
      const t0 = sentAt.get(m.n);
      if (t0 !== undefined) rate.ack(performance.now() - t0);
      sentAt.delete(m.n);
      inflight = Math.max(0, inflight - 1);
      pump();
    }
    else if (op === 'rbx') end(false);
    else if (!port) say('rbe', { message: 'no remote browser is open' });
    else if (op === 'rbi') port.postMessage({ op: 'input', ev: m });
    else if (op === 'rbn') port.postMessage({ op: 'nav', ...m });
    else if (op === 'rbs') port.postMessage({ op: 'size', ...size(m.w, m.h) });
    return undefined;
  };
  return { stop: () => end(false) };
}
