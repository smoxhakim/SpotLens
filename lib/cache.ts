interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Wraps an async loader in a short in-process cache.
 *
 * Used for the curated market, asset and article lists: they change only when
 * the seed is re-run, but sat on the hot path of every candle, ticker and
 * analysis request, each of which was re-querying every row to resolve one id.
 *
 * In-process on purpose. These lists are small and identical for every user,
 * so a shared cache would add a network hop to save a query that now costs
 * nothing. The TTL is what bounds staleness after a re-seed.
 */
export function memoizeAsync<T>(load: () => Promise<T>, ttlMs: number) {
  let entry: Entry<T> | null = null;
  let inFlight: Promise<T> | null = null;

  const memoized = async (): Promise<T> => {
    const now = Date.now();
    if (entry && entry.expiresAt > now) return entry.value;

    // Share one load between concurrent callers, so a cold cache under
    // parallel requests does not fan out into several identical queries.
    inFlight ??= load()
      .then((value) => {
        entry = { value, expiresAt: Date.now() + ttlMs };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };

  memoized.invalidate = () => {
    entry = null;
  };

  return memoized;
}
