import type { CoachContext } from "@/lib/coach";
import type { DecisionSetup } from "@/lib/journal";
import { combinedFreshness, newestReadFreshness, type AnalysisRead } from "@/lib/scanner/freshness";
import { isClosedSetup } from "@/lib/setups/labels";

/**
 * Whether what a decision would be about still stands — closed, or how fresh.
 *
 * Two separate facts, kept separate. `closed` is the setup's lifecycle now: an
 * invalidated or replaced setup is a record, whatever its numbers say.
 * `freshness` is whether the newest read of the market is still the latest
 * closed candle — the same rule Opportunities, the Dashboard and the Scanner
 * page use (`analysisFreshness`), with nothing re-derived here.
 *
 * For a tracked setup the newest read is the latest successful pass that found
 * it still open (`lastScan`), falling back to the analysis that created it; its
 * levels are the creation's either way and never change. An untracked
 * opportunity is one pass's result, so that pass is the only read.
 */
export interface DecisionStanding {
  closed: boolean;
  freshness: ReturnType<typeof combinedFreshness>;
  /** When the newest read was recorded, for the notice. Null when unknown. */
  asOf: number | null;
  /** What the notice names as having been overtaken. */
  subject: string;
  /**
   * The setup as the journal's closed-setup rule reads it — status and the
   * window it was open. Null when not supplied, or for an untracked opportunity.
   */
  setup: DecisionSetup | null;
}

export function decisionStanding(
  context: CoachContext,
  lastScan: AnalysisRead | null | undefined,
  now: number,
  setup: DecisionSetup | null = null,
): DecisionStanding {
  const { identity } = context;
  const created: AnalysisRead = {
    analysedAtCandle: identity.analysedAtCandle,
    recordedAt: identity.recordedAt,
  };
  const { freshness, read } = newestReadFreshness({
    timeframe: identity.timeframe,
    reads: identity.setupId ? [created, lastScan] : [created],
    now,
  });

  return {
    closed: isClosedSetup(context.verdictInputs.lifecycleStatus),
    freshness: combinedFreshness([{ timeframe: identity.timeframe, freshness }]),
    asOf: read?.recordedAt ?? read?.analysedAtCandle ?? null,
    subject: identity.setupId ? "a scan last read this setup" : "this scan",
    setup: identity.setupId ? setup : null,
  };
}
