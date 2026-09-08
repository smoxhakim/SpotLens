/**
 * Historical replay of the analysis engine.
 *
 * Educational only: it shows how the method's own rules would have behaved on
 * data that already happened, which is not evidence about data that has not.
 */
export { runBacktest, DEFAULT_WARMUP_BARS, DEFAULT_MAX_HOLD_BARS } from "./runner";
export type { BacktestSetupResult, BacktestOptions, SetupOutcome } from "./runner";

export { computeMetrics, ASSUMED_RISK_PER_TRADE_PCT } from "./metrics";
export type { BacktestMetrics } from "./metrics";
