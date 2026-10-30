# Kinlink (dev build)

Two browsers share one secret. The Host browser (extension) fetches URLs for the Client.
The Client never contacts the target site.

- Client: any browser, no install. Hosted page: https://shineshuai.github.io/kinlink/
- Host: Chrome/Edge/Brave with this extension (a plain page cannot fetch cross-origin).
- X -> outside: the in-X user is the Client (no install), the outside user is the Host.

## Test (two machines)
1. Host: `chrome://extensions` > Developer mode > Load unpacked > the folder with
   `manifest.json`. The app opens (later: puzzle icon > pin Kinlink).
2. Host tab: set "Serve requests" to "in background" (grant the permission), "Copy invite link",
   send the link. No Connect needed, the tab can be closed. (Or "in this tab": click Connect and
   keep the tab open, you see the log live. "off": this browser only browses.)
3. Client: open the invite link. It connects and offers by itself, nothing to click. The offer is
   re-sent for 60 s, so it does not matter which side is first.
4. The status line shows `signaling: 2/3 signaling servers | link: direct (srflx/srflx udp) |
   peer: build 0022, serving yes | remote: host off`. `link` is `direct`, `relay` or the ICE
   state; `remote` is `host allows`/`host off` (Client) or `off`/`allowed`/`in use` (Host). Then either:
   - "Open rendered": new tab at `.../kinlink/~/<url>`, a real page through the peer
     (hosted web page only; keep the app tab open). Typing `.../kinlink/~/example.com/` works too.
   - "Fetch via peer": script-free preview in this page (also works in the extension page).

Logs: bottom of each app tab ("Log", the "Copy" button copies status and log). The Host's log
is in the extension page. Extension errors: `chrome://extensions` > Kinlink > Errors.
After updating files: `chrome://extensions` > reload button on the Kinlink card, then reload the
open Kinlink tabs. This is required: Chrome reads the manifest (permissions) and the service worker
only at reload, the pages read the files every time. A page that finds another build in the
manifest says so in its log ("warning: the extension is build ..."). The extension needs
`webRequest`, `declarativeNetRequestWithHostAccess`, `offscreen`, `storage` and `debugger`
(remote browser) at install; optional: `webNavigation` and all sites, asked when you enable
serving or the remote browser.

If it does not connect (the log says where it stops):
- `signaling failed` / `0/3`: every broker is blocked or down. Open `diag.html?auto`; the broker
  list is `CFG.mqtt` in `src/diag.js` (`?mqtt=wss://a,wss://b` overrides it per page).
- Signaling ok, `no answer yet`: the other side is not connected, or uses another secret.
- `ice: failed` / link `failed`: no direct path between the two browsers. After 8 s (or at once
  on `failed`) both sides switch to the broker relay: status `link: relay`, slow but it works. The
  log prints `relay: ..` and, before that, `ice local: host .., srflx ..`, the pair states and a
  hint. `host 0` or `srflx 0` usually means a WebRTC privacy extension or policy. Both sides
  behind one public IP (e.g. two tabs on one machine) often fails: Chrome hides local IPs
  (mDNS) and many routers do not hairpin NAT. Test from two different networks.
- `stun: 3/5 answered: ..` in the log: only STUN servers that answer here go to WebRTC (one that
  never answers, e.g. google in China, left the gathering without a server-reflexive candidate).
  `diag.html` picks its server the same way.
- `client: restart (channel closed | link failed | no answer | no signaling server)`: the Client
  (and a Host started with Connect in "this tab") reopens a lost session by itself: Client
  offers again, the Host restarts for the new offer. Gaps grow 5, 10, 20, 40, 60 s while sessions
  die young (`src/supervise.js`). Connect or Offer takes over; the background Host always did
  this. An open remote browser or a running download ends with the old session.
- `link: ..` and `remote: ..` lines in the log say when the link or the remote browser state
  changes (the status line above the log has them, the Copy button copies both).
- Link `direct` or `relay` but `no hello`: one side runs old code. Reload the extension and all tabs.

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
Host tab: set "Serve requests" to "in background" (grants the host permission). An offscreen document (reason
WEB_RTC) then runs the Host with no tab open; the tab can be closed. It survives browser restarts
(`onStartup`). `src/supervise.js` reopens the session when the link or channel is gone, all
brokers are gone, or a new client offers (one client at a time: a new one replaces the old one).
The app tab then only shows status and log (message `bgstat`); set it to "off" to stop. The one-hop
executor runs in the service worker (`src/ext-port.js`: a Port, bodies as base64 chunks); the
app tab, when it is the Host, uses it too. Extension permissions since 0013: `offscreen`,
`storage` (the secret is kept in `chrome.storage.local`, unencrypted, like the one in
localStorage before). Open the `?mqtt=wss://..` override in the app tab to give the background
Host other brokers.

