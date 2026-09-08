import type { MarketRead } from "../market-read";
import type { MtfSummary } from "../mtf";
import type { EntryZone, RiskReward } from "./types";
import { GOOD_RR, MIN_ACCEPTABLE_RR } from "./types";

export type SetupGrade = "STRONG" | "MODERATE" | "WEAK" | "AVOID";

export interface ScoreCategory {
  score: number;
  max: number;
  reason: string;
}

export interface SetupScore {
  total: number;
  grade: SetupGrade;
  breakdown: {
    trend: ScoreCategory;
    supportResistance: ScoreCategory;
    volume: ScoreCategory;
    rsi: ScoreCategory;
    emaAlignment: ScoreCategory;
    riskReward: ScoreCategory;
  };
}

/** Category weights, matching the breakdown specified in the PRD. */
export const SCORE_WEIGHTS = {
  trend: 25,
  supportResistance: 25,
  volume: 15,
  rsi: 10,
  emaAlignment: 10,
  riskReward: 15,
} as const;

/**
 * Setup score, 0-100.
 *
 * A quality measure, not a probability. Nothing here predicts an outcome — it
 * measures how much of the evidence lines up, so a 78 means "most conditions
 * agree", never "78% chance of working".
 */
export function scoreSetup(
  read: MarketRead,
  entry: EntryZone,
  riskReward: RiskReward,
  mtf?: MtfSummary,
): SetupScore {
  const breakdown = {
    trend: scoreTrend(read, mtf),
    supportResistance: scoreZones(read, entry),
    volume: scoreVolume(read),
    rsi: scoreRsi(read),
    emaAlignment: scoreEma(read),
    riskReward: scoreRiskReward(riskReward),
  };

  const total = Math.round(
    Object.values(breakdown).reduce((sum, category) => sum + category.score, 0),
  );

  return { total, grade: gradeFor(total), breakdown };
}

/**
 * Higher-timeframe context adjusts the trend category rather than adding a
 * seventh one. The PRD fixes six categories summing to 100, and multi-timeframe
 * agreement is trend information — putting it anywhere else would either break
 * that breakdown or imply it measures something separate.
 */
function applyMtf(base: ScoreCategory, mtf: MtfSummary | undefined, max: number): ScoreCategory {
  if (!mtf) return base;

  switch (mtf.agreement) {
    case "ALIGNED_BULLISH":
      return {
        score: Math.min(max, base.score * 1.15),
        max,
        reason: `${base.reason} The ${mtf.higherTimeframe} trend is bullish too, so the entry trades with the higher timeframe.`,
      };
    case "PULLBACK_IN_UPTREND":
      return {
        score: Math.min(max, base.score * 1.1),
        max,
        reason: `${base.reason} The ${mtf.higherTimeframe} trend is bullish while the entry timeframe has pulled back — a dip inside a rising market.`,
      };
    case "COUNTER_TREND_BOUNCE":
      // The single most expensive mistake this tool can prevent.
      return {
        score: base.score * 0.25,
        max,
        reason: `${base.reason} The ${mtf.higherTimeframe} trend is bearish, so this is a bounce inside a downtrend rather than a trend continuation.`,
      };
    case "ALIGNED_BEARISH":
      return {
        score: 0,
        max,
        reason: `${base.reason} The ${mtf.higherTimeframe} trend is bearish as well.`,
      };
    default:
      return {
        score: base.score * 0.85,
        max,
        reason: `${base.reason} The ${mtf.higherTimeframe} trend gives no clear direction to lean on.`,
      };
  }
}

function scoreTrend(read: MarketRead, mtf?: MtfSummary): ScoreCategory {
  return applyMtf(scoreTrendBase(read), mtf, SCORE_WEIGHTS.trend);
}

function scoreTrendBase(read: MarketRead): ScoreCategory {
  const max = SCORE_WEIGHTS.trend;

  if (read.trend.conflict) {
    return {
      score: max * 0.2,
      max,
      reason:
        "Market structure and the moving averages point in opposite directions, so the trend gives little support to a long.",
    };
  }

  if (read.trend.trend === "BULLISH") {
    const score = read.trend.confidence === "HIGH" ? max : max * 0.8;
    return {
      score,
      max,
      reason: `Structure is bullish with ${read.trend.confidence.toLowerCase()} confidence, so a long trades with the trend.`,
    };
  }

  if (read.trend.trend === "SIDEWAYS") {
    return {
      score: max * 0.5,
      max,
      reason:
        "The market is ranging. Buying support in a range can work, but there is no trend behind the trade.",
    };
  }

  return {
    score: 0,
    max,
    reason:
      "The trend is bearish. Buying into a downtrend means fighting the dominant direction of the market.",
  };
}

