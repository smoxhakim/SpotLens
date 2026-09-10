import {
  breakdownBy,
  computeMetrics,
  scoreBand,
  type BacktestSetupResult,
} from "@/lib/backtesting";
import { computeOutcome, type JournalDecision, type JournalSkipReason } from "@/lib/journal";

import type { EngineFunnel, HumanDecisions, ResearchFilters, ResearchReport } from "./types";

/**
 * Turns journal and setup history into descriptive statistics.
 *
 * Reuses the backtester's metric definitions rather than writing a second set.
 * Expectancy, profit factor, drawdown and streaks already mean something
 * precise in this codebase, and a research page that computed them slightly
 * differently would be worse than one that did not compute them at all.
 */

/** One setup, as research needs to see it. */
export interface ResearchSetup {
  id: string;
  symbol: string;
  timeframe: string;
  lifecycleStatus: string;
  score: number;
  riskReward: number;
  riskRewardIsSynthetic: boolean;
  confirmationStatus: string | null;
  regimeDirection: string | null;
  regimeVolatility: string | null;
  createdAt: number;
  /** Whether the setup ever reached these states, from its event history. */
  everConfirmed: boolean;
  everPotentialSetup: boolean;
}

/** One journal entry, as research needs to see it. */
export interface ResearchEntry {
  setupId: string;
  decision: JournalDecision;
  /**
   * The setup's lifecycle state when the decision was made, frozen on the
   * journal entry at that moment. This — not the setup's eventual state — is
   * what the person could see.
   */
  statusAtDecision: string;
  skipReason: JournalSkipReason | null;
  decidedAt: number;
  actualEntry: number | null;
  actualStopLoss: number | null;
  actualExit: number | null;
  quantity: number | null;
  fees: number | null;
  slippage: number | null;
  openedAt: number | null;
  closedAt: number | null;
}

/**
 * The engine's own funnel.
 *
 * Reads the lifecycle states a setup actually reached, not its current one: a
 * setup that confirmed and was later invalidated did both, and counting only
 * where it ended would erase the confirmation that happened.
 */
export function engineFunnel(setups: ResearchSetup[]): EngineFunnel {
  const detected = setups.length;
  const confirmed = setups.filter((s) => s.everConfirmed).length;
  const potential = setups.filter((s) => s.everPotentialSetup).length;
  const invalidated = setups.filter((s) => s.lifecycleStatus === "INVALIDATED").length;

  const rate = (n: number) => (detected === 0 ? 0 : (n / detected) * 100);

  return {
    setupsDetected: detected,
    reachedConfirmation: confirmed,
    reachedPotentialSetup: potential,
    invalidated,
    stillOpen: detected - invalidated,
    invalidationRate: rate(invalidated),
    potentialSetupRate: rate(potential),
  };
}

