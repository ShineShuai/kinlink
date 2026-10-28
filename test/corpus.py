"""Run: python3 test/corpus.py [--wait 6] [--out corpus-report] [url ...]
Loads each site through the real extension (Host) and the rendering layer (Client) in one Chromium
and writes <out>/report.md with a verdict and a screenshot per site. Needs internet.
This is the plan's "20-site corpus": the measured pass rate decides whether rewriting is good
enough or a different approach is needed.
Verdict: PASS = HTTP 200, >= 300 characters of text, <= 20% failed requests; WARN = loaded but
failed one of those; FAIL = no page or an HTTP error. Always look at the screenshots: text can hide a broken layout.
Env: KINLINK_RESOLVER="MAP *.test 127.0.0.1:8080" extends --host-resolver-rules (own test sites)."""
import argparse, json, os, pathlib, re, shutil, sys, tempfile
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from support import ROOT, Broker, build_site

CORPUS = [  # static / reference
    "https://example.com/", "https://en.wikipedia.org/wiki/Main_Page", "https://de.wikipedia.org/",
    "https://news.ycombinator.com/", "https://text.npr.org/", "https://lite.cnn.com/",
    "https://developer.mozilla.org/en-US/", "https://html.duckduckgo.com/html/?q=kinlink",
    # news / portals
    "https://www.bbc.com/news", "https://www.theguardian.com/international",
    "https://www.nytimes.com/", "https://de.yahoo.com/", "https://de.finance.yahoo.com/",
    # apps
    "https://github.com/", "https://stackoverflow.com/questions", "https://www.reddit.com/",
    "https://www.bing.com/search?q=kinlink", "https://www.google.com/search?q=kinlink",
    "https://www.youtube.com/", "https://x.com/",
]

ap = argparse.ArgumentParser()
ap.add_argument("urls", nargs="*")
ap.add_argument("--wait", type=float, default=6, help="seconds to let scripts run after load")
ap.add_argument("--out", default="corpus-report")
args = ap.parse_args()
urls = args.urls or CORPUS
out = pathlib.Path(args.out)
shutil.rmtree(out, ignore_errors=True)
out.mkdir(parents=True)

tmp, srv, base = build_site()
R = f"{base}/~/"
ext = pathlib.Path(tempfile.mkdtemp(prefix="kinlink-ext-")) / "ext"
shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns(".git", "node_modules", "site", "test"))
manifest = json.loads((ext / "manifest.json").read_text())
manifest["host_permissions"] = ["<all_urls>"]
manifest.pop("optional_host_permissions", None)
(ext / "manifest.json").write_text(json.dumps(manifest))

rows = []
with sync_playwright() as p:
    flags = ["--no-sandbox", f"--disable-extensions-except={ext}", f"--load-extension={ext}",
             "--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns"]
    if os.environ.get("KINLINK_RESOLVER"):
        flags.append(f"--host-resolver-rules={os.environ['KINLINK_RESOLVER']}")
    ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), channel="chromium", headless=True,
                                               args=flags, viewport={"width": 1280, "height": 800})
    ctx.set_default_timeout(60000)
    ctx.route_web_socket(re.compile(r"wss://good\.test/.*"), Broker().handle)
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    status = "document.getElementById('status').textContent"
    q = "?mqtt=wss://good.test/mqtt"
    host = ctx.new_page()
    host.goto(f"chrome-extension://{sw.url.split('/')[2]}/index.html{q}")
    secret = host.input_value("#secret")
    host.click("#connect")
    host.wait_for_function(f"{status}.includes('1/1 signaling')")
    client = ctx.new_page()
    client.goto(f"{base}/index.html{q}#{secret}")
    client.wait_for_function(f"{status}.includes('serving yes')")
    print(f"paired; {len(urls)} sites, {args.wait}s each after load", flush=True)

    for i, url in enumerate(urls, 1):
        view = ctx.new_page()
        counts = {"ok": 0, "bad": 0, "leaks": 0, "errors": 0}

        def on_response(r):
            if r.url.startswith(R):
                counts["ok" if r.status < 400 else "bad"] += 1

        view.on("response", on_response)
        view.on("requestfailed", lambda r: counts.__setitem__("leaks", counts["leaks"] + ("csp" in (r.failure or "").lower())))
        view.on("console", lambda m: counts.__setitem__("errors", counts["errors"] + (m.type == "error")))
        view.on("pageerror", lambda e: counts.__setitem__("errors", counts["errors"] + 1))
        code, final, text, err = None, url, 0, ""
        try:
            resp = view.goto(f"{R}{url}", timeout=45000)
            code = resp.status if resp else None
            view.wait_for_timeout(int(args.wait * 1000))
            final = view.url[len(R):] if view.url.startswith(R) else view.url
            text = view.evaluate("document.body ? document.body.innerText.length : 0")
        except Exception as e:  # timeouts etc.
            err = str(e).splitlines()[0][:80]
        shot = f"{i:02d}-{re.sub(r'[^a-z0-9]+', '-', url.lower())[:40]}.png"
        try:
            view.screenshot(path=str(out / shot))
        except Exception:
            shot = ""
        total = counts["ok"] + counts["bad"]
        ratio = counts["bad"] / total if total else 1
        verdict = "FAIL" if code is None or code >= 400 else (
            "PASS" if code == 200 and text >= 300 and ratio <= 0.2 else "WARN")
        rows.append((verdict, url, code, final, text, counts["ok"], counts["bad"], counts["errors"], counts["leaks"], shot, err))
        print(f"{verdict:4} {url}  status={code} text={text} requests ok/bad={counts['ok']}/{counts['bad']} "
              f"js-errors={counts['errors']} {err}", flush=True)
        view.close()
    ctx.close()

passed = sum(r[0] == "PASS" for r in rows)
lines = [f"# Kinlink corpus: {passed}/{len(rows)} PASS", "",
         "| verdict | site | status | final url | text chars | requests ok/bad | JS errors | CSP-blocked | screenshot |",
         "|---|---|---|---|---|---|---|---|---|"]
for v, url, code, final, text, ok_, bad_, errs, leaks_, shot, err in rows:
    lines.append(f"| {v} | {url} | {code} {err} | {final if final != url else ''} | {text} | {ok_}/{bad_} | "
                 f"{errs} | {leaks_} | {'[png](' + shot + ')' if shot else ''} |")
(out / "report.md").write_text("\n".join(lines) + "\n")
print(f"\n{passed}/{len(rows)} PASS -> {out}/report.md")
srv.shutdown()
