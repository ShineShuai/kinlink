const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keeps one session alive for an unattended Host. open() -> { dead(): string | null, stop() }.
// Reopens when the session reports a reason (link or channel gone, no broker, new client offers)
// and retries when opening failed, never more often than every minMs.
export function supervise(open, { checkMs = 3000, minMs = 5000, onlog = () => {} } = {}) {
  let cur;
  let busy = false;
  let quit = false;
  let last = 0;
  const reopen = async (why) => {
    if (busy || quit) return;
    busy = true;
    try {
      cur?.stop();
      cur = undefined;
      const wait = last + minMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      onlog(why ? `host: restart (${why})` : 'host: start');
      cur = await open();
      if (quit) cur.stop();
    } catch (e) {
      onlog(`host: open failed: ${e.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    const why = busy || quit ? null : cur ? cur.dead() : 'no session';
    if (why) reopen(why);
  }, checkMs);
  timer.unref?.();
  reopen();
  return { stop() { quit = true; clearInterval(timer); cur?.stop(); } };
}
