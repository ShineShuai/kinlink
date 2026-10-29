# Kinlink (dev build)

Two browsers share one secret. The Host browser (extension) fetches URLs for the Client.
The Client never contacts the target site.

- Client: any browser, no install. Hosted page: https://shineshuai.github.io/kinlink/
- Host: Chrome/Edge/Brave with this extension (a plain page cannot fetch cross-origin).
- X -> outside: the in-X user is the Client (no install), the outside user is the Host.

## Test (two machines)
1. Host: `chrome://extensions` > Developer mode > Load unpacked > the folder with
   `manifest.json`. The app opens (later: puzzle icon > pin Kinlink).
2. Host tab: "New secret", tick "serve requests" (grant), Connect,
   "Copy invite link", send the link.
3. Client: open the invite link. It connects and offers by itself, nothing to click. The offer is
   re-sent for 60 s, so it does not matter which side is first.
4. The status line shows `signaling: 2/3 signaling servers | link: connected | peer: build
   0013, serving yes`. Then either:
   - "Open rendered": new tab at `.../kinlink/~/<url>`, a real page through the peer
     (hosted web page only; keep the app tab open). Typing `.../kinlink/~/example.com/` works too.
   - "Fetch via peer": script-free preview in this page (also works in the extension page).

Logs: bottom of each app tab ("Log", the "Copy" button copies status and log). The Host's log
is in the extension page. Extension errors: `chrome://extensions` > Kinlink > Errors.
After updating files: `chrome://extensions` > reload button on the Kinlink card (re-reads the
folder), then reload the open Kinlink tabs. Since 0010 the extension asks for two more permissions
(`webRequest`, `declarativeNetRequestWithHostAccess`); accept them if Chrome asks.

If it does not connect (the log says where it stops):
- `signaling failed` / `0/3`: every broker is blocked or down. Open `diag.html?auto`; the broker
  list is `CFG.mqtt` in `src/diag.js` (`?mqtt=wss://a,wss://b` overrides it per page).
- Signaling ok, `no answer yet`: the other side is not connected, or uses another secret.
- `ice: failed` / link `failed`: no direct path between the two browsers. After 15 s (or at once
  on `failed`) both sides switch to the broker relay: status `link: relay`, slow but it works. The
  log prints `relay: ..` and, before that, `ice local: host .., srflx ..`, the pair states and a
  hint. `host 0` or `srflx 0` usually means a WebRTC privacy extension or policy. Both sides
  behind one public IP (e.g. two tabs on one machine) often fails: Chrome hides local IPs
  (mDNS) and many routers do not hairpin NAT. Test from two different networks.
- Link `connected` but `no hello`: one side runs old code. Reload the extension and all tabs.

Signaling is always MQTT (all brokers at once, nothing to choose). `?signaling=bc` is a dev-only
shortcut: BroadcastChannel between two tabs of one browser and one origin, no network; it is
never selected automatically.

Invite link base: field above the status line (extension page default: the hosted page; set
`http://localhost:8000/` to test with a local copy, served by `python3 -m http.server 8000`).

Corpus (needs internet, run locally): `python3 test/corpus.py` loads ~20 real sites through the
real extension and the rendering layer in one Chromium and writes `corpus-report/report.md` with a
PASS/WARN/FAIL per site and a screenshot. `python3 test/corpus.py https://my.site/ ...` for your
own list. This is the measurement for "is rewriting good enough?".

Diagnostics: `.../kinlink/diag.html?auto` runs the probes on load; "Copy JSON" for results.

## Background Host (`background.js`, `host.html`, `host.js`)
Host tab: tick "serve in background" (grants the host permission). An offscreen document (reason
WEB_RTC) then runs the Host with no tab open; the tab can be closed. It survives browser restarts
(`onStartup`). `src/supervise.js` reopens the session when the link or channel is gone, all
brokers are gone, or a new client offers (one client at a time: a new one replaces the old one).
The app tab then only shows status and log (message `bgstat`); untick to stop. The one-hop
executor runs in the service worker (`src/ext-port.js`: a Port, bodies as base64 chunks); the
app tab, when it is the Host, uses it too. Extension permissions since 0013: `offscreen`,
`storage` (the secret is kept in `chrome.storage.local`, unencrypted, like the one in
localStorage before). Open the `?mqtt=wss://..` override in the app tab to give the background
Host other brokers.

## Relay fallback (`src/relay.js`)
If WebRTC finds no path (CGNAT, same NAT, UDP blocked), the same protocol runs over the signaling
brokers: frames sealed with a separate HKDF key, a small ARQ (sequence numbers, cumulative acks,
16-frame window, retransmit with backoff) makes the lossy, duplicating QoS 0 medium reliable and
ordered. `RelayChannel` looks like an RTCDataChannel to `Peer`/`proxy.js`, nothing above it changes.
Start: ICE `failed`, or `connecting` for 15 s (`?relay=<ms>` changes it, `?relay=0` forces it, for
tests), or the peer's OPEN frame arrives (then this side joins). Once chosen it stays until
reconnect: a direct channel that opens later is wired for receiving only. Every frame goes to all
connected brokers (3x traffic, no single point of failure). Expect tens of KB/s and 100s of ms.

