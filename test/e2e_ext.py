"""Run: python3 test/e2e_ext.py   (pip install playwright; playwright install chromium)
The REAL extension is the Host (Chromium loads it), the hosted Client page renders through it.
A fake site on site.test needs a consent flow: 302 -> form POST (Origin/Referer checked) ->
303 + Set-Cookie -> page that needs the cookie. Checks cookies, POST, headers and per-hop redirects."""
import base64, hashlib, http.server, json, pathlib, re, shutil, ssl, subprocess, sys, tempfile
import threading
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from support import ROOT, Broker, WsServer, build_site, check

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
        elif self.path == "/rb":  # a page that needs real JavaScript (remote browser)
            port = self.server.server_port
            self.reply(200, (
                "<!doctype html><title>rb-off</title><body style='margin:0;background:#fff'>"
                "<button id=b style='position:absolute;left:100px;top:100px;"
                "width:200px;height:60px'>click me</button>"
                "<input id=i style='position:absolute;left:100px;top:200px;"
                "width:300px;height:40px'><script>document.title='rb-on';"
                "b.onclick=()=>fetch('/clicked');"
                "i.oninput=()=>fetch('/typed?v='+encodeURIComponent(i.value));"
                f"new Image().src='http://127.0.0.1:{port}/leak';</script>").encode())
        elif self.path == "/pop":  # a link that wants a new window
            self.reply(200, b"<!doctype html><title>pop</title><a id=a target=_blank href=/consent"
                            b" style='position:absolute;left:50px;top:50px;font-size:40px'>"
                            b"new window</a>")
        elif self.path == "/esc":  # a page that sends the tab to a private address
            port = self.server.server_port
            self.reply(200, (f"<!doctype html><title>esc</title><script>"
                             f"location.href='http://127.0.0.1:{port}/esc-leak'</script>").encode())
        elif self.path in ("/clicked", "/leak", "/esc-leak") or self.path.startswith("/typed"):
            self.reply(204)
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


class Hsts(Site):
    """hsts.test: https only, sends Strict-Transport-Security. Once the browser has seen that,
    http://hsts.test/ is upgraded inside Chrome (an internal 307, never sent to the network)."""

    def do_GET(self):
        self.seen()
        self.reply(200, b"<!doctype html><title>hsts</title><p id=h>https only</p>",
                   [("Strict-Transport-Security", "max-age=3600")])


tls = pathlib.Path(tempfile.mkdtemp(prefix="kinlink-tls-"))
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                "-keyout", tls / "k.pem", "-out", tls / "c.pem", "-subj", "/CN=hsts.test",
                "-addext", "subjectAltName=DNS:hsts.test"], check=True, capture_output=True)
pub = subprocess.run(["openssl", "x509", "-in", tls / "c.pem", "-pubkey", "-noout"],
                     check=True, capture_output=True).stdout
der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "der"], input=pub,
                     check=True, capture_output=True).stdout
spki = base64.b64encode(hashlib.sha256(der).digest()).decode()
hsts = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Hsts)
tls_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls_ctx.load_cert_chain(tls / "c.pem", tls / "k.pem")
hsts.socket = tls_ctx.wrap_socket(hsts.socket, server_side=True)
threading.Thread(target=hsts.serve_forever, daemon=True).start()

