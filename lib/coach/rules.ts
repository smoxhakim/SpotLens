import type { CoachReview } from "./types";

/**
 * What the Coach may not say.
 *
 * Two kinds of thing are banned here and they fail differently. The first is
 * certainty — "guaranteed", "risk-free" — which is false whatever the chart
 * shows. The second is instruction — "buy now", "enter immediately" — which
 * would move the decision from the reader to the tool, and the product's whole
 * position is that it does not.
 *
 * Kept as a list rather than a judgement so it can be checked mechanically,
 * both in tests and on any future provider's output before it is shown.
 */
export const FORBIDDEN_PHRASES = [
  // Certainty
  "guaranteed",
  "guarantee",
  "certain profit",
  "risk-free",
  "riskless",
  "safe trade",
  "easy money",
  "easy profit",
  "sure thing",
  "can't lose",
  "cannot lose",
  "will pump",
  "will dump",
  "will go up",
  "will go down",
  // Instruction
  "buy now",
  "sell now",
  "must buy",
  "must sell",
  "should buy",
  "should sell",
  "enter now",
  "enter immediately",
  "execute",
  "place order",
  "place an order",
  "take the trade",
  // Urgency
  "don't miss",
  "do not miss",
  "act now",
  "last chance",
  "won't come again",
  "hurry",
  // Score as probability
  "probability",
  "chance of success",
  "odds of",
  "likely to win",
  "win rate for this",
] as const;

/** Every line of a review, as one string, for checking. */
function allText(review: CoachReview): string {
  const sections = [
    review.strengths,
    review.concerns,
    review.confirmationReview,
    review.riskRewardReview,
    review.invalidationReview,
    review.chartChecks,
  ];

  return [review.summary, ...sections.flatMap((s) => [s.title, ...s.points])]
    .join(" ")
    .toLowerCase();
}

/**
 * Whether a review is fit to show.
 *
 * Applied to a *provider's* output, not to the deterministic reviewer's, which
 * has its own tests: running it on both would let a phrase banned here quietly
 * rewrite text this repository controls, and a failing test is the better way
 * to learn about that.
 *
 * A percent sign is refused deliberately — there is no figure in a Coach review
 * that belongs in percent, and the one that would try is the quality score. The
 * one legitimate exception is the engine's own reason text, which can say
 * something like "below 60% of average" and is quoted verbatim rather than
 * rewritten. A foreign provider echoing that will be refused and the
 * deterministic reading shown instead, which is the safe direction to err in.
 */
export function isSafeReview(review: CoachReview): boolean {
  const text = allText(review);

  if (text.includes("%")) return false;
  return !FORBIDDEN_PHRASES.some((phrase) => text.includes(phrase));
}

/** The offending phrases, for a test that wants to say which one fired. */
export function forbiddenPhrasesIn(review: CoachReview): string[] {
  const text = allText(review);
  return FORBIDDEN_PHRASES.filter((phrase) => text.includes(phrase));
}
