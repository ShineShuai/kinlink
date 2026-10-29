import { fromB64, toB64 } from './proxy.js';

// The one-hop executor (src/host-ext.js) lives in the service worker: it has the
// declarativeNetRequest and webRequest APIs, offscreen documents and plain pages have not.
// Callers reach it over a runtime Port (JSON only, so bodies travel as base64 chunks):
//   -> { url, method, headers, cookie, referer, origin, body(b64) }
//   <- { head: {status, url, headers, setCookies, location} } { chunk: b64 }* { end } | { error }
const CHUNK = 48 * 1024;

// Client side: same contract as host-ext.js exec(); the body is a stream.
export function execViaPort(req, connect = () => chrome.runtime.connect({ name: 'exec' })) {
  const port = connect();
  return new Promise((ok, fail) => {
    let ctl;
    let state = 'wait'; // wait -> head -> done
    const body = new ReadableStream({
      start: (c) => { ctl = c; },
      cancel: () => { state = 'done'; port.disconnect(); }, // aborts the fetch in the worker
    });
    const finish = (err) => {
      if (state === 'wait') fail(err);
      else if (state === 'head') { if (err) ctl.error(err); else ctl.close(); }
      state = 'done';
    };
    port.onMessage.addListener((m) => {
      if (state === 'done') return;
      if (m.head) { state = 'head'; ok({ ...m.head, body }); }
      else if (m.chunk) ctl.enqueue(fromB64(m.chunk));
      else if (m.end) { finish(); port.disconnect(); }
      else if (m.error) { finish(new Error(m.error)); port.disconnect(); }
    });
    port.onDisconnect.addListener(() => state !== 'done'
      && finish(new Error('service worker closed the port')));
    const { body: data, ...rest } = req;
    port.postMessage({ ...rest, body: data?.byteLength ? toB64(data) : undefined });
  });
}

// Service worker side: one request per port; a closed port aborts the fetch.
export function servePort(port, exec) {
  const ac = new AbortController();
  port.onDisconnect.addListener(() => ac.abort());
  const send = (m) => { try { port.postMessage(m); } catch { /* the caller is gone */ } };
  port.onMessage.addListener(async (m) => {
    try {
      const r = await exec({ ...m, body: m.body ? fromB64(m.body) : undefined, signal: ac.signal });
      const { status, url, headers, setCookies, location } = r;
      send({ head: { status, url, headers, setCookies, location } });
      const rd = r.body?.getReader();
      while (rd) {
        if (ac.signal.aborted) return void rd.cancel().catch(() => {}); // the caller left
        const { done, value } = await rd.read();
        if (done) break;
        for (let i = 0; i < value.length; i += CHUNK) {
          send({ chunk: toB64(value.subarray(i, i + CHUNK)) });
        }
      }
      send({ end: true });
    } catch (e) {
      send({ error: e.message });
    }
  });
}
