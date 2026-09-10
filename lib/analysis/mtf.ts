import type { Candle, Timeframe } from "@/lib/market-data/provider";
import { TIMEFRAMES, TIMEFRAME_LABELS } from "@/lib/market-data/provider";

import { explainTrend } from "./explain/trend";
import { DEFAULT_SWING_LOOKBACK } from "./structure";
import { detectTrend, type Trend } from "./trend";

/**
 * How the two timeframes relate.
 *
 * The two "disagreement" cases are deliberately not one category, because they
 * are opposites in practice:
 *
 *  - PULLBACK_IN_UPTREND (higher bullish, lower bearish) is the setup this
 *    whole product is built to find — a dip inside a rising market.
 *  - COUNTER_TREND_BOUNCE (higher bearish, lower bullish) is the trap that
 *    ruins retail spot traders — a rally inside a falling market that looks
 *    identical on the lower timeframe.
 *
 * Collapsing both into "conflict" would treat the best case and the worst case
 * the same way.
 */
export type MtfAgreement =
  "ALIGNED_BULLISH" | "ALIGNED_BEARISH" | "PULLBACK_IN_UPTREND" | "COUNTER_TREND_BOUNCE" | "MIXED";

export interface MtfSummary {
  higherTimeframe: Timeframe;
  higherTrend: Trend;
  higherReason: string;
  lowerTimeframe: Timeframe;
  lowerTrend: Trend;
  lowerReason: string;
  agreement: MtfAgreement;
  /** Set only when the higher timeframe argues against the lower one. */
  conflictNote: string | null;
  note: string;
}

/**
 * The higher timeframe each timeframe is read against. One step up: two steps
 * is too coarse to inform an entry, and the same step is no context at all.
 */
export const HIGHER_TIMEFRAME: Record<Timeframe, Timeframe | null> = {
  M1: "M5",
  M5: "M15",
  M15: "H1",
  H1: "H4",
  H4: "D1",
  D1: "W1",
  W1: null,
};

/**
 * Short labels for each classification.
 *
 * Here rather than in a component because the classification is a piece of
 * strategy, not of presentation: the dashboard, an explanation list and a
 * future notification all have to call a counter-trend bounce the same thing.
 */
export const MTF_AGREEMENT_LABELS: Record<MtfAgreement, string> = {
  ALIGNED_BULLISH: "Timeframes aligned",
  ALIGNED_BEARISH: "Both bearish",
  PULLBACK_IN_UPTREND: "Pullback in an uptrend",
  COUNTER_TREND_BOUNCE: "Counter-trend bounce",
  MIXED: "No clear higher-timeframe direction",
};

export function defaultHigherTimeframe(lower: Timeframe): Timeframe | null {
  return HIGHER_TIMEFRAME[lower];
}

/** True when the pair is a sensible bias/entry combination. */
export function isValidTimeframePair(lower: Timeframe, higher: Timeframe): boolean {
  // Derived from TIMEFRAMES, which is ordered shortest to longest, so adding a
  // timeframe cannot leave a stale copy of the ordering behind.
  return TIMEFRAMES.indexOf(higher) > TIMEFRAMES.indexOf(lower);
}

export function analyzeMultiTimeframe(input: {
  lowerCandles: Candle[];
  higherCandles: Candle[];
  lowerTimeframe: Timeframe;
  higherTimeframe: Timeframe;
  swingLookback?: number;
}): MtfSummary {
  const lookback = input.swingLookback ?? DEFAULT_SWING_LOOKBACK;

  const lower = detectTrend(input.lowerCandles, lookback);
  const higher = detectTrend(input.higherCandles, lookback);

  const agreement = classify(higher.trend, lower.trend);

  return {
    higherTimeframe: input.higherTimeframe,
    higherTrend: higher.trend,
    higherReason: explainTrend(higher),
    lowerTimeframe: input.lowerTimeframe,
    lowerTrend: lower.trend,
    lowerReason: explainTrend(lower),
    agreement,
    conflictNote: conflictNoteFor(agreement, input.higherTimeframe, input.lowerTimeframe),
    note: noteFor(
      agreement,
      input.higherTimeframe,
      input.lowerTimeframe,
      higher.trend,
      lower.trend,
    ),
  };
}

function classify(higher: Trend, lower: Trend): MtfAgreement {
  if (higher === "BULLISH" && lower === "BULLISH") return "ALIGNED_BULLISH";
  if (higher === "BEARISH" && lower === "BEARISH") return "ALIGNED_BEARISH";
  if (higher === "BULLISH" && lower === "BEARISH") return "PULLBACK_IN_UPTREND";
  if (higher === "BEARISH" && lower === "BULLISH") return "COUNTER_TREND_BOUNCE";
  return "MIXED";
}

function conflictNoteFor(
  agreement: MtfAgreement,
  higher: Timeframe,
  lower: Timeframe,
): string | null {
  if (agreement === "COUNTER_TREND_BOUNCE") {
    return `Warning: the ${TIMEFRAME_LABELS[lower]} trend is bullish, but the ${TIMEFRAME_LABELS[higher]} trend is still bearish. A rally inside a downtrend looks identical to the start of a reversal on the lower timeframe, and most of them fail.`;
  }
  if (agreement === "ALIGNED_BEARISH") {
    return `Both the ${TIMEFRAME_LABELS[lower]} and ${TIMEFRAME_LABELS[higher]} trends are bearish. There is no long setup here worth taking.`;
  }
  return null;
}

function noteFor(
  agreement: MtfAgreement,
  higher: Timeframe,
  lower: Timeframe,
  higherTrend: Trend,
  lowerTrend: Trend,
): string {
  const H = TIMEFRAME_LABELS[higher];
  const L = TIMEFRAME_LABELS[lower];

  switch (agreement) {
    case "ALIGNED_BULLISH":
      return `Both timeframes agree: ${H} and ${L} are bullish. An entry here trades with the dominant trend rather than against it.`;
    case "ALIGNED_BEARISH":
      return `Both timeframes are bearish. ${H} sets the direction and ${L} confirms it, so there is nothing to buy into.`;
    case "PULLBACK_IN_UPTREND":
      return `The ${H} trend is bullish while ${L} has turned down. That is what a pullback looks like — the higher timeframe still favours buyers, and the lower timeframe is offering a better price. This is the combination worth waiting for, provided the ${L} chart shows a bullish reaction at support.`;
    case "COUNTER_TREND_BOUNCE":
      return `The ${L} trend has turned bullish but ${H} remains bearish. Buying here means trading against the timeframe that sets direction.`;
    default:
      return `${H} is ${higherTrend.toLowerCase()} and ${L} is ${lowerTrend.toLowerCase()}. Without a clear higher-timeframe direction there is less context behind any entry.`;
  }
}
