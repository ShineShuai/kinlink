import {
  FrameAssembler, RB_ID, addressUrl, clickCounter, keyInput, mouseInput, size, viewOf, wheelInput,
} from './remote.js';

const CLIENT_OPS = new Set(['rbf', 'rbm', 'rbe', 'rbc']); // the rest is for the Host side

// Viewer for the remote browser, built inside `box`: address bar, a canvas that shows the JPEG
// frames, and a textarea that takes keyboard focus (so IME and paste work). Only pictures cross
// from the remote page: no script of that site ever runs in this origin.
// can(): null, or why a remote browser cannot be opened now. Chains onto peer.onctl / onbin.
export function mountRemote(box, peer, { can = () => null, onlog = () => {} } = {}) {
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids);
    return n;
  };
  const btn = (text, title, onclick) => el('button', { textContent: text, title, onclick });
  const url = el('input', { size: 40, placeholder: 'https://…' });
  const status = el('span');
  const canvas = el('canvas', { style: 'width:100%;background:#222;display:block;outline:none' });
  const ta = el('textarea', {
    style: 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none',
  });
  const stage = el('div', { style: 'position:relative' }, canvas, ta);
  const send = (op, m = {}) => {
    return peer.dc?.readyState === 'open' && peer.dc.send(`${op}:${JSON.stringify(m)}`);
  };
  const input = (ev) => ev && send('rbi', ev);
  const nav = (a, u) => send('rbn', { a, url: u });
  const go = () => nav('go', addressUrl(url.value));
  url.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  const bar = el('div', {},
    btn('←', 'back', () => nav('back')), btn('→', 'forward', () => nav('forward')),
    btn('⟳', 'reload', () => nav('reload')), url, btn('Go', 'go', go),
    btn('Close', 'close', () => close()), status);
  box.replaceChildren(bar, stage);
  box.hidden = true;

  let view = size(1024, 640);
  let live = false;
  const ctx = canvas.getContext('2d');
  let msg = '';
  let stat = ''; // live numbers: frames/s, KB/s, KB per frame
  const paint = () => { status.textContent = ` ${msg}${stat ? ` | ${stat}` : ''}`; };
  const say = (t) => { msg = t; paint(); };
  const num = { frames: 0, bytes: 0, last: 0 };
  let meter;
  const rect = () => canvas.getBoundingClientRect();
  const viewNow = () => viewOf(rect(), view.w);

  const asm = new FrameAssembler(async (blob, m) => {
    num.frames++;
    num.bytes += blob.size;
    num.last = blob.size;
    try {
      const bmp = await createImageBitmap(blob);
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
    } catch (e) {
      onlog(`remote: bad frame: ${e.message}`);
    }
    send('rbk', { n: m.n });
  });

  const prevCtl = peer.onctl;
  peer.onctl = (op, arg) => {
    if (!CLIENT_OPS.has(op)) return prevCtl?.(op, arg);
    const m = JSON.parse(arg);
    if (op === 'rbf') asm.head(m);
    else if (op === 'rbm') {
      if (m.url) url.value = m.url;
      if (m.title) document.title = `Kinlink: ${m.title}`;
      say(m.loading ? 'loading…' : m.title ?? '');
    } else if (op === 'rbe') { say(m.message); onlog(`remote: ${m.message}`); }
    else if (op === 'rbc') {
      live = false;
      clearInterval(meter);
      stat = '';
      say('closed by the host');
    }
    return undefined;
  };
  const prevBin = peer.onbin;
  peer.onbin = (buf) => {
    if (buf.byteLength >= 4 && new DataView(buf).getUint32(0) === RB_ID) {
      asm.chunk(new Uint8Array(buf, 4));
    } else {
      prevBin?.(buf);
    }
  };

  // pointer, wheel, keyboard
  const focus = () => ta.focus({ preventScroll: true });
  let lastMove = 0;
  canvas.onpointermove = (e) => {
    if (e.timeStamp - lastMove < 25) return;
    lastMove = e.timeStamp;
    input(mouseInput('move', e, rect(), viewNow()));
  };
  canvas.onmousedown = (e) => { e.preventDefault(); focus(); }; // else the click moves focus away
  const count = clickCounter();
  let clicks = 1;
  canvas.onpointerdown = (e) => {
    focus();
    canvas.setPointerCapture(e.pointerId);
    clicks = count(e);
    input(mouseInput('down', e, rect(), viewNow(), clicks));
  };
  canvas.onpointerup = (e) => input(mouseInput('up', e, rect(), viewNow(), clicks));
  canvas.onwheel = (e) => { e.preventDefault(); input(wheelInput(e, rect(), viewNow())); };
  canvas.oncontextmenu = (e) => e.preventDefault();
  for (const k of ['down', 'up']) {
    ta[`onkey${k}`] = (e) => {
      const ev = keyInput(k, e);
      if (!ev) return;
      e.preventDefault();
      input(ev);
    };
  }
  ta.oncompositionend = (e) => { input({ t: 'i', s: e.data }); ta.value = ''; };
  ta.onpaste = (e) => {
    e.preventDefault();
    input({ t: 'i', s: e.clipboardData.getData('text') });
  };

  let resizeTimer;
  const onresize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!live) return;
      view = fit();
      send('rbs', view);
    }, 300);
  };
  addEventListener('resize', onresize);
  const fit = () => {
    const w = box.clientWidth || 1024;
    return size(Math.min(1280, w), Math.round(w * 0.62));
  };

  function close() {
    if (live) send('rbx');
    live = false;
    clearInterval(meter);
    stat = '';
    box.hidden = true;
    removeEventListener('resize', onresize);
  }
  return {
    // Opens (or navigates) the remote browser. Throws a short reason if it cannot.
    open(target) {
      const why = can();
      if (why) throw new Error(why);
      box.hidden = false;
      view = fit();
      url.value = addressUrl(target);
      live = true;
      say('opening… (the host sees this window)');
      send('rbo', { url: url.value, ...view, q: 60 });
      clearInterval(meter);
      meter = setInterval(() => {
        stat = `${num.frames} fps, ${Math.round(num.bytes / 1024)} KB/s, `
          + `${Math.round(num.last / 1024)} KB/frame`;
        Object.assign(num, { frames: 0, bytes: 0 });
        paint();
      }, 1000);
      addEventListener('resize', onresize);
      canvas.focus();
    },
    close,
  };
}
