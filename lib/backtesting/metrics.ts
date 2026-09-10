import type { BacktestSetupResult } from "./runner";

/**
 * Performance accounting for a set of simulated trades.
 *
 * Everything is measured in **R** — multiples of the risk taken on each trade —
 * rather than in currency. The backtester does not model an account, a position
 * size or compounding, so a currency figure would be a fabrication dressed up
 * as a result. R is what the strategy actually produces.
 *
 * Nothing here is predictive. These are observations about one sample of
 * history under one set of assumptions, and a good number is evidence that the
 * rules behaved a certain way then, not that they will behave that way next.
 */

/** A hair either side of zero is a breakeven exit, not a real result. */
const EPSILON = 1e-9;

/**
 * Below this many closed trades, ratios are too unstable to read.
 *
 * Not a significance threshold — there is no honest way to compute one here.
 * It is a line past which a win rate stops being a coin-flip artefact, and the
 * report says so rather than letting three trades look like a finding.
 */
export const MIN_MEANINGFUL_SAMPLE = 30;

export interface DrawdownPoint {
  /** Trade index within the closed series. */
  index: number;
  at: number;
  cumulativeR: number;
  peakR: number;
  drawdownR: number;
}

export interface BacktestMetrics {
  // --- counts -------------------------------------------------------------
  totalSetups: number;
  /** Trades that reached an exit. Unresolved ones are excluded from ratios. */
  closedTrades: number;
  /** Still open when the data ran out. Never counted as losses. */
  unresolvedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;

  /**
   * Share of *decided* trades that ended in profit, 0-100.
   *
   * The denominator is wins + losses. A trade stopped at breakeven after the
   * first target traded is not a loss, and counting it as one would understate
   * a rule whose entire purpose is to remove risk early.
   */
  winRate: number;

  // --- return -------------------------------------------------------------
  totalR: number;
  averageR: number;
  medianR: number;
  averageWinR: number;
  averageLossR: number;
  /**
   * Expected R per trade from this sample's own win rate and average outcomes:
   *
   *   (winRate × averageWinR) + (lossRate × averageLossR)
   *
   * where averageLossR is already negative. Breakeven trades are in neither
   * rate, so they dilute nothing — which is deliberate: a scratch is not
   * evidence either way.
   */
  expectancyR: number;
  /**
   * Gross gains divided by gross losses, both in R. Above 1 means the winners
   * outweighed the losers in this sample. Infinite when there were no losses,
   * which is a small-sample artefact rather than a result.
   */
  profitFactor: number | null;

  // --- risk ---------------------------------------------------------------
  /** Worst peak-to-trough fall of the cumulative R curve. */
  maxDrawdownR: number;
  /** When that trough occurred, if any trade closed. */
  maxDrawdownAt: number | null;
  maxWinStreak: number;
  maxLossStreak: number;

  // --- duration -----------------------------------------------------------
  averageHoldingMs: number | null;
  medianHoldingMs: number | null;
  maxHoldingMs: number | null;
  averageBarsHeld: number | null;

  // --- shape --------------------------------------------------------------
  /** Cumulative R after each closed trade, in order. */
  equityCurve: DrawdownPoint[];
  /** Counts of realised R in fixed buckets, for a distribution view. */
  rDistribution: { bucket: string; count: number }[];
  outcomes: Record<string, number>;
  best: BacktestSetupResult | null;
  worst: BacktestSetupResult | null;

  // --- honesty ------------------------------------------------------------
  /** True when there are too few closed trades for the ratios to mean much. */
  smallSample: boolean;
  /** Cost of fees and slippage across the sample, in R. */
  costR: number;
}

type ClosedTrade = BacktestSetupResult & { realizedRR: number };

function isClosed(setup: BacktestSetupResult): setup is ClosedTrade {
  return setup.realizedRR !== null;
}

