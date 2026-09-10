/**
 * Market regime: context about the environment, never a decision about a trade.
 *
 * Pure, and deliberately outside the analysis engine — `runAnalysis` never
 * receives a regime, so a regime cannot change a status, a score, a
 * confirmation or a lifecycle transition. Consumers classify from the read the
 * engine already produced.
 */
export { classifyRegime, describeRegime } from "./classify";
export {
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
