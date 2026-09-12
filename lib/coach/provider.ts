import { cachedReview, rememberReview } from "./cache";
import { buildDeterministicReview } from "./review";
import { FORBIDDEN_PHRASES, isSafeReview } from "./rules";
import type { CoachContext, CoachReview } from "./types";

/**
 * Where a reading comes from.
 *
 * An interface with one shipped implementation, rather than a call site: the
 * deterministic reviewer is the Coach today, and a model-backed one can be
 * added later without any other file learning that it exists.
 *
 * A provider is deliberately weak. It receives a finished `CoachContext` and
 * returns prose; it cannot fetch anything, cannot see the database, and cannot
 * change a number — every figure a reader sees is rendered from the context,
 * which travels alongside the review rather than through it. A provider that
 * hallucinated an entry price would produce text nobody reads a price from.
 *
 * No model is called today. The repository has no AI integration and none is
 * added here: every section the Coach shows is derived from facts the engine
 * already recorded, so a network round trip and a third-party secret would buy
 * fluency and cost determinism, reviewability and an injection surface. The
 * seam exists so that choice can be revisited without a rewrite.
 */
export interface CoachProvider {
  readonly id: string;
  review(context: CoachContext): Promise<CoachReview>;
}

/** The shipped provider: pure, offline, reproducible. */
export const deterministicProvider: CoachProvider = {
  id: "deterministic",
  async review(context) {
    return buildDeterministicReview(context);
  },
};

export class CoachProviderError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
  ) {
    super(message);
    this.name = "CoachProviderError";
  }
}

/**
 * Runs a provider, and refuses to pass on a reading that fails the rules.
 *
 * Two things can go wrong with a provider that is not this one: it can fail,
 * and it can answer with something it should not have said. Both end the same
 * way — the deterministic review, which is always available because it needs
 * nothing but the context already in hand. The Coach degrades to its own
 * reading rather than to an error page, and the analysis underneath is
 * untouched either way.
 *
 * The failure is reported alongside, never as raw provider text: a message
 * from a provider is the one place a key or an internal URL could surface.
 */
export async function reviewWith(
  provider: CoachProvider,
  context: CoachContext,
): Promise<{ review: CoachReview; degraded: boolean }> {
  if (provider.id === deterministicProvider.id) {
    return { review: await provider.review(context), degraded: false };
  }

  // A frozen context asked twice is the same question. Only tracked setups are
  // eligible, and the key covers every field — see `cache.ts`.
  const remembered = cachedReview(context, provider.id);
  if (remembered) return { review: remembered, degraded: false };

  try {
    const review = await provider.review(context);

    if (!isSafeReview(review)) {
      return { review: buildDeterministicReview(context), degraded: true };
    }

    // The numbers never come from a provider, so there is nothing to check
    // them against — they are rendered from the context. What is checked is
    // that the provider did not put language in the review that the product
    // does not permit, which `isSafeReview` decides against FORBIDDEN_PHRASES.
    //
    // Only a reading that passed is remembered: caching a refused one would
    // mean serving it without the check that refused it.
    rememberReview(context, provider.id, review);
    return { review, degraded: false };
  } catch {
    // A provider failing is not an error the reader needs to see. The
    // deterministic reading needs nothing but the context already in hand, so
    // the page degrades to it rather than to an error — and the analysis
    // underneath is untouched either way. The provider's own message is
    // discarded here rather than surfaced: it is the one place a key could be.
    return { review: buildDeterministicReview(context), degraded: true };
  }
}

export { FORBIDDEN_PHRASES };