export function computeMetrics(setups: BacktestSetupResult[]): BacktestMetrics {
  const closed = setups.filter(isClosed);
  const unresolved = setups.length - closed.length;

  const outcomes: Record<string, number> = {};
  for (const setup of setups) outcomes[setup.outcome] = (outcomes[setup.outcome] ?? 0) + 1;

  if (closed.length === 0) return empty(setups.length, unresolved, outcomes);

  const rs = closed.map((t) => t.realizedRR);
  const wins = closed.filter((t) => t.realizedRR > EPSILON);
  const losses = closed.filter((t) => t.realizedRR < -EPSILON);
  const breakeven = closed.length - wins.length - losses.length;
  const decided = wins.length + losses.length;

  const totalR = sum(rs);
  const grossGain = sum(wins.map((t) => t.realizedRR));
  const grossLoss = Math.abs(sum(losses.map((t) => t.realizedRR)));

  const winRate = decided === 0 ? 0 : (wins.length / decided) * 100;
  const averageWinR = wins.length === 0 ? 0 : grossGain / wins.length;
  const averageLossR = losses.length === 0 ? 0 : -grossLoss / losses.length;

  const equityCurve = buildEquityCurve(closed);
  const deepest = equityCurve.reduce(
    (worst, point) => (point.drawdownR > worst.drawdownR ? point : worst),
    equityCurve[0],
  );

  const holdings = closed.map((t) => t.holdingMs).filter((v): v is number => v !== null);
  const bars = closed.map((t) => t.barsHeld).filter((v): v is number => v !== null);

  const costs = closed
    .filter((t) => t.grossRealizedRR !== null)
    .map((t) => (t.grossRealizedRR as number) - t.realizedRR);

  const sorted = [...closed].sort((a, b) => b.realizedRR - a.realizedRR);

  return {
    totalSetups: setups.length,
    closedTrades: closed.length,
    unresolvedTrades: unresolved,
    wins: wins.length,
    losses: losses.length,
    breakeven,
    winRate,

    totalR,
    averageR: totalR / closed.length,
    medianR: median(rs),
    averageWinR,
    averageLossR,
    // From this sample's own rates, not from a model fitted to it.
    expectancyR:
      decided === 0
        ? 0
        : (wins.length / decided) * averageWinR + (losses.length / decided) * averageLossR,
    profitFactor: grossLoss === 0 ? null : grossGain / grossLoss,

    maxDrawdownR: deepest?.drawdownR ?? 0,
    maxDrawdownAt: deepest && deepest.drawdownR > 0 ? deepest.at : null,
    maxWinStreak: longestStreak(rs, (r) => r > EPSILON),
    maxLossStreak: longestStreak(rs, (r) => r < -EPSILON),

    averageHoldingMs: holdings.length === 0 ? null : sum(holdings) / holdings.length,
    medianHoldingMs: holdings.length === 0 ? null : median(holdings),
    maxHoldingMs: holdings.length === 0 ? null : Math.max(...holdings),
    averageBarsHeld: bars.length === 0 ? null : sum(bars) / bars.length,

    equityCurve,
    rDistribution: distribution(rs),
    outcomes,
    best: sorted[0] ?? null,
    worst: sorted[sorted.length - 1] ?? null,

    smallSample: closed.length < MIN_MEANINGFUL_SAMPLE,
    costR: sum(costs),
  };
}

/**
 * Cumulative R after each trade, with the running peak and the distance below
 * it.
 *
 * Built by walking the closed trades in the order they were entered, which is
 * why the runner never overlaps positions — an equity curve assembled from
 * concurrent trades would double-count the same market move.
 */
function buildEquityCurve(closed: ClosedTrade[]): DrawdownPoint[] {
  const ordered = [...closed].sort((a, b) => a.entryTime - b.entryTime);

  let cumulative = 0;
  let peak = 0;

  return ordered.map((trade, index) => {
    cumulative += trade.realizedRR;
    peak = Math.max(peak, cumulative);

    return {
      index,
      at: trade.exitTime ?? trade.entryTime,
      cumulativeR: cumulative,
      peakR: peak,
      drawdownR: peak - cumulative,
    };
  });
}

