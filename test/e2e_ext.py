"""Run: python3 test/e2e_ext.py   (pip install playwright; playwright install chromium)
The REAL extension is the Host (Chromium loads it), the hosted Client page renders through it.
A fake site on site.test needs a consent flow: 302 -> form POST (Origin/Referer checked) ->
303 + Set-Cookie -> page that needs the cookie. Checks cookies, POST, headers and per-hop redirects."""
import http.server, json, pathlib, re, shutil, sys, tempfile, threading
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from support import ROOT, Broker, build_site, check

LOG = []  # what the fake site saw: (method, path, cookie, origin, referer, body)


class Site(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body=b"", headers=()):
        self.send_response(code)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def seen(self, body=b""):
        h = self.headers
        LOG.append((self.command, self.path, h.get("Cookie"), h.get("Origin"), h.get("Referer"), body))

    def do_GET(self):
        self.seen()
        if self.path == "/":
            if "ok=1" in (self.headers.get("Cookie") or ""):
                self.reply(200, b"<!doctype html><title>welcome</title><p id=w>welcome</p>")
            else:
                self.reply(302, headers=[("Location", "/consent")])
        elif self.path == "/consent":
            self.reply(200, b"<!doctype html><title>consent</title><form method=post action=/consent>"
                            b"<input type=hidden name=x value=1><button id=agree>agree</button></form>")
        else:
            self.reply(404, b"nope")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.seen(body)
        ref = self.headers.get("Referer") or ""
        if self.headers.get("Origin") != "http://site.test" or not ref.startswith("http://site.test/consent"):
            return self.reply(403, b"bad origin")
        self.reply(303, headers=[("Location", "/"), ("Set-Cookie", "ok=1; Path=/; HttpOnly")])


site = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
threading.Thread(target=site.serve_forever, daemon=True).start()

tmp, srv, base = build_site()
R = f"{base}/~/"
ext = pathlib.Path(tempfile.mkdtemp(prefix="kinlink-ext-")) / "ext"
shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns(".git", "node_modules", "site", "test"))
manifest = json.loads((ext / "manifest.json").read_text())
manifest["host_permissions"] = ["<all_urls>"]  # the test cannot click the permission prompt
manifest.pop("optional_host_permissions", None)
(ext / "manifest.json").write_text(json.dumps(manifest))

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(), channel="chromium", headless=True,
        args=["--no-sandbox", f"--disable-extensions-except={ext}", f"--load-extension={ext}",
              "--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns",
              f"--host-resolver-rules=MAP site.test 127.0.0.1:{site.server_port}"])
    ctx.set_default_timeout(45000)
    ctx.route_web_socket(re.compile(r"wss://good\.test/.*"), Broker().handle)
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    ext_id = sw.url.split("/")[2]
    status = "document.getElementById('status').textContent"
    q = "?mqtt=wss://good.test/mqtt"

    host = ctx.new_page()
    host.goto(f"chrome-extension://{ext_id}/index.html{q}")
    secret = host.input_value("#secret")
    host.click("#connect")
    host.wait_for_function(f"{status}.includes('1/1 signaling')")
    client = ctx.new_page()
    client.goto(f"{base}/index.html{q}#{secret}")
    try:
        client.wait_for_function(f"{status}.includes('serving yes')")
    except Exception:
        for who, pg in (("host", host), ("client", client)):
            print(f"--- {who}: {pg.evaluate(status)}\n{pg.inner_text('#log')}")
        raise
    check(True, "real extension and hosted client are paired")

    client.fill("#url", "http://site.test/")
    with ctx.expect_page() as popup:
        client.click("#open")
    view = popup.value
    view.wait_for_selector("#agree")
    check(view.url == f"{R}http://site.test/consent", f"redirect hop followed by the client: {view.url}")
    check(LOG[0][2] is None, "first request carried no cookie")

    view.click("#agree")
    try:
        view.wait_for_selector("#w")
    except Exception:
        print("site saw:", LOG)
        print("host log:\n" + host.inner_text("#log"))
        print("client log:\n" + client.inner_text("#log"))
        print("view:", view.url, view.content()[:300])
        raise
    check(view.url == f"{R}http://site.test/", f"consent POST -> 303 -> page that needs the cookie: {view.url}")
    post = next(l for l in LOG if l[0] == "POST")
    check(post[3] == "http://site.test" and post[4].startswith("http://site.test/consent"),
          f"POST carried Origin and Referer of the real page: {post[3]} {post[4]}")
    check(post[2] is None and b"x=1" in post[5], "POST body arrived, no cookie yet")
    check("ok=1" in (LOG[-1][2] or ""), f"cookie from Set-Cookie replayed by the client: {LOG[-1][2]}")
    check(not any(c["name"] == "ok" for c in ctx.cookies()),
          "the host's own cookie jar stayed clean")
    ctx.close()
srv.shutdown()
site.shutdown()
print("e2e_ext ok")
