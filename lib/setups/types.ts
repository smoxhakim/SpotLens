import type { AnalysisResult, ConfirmationResult } from "@/lib/analysis";

/**
 * Where a tracked setup is in its life, as opposed to what the engine says
 * about the market right now.
 *
 * `CONFIRMATION_DETECTED` is a lifecycle state and nothing more. It records
 * that the deterministic confirmation engine returned PRESENT at some point;
 * it is not a fifth trading status, and it is never an instruction. A setup can
 * sit in it indefinitely while some other rule holds the analysis at WAIT.
 */
export type SetupLifecycleStatus =
  | "SETUP_FORMING"
  | "WAITING_CONFIRMATION"
  | "CONFIRMATION_DETECTED"
  | "POTENTIAL_SETUP"
  | "INVALIDATED";

export type SetupEventType =
  "CREATED" | "STATUS_CHANGED" | "CONFIRMATION_DETECTED" | "POTENTIAL_SETUP" | "INVALIDATED";

/**
 * The support zone a setup is anchored to — its identity.
 *
 * Stored as an interval rather than a key because zones are ATR-scaled and
 * shift slightly on every candle. See `isSameOrigin`.
 */
export interface SetupOrigin {
  zoneLow: number;
  zoneHigh: number;
}

/**
 * Why a moved anchor closed a setup, judged from where the analysed candle
 * closed against the zone stored with the setup. See `closureOf`.
 *
 * - SUPPORT_LOST: closed below the zone. The level failed.
 * - LOWER_HALF: closed inside the zone, at or below its midpoint, which
 *   reclassified it as resistance. Nothing has closed through it.
 * - SUPERSEDED: closed above the midpoint or above the zone, and the engine now
 *   anchors elsewhere — usually a nearer support that formed above it.
 */
export type ClosureCause = "SUPPORT_LOST" | "LOWER_HALF" | "SUPERSEDED";

/** The cause, and the prices it was judged from, as they stood. */
export interface SetupClosure {
  cause: ClosureCause;
  close: number;
  originLow: number;
  originHigh: number;
  anchorLow: number;
  anchorHigh: number;
}

/**
 * The values as they stood when the setup was first seen.
 *
 * Written once and never updated. Later analysis moving the entry or the score
 * is the market changing, not a correction to apply — overwriting these would
 * destroy the only record of what was actually on offer at the time.
 */
export interface SetupSnapshot {
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskReward: number;
  /** Phase A's qualifier, carried through so a stored setup cannot lose it. */
  riskRewardIsSynthetic: boolean;
  score: number;
  scoreGrade: string;
  analysisStatus: AnalysisResult["status"];
  /** Full reasons, targets and score breakdown, so the row explains itself. */
  detail: SetupSnapshotDetail;
}

export interface SetupSnapshotDetail {
  entryReason: string;
  stopLossReason: string;
  riskRewardReason: string;
  statusReason: string;
  takeProfits: { label: string; level: number; rr: number; kind: string; reason: string }[];
  scoreBreakdown: Record<string, { score: number; max: number; reason: string }>;
  trend: string;
  mtfAgreement: string | null;
  createdFromCandleTime: number;
  /**
   * The environment the setup was first seen in. Context only — it played no
   * part in the setup existing, and nothing downstream may treat it as if it
   * had.
   */
  regime: { direction: string; volatility: string; evidence: number } | null;
}

/** The open setup being reconciled against, as the planner needs to see it. */
export interface ExistingSetup {
  id: string;
  status: SetupLifecycleStatus;
  origin: SetupOrigin;
  /** Whether confirmation has ever been recorded, so it is stamped only once. */
  hasConfirmedAt: boolean;
}

export interface PlannedEvent {
  type: SetupEventType;
  detail: string;
  payload: ConfirmationPayload | null;
}

/** What the confirmation engine said, frozen at the moment of a transition. */
export interface ConfirmationPayload {
  status: ConfirmationResult["status"];
  explanation: string;
  evaluatedAt: number;
  signals: { type: string; signal: string; title: string; detail: string }[];
}

export interface PlannedCreate {
  status: SetupLifecycleStatus;
  origin: SetupOrigin;
  snapshot: SetupSnapshot;
  event: PlannedEvent;
  /** Set when confirmation was already present the first time we saw it. */
  marksConfirmed: boolean;
}

export interface PlannedTransition {
  setupId: string;
  from: SetupLifecycleStatus;
  to: SetupLifecycleStatus;
  event: PlannedEvent;
  /** Stamp `confirmedAt` — false whenever the stored setup already has one. */
  marksConfirmed: boolean;
  /**
   * Present only when a moved anchor closed the setup, and written onto the
   * event's payload beside what confirmation said. Absent rather than null, so
   * no other transition's plan changes shape.
   */
  closure?: SetupClosure;
  invalidationReason: string | null;
}

/**
 * What the lifecycle should do about this analysis run.
 *
 * A plan rather than a database call, so every rule below is a pure function of
 * (existing row, analysis result) and can be tested without a database. The
 * service's only job is to execute it.
 */
/**
 * Why a plan writes nothing — typed, so a caller never has to read the prose.
 *
 * - NO_SETUP: the engine built no levels, and nothing is tracked.
 * - CONTRADICTED_UNTRACKED: the engine built levels, but confirmation was
 *   contradicted on a level nobody was tracking, so none is created.
 * - UNCHANGED: a tracked setup was re-observed in the state it is already in.
 *
 * Two more are the service's, decided before the planner runs — it never
 * returns them:
 *
 * - NON_CANONICAL_CONTEXT: the analysis read a higher timeframe other than the
 *   entry timeframe's canonical one (`readsCanonicalContext`), so it does not
 *   speak for the setup tracked there.
 * - STALE_ANALYSIS: the analysis is of an older candle than one already
 *   recorded for this setup (`isStaleAnalysis`), so it may not move it back.
 */
export type NoActionCause =
  "NO_SETUP" | "CONTRADICTED_UNTRACKED" | "UNCHANGED" | "NON_CANONICAL_CONTEXT" | "STALE_ANALYSIS";

/**
 * Why a scanned result has no tracked setup behind it.
 *
 * - CONFIRMATION_CONTRADICTED: levels existed; confirmation was contradicted on
 *   a level nobody was tracking. Nothing was invalidated — nothing existed.
 * - NO_LEVELS: the engine produced no entry, stop or target to track.
 * - NOT_RECORDED: not known — a stored row (the reason is not persisted), or a
 *   pass whose lifecycle step could not run. Said as unknown, never guessed.
 */
export type UntrackedReason = "CONFIRMATION_CONTRADICTED" | "NO_LEVELS" | "NOT_RECORDED";

export type SetupPlan =
  | { action: "NONE"; reason: string; cause: NoActionCause }
  | { action: "CREATE"; create: PlannedCreate }
  | { action: "TRANSITION"; transition: PlannedTransition }
  | { action: "REPLACE"; invalidate: PlannedTransition; create: PlannedCreate };
