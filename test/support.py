"""Helpers shared by the e2e scripts."""
import base64, functools, hashlib, http.server, pathlib, shutil, socket, struct, subprocess
import tempfile, threading

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
            elif kind == 3:  # PUBLISH: to every subscriber of the topic, the publisher included
                n = (body[0] << 8) | body[1]
                for other, topic in list(self.topics.items()):
                    if topic == body[2:2 + n]:
                        other.send(m)
            elif kind == 12:  # PINGREQ
                ws.send(b"\xd0\x00")

        ws.on_message(on_message)

    def drop(self, ws):
        self.topics.pop(ws, None)


class WsServer:
    """A real WebSocket server (stdlib) on 127.0.0.1 for a Broker: for pages that Playwright's
    route_web_socket does not cover, e.g. an extension's offscreen document."""

    GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, broker):
        self.broker = broker
        self.sock = socket.create_server(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self.serve, args=(conn,), daemon=True).start()

    def serve(self, conn):
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = conn.recv(4096)
            if not chunk:
                return
            head += chunk
        key = next(l.split(b":", 1)[1].strip() for l in head.split(b"\r\n")
                   if l.lower().startswith(b"sec-websocket-key"))
        accept = base64.b64encode(hashlib.sha1(key + self.GUID).digest())
        conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                     b"Connection: Upgrade\r\nSec-WebSocket-Protocol: mqtt\r\n"
                     b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n")
        lock = threading.Lock()
        ws = type("Ws", (), {})()

        def send(data):
            n = len(data)
            hdr = bytes([0x82, n]) if n < 126 else (
                bytes([0x82, 126]) + struct.pack(">H", n) if n < 65536
                else bytes([0x82, 127]) + struct.pack(">Q", n))
            with lock:
                try:
                    conn.sendall(hdr + bytes(data))
                except OSError:
                    pass

        ws.send = send
        ws.on_message = lambda cb: setattr(ws, "cb", cb)
        self.broker.handle(ws)

        def read(n):
            buf = b""
            while len(buf) < n:
                chunk = conn.recv(n - len(buf))
                if not chunk:
                    raise EOFError
                buf += chunk
            return buf

        try:
            while True:
                b0, b1 = read(2)
                n = b1 & 127
                n = struct.unpack(">H", read(2))[0] if n == 126 else (
                    struct.unpack(">Q", read(8))[0] if n == 127 else n)
                mask = read(4) if b1 & 128 else b"\0\0\0\0"
                data = bytes(c ^ mask[i % 4] for i, c in enumerate(read(n)))
                if b0 & 15 == 8:
                    break
                if b0 & 15 in (1, 2):
                    ws.cb(data)
        except (EOFError, OSError):
            pass
        finally:
            self.broker.drop(ws)
            conn.close()

    def close(self):
        self.sock.close()


def check(cond, msg):
    assert cond, msg
    print("ok  ", msg)