/** What the person did with them. Counts only — no R, and no merging. */
export function humanDecisions(entries: ResearchEntry[]): HumanDecisions {
  const count = (decision: JournalDecision) =>
    entries.filter((e) => e.decision === decision).length;

  const taken = count("TAKEN");
  const closed = count("CLOSED");
  const acted = taken + closed;

  const reasons = new Map<JournalSkipReason | "UNSPECIFIED", number>();
  for (const entry of entries) {
    if (entry.decision !== "SKIPPED") continue;
    const key = entry.skipReason ?? "UNSPECIFIED";
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }

  return {
    journaled: entries.length,
    watching: count("WATCHING"),
    taken,
    skipped: count("SKIPPED"),
    cancelled: count("CANCELLED"),
    closed,
    actedOnRate: entries.length === 0 ? 0 : (acted / entries.length) * 100,
    // Stable order: commonest first, then alphabetically, so the table does
    // not reshuffle between identical queries.
    skipReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

/**
 * Maps a closed journal entry onto the shape the backtester's metrics read.
 *
 * The adapter that lets research reuse `computeMetrics`. Fields the engine
 * knows are taken from the setup; fields only the trade knows come from what
 * the user recorded. Anything genuinely unavailable — maximum excursion, for
 * instance, which nobody wrote down — stays null rather than being invented.
 */
/** Whether confirmation had already been seen at the moment of the decision. */
export function confirmationAtDecision(statusAtDecision: string): string {
  return statusAtDecision === "CONFIRMATION_DETECTED" || statusAtDecision === "POTENTIAL_SETUP"
    ? "PRESENT"
    : "NOT_PRESENT";
}

export function toMetricRow(
  entry: ResearchEntry,
  setup: ResearchSetup,
): BacktestSetupResult | null {
  if (entry.actualEntry === null || entry.quantity === null) return null;

  const outcome = computeOutcome({
    actualEntry: entry.actualEntry,
    actualStopLoss: entry.actualStopLoss ?? undefined,
    actualExit: entry.actualExit ?? undefined,
    quantity: entry.quantity,
    fees: entry.fees ?? undefined,
    slippage: entry.slippage ?? undefined,
    openedAt: entry.openedAt ?? undefined,
    closedAt: entry.closedAt ?? undefined,
  });

  const gross =
    outcome.grossPnl === null || outcome.riskAmount === null || outcome.riskAmount <= 0
      ? null
      : outcome.grossPnl / outcome.riskAmount;

  return {
    triggeredAt: setup.createdAt,
    entryTime: entry.openedAt ?? entry.decidedAt,
    entry: entry.actualEntry,
    stopLoss: entry.actualStopLoss ?? entry.actualEntry,
    takeProfits: [],
    outcome: entry.actualExit === null ? "STILL_OPEN" : "NO_HIT",
    realizedRR: outcome.realizedR,
    grossRealizedRR: gross,
    exitTime: entry.closedAt,
    exitPrice: entry.actualExit,
    setupScore: setup.score,
    symbol: setup.symbol,
    timeframe: setup.timeframe as BacktestSetupResult["timeframe"],
    barsHeld: null,
    holdingMs: outcome.holdingMs,
    entryRiskReward: setup.riskReward,
    entryRiskRewardIsSynthetic: setup.riskRewardIsSynthetic,
    trend: setup.regimeDirection ?? "UNKNOWN",
    mtfAgreement: null,
    // What the person could see when they decided, not what the setup went on
    // to do. Keying this off the setup's whole history would let a confirmation
    // that arrived *after* entry sort the trade into the confirmed bucket —
    // hindsight, quietly improving the wrong column.
    confirmationStatus: confirmationAtDecision(entry.statusAtDecision),
    // Nobody recorded how far the trade went before it turned. Null, not zero.
    maxFavourableR: null,
    maxAdverseR: null,
    regimeDirection: setup.regimeDirection,
    regimeVolatility: setup.regimeVolatility,
  };
}

export function buildResearchReport(input: {
  setups: ResearchSetup[];
  entries: ResearchEntry[];
  filters: ResearchFilters;
}): ResearchReport {
  const { setups, entries, filters } = input;
  const byId = new Map(setups.map((s) => [s.id, s]));

  // Only positions with a recorded result contribute R. A watched or skipped
  // setup has no outcome, and a taken one that is still open has no result yet.
  const rows = entries
    .filter((e) => e.decision === "CLOSED")
    .map((e) => {
      const setup = byId.get(e.setupId);
      return setup ? toMetricRow(e, setup) : null;
    })
    .filter((row): row is BacktestSetupResult => row !== null);

  const outcomes = computeMetrics(rows);

  return {
    filters,
    engine: engineFunnel(setups),
    human: humanDecisions(entries),
    outcomes,
    bySymbol: breakdownBy(rows, (r) => r.symbol),
    byTimeframe: breakdownBy(rows, (r) => r.timeframe),
    byScoreBand: breakdownBy(rows, (r) => scoreBand(r.setupScore)),
    byConfirmation: breakdownBy(rows, (r) => r.confirmationStatus),
    byRegime: breakdownBy(rows, (r) => r.regimeDirection),
    byVolatility: breakdownBy(rows, (r) => r.regimeVolatility),
    byTargetKind: breakdownBy(rows, (r) =>
      r.entryRiskRewardIsSynthetic ? "unmeasured reward" : "structural target",
    ),
    smallSample: outcomes.smallSample,
  };
}
