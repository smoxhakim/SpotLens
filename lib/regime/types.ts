/**
 * Market regime.
 *
 * Answers "what kind of market is this setup happening in?" and nothing else.
 * It never decides whether a setup is valid, never moves a score, and never
 * changes a status — the engine does not even receive it. It is context a
 * reader uses to interpret a verdict the engine reached without it.
 */

/**
 * Direction and volatility are separate axes, deliberately.
 *
 * A market can be trending *and* volatile, and forcing those into one
 * enumeration means the two most useful facts about the environment compete
 * for a single slot: a strong uptrend in wild conditions would have to be
 * reported as one or the other, and whichever lost would be the one the reader
 * needed. Two fields, each answering its own question.
 */
export type RegimeDirection = "TRENDING_UP" | "TRENDING_DOWN" | "RANGE" | "UNCLEAR";

export type RegimeVolatility = "HIGH" | "NORMAL" | "LOW";

export interface RegimeReason {
  /** Which input this came from, for grouping in a UI. */
  factor: "STRUCTURE" | "EMA" | "VOLATILITY" | "DATA";
  detail: string;
}

export interface MarketRegime {
  direction: RegimeDirection;
  volatility: RegimeVolatility;
  /**
   * How much of the directional evidence agreed, 0-3.
   *
   * An **evidence count**, not a probability and not a confidence: three means
   * structure, EMA alignment and price position all pointed the same way in
   * this sample. It says nothing about what happens next, and it must never be
   * rendered with a percent sign.
   */
  evidence: number;
  /** ATR as a percentage of price — the figure the volatility band came from. */
  atrPercent: number | null;
  reasons: RegimeReason[];
  /** Bumped when a threshold changes, so stored regimes stay interpretable. */
  version: string;
}

/**
 * Thresholds, stated once.
 *
 * ## Volatility
 *
 * ATR relative to price, because an absolute ATR is meaningless across assets
 * priced at 0.30 and 90,000. The bands are set from what the curated set
 * actually does on H1 and H4: below roughly 1% of price a market is quiet, and
 * above roughly 3% ordinary noise routinely spans a normal stop distance. They
 * are round numbers chosen to be legible, not fitted to maximise anything —
 * fitting them would be the parameter search Phase G was told not to do.
 */
export const ATR_LOW_PERCENT = 1;
export const ATR_HIGH_PERCENT = 3;

/**
 * Directional evidence required before a market is called trending.
 *
 * Two of the three signals — swing structure, EMA alignment, price against the
 * EMA 200 — must agree. One alone is the kind of thing that reverses on the
 * next candle; requiring all three would leave almost every real market
 * UNCLEAR, which is not information either.
 */
export const TRENDING_MIN_EVIDENCE = 2;

/** Candles below which the inputs are too thin to classify honestly. */
export const MIN_CANDLES_FOR_REGIME = 60;

export const REGIME_VERSION = "1";
