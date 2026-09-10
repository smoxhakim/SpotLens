import type { ConfirmationResult } from "../confirmation";
import { explainStructure } from "../explain/trend";
import type { MarketRead } from "../market-read";
import { type MtfAgreement, type MtfSummary, MTF_AGREEMENT_LABELS } from "../mtf";
import { EXTENDED_ATR_MULTIPLE } from "../setup/entry";
import type { SetupScore } from "../setup/score";
import { STATUS_LABELS } from "../setup/status";
import type { AnalysisResult } from "../setup";
import type { RiskReward, TradeSetup, TradeStatus } from "../setup/types";
import { GOOD_RR } from "../setup/types";
import { EXPLANATION_ORDER, type Explanation, type ExplanationSignal } from "./types";

/**
 * Turns a finished analysis into the ordered structured explanation list.
 *
 * ## What this is allowed to do
 *
 * Read `AnalysisResult` and phrase it. That is the whole contract. It performs
 * no arithmetic that could change a verdict, holds no thresholds of its own
 * beyond the ones it imports from the engine, and cannot produce a number the
 * engine did not already produce.
 *
 * ## Why the signal is not simply "is the market going up"
 *
 * Every setup this product describes is a long, so `positive` means "supports
 * buying here". That is why a risk/reward of 1:2.5 can be `negative`: when the
 * ratio was measured to a fallback target rather than a level price has
 * reacted to, the healthy-looking number is the fallback multiple restating
 * itself, and Phase A already scores it zero. The explanation has to agree
 * with the score, or the two halves of the product would be arguing.
 *
 * ## Omission is meaningful
 *
 * A category with nothing to say is left out. There is no PRICE_POSITION entry
 * when no entry zone exists, and no CONFIRMATION entry when there is no
 * checklist to satisfy — inventing one would be filling space with a sentence
 * the analysis never justified.
 */
export function buildExplanations(result: AnalysisResult): Explanation[] {
  const explanations: Explanation[] = [
    trendExplanation(result.read),
    mtfExplanation(result.mtf),
    structureExplanation(result.read),
    zoneExplanation(result.read),
    momentumExplanation(result.read),
    volumeExplanation(result.read),
    pricePositionExplanation(result.setup),
    riskRewardExplanation(result.setup, result.score),
    confirmationExplanation(result.setup, result.confirmation),
    statusExplanation(result.status, result.statusReason),
  ].filter((entry): entry is Explanation => entry !== null);

  // The list is assembled in order already; sorting by the declared order as
  // well means adding a builder in the wrong place cannot silently reorder a
  // consumer's output.
  return explanations.sort(
    (a, b) => EXPLANATION_ORDER.indexOf(a.category) - EXPLANATION_ORDER.indexOf(b.category),
  );
}

function trendExplanation(read: MarketRead): Explanation {
  const { trend, confidence, conflict } = read.trend;

  if (conflict) {
    return {
      id: "TREND:conflict",
      category: "TREND",
      signal: "neutral",
      title: "Trend unclear",
      detail: read.trend.reason,
    };
  }

  const signal: ExplanationSignal =
    trend === "BULLISH" ? "positive" : trend === "BEARISH" ? "negative" : "neutral";

  const title =
    trend === "BULLISH"
      ? `Bullish trend (${confidence.toLowerCase()} confidence)`
      : trend === "BEARISH"
        ? `Bearish trend (${confidence.toLowerCase()} confidence)`
        : "Sideways — no clear trend";

  return {
    id: `TREND:${trend.toLowerCase()}`,
    category: "TREND",
    signal,
    title,
    detail: read.trend.reason,
  };
}

/** How each higher-timeframe classification bears on a long. */
const MTF_SIGNAL: Record<MtfAgreement, ExplanationSignal> = {
  ALIGNED_BULLISH: "positive",
  PULLBACK_IN_UPTREND: "positive",
  ALIGNED_BEARISH: "negative",
  COUNTER_TREND_BOUNCE: "negative",
  MIXED: "neutral",
};

function mtfExplanation(mtf: MtfSummary | null): Explanation | null {
  // A single-timeframe run has no higher-timeframe context, and saying so would
  // be reporting the absence of a question rather than an answer.
  if (!mtf) return null;

  return {
    id: `MTF:${mtf.agreement.toLowerCase().replace(/_/g, "-")}`,
    category: "MTF",
    signal: MTF_SIGNAL[mtf.agreement],
    title: MTF_AGREEMENT_LABELS[mtf.agreement],
    // The conflict note is the veto in the engine's own words, so it leads.
    detail: mtf.conflictNote ? `${mtf.conflictNote} ${mtf.note}` : mtf.note,
  };
}

function structureExplanation(read: MarketRead): Explanation {
  const structure = read.trend.structure.structure;

  const signal: ExplanationSignal =
    structure === "UPTREND" ? "positive" : structure === "DOWNTREND" ? "negative" : "neutral";

  const title =
    structure === "UPTREND"
      ? "Higher highs and higher lows"
      : structure === "DOWNTREND"
        ? "Lower highs and lower lows"
        : structure === "RANGING"
          ? "Ranging structure"
          : "Structure not yet readable";

  return {
    id: `STRUCTURE:${structure.toLowerCase()}`,
    category: "STRUCTURE",
    signal,
    title,
    detail: explainStructure(read.trend.structure),
  };
}

