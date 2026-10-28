// App-tab side of the rendering layer: registers the Service Worker and answers its
// requests through the peer. Web page only: extension pages cannot register Service Workers.
export const canRender = () => 'serviceWorker' in navigator && location.protocol.startsWith('http')
  && !globalThis.chrome?.runtime?.id;
export const renderedUrl = (url) => new URL(`~/${url}`, new URL('.', location.href)).href;

// getBrowse() -> { fetch(url, { method, headers, body, referer }) } (see browse.js) or undefined.
export async function startBridge(getBrowse, onlog = () => {}) {
  const sw = navigator.serviceWorker;
  await sw.register('render-sw.js', { type: 'module' });
  const beat = async () => (await sw.ready).active?.postMessage({ type: 'beat' });
  sw.onmessage = async ({ data, ports: [port] }) => {
    if (data?.type === 'who') return beat();
    if (data?.type !== 'req') return;
    try {
      const b = getBrowse();
      if (!b) throw new Error('app tab has no peer: Connect first');
      const { url, method, headers, referer } = data;
      const r = await b.fetch(url, { method, headers, body: data.body, referer });
      const bytes = await r.body.arrayBuffer();
      onlog(`render ${r.status} ${url} ${bytes.byteLength} B`);
      port.postMessage({ status: r.status, url: r.url, headers: r.headers, body: bytes }, [bytes]);
    } catch (e) {
      onlog(`render err ${data.url}: ${e.message}`);
      port.postMessage({ error: e.message });
    }
  };
  setInterval(beat, 5000); // real-time connections are exempt from timer throttling
  await beat();
}
