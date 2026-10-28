"""Helpers shared by the e2e scripts."""
import functools, http.server, pathlib, shutil, subprocess, tempfile, threading

ROOT = pathlib.Path(__file__).resolve().parent.parent


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def build_site(extra=()):
    """Build the static Client site into <tmp>/kinlink and serve <tmp>. Returns (tmp, server, base)."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="kinlink-e2e-"))
    subprocess.run(["bash", str(ROOT / "scripts/build-site.sh"), str(tmp / "kinlink")], check=True,
                   capture_output=True)
    for name in extra:
        shutil.copy(ROOT / "test" / name, tmp / "kinlink" / name)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
                                          functools.partial(Quiet, directory=str(tmp)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return tmp, srv, f"http://127.0.0.1:{srv.server_port}/kinlink"


class Broker:
    """Minimal MQTT 3.1.1 broker (QoS 0): enough for the signaling adapter."""

    def __init__(self):
        self.topics = {}

    def handle(self, ws):
        self.topics[ws] = None

        def on_message(raw):
            m = bytes(raw) if not isinstance(raw, bytes) else raw
            j = 1
            while m[j] & 128:
                j += 1
            body = m[j + 1:]
            kind = m[0] >> 4
            if kind == 1:  # CONNECT
                ws.send(b"\x20\x02\x00\x00")
            elif kind == 8:  # SUBSCRIBE
                n = (body[2] << 8) | body[3]
                self.topics[ws] = body[4:4 + n]
                ws.send(b"\x90\x03" + body[:2] + b"\x00")
            elif kind == 3:  # PUBLISH: forward to the other subscribers of the topic
                n = (body[0] << 8) | body[1]
                for other, topic in list(self.topics.items()):
                    if other is not ws and topic == body[2:2 + n]:
                        other.send(m)
            elif kind == 12:  # PINGREQ
                ws.send(b"\xd0\x00")

        ws.on_message(on_message)


def check(cond, msg):
    assert cond, msg
    print("ok  ", msg)
