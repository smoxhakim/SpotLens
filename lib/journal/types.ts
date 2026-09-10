/**
 * The trading journal.
 *
 * Everything else in SpotLens records what the engine concluded. This records
 * what a person decided about it, and the separation is the point: an engine
 * that produced eighty good setups and a user who took the wrong twelve are
 * two different results, and a single win rate across both would describe
 * neither.
 *
 * Nothing here executes anything. Every transition below is something a human
 * chose and then typed in.
 */

export type JournalDecision = "WATCHING" | "SKIPPED" | "TAKEN" | "CANCELLED" | "CLOSED";

export type JournalSkipReason =
  | "LOW_CONFIDENCE"
  | "POOR_RR"
  | "BAD_REGIME"
  | "NO_CONFIRMATION"
  | "PERSONAL_RULE"
  | "MARKET_CONDITION"
  | "MISSED_ENTRY"
  | "OTHER";

export type TradeExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL_EXIT" | "INVALIDATED" | "OTHER";

export type JournalEventType = "CREATED" | "DECISION_CHANGED" | "OUTCOME_RECORDED" | "NOTE_ADDED";

/**
 * Which decisions can follow which.
 *
 * `CLOSED` is terminal: a position that has been closed and recorded has an
 * outcome, and letting it move again would mean the recorded result no longer
 * describes the entry it is attached to. Everything else stays open, because a
 * person genuinely does change their mind — watching a setup, skipping it, then
 * taking it two candles later is an ordinary sequence, not an error.
 *
 * `TAKEN → SKIPPED` is deliberately absent: a position that was entered cannot
 * retroactively become one that was passed over. Abandoning it is CANCELLED.
 */
export const ALLOWED_TRANSITIONS: Record<JournalDecision, JournalDecision[]> = {
  WATCHING: ["SKIPPED", "TAKEN", "CANCELLED"],
  SKIPPED: ["WATCHING", "TAKEN"],
  TAKEN: ["CLOSED", "CANCELLED"],
  CANCELLED: ["WATCHING", "TAKEN"],
  CLOSED: [],
};

/** Decisions that describe a position the user actually entered. */
export const POSITION_DECISIONS: JournalDecision[] = ["TAKEN", "CLOSED"];

export interface TradeOutcomeInput {
  actualEntry: number;
  actualStopLoss?: number;
  actualTakeProfit?: number;
  actualExit?: number;
  quantity: number;
  fees?: number;
  slippage?: number;
  exitReason?: TradeExitReason;
  openedAt?: number;
  closedAt?: number;
}

/**
 * What a recorded trade actually produced.
 *
 * `realizedR` is null until there is an exit *and* a stop to measure risk
 * against. A trade without both has no R — inventing one from the setup's
 * planned stop would be attributing the engine's plan to the user's fill.
 */
export interface TradeOutcome {
  /** Quote-currency profit or loss before costs. */
  grossPnl: number | null;
  /** After the fees and slippage the user recorded. */
  netPnl: number | null;
  /** Risk actually taken: (actual entry − actual stop) × quantity. */
  riskAmount: number | null;
  /** Net result in multiples of the risk actually taken. */
  realizedR: number | null;
  holdingMs: number | null;
  costs: number;
}

export type JournalErrorCode =
  | "INVALID_TRANSITION"
  | "OUTCOME_REQUIRES_POSITION"
  | "INVALID_PRICE"
  | "INVALID_QUANTITY"
  | "INVALID_COSTS"
  | "STOP_NOT_BELOW_ENTRY"
  | "CLOSED_REQUIRES_EXIT"
  | "INVALID_TIMESTAMPS";

export interface JournalError {
  code: JournalErrorCode;
  field: string;
  message: string;
}