/**
 * Longest run of consecutive trades satisfying `matches`.
 *
 * Consecutive, not total — the distinction that makes a streak worth reporting.
 * Eight losses scattered through a hundred trades is ordinary; eight in a row
 * is the sequence that ends an account.
 */
function longestStreak(values: number[], matches: (value: number) => boolean): number {
  let longest = 0;
  let current = 0;

  for (const value of values) {
    if (matches(value)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      // A breakeven trade breaks a streak rather than extending it: it is
      // neither a win nor a loss, and treating it as one would invent a run
      // that did not happen.
      current = 0;
    }
  }

  return longest;
}

/** Fixed buckets, so two reports can be compared side by side. */
function distribution(rs: number[]): { bucket: string; count: number }[] {
  const buckets = [
    { bucket: "< -1R", test: (r: number) => r < -1 },
    { bucket: "-1R to -0.5R", test: (r: number) => r >= -1 && r < -0.5 },
    { bucket: "-0.5R to 0", test: (r: number) => r >= -0.5 && r < -EPSILON },
    { bucket: "breakeven", test: (r: number) => Math.abs(r) <= EPSILON },
    { bucket: "0 to 1R", test: (r: number) => r > EPSILON && r <= 1 },
    { bucket: "1R to 2R", test: (r: number) => r > 1 && r <= 2 },
    { bucket: "2R to 3R", test: (r: number) => r > 2 && r <= 3 },
    { bucket: "> 3R", test: (r: number) => r > 3 },
  ];

  return buckets.map(({ bucket, test }) => ({ bucket, count: rs.filter(test).length }));
}

function empty(
  totalSetups: number,
  unresolved: number,
  outcomes: Record<string, number>,
): BacktestMetrics {
  return {
    totalSetups,
    closedTrades: 0,
    unresolvedTrades: unresolved,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: 0,
    totalR: 0,
    averageR: 0,
    medianR: 0,
    averageWinR: 0,
    averageLossR: 0,
    expectancyR: 0,
    profitFactor: null,
    maxDrawdownR: 0,
    maxDrawdownAt: null,
    maxWinStreak: 0,
    maxLossStreak: 0,
    averageHoldingMs: null,
    medianHoldingMs: null,
    maxHoldingMs: null,
    averageBarsHeld: null,
    equityCurve: [],
    rDistribution: distribution([]),
    outcomes,
    best: null,
    worst: null,
    smallSample: true,
    costR: 0,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// --- breakdowns ------------------------------------------------------------

export interface Breakdown {
  key: string;
  metrics: BacktestMetrics;
}

/**
 * Groups trades and measures each group separately.
 *
 * Ordering is by total R and then by key, so the same trades always produce the
 * same table. A breakdown is for understanding where the sample came from — it
 * is not a shortlist of markets to trade, and a group of four trades at the top
 * is a group of four trades, not a discovery.
 */
export function breakdownBy(
  setups: BacktestSetupResult[],
  key: (setup: BacktestSetupResult) => string | null,
): Breakdown[] {
  const groups = new Map<string, BacktestSetupResult[]>();

  for (const setup of setups) {
    const group = key(setup);
    if (group === null) continue;
    const existing = groups.get(group);
    if (existing) existing.push(setup);
    else groups.set(group, [setup]);
  }

  return [...groups.entries()]
    .map(([groupKey, trades]) => ({ key: groupKey, metrics: computeMetrics(trades) }))
    .sort((a, b) => {
      const byR = b.metrics.totalR - a.metrics.totalR;
      // Stable tie-break, so an equal pair never reorders between runs.
      return byR !== 0 ? byR : a.key.localeCompare(b.key);
    });
}

/** Score bands, for asking whether the score ordered anything usefully. */
export function scoreBand(score: number): string {
  if (score >= 85) return "85-100";
  if (score >= 75) return "75-84";
  if (score >= 65) return "65-74";
  return "< 65";
}
