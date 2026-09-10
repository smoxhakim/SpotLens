import type { MarketRead } from "@/lib/analysis";

import {
  ATR_HIGH_PERCENT,
  ATR_LOW_PERCENT,
  MIN_CANDLES_FOR_REGIME,
  REGIME_VERSION,
  TRENDING_MIN_EVIDENCE,
  type MarketRegime,
  type RegimeDirection,
  type RegimeReason,
  type RegimeVolatility,
} from "./types";

/**
 * Classifies the market environment from a finished market read.
 *
 * Takes the read rather than candles on purpose. Every input it needs — swing
 * structure, EMA alignment, ATR, price — has already been computed by the
 * engine, so this adds arithmetic and not a single fetch. It also means the
 * classifier physically cannot see anything the engine did not, which is what
 * makes the no-lookahead guarantee inherited rather than re-argued: the read
 * was built from `candles.slice(0, i + 1)`, so this was too.
 *
 * Pure. No clock, no randomness, no I/O.
 */
export function classifyRegime(read: MarketRead): MarketRegime {
  const reasons: RegimeReason[] = [];

  const atrPercent =
    read.indicators.atr14 !== null && read.price > 0
      ? (read.indicators.atr14 / read.price) * 100
      : null;

  const volatility = volatilityFrom(atrPercent, reasons);

  if (read.insufficientData || read.candleCount < MIN_CANDLES_FOR_REGIME) {
    reasons.push({
      factor: "DATA",
      detail: `Only ${read.candleCount} candles of history — too few to describe the environment.`,
    });
    return {
      direction: "UNCLEAR",
      volatility,
      evidence: 0,
      atrPercent,
      reasons,
      version: REGIME_VERSION,
    };
  }

  // Three independent directional signals, each already decided by the engine.
  const structure = read.trend.structure.structure;
  const alignment = read.trend.ema.alignment;
  const ema200 = read.indicators.ema200;

  const up = [
    structure === "UPTREND",
    alignment === "BULLISH",
    ema200 !== null && read.price > ema200,
  ];
  const down = [
    structure === "DOWNTREND",
    alignment === "BEARISH",
    ema200 !== null && read.price < ema200,
  ];

  const upVotes = up.filter(Boolean).length;
  const downVotes = down.filter(Boolean).length;

  describe(reasons, structure, alignment, ema200, read.price);

  let direction: RegimeDirection;
  let evidence: number;

  if (upVotes >= TRENDING_MIN_EVIDENCE && upVotes > downVotes) {
    direction = "TRENDING_UP";
    evidence = upVotes;
  } else if (downVotes >= TRENDING_MIN_EVIDENCE && downVotes > upVotes) {
    direction = "TRENDING_DOWN";
    evidence = downVotes;
  } else if (structure === "RANGING") {
    // The engine already decided highs and lows are not progressing. That is a
    // range whether or not the moving averages have caught up.
    direction = "RANGE";
    evidence = 1;
    reasons.push({
      factor: "STRUCTURE",
      detail: "Highs and lows are not progressing in either direction, which is a range.",
    });
  } else {
    direction = "UNCLEAR";
    evidence = Math.max(upVotes, downVotes);
    reasons.push({
      factor: "STRUCTURE",
      detail:
        "The directional signals disagree, so no environment is claimed. That is a description of the evidence, not a prediction.",
    });
  }

  return { direction, volatility, evidence, atrPercent, reasons, version: REGIME_VERSION };
}

/**
 * Volatility from ATR as a share of price.
 *
 * Relative rather than absolute, because an ATR of 40 is enormous on an asset
 * priced at 200 and unremarkable on one priced at 90,000.
 */
function volatilityFrom(atrPercent: number | null, reasons: RegimeReason[]): RegimeVolatility {
  if (atrPercent === null) {
    reasons.push({
      factor: "DATA",
      detail: "Not enough history to calculate ATR, so volatility is reported as normal.",
    });
    return "NORMAL";
  }

  if (atrPercent >= ATR_HIGH_PERCENT) {
    reasons.push({
      factor: "VOLATILITY",
      detail: `Average true range is ${atrPercent.toFixed(2)}% of price, at or above the ${ATR_HIGH_PERCENT}% mark. Ordinary swings are wide enough to reach a normal stop.`,
    });
    return "HIGH";
  }

  if (atrPercent <= ATR_LOW_PERCENT) {
    reasons.push({
      factor: "VOLATILITY",
      detail: `Average true range is ${atrPercent.toFixed(2)}% of price, at or below the ${ATR_LOW_PERCENT}% mark. The market is quiet, and moves may take longer to develop.`,
    });
    return "LOW";
  }

  reasons.push({
    factor: "VOLATILITY",
    detail: `Average true range is ${atrPercent.toFixed(2)}% of price, inside the usual band.`,
  });
  return "NORMAL";
}

function describe(
  reasons: RegimeReason[],
  structure: string,
  alignment: string,
  ema200: number | null,
  price: number,
): void {
  if (structure === "UPTREND" || structure === "DOWNTREND") {
    reasons.push({
      factor: "STRUCTURE",
      detail: `Swing structure is ${structure.toLowerCase()}.`,
    });
  }

  if (alignment === "BULLISH" || alignment === "BEARISH") {
    reasons.push({
      factor: "EMA",
      detail: `The moving averages are stacked ${alignment.toLowerCase()}ly.`,
    });
  }

  if (ema200 !== null) {
    reasons.push({
      factor: "EMA",
      detail: `Price is ${price > ema200 ? "above" : "below"} the EMA 200.`,
    });
  }
}

/** A short label pair for a UI or a message. Never a prediction. */
export function describeRegime(regime: MarketRegime): string {
  const direction = regime.direction.toLowerCase().replace(/_/g, " ");
  return `${direction}, ${regime.volatility.toLowerCase()} volatility`;
}
