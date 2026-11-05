/**
 * Runs tasks with a ceiling on how many are in flight.
 *
 * Forty-five markets across two timeframes is ninety analyses, each of which
 * needs two candle requests. Firing those at once would be a burst of nearly
 * four hundred requests at a public endpoint in about a second — the kind of
 * thing that gets an IP rate-limited, and rightly so.
 *
 * Results come back in input order regardless of completion order, so a scan
 * over the same universe always produces the same list.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const ceiling = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(ceiling, items.length) }, worker));

  return results;
}

/** Pauses for `ms`, or returns immediately once `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}

/** The longest single wait `sleepUntil` makes before it reads the clock again. */
export const MAX_WAIT_STEP_MS = 30_000;

/**
 * Pauses until the wall clock reaches `wakeAt`, or returns immediately once
 * `signal` aborts.
 *
 * Node's timers do not count down while a Mac sleeps, but the wall clock does.
 * One long `sleep` therefore carries on after waking for whatever it had left,
 * which started a pass 45 minutes after the lid was opened. Waiting in short
 * steps and reading the clock after each bounds that at one step of awake time.
 *
 * It never returns before `wakeAt` by the clock it reads, so a clock set back
 * only means waiting longer. One wait is pending at a time, and each is cleared
 * or finished before the next begins. `pause` is there for tests of the script
 * that calls this, which replace `sleep` with a wait they end themselves.
 */
export async function sleepUntil(
  wakeAt: number,
  signal?: AbortSignal,
  pause: typeof sleep = sleep,
): Promise<void> {
  while (!signal?.aborted) {
    const remaining = wakeAt - Date.now();
    // Not `remaining <= 0`: a NaN must end the wait, not spin on empty timers.
    if (!(remaining > 0)) return;
    await pause(Math.min(remaining, MAX_WAIT_STEP_MS), signal);
  }
}
