// Run: node test/remote-host.mjs   (fake peer and Port; flow control and validation)
import assert from 'node:assert/strict';
import { serveRemote } from '../src/remote-host.js';
import { RB_ID } from '../src/remote.js';
import { toB64 } from '../src/proxy.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkPeer = (relay = false) => {
  const sent = [];
  const peer = { sent, dc: { readyState: 'open', relay, send: (t) => sent.push(t) },
    async tx(b) { sent.push(b); } };
  return peer;
};
const mkPort = () => {
  const p = { out: [], ls: [], dis: [], gone: false };
  p.onMessage = { addListener: (f) => p.ls.push(f) };
  p.onDisconnect = { addListener: (f) => p.dis.push(f) };
  p.postMessage = (m) => p.out.push(m);
  p.disconnect = () => { p.gone = true; };
  p.push = (m) => p.ls.forEach((f) => f(m));
  return p;
};
const texts = (peer, op) => peer.sent.filter((s) => typeof s === 'string' && s.startsWith(`${op}:`))
  .map((s) => JSON.parse(s.slice(op.length + 1)));
const jpeg = (n) => toB64(Uint8Array.from({ length: n }, (_, i) => i & 255));

// open, size is clamped, input and nav are forwarded
{
  const peer = mkPeer();
  const port = mkPort();
  let on = true;
  const prev = [];
  peer.onctl = (op, arg) => prev.push(op);
  const rb = serveRemote(peer, { enabled: () => on, connect: () => port });
  peer.onctl('hello', '{}');
  assert.deepEqual(prev, ['hello'], 'other ops still reach proxy.js');
  peer.onctl('rbi', '{"t":"m"}');
  assert.match(peer.sent.at(-1), /^rbe:.*no remote browser is open/);
  peer.onctl('rbo', JSON.stringify({ url: 'https://a.com/', w: 5, h: 99999, q: 60 }));
  assert.deepEqual(port.out[0], { op: 'open', url: 'https://a.com/', w: 200, h: 1600, q: 60 });
  peer.onctl('rbi', '{"t":"k","k":"down"}');
  peer.onctl('rbn', '{"a":"go","url":"https://b.com/"}');
  peer.onctl('rbs', '{"w":800,"h":500}');
  assert.deepEqual(port.out.slice(1), [
    { op: 'input', ev: { t: 'k', k: 'down' } },
    { op: 'nav', a: 'go', url: 'https://b.com/' },
    { op: 'size', w: 800, h: 500 }]);
  port.push({ meta: { url: 'https://a.com/', title: 'A', loading: false } });
  assert.deepEqual(texts(peer, 'rbm'), [{ url: 'https://a.com/', title: 'A', loading: false }]);
  port.push({ error: 'host: blocked' });
  assert.deepEqual(texts(peer, 'rbe').at(-1), { message: 'host: blocked' });

  // flow control: 2 frames in flight, newer frames replace older ones, an ack releases the next
  peer.sent.length = 0;
  port.push({ frame: jpeg(40000), w: 800, h: 600 });
  await sleep(5);
  assert.equal(texts(peer, 'rbf').length, 1);
  assert.equal(texts(peer, 'rbf')[0].len, 40000);
  const chunks = peer.sent.filter((s) => typeof s !== 'string');
  assert.ok(chunks.length === 3 && chunks.every((c) => new DataView(c.buffer).getUint32(0) === RB_ID));
  port.push({ frame: jpeg(100), w: 800, h: 600 });
  port.push({ frame: jpeg(200), w: 800, h: 600 }); // in flight: 2 -> this and the next wait
  port.push({ frame: jpeg(300), w: 800, h: 600 }); // replaces the 200
  await sleep(5);
  assert.deepEqual(texts(peer, 'rbf').map((f) => f.len), [40000, 100]);
  peer.onctl('rbk', '{"n":1}');
  await sleep(5);
  assert.deepEqual(texts(peer, 'rbf').map((f) => f.len), [40000, 100, 300], 'newest, 200 was dropped');

  // the Client closes / the host switches the feature off / the worker closes the port
  peer.onctl('rbx', '{}');
  assert.ok(port.gone);
  port.gone = false;
  on = false;
  peer.onctl('rbo', '{"url":"https://a.com/"}');
  assert.match(peer.sent.at(-1), /off on the host/);
  rb.stop();
}

// the relay is not a place for a screencast
{
  const peer = mkPeer(true);
  serveRemote(peer, { enabled: () => true, connect: () => assert.fail('must not connect') });
  peer.onctl('rbo', '{"url":"https://a.com/"}');
  assert.match(peer.sent.at(-1), /direct connection/);
}

// the worker's port goes away: the Client is told once
{
  const peer = mkPeer();
  const port = mkPort();
  serveRemote(peer, { enabled: () => true, connect: () => port });
  peer.onctl('rbo', '{"url":"https://a.com/"}');
  port.dis.forEach((f) => f());
  assert.equal(texts(peer, 'rbc').length, 1);
  port.push({ frame: jpeg(10) }); // late message of a dead session: ignored
  await sleep(5);
  assert.equal(texts(peer, 'rbf').length, 0);
}
// onuse: true while a remote browser is open, false after every way of closing
{
  const peer = mkPeer();
  const ports = [];
  const use = [];
  serveRemote(peer, {
    enabled: () => true, connect: () => ports[ports.push(mkPort()) - 1], onuse: (u) => use.push(u),
  });
  peer.onctl('rbo', '{"url":"https://a.com/"}');
  assert.deepEqual(use, [true]);
  peer.onctl('rbx', '{}');
  assert.deepEqual(use, [true, false]);
  peer.onctl('rbx', '{}'); // nothing open: no second false
  peer.onctl('rbo', '{"url":"https://a.com/"}');
  ports[1].dis.forEach((f) => f());
  assert.deepEqual(use, [true, false, true, false]);
}
// rate control: frame headers carry q and the window; a Client that shows too few frames per
// second makes the Host ask the worker for a lower JPEG quality
{
  const peer = mkPeer();
  const port = mkPort();
  serveRemote(peer, { enabled: () => true, connect: () => port, tickMs: 20 });
  peer.onctl('rbo', '{\"url\":\"https://a.com/\",\"q\":60}');
  let acked = 0;
  for (let k = 0; k < 12 && !port.out.some((m) => m.op === 'q'); k++) {
    for (let i = 0; i < 6; i++) port.push({ frame: jpeg(100), w: 800, h: 600 }); // <= 2 get sent
    await sleep(5);
    for (const f of texts(peer, 'rbf')) {
      if (f.n > acked) { peer.onctl('rbk', JSON.stringify({ n: f.n })); acked = f.n; }
    }
    await sleep(20);
  }
  const first = texts(peer, 'rbf')[0];
  assert.equal(first.q, 60);
  assert.equal(first.win, 2);
  assert.deepEqual(port.out.find((m) => m.op === 'q'), { op: 'q', q: 52 });
  peer.onctl('rbx', '{}');
}
console.log('remote-host ok');