function scoreZones(read: MarketRead, entry: EntryZone): ScoreCategory {
  const max = SCORE_WEIGHTS.supportResistance;
  const zone = entry.sourceZone;

  // The zone's own strength score already blends touches, recency and flips.
  let score = (zone.strength / 100) * max * 0.8;

  const hasTarget = read.resistance.length > 0;
  if (hasTarget) score += max * 0.2;

  const reasons = [
    `The entry zone has been tested ${zone.touches} ${
      zone.touches === 1 ? "time" : "times"
    } and scores ${zone.strength}/100 on touches, recency and whether it has flipped.`,
  ];
  reasons.push(
    hasTarget
      ? "There is a resistance level above to target."
      : "There is no resistance zone above to target, so the exit is less well defined.",
  );

  return { score: Math.min(score, max), max, reason: reasons.join(" ") };
}

function scoreVolume(read: MarketRead): ScoreCategory {
  const max = SCORE_WEIGHTS.volume;
  const volume = read.volume.read;

  if (!volume) {
    return { score: max * 0.4, max, reason: "Not enough history to judge volume; scored neutral." };
  }

  if (volume.relative >= 1.5 && volume.trend === "INCREASING") {
    return {
      score: max,
      max,
      reason:
        "Volume is well above average and building, which confirms participation in the move.",
    };
  }
  if (volume.isAboveAverage || volume.trend === "INCREASING") {
    return { score: max * 0.7, max, reason: "Volume is supportive without being decisive." };
  }
  if (volume.relative <= 0.6) {
    return {
      score: max * 0.2,
      max,
      reason: "Volume is well below average, so any move here is weakly confirmed.",
    };
  }
  return { score: max * 0.5, max, reason: "Volume is near average and adds nothing either way." };
}

function scoreRsi(read: MarketRead): ScoreCategory {
  const max = SCORE_WEIGHTS.rsi;
  const rsi = read.rsi.value;

  if (rsi === null) {
    return {
      score: max * 0.4,
      max,
      reason: "Not enough history to calculate RSI; scored neutral.",
    };
  }

  // Confirmation only. RSI never carries a setup on its own, so the spread
  // between best and worst here is deliberately narrow.
  if (rsi <= 30) {
    return {
      score: max,
      max,
      reason: `RSI at ${rsi.toFixed(1)} is oversold, which adds confirmation to buying into support.`,
    };
  }
  if (rsi < 50) {
    return {
      score: max * 0.8,
      max,
      reason: `RSI at ${rsi.toFixed(1)} has cooled off, leaving room for the move to develop.`,
    };
  }
  if (rsi <= 70) {
    return {
      score: max * 0.6,
      max,
      reason: `RSI at ${rsi.toFixed(1)} is mid-range and neither helps nor hurts the case.`,
    };
  }
  return {
    score: max * 0.2,
    max,
    reason: `RSI at ${rsi.toFixed(1)} is overbought. The move is extended, which usually means a worse entry price.`,
  };
}

function scoreEma(read: MarketRead): ScoreCategory {
  const max = SCORE_WEIGHTS.emaAlignment;

  switch (read.trend.ema.alignment) {
    case "BULLISH":
      return {
        score: max,
        max,
        reason: "Price, the EMA 20, the EMA 50 and the EMA 200 are stacked bullishly.",
      };
    case "BEARISH":
      return { score: 0, max, reason: "The moving averages are stacked bearishly." };
    case "MIXED":
      return { score: max * 0.5, max, reason: "The moving averages are mixed." };
    default:
      return {
        score: max * 0.4,
        max,
        reason: "Not enough history to calculate all moving averages; scored neutral.",
      };
  }
}

function scoreRiskReward(riskReward: RiskReward): ScoreCategory {
  const max = SCORE_WEIGHTS.riskReward;
  const { ratio } = riskReward;

  if (ratio >= 3) {
    return { score: max, max, reason: `Risk/reward of 1:${ratio.toFixed(1)} is excellent.` };
  }
  if (ratio >= GOOD_RR) {
    return { score: max * 0.8, max, reason: `Risk/reward of 1:${ratio.toFixed(1)} is good.` };
  }
  if (ratio >= MIN_ACCEPTABLE_RR) {
    return {
      score: max * 0.55,
      max,
      reason: `Risk/reward of 1:${ratio.toFixed(1)} is acceptable but not generous.`,
    };
  }
  if (ratio >= 1) {
    return {
      score: max * 0.2,
      max,
      reason: `Risk/reward of 1:${ratio.toFixed(1)} is poor — the reward does not justify the risk.`,
    };
  }
  return {
    score: 0,
    max,
    reason: `Risk/reward of 1:${ratio.toFixed(1)} means risking more than the trade stands to make.`,
  };
}

function gradeFor(total: number): SetupGrade {
  if (total >= 75) return "STRONG";
  if (total >= 60) return "MODERATE";
  if (total >= 45) return "WEAK";
  return "AVOID";
}
