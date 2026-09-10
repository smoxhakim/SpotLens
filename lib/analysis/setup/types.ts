import type { PriceZone } from "../zones";

/**
 * Spot trading only. There is no SHORT member and no code path that produces
 * one — SpotLens does not model borrowing, leverage, or selling what you do
 * not hold.
 */
export type TradeDirection = "LONG";

export type TradeStatus = "POTENTIAL_SETUP" | "WAIT_FOR_CONFIRMATION" | "HIGH_RISK" | "AVOID";

export interface EntryZone {
  low: number;
  high: number;
  mid: number;
  reason: string;
  /** What the user should see before entering — never "buy now". */
  confirmations: string[];
  /** True when price is currently trading inside the zone. */
  priceInZone: boolean;
  /** How far price sits above the zone, in ATR. Negative when below. */
  distanceAtr: number;
  sourceZone: PriceZone;
}

export interface StopLoss {
  price: number;
  reason: string;
  /** Risk per unit as a fraction of entry, e.g. 0.025 for 2.5%. */
  riskPct: number;
  atrMultiple: number;
}

/**
 * Where a target's price came from.
 *
 * The distinction decides whether the reward is evidence or arithmetic. A
 * STRUCTURAL target is a level price has actually reacted to, so the distance
 * to it is a fact about the chart. An R_MULTIPLE target is `entry + risk × n`,
 * so its reward-to-risk is `n` by construction no matter what the market is
 * doing — it can fill a slot in the ladder, but it cannot be used as evidence
 * that a setup is worth taking.
 */
export type TargetKind = "STRUCTURAL" | "R_MULTIPLE";

export interface TakeProfitTarget {
  label: "TP1" | "TP2" | "TP3";
  level: number;
  reason: string;
  /** Reward-to-risk achieved at this target. */
  rr: number;
  kind: TargetKind;
}

export interface RiskReward {
  /** Headline ratio the status engine judges the setup by. */
  ratio: number;
  risk: number;
  reward: number;
  /** Which target the headline ratio measures to. */
  measuredTo: TakeProfitTarget["label"];
  /**
   * True when no structural target existed above the entry, so the ratio was
   * measured to an R-multiple and is therefore a restatement of that multiple
   * rather than a measurement of the chart.
   */
  isSynthetic: boolean;
  isPoor: boolean;
  reason: string;
}

export interface TradeSetup {
  direction: TradeDirection;
  entry: EntryZone;
  stopLoss: StopLoss;
  takeProfits: TakeProfitTarget[];
  riskReward: RiskReward;
}

/** Minimum reward-to-risk before a setup is worth the capital at risk. */
export const MIN_ACCEPTABLE_RR = 1.5;
/** Above this, risk/reward is considered good rather than merely acceptable. */
export const GOOD_RR = 2;
