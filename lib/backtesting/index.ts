/**
 * Historical replay of the analysis engine.
 *
 * Educational only: it shows how the method's own rules would have behaved on
 * data that already happened, which is not evidence about data that has not.
 */
export { runBacktest, DEFAULT_WARMUP_BARS, DEFAULT_MAX_HOLD_BARS } from "./runner";
export type {
  BacktestSetupResult,
  BacktestOptions,
  BacktestReport,
  BacktestMtfInput,
  SetupOutcome,
} from "./runner";

export { breakdownBy, computeMetrics, scoreBand, MIN_MEANINGFUL_SAMPLE } from "./metrics";
export type { BacktestMetrics, Breakdown, DrawdownPoint } from "./metrics";

export { checkIntegrity } from "./integrity";
export type { IntegrityIssue, IntegrityIssueKind, IntegrityReport } from "./integrity";

export {
  DEFAULT_ENTRY_POLICY,
  DEFAULT_FEE_RATE,
  DEFAULT_SAME_CANDLE_POLICY,
  DEFAULT_SLIPPAGE_RATE,
} from "./types";
export type { BacktestAssumptions, DataCoverage, EntryPolicy, SameCandlePolicy } from "./types";
