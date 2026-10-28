"""Run: python3 test/e2e.py   (pip install playwright; playwright install chromium)
Real Chromium, real Service Worker, fake peer: checks the rendering layer end to end."""
import functools, http.server, pathlib, shutil, subprocess, tempfile, threading
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
tmp = pathlib.Path(tempfile.mkdtemp(prefix="kinlink-e2e-"))
subprocess.run(["bash", str(ROOT / "scripts/build-site.sh"), str(tmp / "kinlink")], check=True,
               capture_output=True)
shutil.copy(ROOT / "test/harness.html", tmp / "kinlink/harness.html")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(tmp)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_port}/kinlink"
R = f"{base}/~/"


def check(cond, msg):
    assert cond, msg
    print("ok  ", msg)


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])  # containers run as root
    ctx = browser.new_context()
    ctx.set_default_timeout(15000)
    hosts, failed, console = set(), {}, []
    ctx.on("response", lambda r: hosts.add(r.url.split("/")[2]))  # who actually answered
    ctx.on("requestfailed", lambda r: failed.update({r.url.split("/")[2]: r.failure}))

    app = ctx.new_page()
    app.goto(f"{base}/harness.html")
    app.evaluate("navigator.serviceWorker.ready")
    app.wait_for_timeout(300)  # first beat

    view = ctx.new_page()
    view.on("console", lambda m: console.append(m.text))
    view.goto(f"{R}https://site.test/")
    view.wait_for_function("document.title === 'js ran'")
    check(True, "page, stylesheet and script came through the peer and ran")
    view.wait_for_function("document.body.dataset.api === 'api ok'")
    check(True, "fetch('/api') hook goes through the peer")
    hits = app.evaluate("hits")
    for u in ["https://site.test/s.css", "https://site.test/i.png", "https://other.test/px.png"]:
        check(u in hits, f"peer served {u}")
    check(any("Content Security Policy" in m for m in console), "CSP blocked unhooked leak")
    check(hosts == {f"127.0.0.1:{srv.server_port}"}, f"only our origin answered: {hosts}")
    check("csp" in failed.get("leak.test", "").lower(), f"leak attempt failed closed: {failed}")

    view.click("#l")
    view.wait_for_selector("#n")
    check(view.url == f"{R}https://site.test/next", f"link click stays rendered: {view.url}")

    resp = view.goto(f"{R}https://site.test/old")
    check(view.url == f"{R}https://site.test/", f"redirect lands on final url: {view.url}")
    resp = view.goto(f"{R}site.test/next")
    check(view.url == f"{R}https://site.test/next", "scheme-less url is canonicalised")

    cdp = ctx.new_cdp_session(app)
    cdp.send("ServiceWorker.enable")
    cdp.send("ServiceWorker.stopAllWorkers")
    resp = view.goto(f"{R}https://site.test/next")
    check(resp.status == 200, "service worker restart: app tab re-announces itself")

    app.close()
    resp = view.goto(f"{R}https://site.test/next")
    check(resp.status == 502 and "no connected" in view.content(), "no app tab -> 502 page")
    browser.close()
srv.shutdown()
shutil.rmtree(tmp)
print("e2e ok")
