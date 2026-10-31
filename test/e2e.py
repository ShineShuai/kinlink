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


def pair(browser, client_first, relay=None, reconnect=False):
    """Host page (extension stubbed) and Client page (invite link) over a fake broker.
    relay: "only" = ?relay=0&ice=relay on both pages, no direct path: frames travel over the
    broker. "then-direct" = ?relay=0 only: starts on the relay, the direct path takes over.
    "client-only" = relay-only on the invite link only (what a user does to try the relay): the
    Host page has no parameters and joins when the Client's OPEN arrives."""
    ctx = browser.new_context()
    ctx.set_default_timeout(45000)
    # good.test and good2.test are one broker cluster (like broker.emqx.io and broker-cn.emqx.io):
    # a message published on one reaches our own subscription on the other, with another sender id
    cluster = Broker()
    ctx.route_web_socket(re.compile(r"wss://good2?\.test/.*"), cluster.handle)
    host, client = ctx.new_page(), ctx.new_page()
    host.add_init_script(EXT_STUB)
    host.route("https://site.test/**", serve_fake_site)
    # dead.test never resolves
    query = "?mqtt=wss://dead.test/mqtt,wss://good.test/mqtt,wss://good2.test/mqtt"
    host_q = query + {"only": "&relay=0&ice=relay", "then-direct": "&relay=0"}.get(relay, "")
    link_q = query + {"only": "&relay=0&ice=relay", "then-direct": "&relay=0",
                      "client-only": "&relay=0&ice=relay"}.get(relay, "")
    host.goto(f"{base}/index.html{host_q}")
    secret = host.input_value("#secret")
    link = f"{base}/index.html{link_q}#{secret}"
    status = "document.getElementById('status').textContent"

    def start_host():
        host.click("#connect")
        host.wait_for_function(f"{status}.includes('2/3 signaling')")

    if client_first:
        client.goto(link)
        client.wait_for_timeout(4000)  # the first offers are lost: nobody is subscribed yet
        start_host()
    else:
        start_host()
        client.goto(link)
    name = "client first" if client_first else "host first"
    name += f", relay {relay}" if relay else ""
    try:
        client.wait_for_function(f"{status}.includes('serving yes')")
        host.wait_for_function(f"{status}.includes('serving no')")  # hello arrived on both sides
    except Exception:
        for who, pg in (("host", host), ("client", client)):
            print(f"--- {who}: {pg.evaluate(status)}\n{pg.inner_text('#log')}")
        raise
    check(True, f"{name}: paired through a dead and a live broker")
    if relay:
        on_relay = relay == "then-direct" or "link: relay" in client.evaluate(status)
        check(on_relay and "dc: open (relay)" in host.inner_text("#log"),
              f"{name}: link started on the broker relay")
    else:
        # a slow ICE can start the relay (8 s): "dc: open (relay)" is another line, not a 2nd open
        opened = [l for l in host.inner_text("#log").split("\n") if l.endswith("dc: open")]
        if len(opened) != 1:
            print("--- host log\n" + host.inner_text("#log"))
            print("--- client log\n" + client.inner_text("#log"))
        check(len(opened) == 1, f"{name}: data channel opened once")

    client.fill("#url", "https://site.test/")
    with ctx.expect_page() as popup:
        client.click("#open")
    view = popup.value
    view.wait_for_selector("#p")
    check(view.title() == "real" and "GET https://site.test/" in host.inner_text("#log"),
          f"{name}: rendered tab served by the host over the live data channel")
    if relay == "then-direct":  # the direct channel opened late; the next request may use it
        for _ in range(60):
            view.reload()
            if "link: direct" in client.evaluate(status):
                break
            client.wait_for_timeout(500)
        check("link: direct" in client.evaluate(status)
              and "(late, adopted)" in client.inner_text("#log"),
              f"{name}: direct channel adopted by the relay once it was idle")
        view.reload()
        view.wait_for_selector("#p")
        check(True, f"{name}: page still loads over the adopted direct channel")
    if reconnect:
        # The Host restarts (Connect again): its peer connection closes. The Client has to notice,
        # open a new session and offer again by itself; the rendered tab then works again.
        start_host()
        client.wait_for_function(
            "document.getElementById('log').textContent.includes('client: restart')", timeout=40000)
        for _ in range(40):
            view.reload()
            try:
                view.wait_for_selector("#p", timeout=1500)
                break
            except Exception:
                client.wait_for_timeout(1000)
        ok = 'id="p"' in view.content()
        if not ok:
            print("--- client log\n" + client.inner_text("#log"))
            print("--- host log\n" + host.inner_text("#log"))
        check(ok, f"{name}: client reconnected by itself after the host restarted")
        client.wait_for_function(f"{status}.includes('link: direct')")
        check(True, f"{name}: and it is a direct link again")
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
    pair(browser, client_first=False, relay="only")
    pair(browser, client_first=True, relay="only")
    pair(browser, client_first=False, relay="then-direct")
    pair(browser, client_first=False, relay="client-only")
    pair(browser, client_first=False, reconnect=True)
    browser.close()
srv.shutdown()
shutil.rmtree(tmp)
print("e2e ok")
