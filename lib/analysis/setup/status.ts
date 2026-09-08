import { formatPrice } from "@/lib/format";

import type { MarketRead } from "../market-read";
import type { MtfSummary } from "../mtf";
import { EXTENDED_ATR_MULTIPLE } from "./entry";
import type { SetupScore } from "./score";
import type { EntryZone, RiskReward, TradeStatus } from "./types";

export interface StatusVerdict {
  status: TradeStatus;
  reason: string;
}

/**
 * Trade status.
 *
 * The rules are ordered so that every disqualifying condition is checked before
 * anything can return POTENTIAL_SETUP. That ordering is the product: a tool
 * that must actively rule out every objection before it says "possible" will
 * say "wait" far more often than one that looks for reasons to say yes, and
 * saying wait is almost always the more valuable answer.
 */
export function determineStatus(
  read: MarketRead,
  entry: EntryZone,
  riskReward: RiskReward,
  score: SetupScore,
  mtf?: MtfSummary,
): StatusVerdict {
  // --- Disqualifying conditions ------------------------------------------

  // Checked before the entry timeframe's own trend: a lower timeframe that has
  // turned up inside a falling higher timeframe looks like a clean setup on its
  // own chart, which is exactly why it needs to be ruled out first.
  if (mtf?.agreement === "COUNTER_TREND_BOUNCE") {
    return {
      status: "AVOID",
      reason: `${mtf.conflictNote} The higher timeframe sets direction, and buying against it is the most common way a setup that looks good on one chart loses money.`,
    };
  }

  if (mtf?.agreement === "ALIGNED_BEARISH") {
    return {
      status: "AVOID",
      reason: mtf.conflictNote ?? "Both timeframes are bearish, so there is no long setup here.",
    };
  }

  if (read.trend.trend === "BEARISH") {
    return {
      status: "AVOID",
      reason:
        "The trend is bearish. Buying into a downtrend is the most reliable way to lose money on spot, and no support level is worth taking that trade before structure turns.",
    };
  }

  if (riskReward.ratio < 1) {
    return {
      status: "AVOID",
      reason: `Risk/reward is 1:${riskReward.ratio.toFixed(
        1,
      )} — the trade risks more than it stands to make. Even a high win rate loses money at this ratio.`,
    };
  }

  if (score.grade === "AVOID") {
    return {
      status: "AVOID",
      reason: `The setup scores ${score.total}/100. Too little of the evidence supports the trade to justify taking it.`,
    };
  }

  // --- High risk ----------------------------------------------------------

  if (riskReward.isPoor) {
    return {
      status: "HIGH_RISK",
      reason: `Risk/reward is only 1:${riskReward.ratio.toFixed(
        1,
      )}, below the 1:1.5 minimum. The setup is not broken, but the payoff does not justify the capital at risk.`,
    };
  }

  if (read.insufficientData) {
    return {
      status: "HIGH_RISK",
      reason: `Only ${read.candleCount} candles of history are available on this timeframe. There is not enough data behind these levels to rely on them.`,
    };
  }

  const nearestResistance = read.resistance[0];
  if (nearestResistance && read.price >= nearestResistance.low) {
    return {
      status: "HIGH_RISK",
      reason: `Price is already trading in the resistance zone at ${formatPrice(
        nearestResistance.low,
      )} – ${formatPrice(
        nearestResistance.high,
      )}. Entering directly beneath a level that has rejected price before gives away most of the reward.`,
    };
  }

  // --- Wait ---------------------------------------------------------------

  if (!entry.priceInZone && entry.distanceAtr > EXTENDED_ATR_MULTIPLE) {
    return {
      status: "WAIT_FOR_CONFIRMATION",
      reason: `Price is ${entry.distanceAtr.toFixed(
        1,
      )} ATR above the entry zone at ${formatPrice(entry.low)} – ${formatPrice(
        entry.high,
      )}. The level is valid, but buying here means chasing. Wait for a pullback into the zone.`,
    };
  }

  if (read.trend.trend === "SIDEWAYS") {
    return {
      status: "WAIT_FOR_CONFIRMATION",
      reason:
        "The market is ranging rather than trending. Buying the lower boundary of a range is a valid approach, but it needs a bullish reaction from the zone first — a range only pays if the boundary holds.",
    };
  }

  if (!entry.priceInZone) {
    return {
      status: "WAIT_FOR_CONFIRMATION",
      reason: `Price has not reached the entry zone at ${formatPrice(entry.low)} – ${formatPrice(
        entry.high,
      )} yet. Set an alert rather than entering early.`,
    };
  }

  if (mtf?.agreement === "MIXED") {
    return {
      status: "WAIT_FOR_CONFIRMATION",
      reason: `${mtf.note} Without a clear higher-timeframe direction, wait for one to establish itself before committing.`,
    };
  }

  const volume = read.volume.read;
  if (volume && volume.relative < 0.7) {
    return {
      status: "WAIT_FOR_CONFIRMATION",
      reason: `Price is in the entry zone, but volume is only ${volume.relative.toFixed(
        1,
      )}× average. A bounce on volume this thin is not yet confirmed — wait for buyers to show up.`,
    };
  }

  if (score.grade === "WEAK") {
    return {
      status: "WAIT_FOR_CONFIRMATION",
      reason: `The setup scores ${score.total}/100. Price is at the level, but not enough else agrees to act on it yet.`,
    };
  }

  // --- Everything checked out --------------------------------------------

  return {
    status: "POTENTIAL_SETUP",
    reason: `Price is in the entry zone at ${formatPrice(entry.low)} – ${formatPrice(
      entry.high,
    )}, the trend supports a long, and risk/reward is 1:${riskReward.ratio.toFixed(
      1,
    )}. The setup scores ${score.total}/100. This is a candidate to watch for confirmation, not an instruction to buy.`,
  };
}

export const STATUS_LABELS: Record<TradeStatus, { label: string; tone: string }> = {
  POTENTIAL_SETUP: { label: "Potential setup", tone: "bullish" },
  WAIT_FOR_CONFIRMATION: { label: "Wait for confirmation", tone: "warning" },
  HIGH_RISK: { label: "High risk", tone: "warning" },
  AVOID: { label: "Avoid for now", tone: "bearish" },
};
