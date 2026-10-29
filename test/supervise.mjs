// Run: node test/supervise.mjs   (fake sessions; real timers, short intervals)
import assert from 'node:assert/strict';
import { supervise } from '../src/supervise.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keep = setInterval(() => {}, 1000);
const T = { checkMs: 5, minMs: 30 };

// restarts when the session reports a reason, stops the old one first
{
  const made = [];
  const logs = [];
  const sup = supervise(async () => {
    const s = { why: null, stopped: false, dead: () => s.why, stop: () => { s.stopped = true; } };
    made.push(s);
    return s;
  }, { ...T, onlog: (l) => logs.push(l) });
  await sleep(40);
  assert.equal(made.length, 1);
  made[0].why = 'link failed';
  await sleep(80);
  assert.equal(made.length, 2);
  assert.ok(made[0].stopped && !made[1].stopped);
  assert.ok(logs.some((l) => /restart \(link failed\)/.test(l)), logs.join('|'));
  await sleep(80);
  assert.equal(made.length, 2, 'healthy: no restarts');
  sup.stop();
  assert.ok(made[1].stopped);
}

// open() fails (no network at browser start): retried, but not faster than minMs
{
  let tries = 0;
  const times = [];
  const sup = supervise(async () => {
    times.push(Date.now());
    if (++tries < 3) throw new Error('no signaling server reachable');
    return { dead: () => null, stop() {} };
  }, T);
  await sleep(300);
  assert.equal(tries, 3);
  assert.ok(times[1] - times[0] >= 25 && times[2] - times[1] >= 25, times.join(','));
  sup.stop();
}

// stop() while open() is pending: the session that arrives late is closed
{
  let stopped = false;
  const sup = supervise(async () => {
    await sleep(30);
    return { dead: () => null, stop: () => { stopped = true; } };
  }, T);
  sup.stop();
  await sleep(60);
  assert.ok(stopped);
}
clearInterval(keep);
console.log('supervise ok');
