import { blocked } from './proxy.js';

// Remote browser, shared parts (pure, no chrome.* and no DOM).
// DataChannel ops, all JSON after "op:" unless noted. Client -> Host:
//   rbo {url,w,h,q} open | rbi {t,..} input | rbn {a,url} go/back/forward/reload | rbs {w,h} resize
//   rbk {n} frame shown (flow control) | rbx {} close
// Host -> Client: rbm {url,title,loading} | rbf {n,len,w,h,q,win} (q, win: the Host's rate control,
//   src/rbrate.js) then binary [u32 RB_ID][<= 16 KiB] chunks of one JPEG | rbe {message} |
//   rbc {} closed
// Frame chunks use binary id RB_ID; proxy.js ids are always >= 2.
// Optional extension permission the Host grants for the remote browser (with the host access).
// "debugger" cannot be optional in Chrome: it is in the manifest.
export const PERMS = ['webNavigation'];
export const RB_ID = 1;
export const CHUNK = 16 * 1024 - 4;
export const MAX_FRAME = 4 << 20;

const num = (v, lo, hi, d = lo) => {
  return Math.min(hi, Math.max(lo, Number.isFinite(+v) ? Math.round(+v) : d));
};
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
export const size = (w, h) => ({ w: num(w, 200, 2560, 1024), h: num(h, 200, 1600, 640) });

// Status phrase for the remote browser, the same words on both sides. The Client's hello always
// says remote: false, so "peer allows" identifies the Client side.
export const rbWord = ({ peerServes, peerRemote, allowed, using }) => {
  if (peerRemote) return 'remote: host allows';
  if (peerServes) return 'remote: host off';
  return `remote: ${allowed ? (using ? 'in use' : 'allowed') : 'off'}`;
};

// The remote browser may only load web pages, and the same SSRF rules as the fetch executor apply.
export const urlProblem = (u) => {
  return typeof u === 'string' && u.length < 8192 ? blocked(u) : 'bad url';
};

// A request the Client sends is never trusted: this turns an input event into a CDP command with
// every field range-checked, or returns null.
const BUTTON = ['none', 'left', 'middle', 'right'];
export function cdpInput(ev, { w, h } = size()) {
  if (!ev || typeof ev !== 'object') return null;
  const mod = num(ev.mod, 0, 15, 0);
  if (ev.t === 'm') {
    const type = {
      move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased', wheel: 'mouseWheel',
    }[ev.k];
    if (!type) return null;
    const b = num(ev.b, 0, 3, 0);
    return { method: 'Input.dispatchMouseEvent', params: {
      type, x: num(ev.x, 0, w - 1, 0), y: num(ev.y, 0, h - 1, 0), modifiers: mod,
      button: type === 'mouseMoved' || type === 'mouseWheel' ? 'none' : BUTTON[b],
      buttons: num(ev.bs, 0, 31, 0), clickCount: num(ev.n, 0, 3, 0),
      ...(type === 'mouseWheel'
        ? { deltaX: num(ev.dx, -5000, 5000, 0), deltaY: num(ev.dy, -5000, 5000, 0) } : {}),
    } };
  }
  if (ev.t === 'k') {
    if (ev.k !== 'down' && ev.k !== 'up') return null;
    const text = ev.k === 'down' ? str(ev.text, 8) : '';
    return { method: 'Input.dispatchKeyEvent', params: {
      type: ev.k === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
      key: str(ev.key, 32), code: str(ev.code, 32), modifiers: mod,
      windowsVirtualKeyCode: num(ev.vk, 0, 255, 0), nativeVirtualKeyCode: num(ev.vk, 0, 255, 0),
      ...(text ? { text, unmodifiedText: text } : {}),
    } };
  }
  if (ev.t === 'i') {
    const text = str(ev.s, 2000);
    return text ? { method: 'Input.insertText', params: { text } } : null;
  }
  return null;
}

// Splits one JPEG into binary DataChannel messages.
export function* frameChunks(u8) {
  for (let i = 0; i < u8.length; i += CHUNK) {
    const part = u8.subarray(i, i + CHUNK);
    const m = new Uint8Array(4 + part.length);
    new DataView(m.buffer).setUint32(0, RB_ID);
    m.set(part, 4);
    yield m;
  }
}

// Client side: header (rbf) then chunks; calls onframe(Blob, meta) when complete. A new header
// drops a half-received frame (cannot happen on an ordered channel, but costs nothing).
export class FrameAssembler {
  constructor(onframe) { this.onframe = onframe; this.cur = null; }
  head(m) {
    this.cur = null;
    if (!(m.len > 0 && m.len <= MAX_FRAME)) return;
    this.cur = { m, parts: [], got: 0 };
  }
  chunk(u8) {
    const c = this.cur;
    if (!c) return;
    c.parts.push(u8);
    c.got += u8.length;
    if (c.got < c.m.len) return;
    this.cur = null;
    if (c.got === c.m.len) this.onframe(new Blob(c.parts, { type: 'image/jpeg' }), c.m);
  }
}

// DOM events on the Client -> input messages (rbi). view = { w, h } of the remote viewport,
// rect = the canvas' getBoundingClientRect(). Plain data in, plain data out (testable).
const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0)
  | (e.shiftKey ? 8 : 0);
const at = (e, rect, view) => ({
  x: ((e.clientX - rect.left) * view.w) / (rect.width || 1),
  y: ((e.clientY - rect.top) * view.h) / (rect.height || 1),
});
// The remote viewport as the Client sees it: width w CSS px, height from the canvas' aspect. The
// Host window can be smaller than the viewport asked for (the frame is then cropped, not scaled),
// so both axes use the same scale.
export const viewOf = (rect, w) => ({ w, h: (rect.height * w) / (rect.width || 1) });

// n: click count (PointerEvent.detail is always 0, and CDP only clicks with clickCount >= 1)
export const mouseInput = (k, e, rect, view, n = e.detail ?? 0) => ({
  t: 'm', k, ...at(e, rect, view), b: k === 'move' || k === 'wheel' ? 0 : e.button + 1,
  bs: e.buttons ?? 0, n, mod: mods(e),
});

// Counts clicks like a browser: same button, close in time and place -> 2, 3. Returns the count.
export function clickCounter(ms = 500, px = 5) {
  let last = null;
  let n = 0;
  return (e) => {
    const near = last && e.timeStamp - last.t < ms && last.b === e.button
      && Math.abs(e.clientX - last.x) <= px && Math.abs(e.clientY - last.y) <= px;
    n = near ? Math.min(3, n + 1) : 1;
    last = { t: e.timeStamp, b: e.button, x: e.clientX, y: e.clientY };
    return n;
  };
}
export const wheelInput = (e, rect, view) => {
  const f = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.h : 1; // lines, pages -> pixels
  return { ...mouseInput('wheel', e, rect, view), dx: e.deltaX * f, dy: e.deltaY * f };
};
// null: let the browser handle it (paste arrives as a paste event, IME as composition events)
export function keyInput(k, e) {
  if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return null;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return null;
  const typed = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  const text = e.key === 'Enter' ? '\r' : typed ? e.key : '';
  return {
    t: 'k', k, key: e.key, code: e.code, vk: e.keyCode, mod: mods(e),
    ...(k === 'down' && text ? { text } : {}),
  };
}

// What the address bar accepts: a URL, or a host name (https).
export const addressUrl = (v) => {
  const t = v.trim();
  return /^[a-z][a-z\d+.-]*:/i.test(t) ? t : `https://${t}`;
};