## Remote browser (opt-in, for sites that need real JavaScript)
"Open in remote browser" (Client): the Host's own Chrome loads the page in a popup window and the
Client sees it as a live picture and controls it with mouse, wheel and keyboard (paste and IME
text too). Nothing of that site runs in the Client's origin, only JPEG frames cross, so bot
checks, YouTube-style apps and heavy JS work as on the Host. It is slower and heavier than the
rewritten view: it needs a direct link (not the relay), and a window opens on the Host.
Host setup (extension page): reload the extension (it needs the permission `debugger` in the
manifest: Chrome does not allow it as an optional one), turn on "Allow in Incognito" for Kinlink in
`chrome://extensions`, then tick "allow the remote browser" (asks for `webNavigation`, which
catches new tabs of the remote page). It works with
"in this tab" and "in background". Client: Open in remote browser, status shows `remote: host allows`.
Parts: `src/remote-client.js` (viewer), `src/remote-host.js` (DataChannel <-> Port, keeps only the
newest frame, 2 frames in flight, acked by the viewer), `src/remote-sw.js` (the window, CDP
screencast and input), `src/remote.js` (protocol, input validation, URL policy).
Safety: the window is **incognito**, so the Client never sees the Host's logins. All incognito
windows of a profile share one cookie jar, so the remote browser refuses to start while another
Incognito window is open, ends when the Host opens one, and closing its window wipes the jar
(without "Allow in Incognito" it refuses; `chrome.storage.local` `remote.unsafeProfile` is a test-only escape). Only
http(s) pages; the same SSRF check as the fetch executor for typed URLs, plus six
declarativeNetRequest rules that block every request of that tab to private, loopback and
link-local addresses (also for navigations and redirects of the tab); a tab that still ends on a
disallowed URL is sent to about:blank; downloads are denied (CDP, not tested); new tabs and
popups (they open in the Host's normal window, outside the block rules) are closed at once and the
same tab navigates instead; one remote browser at a time. The tab is muted (no audio crosses; a screencast has none). Chrome shows its "is being
debugged" banner in that window, so the Host user sees it.
**The Host sees everything the Client does in that window** (pages, typed text, passwords shown),
and can click in it; closing it ends the session. It is a shared screen, not a hidden browser.
The rewritten view is no better: the Host fetches every URL and sees its cookies. Pair only with
people you trust. Known gaps: names that resolve to private IPs (as for fetch); camera, microphone
and location prompts of the page appear on the Host; copy to the Client clipboard, file upload
and drag and drop are missing; if the Host's screen is smaller than the viewport the picture is
cropped; if other windows cover it, Chrome may stop painting; the frame rate depends on the link:
the viewer's status line shows live frames per second, KB per second, KB per frame, and the
Host's JPEG quality (`q`, 25..60) and number of frames in flight (`window`, 2..8). The Host adapts
both from the Client's acks (`src/rbrate.js`): the window from the delay (1 frame per 50 ms, a
high RTT needs more frames in flight), then down when frames queue up; the quality down by 8 when
fewer than 10 frames/s get through while the page makes more, up by 4 after 5 calm seconds (a
quality change restarts the screencast, so >= 3 s apart). Not verified on a real slow link; the
resolution does not adapt yet, so below about 60 KB/s the picture stays slow. Tested in Chromium with the real extension (click,
typing, SSRF block, address bar, close, through the background Host); not tested over a real
network, with real sites, or on macOS and Windows.

## Brokers of one cluster (duplicates and our own messages)
The public brokers broker.emqx.io and broker-cn.emqx.io appear to be one cluster, and we publish
to every connected broker: each signaling message and relay frame arrives several times, and our
own messages come back through the other connection (the per-connection sender id does not match).
Handled in three places: `SealedAdapter` delivers identical sealed text once and never our own
copy, one message at a time; `Peer` ignores its own offer text (Chrome would roll back its offer
and answer it itself); `RelayChannel` drops repeated frame text before decrypting and ignores
frames with its own session id. Before 0017 the relay on those brokers opened with itself and the
direct connection could fail. The fake broker in the tests now behaves like that cluster.

