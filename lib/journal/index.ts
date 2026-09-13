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
