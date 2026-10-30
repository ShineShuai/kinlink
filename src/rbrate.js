// Remote browser rate control, Host side (pure, no chrome.* and no DOM). From the Client's acks it
// decides how many frames may be in flight (win) and how hard the JPEGs are compressed (q).
// lat = ms from starting to send a frame until its ack (RTT + queue + decode). The smallest lat of
// the last 10 s is the path's own delay (base); what lies above it is queueing: the link is full.
// Each second, the first rule that applies wins ("drops": frames replaced before they got a slot,
// i.e. the page makes more frames than we deliver):
//   1. queueing > QUEUE_BAD and win > W_MIN: halve the window (latency, no quality lost); if the
//      window had just grown, the link (not the window) is the limit: no growth for CAP_MS
//   2. drops, queueing < QUEUE_OK, win below the delay's need (1 frame per 50 ms): win + 1
//      (window-limited: a high RTT with 2 frames in flight, not a slow link)
//   3. drops and under FPS_MIN frames/s: q - 8 (link-limited: the frames are too big)
//   4. no drops (or FPS_GOOD+ frames/s), no queueing, 5 s in a row: q + 4 (up to the maximum)
// The window starts from the delay too. Quality changes restart the screencast: >= 3 s apart.
export const Q_MIN = 25;
export const W_MIN = 2;
export const W_MAX = 8;
export const QUEUE_BAD = 100;
export const QUEUE_OK = 30;
export const FPS_MIN = 10;
export const FPS_GOOD = 20;
const Q_GAP = 3000;
const CAP_MS = 10000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Rate {
  constructor(qMax = 60) {
    this.qMax = clamp(Math.round(qMax) || 60, Q_MIN, 90);
    this.q = this.qMax;
    this.win = W_MIN;
    this.n = 0; // this second: acks, their lat sum and minimum, frames dropped unsent
    this.sum = 0;
    this.min = Infinity;
    this.drops = 0;
    this.mins = []; // smallest lat of each of the last 10 seconds
    this.calm = 0;
    this.qAt = -Infinity;
    this.known = false;
    this.grew = false; // the window grew at the last tick
    this.capUntil = 0; // no window growth before this time: it only made a queue
    this.base = 0; // last estimate of the path's own delay
    this.queue = 0; // and of the queueing above it
  }

  ack(ms) {
    this.n++;
    this.sum += ms;
    this.min = Math.min(this.min, ms);
  }

  drop() { this.drops++; }

  // Once per second (now: ms, any clock). Returns true when q changed.
  tick(now) {
    const { n, sum, min, drops } = this;
    this.n = this.sum = this.drops = 0;
    this.min = Infinity;
    if (!n) return false; // a still page: nothing to learn
    this.mins.push(min);
    if (this.mins.length > 10) this.mins.shift();
    this.base = Math.min(...this.mins);
    this.queue = sum / n - this.base;
    const want = clamp(Math.ceil(this.base / 50) + 1, W_MIN, W_MAX);
    if (!this.known) { // the first second only tells the delay: the window starts from it
      this.known = true;
      this.win = want;
      return false;
    }
    const slow = now - this.qAt >= Q_GAP;
    const grew = this.grew;
    this.grew = false;
    if (this.queue > QUEUE_BAD && this.win > W_MIN) {
      this.calm = 0;
      this.win = Math.max(W_MIN, this.win >> 1);
      if (grew) this.capUntil = now + CAP_MS;
    } else if (drops && this.queue < QUEUE_OK && this.win < want && now >= this.capUntil) {
      this.calm = 0;
      this.win++;
      this.grew = true;
    } else if (drops && n < FPS_MIN && this.q > Q_MIN && slow) {
      this.calm = 0;
      return this.setQ(this.q - 8, now);
    } else if (this.queue < QUEUE_OK && (!drops || n >= FPS_GOOD)) {
      if (++this.calm >= 5 && this.q < this.qMax && slow) {
        this.calm = 0;
        return this.setQ(this.q + 4, now);
      }
    } else {
      this.calm = 0;
    }
    return false;
  }

  setQ(q, now) {
    this.q = clamp(q, Q_MIN, this.qMax);
    this.qAt = now;
    return true;
  }
}
