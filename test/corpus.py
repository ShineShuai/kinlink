"""Run: python3 test/corpus.py [--wait 6] [--out corpus-report] [url ...]
     python3 test/corpus.py --join SECRET [--base URL] [--mqtt URLS] [--headed] [url ...]
Loads each site through Kinlink's rendering layer (Client) and writes <out>/report.md with a
verdict, details and a screenshot per site. Needs internet. This is the plan's "20-site corpus":
the measured pass rate decides whether rewriting is good enough or a different approach is needed.

Default: ONE Chromium on this machine is both Host (the real extension) and Client. The Host's
network is this machine's network and the Client-Host link is local, so this measures what the
rewriting can render, not a China path.
--join: Client only. Joins a Host that runs elsewhere (secret from its page, the Host in
"background" mode is fine) over the real brokers and renders the corpus over that link. Run this
on the machine in China, with the Host abroad, to measure the real path (reachability, speed,
relay). --base is the Client site (default: the public one), --mqtt overrides the brokers.

Verdict: PASS = HTTP 200, >= 300 characters of text, <= 20% failed requests, <= 5 requests blocked
by the CSP (they escaped the rewriting); WARN = loaded but failed one of those; BLOCK = a bot
check (CAPTCHA, JS challenge, HTTP 202/403/429, "unusual traffic"): rewriting cannot pass these,
the remote browser could; FAIL = no page or another HTTP error. Always look at the screenshots:
text can hide a broken layout.
Env: KINLINK_RESOLVER="MAP *.test 127.0.0.1:8080" extends --host-resolver-rules (own test sites;
the Host's Chromium)."""
import argparse, json, os, pathlib, re, shutil, sys, tempfile, time
from collections import Counter
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

BLOCK_URL = re.compile(r"/sorry/|js_challenge|captcha|/challenge|cdn-cgi/", re.I)
BLOCK_TEXT = re.compile(
    r"unusual traffic|verify you are (a )?human|are you a robot|captcha|checking your browser"
    r"|just a moment|bots use|access denied|automated (queries|access)"
    r"|enable javascript and cookies", re.I)

ap = argparse.ArgumentParser()
ap.add_argument("urls", nargs="*")
ap.add_argument("--wait", type=float, default=6, help="seconds to let scripts run after load")
ap.add_argument("--out", default="corpus-report")
ap.add_argument("--join", metavar="SECRET", help="Client only: join the Host that has this secret")
ap.add_argument("--base", default="https://shineshuai.github.io/kinlink", help="with --join")
ap.add_argument("--mqtt", help="with --join: comma-separated broker URLs (default: the app's)")
ap.add_argument("--headed", action="store_true", help="show the browser")
args = ap.parse_args()
urls = args.urls or CORPUS
out = pathlib.Path(args.out)
shutil.rmtree(out, ignore_errors=True)
out.mkdir(parents=True)

if args.join:
    srv, base = None, args.base.rstrip("/")
else:
    tmp, srv, base = build_site()
    ext = pathlib.Path(tempfile.mkdtemp(prefix="kinlink-ext-")) / "ext"
    shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns(".git", "node_modules", "site", "test"))
    manifest = json.loads((ext / "manifest.json").read_text())
    manifest["host_permissions"] = ["<all_urls>"]
    manifest.pop("optional_host_permissions", None)
    (ext / "manifest.json").write_text(json.dumps(manifest))
R = f"{base}/~/"
status = "document.getElementById('status').textContent"


def until(page, needle, secs=60):
    """Polled: extension pages forbid the eval behind wait_for_function (CSP script-src 'self')."""
    for _ in range(secs * 5):
        if needle in page.evaluate(status):
            return
        page.wait_for_timeout(200)
    raise TimeoutError(f"status never had {needle!r}: {page.evaluate(status)}\n"
                       + page.inner_text("#log"))


def short(u, n=100):
    u = u.split("?")[0].split("#")[0]
    return u if len(u) <= n else u[:n] + "..."


def top(items, n=5):
    return [f"{k} (x{c})" if c > 1 else k for k, c in Counter(items).most_common(n)]


