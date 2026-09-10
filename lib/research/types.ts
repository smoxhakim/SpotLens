import type { BacktestMetrics, Breakdown } from "@/lib/backtesting";
import type { JournalDecision, JournalSkipReason } from "@/lib/journal";

/**
 * Research: describing what already happened.
 *
 * Every number here is an observation about one sample of history. None of it
 * is predictive, none of it ranks markets to trade, and the vocabulary is
 * chosen to keep that visible — "observed", "in this sample", never "best" or
 * "probability".
 */

/**
 * What the engine did, as a funnel.
 *
 * Counts rather than R, because a setup is not a trade: an engine that
 * produced sixty confirmed setups did that whether or not anyone acted on
 * them. Measuring it in R would require assuming trades that never happened.
 */
export interface EngineFunnel {
  setupsDetected: number;
  reachedConfirmation: number;
  reachedPotentialSetup: number;
  invalidated: number;
  stillOpen: number;
  /** Share of detected setups that were later invalidated, 0-100. */
  invalidationRate: number;
  /** Share that ever reached the engine's highest state, 0-100. */
  potentialSetupRate: number;
}

/**
 * What the person did.
 *
 * Kept apart from the funnel above on purpose. Merging them would produce a
 * single win rate that describes neither the engine nor the user — the
 * specific misleading number this split exists to prevent.
 */
export interface HumanDecisions {
  journaled: number;
  watching: number;
  taken: number;
  skipped: number;
  cancelled: number;
  closed: number;
  /** Share of journaled setups that were acted on, 0-100. */
  actedOnRate: number;
  skipReasons: { reason: JournalSkipReason | "UNSPECIFIED"; count: number }[];
}

export interface ResearchReport {
  /** The filters that produced this, echoed back so a result is reproducible. */
  filters: ResearchFilters;
  engine: EngineFunnel;
  human: HumanDecisions;
  /**
   * R metrics over closed journal entries only — the trades the user actually
   * took and recorded. Reuses the backtester's own metric definitions so an
   * expectancy here means the same thing as an expectancy there.
   */
  outcomes: BacktestMetrics;
  /**
   * Decision state is a filter and a count, not an R breakdown.
   *
   * Only a CLOSED entry has a result, so grouping R by decision would produce
   * one group called "closed" and nothing else — a table that looks like
   * analysis and contains none. The counts per decision live on `human`, where
   * they mean something.
   */
  bySymbol: Breakdown[];
  byTimeframe: Breakdown[];
  byScoreBand: Breakdown[];
  byConfirmation: Breakdown[];
  byRegime: Breakdown[];
  byVolatility: Breakdown[];
  byTargetKind: Breakdown[];
  /** True when there are too few closed trades for the ratios to mean much. */
  smallSample: boolean;
}

export interface ResearchFilters {
  from?: number;
  to?: number;
  symbol?: string;
  timeframe?: string;
  decision?: JournalDecision;
  lifecycleStatus?: string;
  minScore?: number;
  maxScore?: number;
  confirmation?: string;
  regimeDirection?: string;
  volatility?: string;
  /** Restrict to setups whose reward was, or was not, measured to structure. */
  measuredRewardOnly?: boolean;
}