function zoneExplanation(read: MarketRead): Explanation {
  const nearestResistance = read.resistance[0];
  const hasSupport = read.support.length > 0;

  if (!hasSupport && !nearestResistance) {
    return {
      id: "SUPPORT_RESISTANCE:none",
      category: "SUPPORT_RESISTANCE",
      signal: "neutral",
      title: "No clear zones",
      detail: read.zonesReason,
    };
  }

  // The same condition the status engine treats as high risk: entering
  // directly beneath a level that has rejected price before.
  if (nearestResistance && read.price >= nearestResistance.low) {
    return {
      id: "SUPPORT_RESISTANCE:price-in-resistance",
      category: "SUPPORT_RESISTANCE",
      signal: "negative",
      title: "Price is inside resistance",
      detail: read.zonesReason,
    };
  }

  if (!hasSupport) {
    return {
      id: "SUPPORT_RESISTANCE:no-support",
      category: "SUPPORT_RESISTANCE",
      signal: "negative",
      title: "No support below to anchor to",
      detail: read.zonesReason,
    };
  }

  return {
    id: nearestResistance
      ? "SUPPORT_RESISTANCE:support-and-target"
      : "SUPPORT_RESISTANCE:support-only",
    category: "SUPPORT_RESISTANCE",
    signal: "positive",
    title: nearestResistance ? "Support below, resistance above" : "Support below, no target above",
    detail: read.zonesReason,
  };
}

/**
 * RSI, reported only where it and the scoring engine agree.
 *
 * The two describe RSI differently on purpose: `explainRsi` reads it as
 * direction ("leans bearish" in the lower half), while `scoreRsi` reads it as
 * entry quality for a long (a cooled-off reading leaves room for the move).
 * Both are right about their own question, so the signal here is only committed
 * at the extremes, where they say the same thing: oversold adds confirmation to
 * buying support, overbought means the move is extended and the entry worse.
 * Everything between is `neutral`, which is also what the prose says.
 */
function momentumExplanation(read: MarketRead): Explanation {
  const rsi = read.rsi.value;

  if (rsi === null) {
    return {
      id: "MOMENTUM:unavailable",
      category: "MOMENTUM",
      signal: "neutral",
      title: "RSI unavailable",
      detail: read.rsi.reason,
    };
  }

  if (rsi <= 30) {
    return {
      id: "MOMENTUM:oversold",
      category: "MOMENTUM",
      signal: "positive",
      title: `RSI ${rsi.toFixed(1)} — oversold`,
      detail: read.rsi.reason,
    };
  }

  if (rsi > 70) {
    return {
      id: "MOMENTUM:overbought",
      category: "MOMENTUM",
      signal: "negative",
      title: `RSI ${rsi.toFixed(1)} — overbought`,
      detail: read.rsi.reason,
    };
  }

  return {
    id: "MOMENTUM:mid-range",
    category: "MOMENTUM",
    signal: "neutral",
    title: `RSI ${rsi.toFixed(1)} — mid-range`,
    detail: read.rsi.reason,
  };
}

/** Volume bands, matching the ones `scoreVolume` already uses. */
function volumeExplanation(read: MarketRead): Explanation {
  const volume = read.volume.read;

  if (!volume) {
    return {
      id: "VOLUME:unavailable",
      category: "VOLUME",
      signal: "neutral",
      title: "Volume unavailable",
      detail: read.volume.reason,
    };
  }

  const relative = `${volume.relative.toFixed(1)}× average`;

  if (volume.relative >= 1.5 && volume.trend === "INCREASING") {
    return {
      id: "VOLUME:strong",
      category: "VOLUME",
      signal: "positive",
      title: `Volume ${relative} and building`,
      detail: read.volume.reason,
    };
  }

  if (volume.isAboveAverage || volume.trend === "INCREASING") {
    return {
      id: "VOLUME:supportive",
      category: "VOLUME",
      signal: "positive",
      title: `Volume ${relative} — supportive`,
      detail: read.volume.reason,
    };
  }

  if (volume.relative <= 0.6) {
    return {
      id: "VOLUME:thin",
      category: "VOLUME",
      signal: "negative",
      title: `Volume ${relative} — thin`,
      detail: read.volume.reason,
    };
  }

  return {
    id: "VOLUME:average",
    category: "VOLUME",
    signal: "neutral",
    title: `Volume ${relative} — unremarkable`,
    detail: read.volume.reason,
  };
}

