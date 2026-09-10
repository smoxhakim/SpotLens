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
