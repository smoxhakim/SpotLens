/**
 * The demo trial: manual orders on Binance Demo Trading, checked against what
 * SpotLens planned. Pure throughout — the services read, this compares and
 * lays out, and nothing here sizes, scores or places anything.
 */
export { stateAt, statesAround, type SetupHistory, type StateAtEntry } from "./at-entry";
export { DEMO_TRIAL, FEE_ESTIMATE } from "./config";
export { scanCoverage, type Coverage, type CoverageGap } from "./coverage";
export {
  BINANCE_HOSTS,
  publicMarketDataUrl,
  type BinanceVenue,
  type PublicPath,
} from "./public-endpoints";
export { renderTrialReport, type TrialReportInput } from "./report";
export {
  plannedLossAtStop,
  reviewTrade,
  type PlanComparison,
  type RuleVerdict,
  type RuleVerdicts,
  type TrialFlag,
  type TrialFlagCode,
  type TrialPlan,
  type TrialTradeInput,
  type TrialTradeReview,
} from "./trades";
export {
  WORKFLOW_ORDER_TYPES,
  compareQuotes,
  compareRules,
  quoteFrom,
  rulesFrom,
  summariseGaps,
  workflowGaps,
  type GapSummary,
  type MarketRules,
  type Quote,
  type QuoteComparison,
  type RawBookTicker,
  type RawSymbolInfo,
  type RuleComparison,
} from "./venue-compare";
