import { isPrimarySignal, type ConfirmationSignalType } from "@/lib/analysis";

import type { CoachContext, CoachEvidence } from "./types";

/**
 * Turning what was recorded into what the Coach may read.
 *
 * Pure, and that is load-bearing rather than tidy: no clock, no randomness, no
 * database, no network. The caller loads the rows and hands them here, so the
 * same stored setup produces a byte-identical context however long afterwards
 * it is reviewed, and a later candle or a later event cannot change a reading
 * of an earlier one.
 *
 * Two shapes go in. A *tracked* setup carries the full immutable snapshot the
 * lifecycle froze at creation. A candidate the scanner merely scored carries
 * the verdict and the context and no levels — and no levels are invented for
 * it, because the only way to produce them after the fact is to run the engine
 * against candles that had not closed when the run happened.
 */

/** The stored setup, as the caller read it. Numbers already widened from Decimal. */
export interface TrackedSetupFacts {
  setupId: string;
  symbol: string;
  timeframe: string;
  lifecycleStatus: string;
  analysisStatus: string;
  score: number;
  scoreGrade: string;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskReward: number;
  riskRewardIsSynthetic: boolean;
  invalidationReason: string | null;
  createdAt: number;
  /** The `detail` object the lifecycle wrote. Shapes are checked, not assumed. */
  snapshot: Record<string, unknown>;
  /** Confirmation payload from the transition that carried it, when there was one. */
  confirmationPayload: Record<string, unknown> | null;
}

/** A candidate the scanner scored without tracking a setup for it. */
export interface ScannerCandidateFacts {
  symbol: string;
  timeframe: string;
  analysisStatus: string;
  score: number;
  scoreGrade: string;
  riskReward: number | null;
  riskRewardIsSynthetic: boolean | null;
  trend: string | null;
  mtfAgreement: string | null;
  regimeDirection: string | null;
  analysedAtCandle: number | null;
  recordedAt: number;
}

/**
 * Evidence, sorted into the three kinds the confirmation engine distinguishes.
 *
 * A negative *primary* signal is opposing evidence — the market answered in the
 * wrong direction. A negative supporting signal, which in practice means thin
 * volume, is an absence: nobody showed up, and nobody showing up cannot refute
 * a rejection wick that visibly happened. Phase C draws that line and this
 * reads it; it is not redrawn here.
 */
function evidenceFrom(signals: unknown): CoachEvidence[] {
  if (!Array.isArray(signals)) return [];

  const evidence: CoachEvidence[] = [];

  for (const raw of signals) {
    if (typeof raw !== "object" || raw === null) continue;
    const signal = raw as { type?: unknown; signal?: unknown; title?: unknown; detail?: unknown };

    if (typeof signal.title !== "string" || typeof signal.signal !== "string") continue;

    const primary =
      typeof signal.type === "string" && isPrimarySignal(signal.type as ConfirmationSignalType);

    evidence.push({
      title: signal.title,
      detail: typeof signal.detail === "string" ? signal.detail : "",
      kind:
        signal.signal === "positive"
          ? "PRESENT"
          : signal.signal === "negative" && primary
            ? "CONTRADICTING"
            : "MISSING",
    });
  }

  return evidence;
}

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The score breakdown the engine wrote, kept in its own words. */
function breakdownFrom(snapshot: Record<string, unknown>) {
  const raw = snapshot.scoreBreakdown;
  if (typeof raw !== "object" || raw === null) return [];

  const out: { category: string; score: number; max: number; reason: string }[] = [];

  for (const [category, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as { score?: unknown; max?: unknown; reason?: unknown };
    if (typeof entry.score !== "number" || typeof entry.max !== "number") continue;

    out.push({
      category,
      score: entry.score,
      max: entry.max,
      reason: typeof entry.reason === "string" ? entry.reason : "",
    });
  }

  // Ordered by name so the same setup lists its categories the same way every
  // time — object key order is not something to rely on across a JSON round
  // trip, and a review that reshuffled itself would not be reproducible.
  return out.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
}

/**
 * The targets the engine chose, each with the reason it chose that level.
 *
 * The *level* comes from the column and the *words* come from the snapshot,
 * which is not a stylistic split. The column is `Decimal(24, 8)` and the JSON
 * keeps the original float, so the same target is 2560.44053765 in one and
 * 2560.440537649623 in the other. Every other surface — the setups page, the
 * shortlist, a Telegram message — reads the column, and a Coach that quoted the
 * snapshot would show a different number for the same target than the page the
 * reader just came from. The reasons and per-target ratios exist only in the
 * snapshot, so those are taken from there.
 */
function takeProfitsFrom(
  snapshot: Record<string, unknown>,
  columns: (number | null)[],
): { label: string; level: number; rr: number | null; reason: string | null }[] {
  const raw = Array.isArray(snapshot.takeProfits) ? snapshot.takeProfits : [];

  const described = raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) return null;
    const target = entry as { label?: unknown; rr?: unknown; reason?: unknown };

    return {
      label: typeof target.label === "string" ? target.label : null,
      rr: typeof target.rr === "number" ? target.rr : null,
      reason: typeof target.reason === "string" ? target.reason : null,
    };
  });

  return columns.flatMap((level, index) => {
    if (level === null) return [];
    const detail = described[index] ?? null;

    return [
      {
        label: detail?.label ?? `TP${index + 1}`,
        level,
        rr: detail?.rr ?? null,
        reason: detail?.reason ?? null,
      },
    ];
  });
}

