/**
 * Deterministic analysis engine. Pure functions over candle arrays — no I/O,
 * no framework imports, no randomness. The same code runs in the browser, on
 * the server, and inside the backtester.
 *
 * AI is never used to produce a number here. The explanation layer phrases what
 * these functions decide, and nothing more.
 */
export { runMarketRead, MIN_CANDLES_FOR_READ } from "./market-read";
export type { MarketRead, MarketReadIndicators, MarketReadOptions } from "./market-read";

export { detectTrend, readEmas, EMA_PERIODS, EMA_LEVEL_TOLERANCE } from "./trend";
export type { Trend, TrendRead, EmaRead, EmaAlignment, EmaCheck } from "./trend";

export {
  findSwingPoints,
  readStructure,
  DEFAULT_SWING_LOOKBACK,
  STRUCTURE_LEVEL_TOLERANCE,
} from "./structure";
export type {
  SwingPoint,
  SwingType,
  StructureRead,
  StructureLabel,
  MarketStructure,
} from "./structure";

export { detectZones, isInZone, distanceToZone } from "./zones";
export type { PriceZone, ZoneKind, ZoneRead, ZoneOptions } from "./zones";

export * from "./setup";

export {
  analyzeMultiTimeframe,
  defaultHigherTimeframe,
  isValidTimeframePair,
  HIGHER_TIMEFRAME,
  MTF_AGREEMENT_LABELS,
} from "./mtf";
export type { MtfSummary, MtfAgreement } from "./mtf";

export { evaluateConfirmation } from "./confirmation";
export {
  MIN_POSITIVE_SIGNALS,
  PRIMARY_SIGNALS,
  isPrimarySignal,
  RECENT_SWING_MAX_AGE_BARS,
  RECLAIM_LOOKBACK_BARS,
  REJECTION_MIN_CLOSE_POSITION,
  REJECTION_MIN_WICK_RATIO,
  THIN_VOLUME_RELATIVE,
} from "./confirmation";
export type {
  ConfirmationResult,
  ConfirmationSignal,
  ConfirmationSignalType,
  ConfirmationSignalDirection,
  ConfirmationStatus,
} from "./confirmation";

export { buildExplanations } from "./explanations";
export { EXPLANATION_ORDER, EXPLANATION_CATEGORY_LABELS } from "./explanations";
export type { Explanation, ExplanationCategory, ExplanationSignal } from "./explanations";

export { explainTrend, explainStructure, explainEmaAlignment } from "./explain/trend";
export { explainZone, explainZones, explainZoneWidth } from "./explain/zones";
export { explainVolume } from "./explain/volume";
export { explainRsi } from "./explain/rsi";
