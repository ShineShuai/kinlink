import { BroadcastAdapter, ManualAdapter } from './src/signaling.js';
import { Peer } from './src/p2p.js';
import { CFG, pickStun, runProbes } from './src/diag.js';
import { MqttWssAdapter } from './src/mqtt.js';
import { SealedAdapter, derive, newSecret } from './src/crypto.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => {
  $('log').textContent += `${new Date().toISOString().slice(11, 23)} ${m}\n`;
};
const act = (id, f) => {
  $(id).onclick = () => Promise.resolve().then(f).catch((e) => log(`err: ${e.message}`));
};

const results = [];
window.kinlink = { results }; // handle for headless automation

act('run', async () => {
  $('probes').textContent = '';
  results.length = 0;
  results.push(...await runProbes(CFG, 5000, (r) => {
    const row = document.createElement('div');
    row.className = `row ${r.ok ? 'ok' : 'bad'}`;
    row.textContent = `${r.ok ? 'OK ' : 'ERR'} ${r.kind.padEnd(5)} `
      + `${String(r.ms).padStart(5)}ms ${r.target} ${r.info ?? r.err}`;
    $('probes').append(row);
  }));
});
act('copy', () => navigator.clipboard.writeText(JSON.stringify(
  { ts: new Date().toISOString(), ua: navigator.userAgent, probes: results }, null, 1)));

let sig, peer, soakTimer;
const rtts = [];
const stats = { sent: 0, recv: 0, max: 0 };

async function init() {
  clearInterval(soakTimer);
  $('soak').checked = false;
  await sig?.close();
  peer?.pc.close();
  const mode = $('mode').value;
  if (mode === 'bc') sig = new BroadcastAdapter();
  else if (mode === 'manual') sig = new ManualAdapter((t) => { $('out').value = t; });
  else {
    if (!location.hash) location.hash = newSecret();
    const { room, sigKey } = await derive(location.hash.slice(1));
    sig = new SealedAdapter(
      new MqttWssAdapter(q.get('broker') ?? CFG.wss[0][0], `kinlink/${room}`), sigKey);
    await sig.open();
    log(`mqtt: subscribed, room ${room.slice(0, 8)} (open this URL on the other side)`);
  }
  const stun = q.has('stun') ? [q.get('stun')] : (await pickStun(CFG.stun)).up;
  log(`stun: ${stun.join(', ')}`);
  peer = new Peer(sig, stun.map((urls) => ({ urls })));
  peer.onlog = log;
  peer.onrtt = (ms) => { rtts.push(ms); stats.recv++; stats.max = Math.max(stats.max, ms); };
  window.kinlink.peer = peer;
}

act('offer', () => peer.offer());
act('apply', () => sig.feed?.($('in').value.trim()));
act('ping', async () => {
  rtts.length = 0;
  for (let i = 0; i < 20; i++) { peer.ping(); await sleep(100); }
  await sleep(500);
  const s = [...rtts].sort((a, b) => a - b);
  const f = (x) => x?.toFixed(1);
  log(`ping ${s.length}/20 min=${f(s[0])} med=${f(s[s.length >> 1])} max=${f(s.at(-1))} ms`);
  log(`path ${await peer.path()}`);
});
act('blast', async () => {
  const r = await peer.blast(64 << 20);
  log(`blast ${r.bytes >> 20} MiB ${r.s.toFixed(2)} s ${r.mbps.toFixed(1)} Mbit/s`);
});

// Soak: timer-driven ping. Hide the tab and watch for timer gaps / RTT spikes.
$('soak').onchange = (e) => {
  clearInterval(soakTimer);
  if (!e.target.checked) return;
  let last = performance.now();
  soakTimer = setInterval(() => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    peer.ping();
    stats.sent++;
    if (dt > 1500) log(`timer gap ${dt | 0} ms vis=${document.visibilityState}`);
    if (stats.sent % 60 === 0) {
      log(`soak sent=${stats.sent} recv=${stats.recv} max=${stats.max | 0} ms `
        + `vis=${document.visibilityState}`);
      stats.max = 0;
    }
  }, 1000);
};

const reinit = () => init().catch((e) => log(`err: ${e.message}`));
$('mode').onchange = reinit;
reinit();
if (q.has('auto')) $('run').click();
