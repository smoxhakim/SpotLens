/**
 * The journal: human decisions, kept separate from engine output.
 */
export { canTransition, computeOutcome, validateOutcome, validateTransition } from "./decide";
export {
  ALLOWED_TRANSITIONS,
  POSITION_DECISIONS,
  type JournalDecision,
  type JournalError,
  type JournalErrorCode,
  type JournalEventType,
  type JournalSkipReason,
  type TradeExitReason,
  type TradeOutcome,
  type TradeOutcomeInput,
} from "./types";
