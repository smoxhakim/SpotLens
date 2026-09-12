import type { ConfirmationStatus, SetupGrade, TradeStatus } from "@/lib/analysis";

/**
 * The Coach: an interpretation layer over an analysis SpotLens already made.
 *
 * The division of labour is the whole design. SpotLens owns every number —
 * entry, stop, targets, the measured ratio, the score, the regime — and the
 * Coach owns only the reading of them. Nothing here computes an indicator,
 * moves a level, or reaches a verdict the engine did not already support; if a
 * fact is not in the context below, the Coach says it is not recorded rather
 * than supplying one.
 *
 * That is also why the context is a closed structure rather than a bag of
 * whatever was handy. A reviewer that can only see these fields cannot
 * accidentally review something else.
 */

/** A number the engine produced, with the reason it produced it. */
export interface CoachFact {
  label: string;
  value: string;
  /** The engine's own wording. Never paraphrased, never regenerated. */
  reason: string | null;
}

/** One piece of evidence, classified the way the confirmation engine classifies it. */
export interface CoachEvidence {
  title: string;
  detail: string;
  /**
   * Missing and contradicting are different things and are never merged.
   * `NOT_PRESENT` is an absence — nobody showed up. `CONTRADICTED` is opposing
   * evidence — the market answered in the wrong direction. Only a primary
   * signal can supply the latter, which is Phase C's rule, not a new one.
   */
  kind: "PRESENT" | "MISSING" | "CONTRADICTING";
}

export interface CoachLevels {
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfits: { label: string; level: number; rr: number | null; reason: string | null }[];
  riskReward: number;
  /**
   * Phase A's qualifier, carried the whole way to the screen. A ratio measured
   * to an R-multiple is the fallback ladder restating its own constant, and the
   * Coach must never discuss it as though structure supported it.
   */
  riskRewardIsSynthetic: boolean;
  riskRewardReason: string | null;
  entryReason: string | null;
  stopLossReason: string | null;
}

/**
 * Everything the Coach is allowed to see.
 *
 * Built once, purely, from canonical data. `levels` is null for a candidate
 * that was never tracked: the scanner records the verdict and the score for
 * every market it looks at but only stores levels for setups it began
 * following, and inventing them here — or recomputing them from today's
 * candles for a run that happened yesterday — would be the two ways to get
 * this wrong.
 */
export interface CoachContext {
  identity: {
    symbol: string;
    timeframe: string;
    runId: string;
    setupId: string | null;
    /** Close time of the candle the analysis ran on. The cutoff. */
    analysedAtCandle: number | null;
    /** When the reviewed record was written. Never "now". */
    recordedAt: number | null;
    source: "TRACKED_SETUP" | "SCANNER_RESULT";
  };
  verdictInputs: {
    analysisStatus: TradeStatus;
    lifecycleStatus: string | null;
    confirmationStatus: ConfirmationStatus | null;
  };
  quality: {
    score: number;
    grade: SetupGrade;
    /** Per category, with the engine's reason for each. */
    breakdown: { category: string; score: number; max: number; reason: string }[];
  };
  market: {
    trend: string | null;
    mtfAgreement: string | null;
    regimeDirection: string | null;
    regimeVolatility: string | null;
    regimeEvidence: number | null;
  };
  levels: CoachLevels | null;
  confirmation: {
    status: ConfirmationStatus | null;
    explanation: string | null;
    evaluatedAt: number | null;
    evidence: CoachEvidence[];
  };
  /** The engine's own sentence about why the setup stands where it does. */
  statusReason: string | null;
  /** Why the setup was invalidated, when it was. */
  invalidationReason: string | null;
}

/**
 * How the Coach reads the evidence.
 *
 * Educational readings, not instructions. None of them names a direction or an
 * action, because a verdict that did would be a trading signal wearing a
 * different word.
 */
export type CoachVerdict =
  | "STRONG_EVIDENCE"
  | "PROMISING_NEEDS_CONFIRMATION"
  | "MIXED_EVIDENCE"
  | "CONTRADICTED"
  | "INSUFFICIENT_DATA";

export const VERDICT_LABELS: Record<CoachVerdict, string> = {
  STRONG_EVIDENCE: "Strong evidence",
  PROMISING_NEEDS_CONFIRMATION: "Promising, but needs confirmation",
  MIXED_EVIDENCE: "Mixed evidence",
  CONTRADICTED: "Contradicted",
  INSUFFICIENT_DATA: "Insufficient data",
};

export interface CoachSection {
  title: string;
  points: string[];
}

/**
 * The review.
 *
 * Structured rather than prose, so no part of it can quietly become the source
 * of a number. Every numeric value a reader sees comes from `context`, which
 * travels alongside; this carries only the reading.
 */
export interface CoachReview {
  verdict: CoachVerdict;
  summary: string;
  strengths: CoachSection;
  concerns: CoachSection;
  confirmationReview: CoachSection;
  riskRewardReview: CoachSection;
  invalidationReview: CoachSection;
  chartChecks: CoachSection;
  /** Which provider produced this reading, for the reader and for tests. */
  providerId: string;
}

export interface CoachResult {
  context: CoachContext;
  review: CoachReview;
}
