import type { CoachContext, CoachReview } from "./types";

/**
 * Remembering a review for a context that cannot change.
 *
 * A tracked setup's context is frozen — the snapshot is immutable and the
 * confirmation comes from the event written with it — so asking twice is asking
 * the same question, and paying a provider twice for the same answer is waste
 * rather than freshness.
 *
 * The key is derived from the whole context rather than from a symbol. Keying
 * on `BTCUSDT` alone would hand one setup's review to a different setup on the
 * same market, which is the obvious way to get this badly wrong: every field
 * that could differ is in the key, so two contexts that differ anywhere cannot
 * collide.
 *
 * In-process and bounded. SpotLens is a local, single-user application; Redis
 * for a handful of reviews a day would be a moving part bought for nothing.
 * A restart loses the cache, which costs one request.
 */

const MAX_ENTRIES = 64;

/** Insertion-ordered, so the oldest key is the first one `keys()` yields. */
const cache = new Map<string, CoachReview>();

/**
 * A stable fingerprint of everything the review was built from.
 *
 * `JSON.stringify` over the context is enough because the context is built
 * deterministically: its fields are written in a fixed order and its arrays are
 * sorted, so the same record always serialises identically. The provider id is
 * part of the key too — a review written by one model is not a review by
 * another, and switching models should not serve the old one.
 */
export function cacheKeyFor(context: CoachContext, providerId: string): string {
  return `${providerId}::${JSON.stringify(context)}`;
}

/**
 * A cached review, when the same question has already been answered.
 *
 * Only a *tracked* setup is eligible. An untracked candidate's context is built
 * from a scanner result that a later pass could replace, and caching something
 * that can change is how a stale answer outlives the thing it described.
 */
export function cachedReview(context: CoachContext, providerId: string): CoachReview | null {
  if (context.identity.setupId === null) return null;
  return cache.get(cacheKeyFor(context, providerId)) ?? null;
}

export function rememberReview(
  context: CoachContext,
  providerId: string,
  review: CoachReview,
): void {
  if (context.identity.setupId === null) return;

  const key = cacheKeyFor(context, providerId);
  // Re-inserting moves the key to the end, so a review that keeps being read
  // keeps its place and the least recently stored one is evicted first.
  cache.delete(key);
  cache.set(key, review);

  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** For tests, and for nothing else. */
export function clearCoachCache(): void {
  cache.clear();
}

export function coachCacheSize(): number {
  return cache.size;
}
