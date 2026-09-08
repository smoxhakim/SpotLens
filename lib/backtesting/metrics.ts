import type { BacktestSetupResult } from "./runner";

export interface BacktestMetrics {
  numSetups: number;
  /** Setups that reached an exit; STILL_OPEN ones are excluded from ratios. */
  closedSetups: number;
  wins: number;
  losses: number;
  /** Exited at or within rounding of the entry — neither a win nor a loss. */
  breakeven: number;
  /**
   * Share of *decided* setups that ended in profit, 0-100.
   *
   * The denominator is wins + losses, not every closed setup. A trade stopped
   * out at breakeven after TP1 traded is not a loss, and counting it as one
   * would understate a rule whose whole purpose is to remove risk early.
   */
  winRate: number;
  avgRealizedRR: number;
  /** Sum of realised R across all closed setups. */
  totalR: number;
  /** Worst peak-to-trough fall of the equity curve, as a percentage. */
  maxDrawdownPct: number;
  /** Risk per trade the drawdown figure assumes. */
  riskPerTradePct: number;
  best: BacktestSetupResult | null;
  worst: BacktestSetupResult | null;
  outcomes: Record<string, number>;
}

/**
 * Risk assumed per trade when turning R multiples into an equity curve.
 * Drawdown is meaningless without one, and 1% is the default this product
 * recommends everywhere else.
 */
export const ASSUMED_RISK_PER_TRADE_PCT = 1;

export function computeMetrics(setups: BacktestSetupResult[]): BacktestMetrics {
  const closed = setups.filter(
    (s): s is BacktestSetupResult & { realizedRR: number } => s.realizedRR !== null,
  );

  const outcomes: Record<string, number> = {};
  for (const setup of setups) {
    outcomes[setup.outcome] = (outcomes[setup.outcome] ?? 0) + 1;
  }

  if (closed.length === 0) {
    return {
      numSetups: setups.length,
      closedSetups: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRate: 0,
      avgRealizedRR: 0,
      totalR: 0,
      maxDrawdownPct: 0,
      riskPerTradePct: ASSUMED_RISK_PER_TRADE_PCT,
      best: null,
      worst: null,
      outcomes,
    };
  }

  // A hair either side of zero is a breakeven exit, not a real result.
  const EPSILON = 1e-9;
  const wins = closed.filter((s) => s.realizedRR > EPSILON).length;
  const losses = closed.filter((s) => s.realizedRR < -EPSILON).length;
  const breakeven = closed.length - wins - losses;
  const decided = wins + losses;
  const totalR = closed.reduce((sum, s) => sum + s.realizedRR, 0);

  const sorted = [...closed].sort((a, b) => b.realizedRR - a.realizedRR);

  return {
    numSetups: setups.length,
    closedSetups: closed.length,
    wins,
    losses,
    breakeven,
    winRate: decided === 0 ? 0 : (wins / decided) * 100,
    avgRealizedRR: totalR / closed.length,
    totalR,
    maxDrawdownPct: maxDrawdown(closed.map((s) => s.realizedRR)),
    riskPerTradePct: ASSUMED_RISK_PER_TRADE_PCT,
    best: sorted[0] ?? null,
    worst: sorted[sorted.length - 1] ?? null,
    outcomes,
  };
}

/**
 * Worst peak-to-trough fall of an equity curve built from R multiples,
 * compounding a fixed fractional risk per trade.
 *
 * Reported as a percentage because "3.4R of drawdown" means nothing without
 * knowing what an R was worth.
 */
function maxDrawdown(rMultiples: number[], riskPct = ASSUMED_RISK_PER_TRADE_PCT): number {
  let equity = 1;
  let peak = 1;
  let worst = 0;

  for (const r of rMultiples) {
    equity *= 1 + (riskPct / 100) * r;
    peak = Math.max(peak, equity);
    worst = Math.max(worst, (peak - equity) / peak);
  }

  return worst * 100;
}
