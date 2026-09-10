/**
 * Risk management: how much to expose, never whether to trade.
 *
 * Pure and server-independent, so the same function backs the API route, the
 * calculator UI and the tests.
 */
export { calculateRisk } from "./calculate";
export {
  COSTS_SIGNIFICANT_RATIO,
  DEFAULT_RISK_FEE_RATE,
  DEFAULT_RISK_SLIPPAGE_RATE,
  HIGH_RISK_PERCENT,
  TIGHT_STOP_PERCENT,
  type RiskCalculation,
  type RiskError,
  type RiskErrorCode,
  type RiskInput,
  type RiskResult,
  type RiskWarning,
  type RiskWarningCode,
} from "./types";
