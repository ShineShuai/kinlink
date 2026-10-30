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
// initial: supervised from the start, nothing is opened until it reports a reason; label in logs
{
  const first = { why: null, stopped: false, dead: () => first.why, stop: () => { first.stopped = true; } };
  const made = [];
  const logs = [];
  const sup = supervise(async () => {
    const s = { dead: () => null, stop() {} };
    made.push(s);
    return s;
  }, { ...T, initial: first, label: 'client', onlog: (l) => logs.push(l) });
  await sleep(60);
  assert.equal(made.length, 0, 'healthy initial session: nothing opened');
  first.why = 'no answer';
  await sleep(80);
  assert.equal(made.length, 1);
  assert.ok(first.stopped);
  assert.ok(logs.some((l) => l === 'client: restart (no answer)'), logs.join('|'));
  sup.stop();
}

// sessions that die young: the gap doubles up to maxMs; a long-lived one resets it
{
  const times = [];
  const sup = supervise(async () => {
    times.push(Date.now());
    return { dead: () => 'x', stop() {} };
  }, { checkMs: 5, minMs: 20, maxMs: 80, stableMs: 10000 });
  await sleep(450);
  sup.stop();
  const gaps = times.slice(1).map((t, k) => t - times[k]);
  assert.ok(gaps.length >= 5, gaps.join(','));
  const want = [20, 40, 80, 80, 80];
  want.forEach((w, k) => assert.ok(gaps[k] >= w - 3 && gaps[k] < w + 40, `${gaps.join(',')}`));
}
{
  const times = [];
  const sup = supervise(async () => {
    times.push(Date.now());
    const born = Date.now();
    const s = { dead: () => (Date.now() - born > 40 ? 'x' : null), stop() {} };
    return s;
  }, { checkMs: 5, minMs: 20, maxMs: 200, stableMs: 30 });
  await sleep(300);
  sup.stop();
  const gaps = times.slice(1).map((t, k) => t - times[k]);
  assert.ok(gaps.every((g) => g < 120), `lived long enough: no growth: ${gaps.join(',')}`);
}
clearInterval(keep);
console.log('supervise ok');
