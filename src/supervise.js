const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keeps one session alive. open() -> { dead(): string | null, stop() }.
// Reopens when the session reports a reason (link or channel gone, no broker, new client offers,
// nobody answered) and retries when opening failed. Never more often than every minMs; when
// sessions keep dying young (< stableMs), the gap doubles up to maxMs (default: no growth).
// initial: a session that is already open (supervised from now on, none is opened at first).
export function supervise(open, opts = {}) {
  const { checkMs = 3000, minMs = 5000, maxMs = minMs, stableMs = 30000, initial,
    label = 'host', onlog = () => {} } = opts;
  let cur = initial;
  let busy = false;
  let quit = false;
  let last = initial ? Date.now() : 0; // when the current session was opened
  let fails = 0;
  const reopen = async (why) => {
    if (busy || quit) return;
    busy = true;
    try {
      cur?.stop();
      cur = undefined;
      fails = Date.now() - last < stableMs ? fails + 1 : 0;
      const wait = last + Math.min(maxMs, minMs * 2 ** Math.max(0, fails - 1)) - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      onlog(why ? `${label}: restart (${why})` : `${label}: start`);
      cur = await open();
      if (quit) cur.stop();
    } catch (e) {
      onlog(`${label}: open failed: ${e.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    const why = busy || quit ? null : cur ? cur.dead() : 'no session';
    if (why) reopen(why);
  }, checkMs);
  timer.unref?.();
  if (!initial) reopen();
  return { stop() { quit = true; clearInterval(timer); cur?.stop(); } };
}
