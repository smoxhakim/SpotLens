/**
 * Risk management.
 *
 * The distinction this module exists to make is that **capital is not risk**.
 * A 100 USDT account risking 1% on a trade whose stop sits 5% away buys a
 * 20 USDT position — not a 100 USDT one, and not a 1 USDT one. Getting that
 * wrong in either direction is how accounts die: too large and one stop is
 * catastrophic, too small and the arithmetic was pointless.
 *
 * Nothing here decides whether to take a trade. It answers "if I decide to,
 * how much?" and stops there.
 */

export type RiskErrorCode =
  | "INVALID_BALANCE"
  | "INVALID_RISK_PERCENT"
  | "INVALID_ENTRY"
  | "INVALID_STOP"
  | "STOP_NOT_BELOW_ENTRY"
  | "INVALID_TAKE_PROFIT"
  | "INVALID_EXPOSURE_CAP"
  | "INVALID_COSTS";

export interface RiskError {
  code: RiskErrorCode;
  field: string;
  message: string;
}

export interface RiskInput {
  /** Total account balance in quote currency. */
  balance: number;
  /** Share of the balance to risk, as a percentage: 1 means 1%. */
  riskPercent: number;
  entry: number;
  stopLoss: number;
  /** Optional. Without it, no profit figures and no ratio are produced. */
  takeProfit?: number;
  /**
   * Optional ceiling on the position as a percentage of balance. Spot already
   * caps exposure at 100% — this is for someone who wants a tighter limit.
   */
  maxExposurePercent?: number;
  /** Fee per side, as a fraction. Same convention as the backtester. */
  feeRate?: number;
  /** Slippage as a fraction of price, applied against the trade on both legs. */
  slippageRate?: number;
  /**
   * Set when the target came from a setup whose reward was never measured
   * against structure. Phase A's rule follows the number wherever it goes: a
   * ratio to an R-multiple is arithmetic, not evidence.
   */
  takeProfitIsSynthetic?: boolean;
}

export type RiskWarningCode =
  | "POSITION_CAPPED"
  | "TIGHT_STOP"
  | "HIGH_RISK_PERCENT"
  | "COSTS_LARGE_VS_RISK"
  | "UNMEASURED_TARGET";

export interface RiskWarning {
  code: RiskWarningCode;
  message: string;
}

export interface RiskCalculation {
  // --- what was asked for -------------------------------------------------
  balance: number;
  riskPercent: number;
  entry: number;
  stopLoss: number;
  takeProfit: number | null;

  // --- the risk itself ----------------------------------------------------
  /** Quote currency the user intended to put at risk. */
  intendedRiskAmount: number;
  stopDistance: number;
  stopDistancePercent: number;

  // --- sizing -------------------------------------------------------------
  /** What the risk alone implies, before any cap. */
  uncappedPositionQuote: number;
  uncappedQuantity: number;
  /** The lower of available capital and any configured exposure limit. */
  exposureCap: number;
  /** What is actually buyable, after the cap. */
  positionQuote: number;
  quantity: number;
  positionPercentOfBalance: number;
  wasCapped: boolean;

  /**
   * What the capped position actually risks.
   *
   * Equal to `intendedRiskAmount` when nothing was capped. When a cap applies
   * it is **lower**, because a smaller position loses less at the same stop —
   * and saying so is the difference between a calculator and a calculator that
   * quietly rewrote the question.
   */
  actualRiskAmount: number;

  // --- outcome ------------------------------------------------------------
  estimatedCosts: number;
  /** Intended risk plus the cost of getting in and out. */
  estimatedNetLoss: number;
  potentialGrossProfit: number | null;
  potentialNetProfit: number | null;
  /** Reward to risk per unit. Null when there is no target to measure to. */
  riskReward: number | null;
  /** True when the ratio came from a target the engine never measured. */
  riskRewardIsSynthetic: boolean;

  warnings: RiskWarning[];
  disclaimer: string;
}

export type RiskResult =
  { ok: true; calculation: RiskCalculation } | { ok: false; errors: RiskError[] };

/** Fee per side. Matches the backtester's default; a generic spot taker rate. */
export const DEFAULT_RISK_FEE_RATE = 0.001;
export const DEFAULT_RISK_SLIPPAGE_RATE = 0;

/**
 * A stop this close to the entry is worth flagging.
 *
 * Not because it is wrong — a tight stop is often the point — but because it
 * is the input that makes position size explode, and at half a percent the
 * round-trip cost starts to rival the risk itself.
 */
export const TIGHT_STOP_PERCENT = 0.5;

/** Above this, one bad run does real damage. Flagged, never overridden. */
export const HIGH_RISK_PERCENT = 5;

/** Costs above this share of intended risk change the trade's arithmetic. */
export const COSTS_SIGNIFICANT_RATIO = 0.2;
