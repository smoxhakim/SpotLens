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

export interface TakeProfitTarget {
  label: "TP1" | "TP2" | "TP3";
  level: number;
  reason: string;
  /** Reward-to-risk achieved at this target. */
  rr: number;
}

export interface RiskReward {
  /** Headline ratio the status engine judges the setup by. */
  ratio: number;
  risk: number;
  reward: number;
  /** Which target the headline ratio measures to. */
  measuredTo: TakeProfitTarget["label"];
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
