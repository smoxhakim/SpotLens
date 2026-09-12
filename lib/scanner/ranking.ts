import type { TradeStatus } from "@/lib/analysis";

/**
 * Deterministic ranking for scanner output.
 *
 * Nothing here reads a clock, a random number, or a popularity figure. The same
 * set of results always sorts into the same order, which is what makes a ranked
 * list something you can act on rather than something that reshuffles itself
 * between refreshes.
 */

/**
 * Rank order of the four statuses. Lower sorts first.
 *
 * WAIT above HIGH_RISK is deliberate: a setup waiting for confirmation is one
 * the tool might yet offer, while HIGH_RISK is one it has already qualified
 * against. AVOID last, and it carries no levels at all.
 */
export const STATUS_RANK: Record<TradeStatus, number> = {
  POTENTIAL_SETUP: 0,
  WAIT_FOR_CONFIRMATION: 1,
  HIGH_RISK: 2,
  AVOID: 3,
};

export interface RankableResult {
  symbol: string;
  /**
   * Which timeframe this result is for.
   *
   * Part of identity, not decoration: one pass produces every market on every
   * scheduled timeframe, so `BTCUSDT` appears twice and the two entries can tie
   * on every other field. Without this the order of such a pair fell out of the
   * sort's stability and therefore out of the order the jobs happened to be
   * built in — deterministic by accident rather than by rule.
   */
  timeframe: string;
  analysisStatus: TradeStatus | null;
  score: number | null;
  riskReward: number | null;
  riskRewardIsSynthetic: boolean | null;
}

/**
 * A reward that was never measured counts as zero, exactly as it does in the
 * score.
 *
 * Phase A established that a ratio measured to an R-multiple is the fallback
 * ladder's own constant restated. Letting that number sort a list would put the
 * setups with nothing above them at the top, which is precisely the distortion
 * the scoring engine already refuses to make.
 */
export function effectiveRiskReward(result: RankableResult): number {
  if (result.riskReward === null || result.riskRewardIsSynthetic) return 0;
  return result.riskReward;
}

/**
 * Sorts by, in order:
 *
 *   1. status — POTENTIAL_SETUP, then WAIT, then HIGH_RISK, then AVOID
 *   2. setup quality score, highest first
 *   3. measured risk/reward, highest first (an unmeasured one counts as zero)
 *   4. symbol, alphabetically
 *   5. timeframe, alphabetically — because a market appears once per scanned
 *      timeframe and those two entries can be equal on everything above
 *
 * The last two together are a total tie-break: one pass contains each
 * (symbol, timeframe) at most once, so no two entries can compare equal and the
 * order never depends on the order the results arrived in.
 *
 * The score is a quality measure and is used here only to order a list. It is
 * not a probability, and nothing in the scanner presents it as one.
 */
export function rankResults<T extends RankableResult>(results: readonly T[]): T[] {
  return [...results].sort((a, b) => {
    const statusA =
      a.analysisStatus === null ? Number.MAX_SAFE_INTEGER : STATUS_RANK[a.analysisStatus];
    const statusB =
      b.analysisStatus === null ? Number.MAX_SAFE_INTEGER : STATUS_RANK[b.analysisStatus];
    if (statusA !== statusB) return statusA - statusB;

    const scoreA = a.score ?? -1;
    const scoreB = b.score ?? -1;
    if (scoreA !== scoreB) return scoreB - scoreA;

    const rrA = effectiveRiskReward(a);
    const rrB = effectiveRiskReward(b);
    if (rrA !== rrB) return rrB - rrA;

    // `localeCompare` without a locale argument follows the runtime's default
    // collation, which is why both of these are compared as plain code points
    // instead: a symbol list and a timeframe list are ASCII, and an ordering
    // that changes with the host's locale is not deterministic.
    if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
    if (a.timeframe !== b.timeframe) return a.timeframe < b.timeframe ? -1 : 1;

    return 0;
  });
}