function pricePositionExplanation(setup: TradeSetup | null): Explanation | null {
  // No entry zone means there is no position to be in or out of.
  if (!setup) return null;

  const { entry } = setup;

  if (entry.priceInZone) {
    return {
      id: "PRICE_POSITION:in-zone",
      category: "PRICE_POSITION",
      signal: "positive",
      title: "Price is in the entry zone",
      detail: entry.reason,
    };
  }

  if (entry.distanceAtr > EXTENDED_ATR_MULTIPLE) {
    return {
      id: "PRICE_POSITION:extended",
      category: "PRICE_POSITION",
      signal: "negative",
      title: `Price is ${entry.distanceAtr.toFixed(1)} ATR above the zone`,
      detail: `${entry.reason} Buying at this distance means chasing rather than waiting for the level.`,
    };
  }

  return {
    id: "PRICE_POSITION:approaching",
    category: "PRICE_POSITION",
    signal: "neutral",
    title: "Price has not reached the entry zone",
    detail: entry.reason,
  };
}

/**
 * Risk/reward, respecting the Phase A rule exactly.
 *
 * An unmeasured reward is `negative`, never `neutral`. Neutral would read as
 * "no strong opinion" about a setup the engine scores zero on, and the ratio
 * printed beside it looks healthy — which is precisely the impression Phase A
 * exists to prevent.
 */
function riskRewardExplanation(
  setup: TradeSetup | null,
  score: SetupScore | null,
): Explanation | null {
  if (setup) return riskRewardFromSetup(setup.riskReward);

  // An AVOID withholds the levels but keeps the score, so the reasoning behind
  // the refusal survives even though the ratio itself is no longer on offer.
  const category = score?.breakdown.riskReward;
  if (!category) return null;

  const fraction = category.max === 0 ? 0 : category.score / category.max;

  return {
    id: "RISK_REWARD:from-score",
    category: "RISK_REWARD",
    signal: fraction >= 0.8 ? "positive" : fraction < 0.5 ? "negative" : "neutral",
    title: "Reward against risk",
    detail: category.reason,
  };
}

function riskRewardFromSetup(riskReward: RiskReward): Explanation {
  const ratio = `1:${riskReward.ratio.toFixed(1)}`;

  if (riskReward.isSynthetic) {
    return {
      id: "RISK_REWARD:synthetic",
      category: "RISK_REWARD",
      signal: "negative",
      title: "No measurable structural target",
      detail: `${riskReward.reason} It therefore earns nothing towards the setup score, and the ${ratio} figure should not be read as a comparable reward.`,
    };
  }

  if (riskReward.isPoor) {
    return {
      id: "RISK_REWARD:poor",
      category: "RISK_REWARD",
      signal: "negative",
      title: `Risk/reward ${ratio} — below the minimum`,
      detail: riskReward.reason,
    };
  }

  return {
    id: riskReward.ratio >= GOOD_RR ? "RISK_REWARD:good" : "RISK_REWARD:acceptable",
    category: "RISK_REWARD",
    signal: "positive",
    title: `Risk/reward ${ratio} to ${riskReward.measuredTo}`,
    detail: riskReward.reason,
  };
}

/**
 * What the market has actually done at the level.
 *
 * Until the confirmation engine existed this could only ever restate the entry
 * checklist, because nothing computed whether any of it had happened. It now
 * reports the deterministic verdict, and falls back to the checklist only when
 * there is no confirmation result to report.
 */
function confirmationExplanation(
  setup: TradeSetup | null,
  confirmation: ConfirmationResult | null,
): Explanation | null {
  if (!setup) return null;

  if (confirmation) {
    if (confirmation.status === "PRESENT") {
      return {
        id: "CONFIRMATION:present",
        category: "CONFIRMATION",
        signal: "positive",
        title: `Confirmed by ${confirmation.signals.filter((s) => s.signal === "positive").length} signals`,
        detail: confirmation.explanation,
      };
    }

    if (confirmation.status === "CONTRADICTED") {
      return {
        id: "CONFIRMATION:contradicted",
        category: "CONFIRMATION",
        signal: "negative",
        title: "Confirmation is contradicted",
        detail: confirmation.explanation,
      };
    }

    return {
      id: "CONFIRMATION:not-present",
      category: "CONFIRMATION",
      signal: "neutral",
      title: "Confirmation still to be seen",
      detail: confirmation.explanation,
    };
  }

  if (setup.entry.confirmations.length === 0) return null;

  return {
    id: "CONFIRMATION:checklist",
    category: "CONFIRMATION",
    signal: "neutral",
    title: "Confirmation still to be seen",
    detail: `Before entering, look for: ${setup.entry.confirmations.join(" ")}`,
  };
}

/** How each verdict bears on taking the trade. */
const STATUS_SIGNAL: Record<TradeStatus, ExplanationSignal> = {
  POTENTIAL_SETUP: "positive",
  WAIT_FOR_CONFIRMATION: "neutral",
  HIGH_RISK: "negative",
  AVOID: "negative",
};

function statusExplanation(status: TradeStatus, statusReason: string): Explanation {
  return {
    id: `STATUS:${status.toLowerCase().replace(/_/g, "-")}`,
    category: "STATUS",
    signal: STATUS_SIGNAL[status],
    title: STATUS_LABELS[status].label,
    // The engine's own reason, unaltered. It already names the specific
    // condition that decided the verdict — the veto, the missing target, the
    // distance from the zone — which is what makes a no-trade answer useful.
    detail: statusReason,
  };
}
