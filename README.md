# Kinlink (dev build)

Two browsers share one secret. The Host browser (extension) fetches URLs for the Client.
The Client never contacts the target site.

## Quick test (Chrome/Edge/Brave, one machine, no server)
1. `chrome://extensions` > Developer mode > Load unpacked > select the folder that contains
   `manifest.json`. A tab with `app.html` opens. Later: puzzle icon > pin Kinlink > click it,
   or open `chrome-extension://<ID>/app.html` (ID is on the extension card).
2. Tab 1 (Host): mode `bc`, "New secret", tick "serve requests" (grant), Connect.
3. Tab 2 (Client): open the same `chrome-extension://<ID>/app.html` address (copy it from
   tab 1). Same secret, mode `bc`, Connect, then Offer. Use "Fetch via peer" in this tab
   only. The status line shows the peer's build and whether it serves.
4. Log shows `dc: open`. Click "Fetch via peer" with `https://example.com/`.

Two machines: mode `mqtt` on both. The Client can be any browser: run
`python3 -m http.server 8000` inside the folder with `app.html`, open
`http://localhost:8000/app.html`. A 404 there means the server runs in the wrong folder.

## Files
- `app.html`, `app.js`: pairing UI and the fetch viewer.
- `src/proxy.js`: request/response protocol, SSRF guard.
- `src/p2p.js`: WebRTC peer. `src/crypto.js`: HKDF, AES-GCM, SealedAdapter.
- `src/signaling.js`, `src/mqtt.js`: signaling adapters.
- `index.html`, `src/diag.js`: M0 probes and echo/throughput test.
- `test/*.mjs`: `node test/m1.mjs && node test/proxy.mjs`.

## Known gaps
- GET only, no cookies, no request bodies, HTML shown as a script-free preview.
- DNS names resolving to private IPs are not blocked; redirects are checked after the fact.
- Host tab must stay open. Signaling needs both sides online (no retained messages).
- No WSS relay fallback yet.
