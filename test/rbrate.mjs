// Run: node test/rbrate.mjs   (remote browser rate control: pure, simulated seconds)
import assert from 'node:assert/strict';
import { QUEUE_BAD, Q_MIN, Rate, W_MAX, W_MIN } from '../src/rbrate.js';

// One simulated second: `n` acks of `lat` ms, `drops` frames replaced unsent.
const sec = (r, t, lat, n = 12, drops = 0) => {
  for (let i = 0; i < n; i++) r.ack(lat);
  for (let i = 0; i < drops; i++) r.drop();
  return r.tick(t * 1000);
};
const started = (lat, q = 60) => { // a Rate that knows the path delay (first second done)
  const r = new Rate(q);
  sec(r, 1, lat);
  return r;
};

// a still page teaches nothing
{
  const r = new Rate(60);
  assert.equal(sec(r, 1, 0, 0), false);
  assert.deepEqual([r.q, r.win], [60, W_MIN]);
}
// the first second sets the window from the delay (1 frame per 50 ms) and nothing else
{
  assert.equal(started(250).win, 6);
  assert.equal(started(10).win, W_MIN);
  assert.equal(started(900).win, W_MAX);
  const r = new Rate(60);
  assert.equal(sec(r, 1, 250, 3, 30), false, 'slow and dropping in the first second: no change');
  assert.equal(r.q, 60);
}
// window-limited (high RTT, no queueing, frames dropped): +1 per second up to what the delay needs
{
  const r = started(250);
  r.win = 2;
  const seen = [];
  for (let t = 2; t < 10; t++) { sec(r, t, 250, 12, 5); seen.push(r.win); }
  assert.deepEqual(seen, [3, 4, 5, 6, 6, 6, 6, 6]);
  assert.equal(r.q, 60, 'quality untouched');
}
// queueing: the window is halved; when it had just grown, it stops growing for 10 s
{
  const r = started(100); // want 3
  r.win = 8;
  sec(r, 2, 100 + QUEUE_BAD + 50, 12, 5);
  assert.equal(r.win, 4);
  sec(r, 3, 100 + QUEUE_BAD + 50, 12, 5);
  assert.equal(r.win, W_MIN);
  assert.equal(r.capUntil, 0, 'it was the queue, not a growth that caused it');
  r.win = 2;
  sec(r, 4, 100, 12, 5); // base stays 100: no queueing, dropping: grows
  assert.equal(r.win, 3);
  sec(r, 5, 100 + QUEUE_BAD + 50, 12, 5); // and that made a queue
  assert.equal(r.win, W_MIN);
  assert.equal(r.capUntil, 15000);
  for (let t = 6; t < 15; t++) { sec(r, t, 100, 12, 5); assert.equal(r.win, W_MIN, `t=${t}`); }
  sec(r, 15, 100, 12, 5);
  assert.equal(r.win, 3, 'growth allowed again');
}
// link-limited (too few frames per second, dropping, window as large as the delay needs): q - 8
// every 3 s, never below Q_MIN. (The window gets its one step first: 2 -> 3, t=2.)
{
  const r = started(100);
  r.win = W_MIN;
  const ch = [];
  for (let t = 2; t < 40; t++) if (sec(r, t, 100, 5, 20)) ch.push([t, r.q]);
  assert.deepEqual(ch.slice(0, 3), [[3, 52], [6, 44], [9, 36]]);
  assert.equal(r.q, Q_MIN);
  assert.ok(ch.every(([, q]) => q >= Q_MIN));
  assert.equal(r.win, 3);
}
// fast enough (>= 10 frames/s while dropping): the quality is not touched
{
  const r = started(100);
  r.win = W_MIN;
  for (let t = 2; t < 30; t++) assert.equal(sec(r, t, 100, 12, 20), false);
  assert.equal(r.q, 60);
}
// recovery: 5 calm seconds, then q + 4, 3 s apart, up to the maximum
{
  const r = started(100);
  r.q = 36;
  const up = [];
  for (let t = 2; t < 70; t++) if (sec(r, t, 100)) up.push([t, r.q]);
  assert.deepEqual(up.slice(0, 2), [[6, 40], [11, 44]]);
  assert.equal(r.q, 60);
}
// dropping frames at a high rate (25 frames/s) is fine too: the quality may rise
{
  const r = started(100);
  r.q = 44;
  for (let t = 2; t < 12; t++) sec(r, t, 100, 25, 10);
  assert.ok(r.q > 44);
}
// queueing between the two limits, window at its need: nothing changes
{
  const r = started(100);
  r.win = 3;
  for (let t = 2; t < 10; t++) assert.equal(sec(r, t, 100 + 60, 12, 3), false); // < 10 s of it
  assert.deepEqual([r.q, r.win], [60, 3]);
}
// the path's own delay is the smallest lat of the last 10 s
{
  const r = started(300);
  for (let t = 2; t < 14; t++) sec(r, t, 40);
  assert.equal(r.base, 40);
}
// qMax comes from the open message, clamped
assert.equal(new Rate(500).qMax, 90);
assert.equal(new Rate(NaN).qMax, 60);
assert.equal(new Rate(1).qMax, Q_MIN);
console.log('rbrate ok');
