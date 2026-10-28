"""Run: python3 test/e2e.py   (pip install playwright; playwright install chromium)
Real Chromium, real Service Worker, fake peer: checks the rendering layer end to end."""
import re, shutil, sys
import pathlib
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from support import Broker, build_site, check

tmp, srv, base = build_site(extra=["harness.html"])
R = f"{base}/~/"


EXT_STUB = ("window.chrome = {runtime: {id: 'kinlink-test'}, permissions: "
            "{contains: async () => true, request: async () => true}};")
SITE = {"/": ("text/html", "<!doctype html><title>real</title><img src=/i.png><p id=p>hi</p>")}


def serve_fake_site(route):
    path = "/" + route.request.url.split("/", 3)[3]
    ctype, body = SITE.get(path, ("image/png", "png"))
    route.fulfill(status=200, content_type=ctype, body=body,
                  headers={"access-control-allow-origin": "*"})  # the real Host has host_permissions


def pair(browser, client_first):
    """Host page (extension stubbed) and Client page (invite link) over a fake broker."""
    ctx = browser.new_context()
    ctx.set_default_timeout(45000)
    ctx.route_web_socket(re.compile(r"wss://good\.test/.*"), Broker().handle)
    host, client = ctx.new_page(), ctx.new_page()
    host.add_init_script(EXT_STUB)
    host.route("https://site.test/**", serve_fake_site)
    query = "?mqtt=wss://dead.test/mqtt,wss://good.test/mqtt"  # dead.test never resolves
    host.goto(f"{base}/index.html{query}")
    secret = host.input_value("#secret")
    link = f"{base}/index.html{query}#{secret}"
    status = "document.getElementById('status').textContent"

    def start_host():
        host.click("#connect")
        host.wait_for_function(f"{status}.includes('1/2 signaling')")

    if client_first:
        client.goto(link)
        client.wait_for_timeout(4000)  # the first offers are lost: nobody is subscribed yet
        start_host()
    else:
        start_host()
        client.goto(link)
    name = "client first" if client_first else "host first"
    try:
        client.wait_for_function(f"{status}.includes('serving yes')")
        host.wait_for_function(f"{status}.includes('serving no')")  # hello arrived on both sides
    except Exception:
        for who, pg in (("host", host), ("client", client)):
            print(f"--- {who}: {pg.evaluate(status)}\n{pg.inner_text('#log')}")
        raise
    check(True, f"{name}: paired through a dead and a live broker")
    check(host.inner_text("#log").count("dc: open") == 1, f"{name}: data channel opened once")

    client.fill("#url", "https://site.test/")
    with ctx.expect_page() as popup:
        client.click("#open")
    view = popup.value
    view.wait_for_selector("#p")
    check(view.title() == "real" and "GET https://site.test/" in host.inner_text("#log"),
          f"{name}: rendered tab served by the host over the live data channel")
    ctx.close()


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox", "--allow-loopback-in-peer-connection",
                                      "--disable-features=WebRtcHideLocalIpsWithMdns"])
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
    view.wait_for_function("document.body.dataset.worker === 'worker ok'")
    check(True, "Worker script is served through the service worker")
    view.wait_for_function("document.body.dataset.api2 === 'api ok'")
    check(True, "fetch(location.origin + path) is mapped to the real site")
    check(app.evaluate("navigator.serviceWorker.getRegistration().then(Boolean)"),
          "a rendered page cannot unregister the service worker")
    hits = app.evaluate("hits")
    for u in ["https://site.test/s.css", "https://site.test/i.png", "https://other.test/px.png"]:
        check(u in hits, f"peer served {u}")
    check(any("Content Security Policy" in m for m in console), "CSP blocked unhooked leak")
    check(hosts == {f"127.0.0.1:{srv.server_port}"}, f"only our origin answered: {hosts}")
    check("csp" in failed.get("leak.test", "").lower(), f"leak attempt failed closed: {failed}")

    view.click("#l")
    view.wait_for_selector("#n")
    check(view.url == f"{R}https://site.test/next", f"link click stays rendered: {view.url}")

    for btn, what in (("#b1", "location.href = '/next' (root-relative, would 404 on our origin)"),
                      ("#b2", "location.assign('https://site.test/next') (absolute)")):
        view.goto(f"{R}https://site.test/")
        view.click(btn)
        view.wait_for_selector("#n")
        check(view.url == f"{R}https://site.test/next", f"script navigation {what}")

    resp = view.goto(f"{R}https://site.test/old")
    check(view.url == f"{R}https://site.test/", f"redirect lands on final url: {view.url}")
    resp = view.goto(f"{R}site.test/next")
    check(view.url == f"{R}https://site.test/next", "scheme-less url is canonicalised")

    app.evaluate("navigator.serviceWorker.getRegistration().then((r) => r.unregister())")
    for _ in range(15):  # the app tab notices within its 5 s heartbeat
        if app.evaluate("navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active))"):
            break
        app.wait_for_timeout(1000)
    resp = view.goto(f"{R}https://site.test/next")
    check(resp.status == 200, "app tab re-registers a service worker that was removed anyway")

    cdp = ctx.new_cdp_session(app)
    cdp.send("ServiceWorker.enable")
    cdp.send("ServiceWorker.stopAllWorkers")
    resp = view.goto(f"{R}https://site.test/next")
    check(resp.status == 200, "service worker restart: app tab re-announces itself")

    app.close()
    resp = view.goto(f"{R}https://site.test/next")
    check(resp.status == 502 and "no connected" in view.content(), "no app tab -> 502 page")
    pair(browser, client_first=False)
    pair(browser, client_first=True)
    browser.close()
srv.shutdown()
shutil.rmtree(tmp)
print("e2e ok")
