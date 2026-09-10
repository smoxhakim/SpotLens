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
  /** Stamp `confirmedAt` — the service applies it only if still null. */
  marksConfirmed: boolean;
  invalidationReason: string | null;
}

/**
 * What the lifecycle should do about this analysis run.
 *
 * A plan rather than a database call, so every rule below is a pure function of
 * (existing row, analysis result) and can be tested without a database. The
 * service's only job is to execute it.
 */
export type SetupPlan =
  | { action: "NONE"; reason: string }
  | { action: "CREATE"; create: PlannedCreate }
  | { action: "TRANSITION"; transition: PlannedTransition }
  | { action: "REPLACE"; invalidate: PlannedTransition; create: PlannedCreate };