## What the Client does like a browser (`src/browse.js`, `src/cookies.js`)
The Host executes exactly one request hop and never follows redirects. The Client follows them
hop by hop (max 10), keeps the cookie jar (memory of the app tab, lost on reload), sends
Referer/Origin like a browser, and turns POST into GET after 303 (and 301/302). The extension
sets Cookie/Referer/Origin per request with declarativeNetRequest session rules and reads
Set-Cookie and Location with webRequest (`src/host-ext.js`), because fetch() can do neither.
The Host never uses its own cookies (`credentials: omit`) and its own cookie jar stays clean.
Each hop passes the Host's SSRF check. Request bodies up to 150 KiB, methods GET and POST.

## Rendering layer
`render-sw.js` (Service Worker) answers `~/<url>` requests: it asks the app tab over a
MessageChannel, the app tab asks the peer (`src/bridge.js`), `src/render.js` rewrites the
response (`src/rewrite.js`: HTML and CSS URLs, charset to UTF-8, redirects, injected `rt.js`).
`rt.js` hooks fetch/XHR/DOM setters/history in the page. The response carries a CSP that allows
only our own origin, so anything the rewriting misses fails closed instead of leaking.

## CI and deploy
`.github/workflows/ci.yml`: `test` (`npm test`) and `e2e` (`python3 test/e2e.py` and
`python3 test/e2e_ext.py`, Chromium) run
on every push and PR. Only on `main`, and only if both pass, `build` assembles `site/`
(`scripts/build-site.sh`) and `deploy` publishes it.
One-time: repo Settings > Pages > Source: **GitHub Actions** (public repo on the free plan).

Local: `npm test`, `bash scripts/build-site.sh`,
`pip install playwright && playwright install chromium && python3 test/e2e.py`.

## Files
- `index.html`, `app.js`: pairing UI and the viewers. `diag.html`: probes, echo/throughput test.
- `render-sw.js`, `rt.js`, `src/bridge.js`, `src/render.js`, `src/rewrite.js`: rendering layer.
- `src/proxy.js`: request/response protocol, SSRF guard. `src/browse.js`, `src/cookies.js`: Client
  side redirects, cookies. `src/host-ext.js`: the extension's one-hop executor.
- `src/p2p.js`: WebRTC peer. `src/relay.js`: broker relay channel and fallback trigger.
  `src/crypto.js`: HKDF, AES-GCM, SealedAdapter.
- `src/signaling.js`, `src/mqtt.js`: signaling adapters; `FanoutAdapter` uses all brokers at once. `src/diag.js`: probes and endpoint list.
- `manifest.json`, `background.js`: extension shell (opens `index.html`), executor port, offscreen
  control. `host.html`, `host.js`: background Host. `src/session.js`: one pairing session (used by
  `app.js` and `host.js`). `src/supervise.js`, `src/ext-port.js`: see above.
- `test/*.mjs`: unit tests (fake broker, fake RTCPeerConnection, lossy medium for `relay.mjs`). `test/e2e.py` (+ `harness.html`): browser test of rendering and pairing through a fake broker, also with the relay forced.
  `test/e2e_ext.py`: loads the real extension as Host, runs a cookie-consent flow and the
  background Host (no tab open, second client after the first left; real local WebSocket broker).
  `test/corpus.py`: the site corpus (manual, needs internet). `scripts/`: build.

## Known gaps
- Only GET and POST (body <= 150 KiB). `document.cookie` is stubbed: cookies set by scripts are
  lost. Cookie jar: no SameSite, no public suffix list, memory only.
- Sites with bot detection fail. Google's `/sorry` page (reCAPTCHA, "Invalid domain for site key")
  is one: the reCAPTCHA script reads `location.hostname`, which is our host, not google.com. This
  needs JS `location` fidelity (rewriting scripts), not built.
- JS is not rewritten, only hooked at run time. Not covered: `location.hostname` and friends
  (scripts see our host), `document.write`, dynamic `srcset`/`<style>`, static or dynamic
  `import` of absolute URLs, WebSocket. JS-heavy sites (e.g. google.com) may stay broken.
- Rendered pages share the app's origin. Pages cannot see, unregister or replace the Service
  Worker (hooked), and the app tab re-registers it within 5 s if it is removed anyway (localStorage, IndexedDB are shared between rendered
  sites). Mitigations: opened with `noopener`, secret kept in the app tab only, CSP fail-closed.
  After a Service Worker restart, a malicious page could race to announce itself as the app tab.
  Real fix: serve rendered pages from a dedicated origin.
- Script-driven `location.href = ...` is caught only in Chromium (Navigation API).
- Extension pages cannot register Service Workers: rendering is for the hosted page only.
- DNS names resolving to private IPs are not blocked; redirects are checked after the fact.
- Without background mode the Host tab must stay open. Background mode is tested in Chromium
  with the real extension, but not over days: offscreen document lifetime in real Chrome and
  the browser-restart path are unverified. Signaling needs both sides online (no retained
  messages). Only the Host's Chrome profile must be running.
- Relay: throughput on the real public brokers is not measured (their rate and size limits are
  unknown); a request times out after 30 s, so big bodies fail on it. No switch back to a direct
  path that comes up late. Brokers see room id, timing and volume. A malicious broker can replay
  old frames of an earlier session (needs per-session keys). No own WSS/TURN relay yet.
- Bodies are buffered (32 MiB max), no streaming.
