# Kinlink (dev build)

Two browsers share one secret. The Host browser (extension) fetches URLs for the Client.
The Client never contacts the target site.

- Client: any browser, no install. Hosted page: https://shineshuai.github.io/kinlink/
- Host: Chrome/Edge/Brave with this extension (a plain page cannot fetch cross-origin).
- X -> outside: the in-X user is the Client (no install), the outside user is the Host.

## Test (two machines)
1. Host: `chrome://extensions` > Developer mode > Load unpacked > the folder with
   `manifest.json`. The app opens (later: puzzle icon > pin Kinlink).
2. Host tab: mode `mqtt`, "New secret", tick "serve requests" (grant), Connect,
   "Copy invite link", send the link.
3. Client: open the invite link. It connects and offers by itself, nothing to click. The offer is
   re-sent for 60 s, so it does not matter which side is first.
4. The status line shows `signaling: 2/3 signaling servers | link: connected | peer: build
   0008, serving yes`. Then either:
   - "Open rendered": new tab at `.../kinlink/~/<url>`, a real page through the peer
     (hosted web page only; keep the app tab open). Typing `.../kinlink/~/example.com/` works too.
   - "Fetch via peer": script-free preview in this page (also works in the extension page).

If it does not connect (the log says where it stops):
- `signaling failed` / `0/3`: every broker is blocked or down. Open `diag.html?auto`; the broker
  list is `CFG.mqtt` in `src/diag.js` (`?mqtt=wss://a,wss://b` overrides it per page).
- Signaling ok, `no answer yet`: the other side is not connected, or uses another secret.
- `ice: failed` / link `failed`: the two networks cannot reach each other directly
  (needs a TURN/relay, not built yet).
- Link `connected` but `no hello`: one side runs old code. Reload the extension and all tabs.

One machine, offline: mode `bc` in two tabs of the same address (extension page or
`python3 -m http.server 8000` > `http://localhost:8000/`). `bc` does not work across origins.

Diagnostics: `.../kinlink/diag.html?auto` runs the probes on load; "Copy JSON" for results.

## Rendering layer
`render-sw.js` (Service Worker) answers `~/<url>` requests: it asks the app tab over a
MessageChannel, the app tab asks the peer (`src/bridge.js`), `src/render.js` rewrites the
response (`src/rewrite.js`: HTML and CSS URLs, charset to UTF-8, redirects, injected `rt.js`).
`rt.js` hooks fetch/XHR/DOM setters/history in the page. The response carries a CSP that allows
only our own origin, so anything the rewriting misses fails closed instead of leaking.

## CI and deploy
`.github/workflows/ci.yml`: `test` (`npm test`) and `e2e` (`python3 test/e2e.py`, Chromium) run
on every push and PR. Only on `main`, and only if both pass, `build` assembles `site/`
(`scripts/build-site.sh`) and `deploy` publishes it.
One-time: repo Settings > Pages > Source: **GitHub Actions** (public repo on the free plan).

Local: `npm test`, `bash scripts/build-site.sh`,
`pip install playwright && playwright install chromium && python3 test/e2e.py`.

## Files
- `index.html`, `app.js`: pairing UI and the viewers. `diag.html`: probes, echo/throughput test.
- `render-sw.js`, `rt.js`, `src/bridge.js`, `src/render.js`, `src/rewrite.js`: rendering layer.
- `src/proxy.js`: request/response protocol, SSRF guard.
- `src/p2p.js`: WebRTC peer. `src/crypto.js`: HKDF, AES-GCM, SealedAdapter.
- `src/signaling.js`, `src/mqtt.js`: signaling adapters; `FanoutAdapter` uses all brokers at once. `src/diag.js`: probes and endpoint list.
- `manifest.json`, `background.js`: extension shell (opens `index.html`).
- `test/*.mjs`: unit tests (fake broker, fake RTCPeerConnection). `test/e2e.py`, `test/harness.html`: browser test (rendering, and pairing through a fake broker). `scripts/`: build.

## Known gaps
- GET only, no cookies (`document.cookie` is stubbed), no request bodies (forms must be GET).
- JS is not rewritten, only hooked at run time. Not covered: `location.hostname` and friends
  (scripts see our host), `document.write`, dynamic `srcset`/`<style>`, static or dynamic
  `import` of absolute URLs, WebSocket. JS-heavy sites (e.g. google.com) may stay broken.
- Rendered pages share the app's origin (localStorage, IndexedDB are shared between rendered
  sites). Mitigations: opened with `noopener`, secret kept in the app tab only, CSP fail-closed.
  After a Service Worker restart, a malicious page could race to announce itself as the app tab.
  Real fix: serve rendered pages from a dedicated origin.
- Script-driven `location.href = ...` is caught only in Chromium (Navigation API).
- Extension pages cannot register Service Workers: rendering is for the hosted page only.
- DNS names resolving to private IPs are not blocked; redirects are checked after the fact.
- Host tab must stay open. Signaling needs both sides online (no retained messages).
- No WSS relay fallback yet. Bodies are buffered (32 MiB max), no streaming.
