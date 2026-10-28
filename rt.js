// Runtime hooks for rendered pages. The Service Worker injects this first in every HTML page.
// Best effort: rewrites URLs built at run time so they go back through the Service Worker.
// Anything missed is stopped by the Content-Security-Policy set in src/render.js.
(() => {
  const { origin, pathname } = location;
  if (!pathname.includes('/~/')) return;
  const ROOT = pathname.slice(0, pathname.indexOf('/~/') + 3); // "/kinlink/~/"
  const real = () => location.href.slice(origin.length + ROOT.length);
  const unpx = (s) => (typeof s === 'string' && s.startsWith(origin + ROOT)
    ? s.slice(origin.length + ROOT.length) : s);
  const px = (u) => {
    const s = String(u);
    if (s.startsWith(ROOT) || s.startsWith(origin + ROOT)) return s;
    try {
      const a = new URL(s, real());
      return /^https?:$/.test(a.protocol) ? ROOT + a.href : s;
    } catch { return s; }
  };
  const hook = (o, k, f) => {
    const g = o[k];
    if (g) o[k] = function (...a) { return f(g, this, a); };
  };

  hook(window, 'fetch', (g, t, [i, o]) =>
    g.call(t, i instanceof Request ? new Request(px(i.url), i) : px(i), o));
  hook(XMLHttpRequest.prototype, 'open', (g, t, [m, u, ...r]) => g.call(t, m, px(u), ...r));
  hook(navigator, 'sendBeacon', (g, t, [u, d]) => g.call(t, px(u), d));
  hook(window, 'open', (g, t, [u, ...r]) => g.call(t, u ? px(u) : u, ...r));
  for (const k of ['pushState', 'replaceState']) {
    hook(history, k, (g, t, [s, n, u]) => g.call(t, s, n, u == null ? u : px(u)));
  }
  const Worker0 = window.Worker;
  window.Worker = class extends Worker0 { constructor(u, o) { super(px(u), o); } };
  if (navigator.serviceWorker) { // a page's own Service Worker would bypass ours
    navigator.serviceWorker.register = () => Promise.reject(new DOMException('blocked', 'SecurityError'));
  }
  Object.defineProperty(Document.prototype, 'cookie', { get: () => '', set() {} });

  const ATTRS = ['src', 'href', 'action', 'poster', 'data', 'formaction'];
  hook(Element.prototype, 'setAttribute', (g, t, [n, v]) =>
    g.call(t, n, ATTRS.includes(String(n).toLowerCase()) ? px(v) : v));
  for (const [C, p] of [[HTMLImageElement, 'src'], [HTMLScriptElement, 'src'],
    [HTMLLinkElement, 'href'], [HTMLAnchorElement, 'href'], [HTMLAreaElement, 'href'],
    [HTMLIFrameElement, 'src'], [HTMLFormElement, 'action'], [HTMLMediaElement, 'src'],
    [HTMLSourceElement, 'src'], [HTMLTrackElement, 'src'], [HTMLEmbedElement, 'src'],
    [HTMLObjectElement, 'data'], [HTMLInputElement, 'src'], [HTMLVideoElement, 'poster']]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, p);
    if (!d?.set) continue;
    Object.defineProperty(C.prototype, p, {
      ...d,
      get() { return unpx(d.get.call(this)); },
      set(v) { d.set.call(this, px(v)); },
    });
  }

  // Markup strings: parse in an inert <template>, rewrite attributes, serialize.
  const inner = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  const tpl = document.createElement('template');
  const fix = (html) => {
    inner.set.call(tpl, String(html));
    for (const el of tpl.content.querySelectorAll('*')) {
      for (const a of ATTRS) if (el.hasAttribute(a)) el.setAttribute(a, el.getAttribute(a));
    }
    return inner.get.call(tpl);
  };
  Object.defineProperty(Element.prototype, 'innerHTML', {
    ...inner, set(v) { inner.set.call(this, fix(v)); },
  });
  hook(Element.prototype, 'insertAdjacentHTML', (g, t, [p, h]) => g.call(t, p, fix(h)));

  // Script-driven navigation to a real URL (location.href = ...). Chromium only.
  window.navigation?.addEventListener('navigate', (e) => {
    const to = new URL(e.destination.url);
    if (!e.cancelable || to.origin === origin || !/^https?:$/.test(to.protocol)) return;
    e.preventDefault();
    location.href = px(to.href);
  });
})();