rows = []
with sync_playwright() as p:
    flags = ["--no-sandbox"]
    if not args.join:
        flags += [f"--disable-extensions-except={ext}", f"--load-extension={ext}",
                  "--allow-loopback-in-peer-connection",
                  "--disable-features=WebRtcHideLocalIpsWithMdns"]
    if os.environ.get("KINLINK_RESOLVER"):
        flags.append(f"--host-resolver-rules={os.environ['KINLINK_RESOLVER']}")
    ctx = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(), channel="chromium", headless=not args.headed, args=flags,
        viewport={"width": 1280, "height": 800})
    ctx.set_default_timeout(60000)
    if args.join:
        secret = args.join
        q = f"?mqtt={args.mqtt}" if args.mqtt else ""
    else:
        ctx.route_web_socket(re.compile(r"wss://good\.test/.*"), Broker().handle)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        q = "?mqtt=wss://good.test/mqtt"
        host = ctx.new_page()
        host.goto(f"chrome-extension://{sw.url.split('/')[2]}/index.html{q}")
        secret = host.input_value("#secret")
        host.click("#connect")
        until(host, "1/1 signaling")
    client = ctx.new_page()
    client.goto(f"{base}/index.html{q}#{secret}")
    until(client, "serving yes", 120 if args.join else 60)
    mode = f"join {base}" if args.join else "local Host (this machine's network)"
    print(f"paired ({mode}); {len(urls)} sites, {args.wait}s each after load", flush=True)

    for i, url in enumerate(urls, 1):
        view = ctx.new_page()
        n = {"ok": 0, "bad": 0}
        leaks, failed, badurls, errors = [], [], [], []

        def on_response(r):
            if not r.url.startswith(R):
                return
            n["ok" if r.status < 400 else "bad"] += 1
            if r.status >= 400:
                badurls.append(f"{r.status} {short(r.url[len(R):])}")

        def on_failed(r):
            why = r.failure or ""
            (leaks if "csp" in why.lower() else failed).append(f"{short(r.url)} [{why}]"[:140])

        view.on("response", on_response)
        view.on("requestfailed", on_failed)
        view.on("console", lambda m: errors.append(m.text[:140]) if m.type == "error" else None)
        view.on("pageerror", lambda e: errors.append(str(e)[:140]))
        code, final, text, err, sample = None, url, 0, "", ""
        t0 = time.time()
        try:
            resp = view.goto(f"{R}{url}", timeout=45000)
            code = resp.status if resp else None
            ms = int((time.time() - t0) * 1000)
            view.wait_for_timeout(int(args.wait * 1000))
        except Exception as e:  # timeouts, net errors
            err = str(e).splitlines()[0][:100]
            ms = int((time.time() - t0) * 1000)
        final = view.url[len(R):] if view.url.startswith(R) else view.url
        for _ in range(3):  # a script may navigate: the context is destroyed, ask again
            try:
                sample = view.evaluate("document.body ? document.body.innerText : ''")
                break
            except Exception:
                view.wait_for_timeout(1500)
        text = len(sample)
        shot = f"{i:02d}-{re.sub(r'[^a-z0-9]+', '-', url.lower())[:40]}.png"
        try:
            view.screenshot(path=str(out / shot))
        except Exception:
            shot = ""
        total = n["ok"] + n["bad"]
        ratio = n["bad"] / total if total else 1
        hit = BLOCK_URL.search(final) or BLOCK_TEXT.search(sample[:3000])
        reason = (f"HTTP {code}" if code in (202, 403, 429)
                  else f"matched \"{hit.group(0)}\"" if hit else "")
        blocked = bool(reason)
        if code is None or (code >= 400 and not blocked):
            verdict = "FAIL"
        elif blocked:
            verdict = "BLOCK"
        else:
            verdict = ("PASS" if code == 200 and text >= 300 and ratio <= 0.2 and len(leaks) <= 5
                       else "WARN")
        rows.append(dict(verdict=verdict, url=url, code=code, err=err, final=final, text=text,
                         ok=n["ok"], bad=n["bad"], errors=errors, leaks=leaks, failed=failed,
                         badurls=badurls, shot=shot, ms=ms, reason=reason,
                         snippet=" ".join(sample.split())[:140]))
        print(f"{verdict:5} {url}  status={code} {ms} ms text={text} requests ok/bad="
              f"{n['ok']}/{n['bad']} js-errors={len(errors)} csp-blocked={len(leaks)} {err}",
              flush=True)
        view.close()
    ctx.close()

count = Counter(r["verdict"] for r in rows)
lines = [f"# Kinlink corpus: {count['PASS']}/{len(rows)} PASS, {count['BLOCK']} BLOCK, "
         f"{count['WARN']} WARN, {count['FAIL']} FAIL", "",
         f"Mode: {mode}. {time.strftime('%Y-%m-%d %H:%M')}. BLOCK = bot check (CAPTCHA, "
         "challenge, 202/403/429): needs the remote browser, not better rewriting.", "",
         "| verdict | site | status | ms | final url | text chars | requests ok/bad | JS errors "
         "| CSP-blocked | screenshot |", "|---|---|---|---|---|---|---|---|---|---|"]
for r in rows:
    final = short(r["final"], 80) if r["final"] != r["url"] else ""
    shot = "[png](" + r["shot"] + ")" if r["shot"] else ""
    lines.append(f"| {r['verdict']} | {r['url']} | {r['code']} {r['err']} | {r['ms']} | {final} "
                 f"| {r['text']} | {r['ok']}/{r['bad']} | {len(r['errors'])} | {len(r['leaks'])} "
                 f"| {shot} |")
lines += ["", "## Details", "", "Per site: what escaped the rewriting (CSP-blocked), what failed,",
          "which rendered requests got an error status, the first JS errors.", ""]
for r in rows:
    if r["verdict"] == "PASS" and not r["leaks"] and len(r["errors"]) < 5:
        continue
    lines.append(f"### {r['verdict']} {r['url']}")
    if r["reason"]:
        lines.append(f"- bot check: {r['reason']}")
    if r["verdict"] != "PASS" and r["snippet"]:
        lines.append(f"- page text: {r['snippet']}")
    for label, items, k in (("CSP-blocked", r["leaks"], 5), ("failed", r["failed"], 5),
                            ("HTTP errors", r["badurls"], 5), ("JS errors", r["errors"], 3)):
        if items:
            lines.append(f"- {label} ({len(items)}): " + "; ".join(top(items, k)))
    lines.append("")
(out / "report.md").write_text("\n".join(lines) + "\n")
print(f"\n{count['PASS']}/{len(rows)} PASS -> {out}/report.md")
if srv:
    srv.shutdown()
