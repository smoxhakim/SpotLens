/**
 * Structured explanations.
 *
 * A separate layer from `../explain`, and the distinction is worth stating:
 * `explain/` writes individual sentences that the engine embeds in its own
 * output (`read.trend.reason` and friends). This directory assembles a
 * finished analysis into an ordered, categorised, signal-tagged list that a
 * consumer can render without knowing any trading rules.
 *
 * Nothing here computes. The builder is a pure function of an `AnalysisResult`,
 * which means every consumer — the analysis page today, a scanner or a
 * notification later — derives the same reasoning from the same result without
 * a further request, a stored column, or a second opinion.
 */
export { buildExplanations } from "./build";
export {
  EXPLANATION_ORDER,
  EXPLANATION_CATEGORY_LABELS,
  type Explanation,
  type ExplanationCategory,
  type ExplanationSignal,
} from "./types";