tmp, srv, base = build_site()
R = f"{base}/~/"
ext = pathlib.Path(tempfile.mkdtemp(prefix="kinlink-ext-")) / "ext"
shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns(".git", "node_modules", "site", "test"))
manifest = json.loads((ext / "manifest.json").read_text())
manifest["host_permissions"] = ["<all_urls>"]  # the test cannot click the permission prompt
manifest.pop("optional_host_permissions", None)
manifest["permissions"] += manifest.pop("optional_permissions", [])  # the debugger prompt, same
(ext / "manifest.json").write_text(json.dumps(manifest))

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(), channel="chromium", headless=True,
        args=["--no-sandbox", f"--disable-extensions-except={ext}", f"--load-extension={ext}",
              "--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns",
              "--host-resolver-rules=MAP site.test 127.0.0.1:%d, MAP hsts.test 127.0.0.1:%d"
              % (site.server_port, hsts.server_port),
              f"--ignore-certificate-errors-spki-list={spki}"])
    ctx.set_default_timeout(45000)
    ctx.route_web_socket(re.compile(r"wss://good\.test/.*"), Broker().handle)
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    ext_id = sw.url.split("/")[2]
    status = "document.getElementById('status').textContent"
    q = "?mqtt=wss://good.test/mqtt"

    def status_has(page, *needles):
        """Polled: extension pages forbid the eval behind wait_for_function."""
        for _ in range(150):
            text = page.evaluate(status)
            if all(n in text for n in needles):
                return
            page.wait_for_timeout(200)
        raise AssertionError(f"status never had {needles}: {text}\n{page.inner_text('#log')}")

    host = ctx.new_page()
    host.goto(f"chrome-extension://{ext_id}/index.html{q}")
    secret = host.input_value("#secret")
    host.click("#connect")
    status_has(host, "1/1 signaling")
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

    # HSTS: after one https visit Chrome upgrades http://hsts.test/ internally. fetch() then shows
    # an opaque redirect and webRequest only onBeforeRedirect: the Host must still report 307 +
    # Location (0014 sent status 0 and the page died with ERR_FAILED).
    def open_view(url):
        client.fill("#url", url)
        with ctx.expect_page() as pop:
            client.click("#open")
        return pop.value

    v = open_view("https://hsts.test/")
    v.wait_for_selector("#h")
    v.close()
    v = open_view("http://hsts.test/")
    try:
        v.wait_for_selector("#h")
    except Exception:
        print("host log:\n" + host.inner_text("#log"))
        print("view:", v.url, v.content()[:300])
        raise
    check(v.url == f"{R}https://hsts.test/", f"HSTS upgrade followed by the client: {v.url}")
    check("307 http://hsts.test/ -> https://hsts.test/" in host.inner_text("#log"),
          "host logged the upgrade as a 307 redirect")
    v.close()

    # Remote browser: the Host's real Chrome loads a page that needs JavaScript; the Client sees
    # frames and sends clicks and keys. (unsafeProfile: the test browser cannot be set to "allow in
    # incognito"; the default refuses to run outside incognito, which is checked first.)
    DRAWN = "c => c.width > 0 && c.getContext('2d').getImageData(1, 1, 1, 1).data[3] === 255"
    POPUPS = ("chrome.windows.getAll()"
              ".then((w) => w.filter((x) => x.type === 'popup').length)")
    sw.evaluate("chrome.storage.local.set({ remote: {} })")
    host.check("#remote")
    status_has(client, "remote: host allows")
    client.fill("#url", "http://site.test/rb")
    client.click("#ropen")
    box = "#rbox"
    for _ in range(50):
        if "Incognito" in client.inner_text(box):
            break
        client.wait_for_timeout(200)
    check("Incognito" in client.inner_text(box), "remote browser refuses to run outside incognito")
    sw.evaluate("chrome.storage.local.set({ remote: { on: true, unsafeProfile: true } })")
    client.click("#ropen")
    client.set_viewport_size({"width": 1280, "height": 1300})  # the whole canvas on screen
    cv = client.locator(f"{box} canvas")
    for _ in range(100):
        if cv.evaluate(DRAWN):
            break
        client.wait_for_timeout(200)
    else:
        raise AssertionError("no frame arrived\n" + client.inner_text("#log")
                             + host.inner_text("#log"))
    check(client.title() == "Kinlink: rb-on", f"page JavaScript ran on the host: {client.title()}")
    for _ in range(30):
        if " fps, " in client.inner_text(f"{box} span"):
            break
        client.wait_for_timeout(200)
    check(" KB/s, " in client.inner_text(f"{box} span"), "the viewer shows frames per second")

    def at(x, y):  # remote viewport px -> page px
        b = cv.bounding_box()
        k = b["width"] / cv.evaluate("c => c.width")
        return b["x"] + x * k, b["y"] + y * k

    client.mouse.click(*at(150, 130))
    client.mouse.click(*at(150, 220))
    client.keyboard.type("hey")
    for _ in range(50):
        if any(p == "/typed?v=hey" for _, p, *_ in LOG):
            break
        client.wait_for_timeout(200)
    paths = [p for _, p, *_ in LOG]
    if "/clicked" not in paths or "/typed?v=hey" not in paths:
        print("site saw:", [p for _, p, *_ in LOG][-8:])
        print("host log:\n" + host.inner_text("#log"))
        print("client log:\n" + client.inner_text("#log"))
        print("viewer:", client.inner_text(f"{box} span"), cv.bounding_box(),
              cv.evaluate("c => [c.width, c.height]"))
    check("/clicked" in paths, "click reached the remote page")
    check("/typed?v=hey" in paths, "typing reached the remote page")
    check("/leak" not in paths, "the tab could not reach 127.0.0.1 (blocked)")
    client.fill(f"{box} input", f"http://127.0.0.1:{site.server_port}/secret")
    client.press(f"{box} input", "Enter")
    for _ in range(50):
        if "blocked" in client.inner_text(f"{box} span"):
            break
        client.wait_for_timeout(100)
    check("blocked" in client.inner_text(f"{box} span"), "address bar refuses private addresses")
    client.fill(f"{box} input", "http://site.test/consent")
    client.press(f"{box} input", "Enter")
    for _ in range(50):
        if client.title() == "Kinlink: consent":
            break
        client.wait_for_timeout(200)
    check(client.title() == "Kinlink: consent", f"address bar navigates: {client.title()}")
    # a target=_blank link opens in the Host's normal window: that tab must be closed and the
    # remote tab navigates instead
    client.fill(f"{box} input", "http://site.test/pop")
    client.press(f"{box} input", "Enter")
    for _ in range(50):
        if client.title() == "Kinlink: pop":
            break
        client.wait_for_timeout(200)
    check(client.title() == "Kinlink: pop", f"address bar navigates again: {client.title()}")
    client.mouse.click(*at(80, 70))
    for _ in range(50):
        if client.title() == "Kinlink: consent":
            break
        client.wait_for_timeout(200)
    count = ("chrome.tabs.query({})"
             ".then((t) => t.filter((x) => (x.url || '').startsWith('http://site.test')).length)")
    for _ in range(25):  # the extra tab is closed a moment after it opened
        tabs = sw.evaluate(count)
        if tabs == 1:
            break
        client.wait_for_timeout(200)
    check(client.title() == "Kinlink: consent" and tabs == 1,
          f"target=_blank: the same remote tab navigates, the new tab is closed ({tabs})")
    # a page sending the tab to 127.0.0.1: blocked at the network level
    client.fill(f"{box} input", "http://site.test/esc")
    client.press(f"{box} input", "Enter")
    client.wait_for_timeout(2500)
    check("/esc-leak" not in [p for _, p, *_ in LOG], "script navigation to 127.0.0.1 is blocked")
    client.click(f"{box} button:has-text('Close')")
    for _ in range(50):
        if sw.evaluate(POPUPS) == 0:
            break
        client.wait_for_timeout(200)
    n = sw.evaluate(POPUPS)
    check(n == 0, "closing the viewer closes the host's window")
    host.uncheck("#remote")
    status_has(client, "serving yes")
    sw.evaluate("chrome.storage.local.set({ remote: {} })")

    # Background host: the offscreen document serves while no Kinlink tab is open, and takes a
    # new client after the first one left. Needs a real WebSocket broker (offscreen documents are
    # not covered by route_web_socket).
    for pg in ctx.pages:  # also the tab the extension opens by itself on install
        pg.close()
    wsb = WsServer(Broker())
    # two connections to one broker = a cluster: our own frames come back on the other connection
    mq = f"?mqtt=ws://127.0.0.1:{wsb.port}/mqtt,ws://localhost:{wsb.port}/mqtt"
    sw.evaluate("chrome.storage.local.set({ remote: { on: true, unsafeProfile: true } })")
    ui = ctx.new_page()
    ui.goto(f"chrome-extension://{ext_id}/index.html{mq}")
    secret2 = ui.input_value("#secret")
    ui.select_option("#serve", "bg")
    status_has(ui, "background host", "2/2 signaling")
    n_docs = sw.evaluate("chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})"
                         ".then((c) => c.length)")
    check(n_docs == 1, "background host: offscreen document is running")
    ui.close()
    check(not ctx.pages, "background host: no tab is open at all")

    def pair_and_browse(n, extra=""):
        pg = ctx.new_page()
        pg.goto(f"{base}/index.html{mq}{extra}#{secret2}")
        try:
            pg.wait_for_function(f"{status}.includes('serving yes')")
        except Exception:
            print(f"--- client {n}: {pg.evaluate(status)}\n{pg.inner_text('#log')}")
            raise
        pg.fill("#url", "http://site.test/consent")
        with ctx.expect_page() as pop:
            pg.click("#open")
        try:
            pop.value.wait_for_selector("#agree")
        except Exception:
            print(f"--- client {n}: {pg.evaluate(status)}\n{pg.inner_text('#log')}")
            print(f"--- view: {pop.value.url} {pop.value.content()[:300]}")
            raise
        pop.value.close()
        return pg

    first = pair_and_browse(1)
    check(True, "background host: client 1 paired and browsed with no host tab")
    status_has(first, "remote: host allows")  # the offscreen document offers the remote browser too
    first.fill("#url", "http://site.test/rb")
    first.click("#ropen")
    cv1 = first.locator("#rbox canvas")
    for _ in range(100):
        if first.title() == "Kinlink: rb-on":
            break
        first.wait_for_timeout(200)
    check(first.title() == "Kinlink: rb-on" and cv1.evaluate("c => c.width > 0"),
          "background host: remote browser works from the offscreen document")
    first.close()
    second = pair_and_browse(2)
    check(True, "background host: client 2 paired after client 1 left (session restarted)")

    # Client 3 can only use the relay. It arrives while the Host still holds client 2's session, so
    # the Host restarts for its offer; client 3's relay must then find the new session (its idle
    # keepalive wakes it) and keep working.
    second.close()
    third = pair_and_browse(3, "&relay=0&ice=relay")
    ui2 = ctx.new_page()
    ui2.goto(f"chrome-extension://{ext_id}/index.html{mq}")

    def host_log():
        ui2.reload()
        for _ in range(50):
            text = ui2.inner_text("#log")
            if "build" in text:
                return text
            ui2.wait_for_timeout(100)
        return text

    for _ in range(40):
        text = host_log()
        if text.count("dc: open (relay)") >= 2 and "host: restart" in text:
            break
        ui2.wait_for_timeout(2000)
    else:
        raise AssertionError("client 3's relay never reached the restarted Host\n" + host_log())
    check(True, "background host: relay client found the restarted session")
    third.fill("#url", "http://site.test/consent")
    with ctx.expect_page() as pop:
        third.click("#open")
    pop.value.wait_for_selector("#agree")
    check(True, "background host: relay client browses after the restart")
    ctx.close()
    wsb.close()
srv.shutdown()
site.shutdown()
print("e2e_ext ok")
