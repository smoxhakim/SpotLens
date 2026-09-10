/**
 * Scanner logic that does not touch the network or the database.
 *
 * Scheduling, concurrency, retries, failure classification, ranking and event
 * derivation all live here so they can be tested without a provider or a
 * database. `services/scanner.ts` is the part that performs I/O, and it owns no
 * rules of its own.
 */
export {
  DEFAULT_CLOSE_DELAY_MS,
  DEFAULT_SCAN_TIMEFRAMES,
  closedCandlesOnly,
  currentCandleOpen,
  nextCandleClose,
  nextScanWindow,
  type ScanWindow,
} from "./schedule";
export { mapWithConcurrency, sleep } from "./concurrency";
export {
  MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  classifyFailure,
  withRetries,
  type AttemptResult,
  type ClassifiedFailure,
  type ScannerFailureCategory,
} from "./failures";
export { STATUS_RANK, effectiveRiskReward, rankResults, type RankableResult } from "./ranking";
export {
  eventsForOutcome,
  failureEvent,
  type LifecycleOutcome,
  type ScannerEvent,
  type ScannerEventType,
} from "./events";
