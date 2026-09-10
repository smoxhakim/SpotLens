/**
 * The structured explanation model.
 *
 * One analysis produces one ordered list of these. Everything in a list is
 * derived from an `AnalysisResult` that has already been computed — the builder
 * reads deterministic output and phrases it, exactly as `explain/` does for
 * individual sentences. It never calculates, never re-derives an indicator, and
 * never reaches the network.
 *
 * The point of the shape is that a consumer can render it without knowing any
 * trading rules. A dashboard, a Telegram message and a journal entry each need
 * the same reasoning in a different form, and the alternative — each one
 * re-deciding what "counter-trend bounce" should read like — is how the same
 * verdict starts being worded three different ways.
 */

export type ExplanationCategory =
  | "TREND"
  | "MTF"
  | "STRUCTURE"
  | "SUPPORT_RESISTANCE"
  | "MOMENTUM"
  | "VOLUME"
  | "PRICE_POSITION"
  | "RISK_REWARD"
  | "CONFIRMATION"
  | "STATUS";

/**
 * Whether the factor supports the setup, weakens it, or does neither.
 *
 * Always read against the only trade this product describes: a long. "Negative"
 * therefore means "argues against buying here", not "the market is falling".
 *
 * `neutral` is the honest answer both when a factor genuinely sits in the
 * middle and when the input could not be computed. It is never a consolation
 * prize: a factor that weakens the setup is `negative` even when the number
 * attached to it looks respectable, which is the whole point of the
 * risk/reward case below.
 */
export type ExplanationSignal = "positive" | "negative" | "neutral";

export interface Explanation {
  /**
   * Stable identity for this explanation, `category:discriminator`.
   *
   * Derived from the verdict rather than from position in the list, so it can
   * be used as a render key, and later to recognise that a setup is still
   * saying the same thing it said an hour ago.
   */
  id: string;
  category: ExplanationCategory;
  signal: ExplanationSignal;
  /** A few words. The line a reader scans. */
  title: string;
  /** The reasoning, in the wording the engine already uses. */
  detail: string;
}

/**
 * The order categories are always presented in: context first, then the
 * evidence, then the verdict that follows from it.
 *
 * Fixed rather than sorted per result, so two analyses of the same market read
 * as comparable documents. A category with nothing to say is omitted, never
 * padded.
 */
export const EXPLANATION_ORDER: ExplanationCategory[] = [
  "TREND",
  "MTF",
  "STRUCTURE",
  "SUPPORT_RESISTANCE",
  "MOMENTUM",
  "VOLUME",
  "PRICE_POSITION",
  "RISK_REWARD",
  "CONFIRMATION",
  "STATUS",
];

/** Human labels for the categories, for any consumer that groups by them. */
export const EXPLANATION_CATEGORY_LABELS: Record<ExplanationCategory, string> = {
  TREND: "Trend",
  MTF: "Higher timeframe",
  STRUCTURE: "Market structure",
  SUPPORT_RESISTANCE: "Support / resistance",
  MOMENTUM: "Momentum",
  VOLUME: "Volume",
  PRICE_POSITION: "Price position",
  RISK_REWARD: "Risk / reward",
  CONFIRMATION: "Confirmation",
  STATUS: "Verdict",
};
