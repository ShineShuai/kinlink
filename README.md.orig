# Kinlink (dev build)

Two browsers share one secret. The Host browser (extension) fetches URLs for the Client.
The Client never contacts the target site.

- Client: any browser, no install. Hosted page: https://shineshuai.github.io/kinlink/
- Host: Chrome/Edge/Brave with this extension (a plain page cannot fetch cross-origin).
- X -> outside: the in-X user is the Client (no install), the outside user is the Host.

## Deploy the Client page
GitHub repo > Settings > Pages > Deploy from a branch > `main` / `/ (root)` (public repo).
The repo root is served as is: `index.html` (app), `diag.html` (network diagnostics).

## Test (two machines)
1. Host: `chrome://extensions` > Developer mode > Load unpacked > the folder with
   `manifest.json`. The app opens (later: puzzle icon > pin Kinlink).
2. Host tab: mode `mqtt`, "New secret", tick "serve requests" (grant), Connect,
   "Copy invite link", send the link.
3. Client: open the invite link (`.../kinlink/#<secret>`), mode `mqtt`, Connect, Offer.
   The status line shows the peer's build and whether it serves.
4. Log shows `dc: open`. "Fetch via peer" with `https://example.com/`.

One machine, offline: mode `bc` in two tabs of the same address (extension page or
`python3 -m http.server 8000` > `http://localhost:8000/`). `bc` does not work across origins.

Diagnostics: `.../kinlink/diag.html?auto` runs the probes on load; "Copy JSON" for results.

## Files
- `index.html`, `app.js`: pairing UI and the fetch viewer.
- `diag.html`: reachability probes (STUN/WSS/HTTPS/NAT) and P2P echo/throughput test.
- `src/proxy.js`: request/response protocol, SSRF guard.
- `src/p2p.js`: WebRTC peer. `src/crypto.js`: HKDF, AES-GCM, SealedAdapter.
- `src/signaling.js`, `src/mqtt.js`: signaling adapters. `src/diag.js`: probes and endpoint list.
- `manifest.json`, `sw.js`: extension shell (opens `index.html`).
- `test/*.mjs`: `node test/signaling.mjs && node test/proxy.mjs`.

## Known gaps
- GET only, no cookies, no request bodies. HTML is a script-free, subresource-free preview,
  so JS-only pages (e.g. google.com) show their `<noscript>` fallback. Needs the
  Service Worker rewriting layer.
- DNS names resolving to private IPs are not blocked; redirects are checked after the fact.
- Host tab must stay open. Signaling needs both sides online (no retained messages).
- No WSS relay fallback yet.