## Same Wi-Fi, same public IP
Two machines behind one router often get no direct path: the browsers hide local addresses
behind mDNS names, access points can isolate clients, and the router would need NAT hairpinning.
ICE then ends `failed` after about 15 s. The relay opens before that (8 s), and the Host keeps the
session as long as a channel works, whatever ICE says. Status shows `link: relay` (slow but fine
for pages). Use two different networks to test the direct path.

## Relay fallback (`src/relay.js`)
If WebRTC finds no path (CGNAT, same NAT, UDP blocked), the same protocol runs over the signaling
brokers: frames sealed with a separate HKDF key, a small ARQ (sequence numbers, cumulative acks,
16-frame window, retransmit with backoff) makes the lossy, duplicating QoS 0 medium reliable and
ordered. `RelayChannel` looks like an RTCDataChannel to `Peer`/`proxy.js`, nothing above it changes.
Start: ICE `failed`, or `connecting` for 8 s (`?relay=<ms>` changes it, `?relay=0` forces it, and
`?ice=relay` blocks the direct path, both for tests), or the peer's OPEN frame arrives (then this
side joins). The relay stays `peer.dc`. A direct channel that comes up later is adopted: it takes
over sending as soon as every relay frame is acked (nothing can then arrive late, so no reordering),
and sending falls back to the relay if it closes. Status shows `link: direct` after the switch.
It happens at the next message after a pause, not in the middle of a long download. A frame goes to ONE
broker: the one the peer's last frame came from (the peer is subscribed there); retransmits, OPEN
and keepalives go to all connected brokers, so a broker that stays connected but drops costs one
retransmit, and both sides move to a broker that works (about 1x traffic instead of 3x). An idle open side
sends a keepalive every 15 s: if its peer restarted, the new session sees a frame it does not know,
joins and answers with OPEN, and both sides re-open. Expect tens of KB/s
and 100s of ms.

## What the Client does like a browser (`src/browse.js`, `src/cookies.js`)
The Host executes exactly one request hop and never follows redirects. The Client follows them
hop by hop (max 10), keeps the cookie jar (memory of the app tab, lost on reload), sends
Referer/Origin like a browser, and turns POST into GET after 303 (and 301/302). The extension
sets Cookie/Referer/Origin per request with declarativeNetRequest session rules and reads
Set-Cookie and Location with webRequest (`src/host-ext.js`), because fetch() can do neither.
The Host never uses its own cookies (`credentials: omit`) and its own cookie jar stays clean.
Each hop passes the Host's SSRF check. Request bodies up to 150 KiB, methods GET and POST.
Chrome's own http to https upgrade (HSTS) is an internal redirect: `fetch` shows it as an opaque
redirect and `webRequest` reports it only through `onBeforeRedirect` (no headers event), so the
executor also listens there and answers 307 + Location; it never returns status 0.

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
- `src/remote*.js`: remote browser (see above).
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
  unknown). A request times out after 30 s without a byte from the peer (90 s on the relay), or
  after 10 minutes in any case; slow but steady bodies survive. Brokers see room id, timing and
  volume. A malicious broker can replay
  old frames of an earlier session (needs per-session keys). No own WSS/TURN relay yet.
- Bodies are buffered (32 MiB max), no streaming.
- Compression: the Client asks for gzip (`req.ae`), the Host gzips text-like bodies (HTML, CSS,
  JS, JSON, XML, SVG, wasm, ttf/otf) as they cross: the browser has already decoded what the site
  sent, so without this a 300 KB script crossed as 300 KB. Images, video and woff/woff2 are sent
  as they are. The Client unzips with the same size limit as a plain body.
- Cache (`src/cache.js`): the Client keeps GET responses in memory (64 MiB, gone with the tab):
  fresh ones (`max-age`, `Expires`) answer without any request; stale ones with `ETag` /
  `Last-Modified` are revalidated (the Host passes `If-None-Match` / `If-Modified-Since`, a 304
  reuses the stored body); permanent redirects with a lifetime too. Not stored: `no-store`,
  Set-Cookie, `Vary: Cookie`, Range, bodies over 8 MiB, no heuristic lifetimes. The log shows
  `render 200 <url> <n> B (cached)` for a hit. Reload the tab to empty it.