export function contextFromTrackedSetup(facts: TrackedSetupFacts, runId: string): CoachContext {
  const { snapshot } = facts;
  const payload = facts.confirmationPayload ?? {};

  const regime = snapshot.regime;
  const regimeObject =
    typeof regime === "object" && regime !== null ? (regime as Record<string, unknown>) : {};

  return {
    identity: {
      symbol: facts.symbol,
      timeframe: facts.timeframe,
      runId,
      setupId: facts.setupId,
      analysedAtCandle: num(snapshot, "createdFromCandleTime"),
      recordedAt: facts.createdAt,
      source: "TRACKED_SETUP",
    },
    verdictInputs: {
      analysisStatus: facts.analysisStatus as CoachContext["verdictInputs"]["analysisStatus"],
      lifecycleStatus: facts.lifecycleStatus,
      confirmationStatus: (str(payload, "status") ??
        null) as CoachContext["verdictInputs"]["confirmationStatus"],
    },
    quality: {
      score: facts.score,
      grade: facts.scoreGrade as CoachContext["quality"]["grade"],
      breakdown: breakdownFrom(snapshot),
    },
    market: {
      trend: str(snapshot, "trend"),
      mtfAgreement: str(snapshot, "mtfAgreement"),
      regimeDirection: str(regimeObject, "direction"),
      regimeVolatility: str(regimeObject, "volatility"),
      regimeEvidence: num(regimeObject, "evidence"),
    },
    levels: {
      entryLow: facts.entryLow,
      entryHigh: facts.entryHigh,
      stopLoss: facts.stopLoss,
      takeProfits: takeProfitsFrom(snapshot, [
        facts.takeProfit1,
        facts.takeProfit2,
        facts.takeProfit3,
      ]),
      riskReward: facts.riskReward,
      riskRewardIsSynthetic: facts.riskRewardIsSynthetic,
      riskRewardReason: str(snapshot, "riskRewardReason"),
      entryReason: str(snapshot, "entryReason"),
      stopLossReason: str(snapshot, "stopLossReason"),
    },
    confirmation: {
      status: (str(payload, "status") ?? null) as CoachContext["confirmation"]["status"],
      explanation: str(payload, "explanation"),
      evaluatedAt: num(payload, "evaluatedAt"),
      evidence: evidenceFrom(payload.signals),
    },
    statusReason: str(snapshot, "statusReason"),
    invalidationReason: facts.invalidationReason,
  };
}

/**
 * A candidate that was scored but never tracked.
 *
 * `levels` is null and stays null. The scanner records a verdict and a score
 * for every market it looks at and stores levels only for setups it began
 * following, so there is nothing here to show — and working them out now would
 * mean running the engine against candles that closed after the run being
 * reviewed. A review that reaches forward in time is not a review of that
 * moment.
 */
export function contextFromScannerCandidate(
  facts: ScannerCandidateFacts,
  runId: string,
): CoachContext {
  return {
    identity: {
      symbol: facts.symbol,
      timeframe: facts.timeframe,
      runId,
      setupId: null,
      analysedAtCandle: facts.analysedAtCandle,
      recordedAt: facts.recordedAt,
      source: "SCANNER_RESULT",
    },
    verdictInputs: {
      analysisStatus: facts.analysisStatus as CoachContext["verdictInputs"]["analysisStatus"],
      lifecycleStatus: null,
      confirmationStatus: null,
    },
    quality: {
      score: facts.score,
      grade: facts.scoreGrade as CoachContext["quality"]["grade"],
      // The scanner stores the total, not the breakdown. An empty list is the
      // honest answer; a reconstructed one would be a second scoring engine.
      breakdown: [],
    },
    market: {
      trend: facts.trend,
      mtfAgreement: facts.mtfAgreement,
      regimeDirection: facts.regimeDirection,
      regimeVolatility: null,
      regimeEvidence: null,
    },
    levels: null,
    confirmation: { status: null, explanation: null, evaluatedAt: null, evidence: [] },
    statusReason: null,
    invalidationReason: null,
  };
}
