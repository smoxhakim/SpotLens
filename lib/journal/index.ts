/**
 * The journal: human decisions, kept separate from engine output.
 */
export {
  buildAmendmentPayload,
  hasRecordedOutcome,
  readAmendmentPayload,
  supersededVersions,
  type AmendmentPayload,
  type StoredOutcome,
  type SupersededOutcome,
} from "./amendment";
export {
  buildLateEntryPayload,
  checkSetupDecision,
  closedSetupMove,
  describeLateEntry,
  lateEntryRecord,
  readLateEntry,
  LATE_ENTRY_OUTSIDE_WINDOW_MESSAGE,
  LATE_ENTRY_REQUIRED_MESSAGE,
  SETUP_CLOSED_MESSAGE,
  type ClosedSetupMove,
  type DecisionSetup,
  type LateEntryClaim,
  type LateEntryRecord,
} from "./closed-setup";
export { canTransition, computeOutcome, validateOutcome, validateTransition } from "./decide";
export {
  buildDecisionContext,
  coachWasRead,
  readDecisionContext,
  COACH_VERDICTS,
  type CoachReference,
  type CoachVerdictRecord,
  type DecisionContext,
  type DecisionContextPayload,
} from "./decision-context";
export {
  ALLOWED_TRANSITIONS,
  CLOSED_SETUP_ERROR_CODES,
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
