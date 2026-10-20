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
  LATE_WAKE_TOLERANCE_MS,
  closedCandlesOnly,
  currentCandleOpen,
  nextCandleClose,
  nextScanWindow,
  latestScanWindow,
  markScanned,
  planScan,
  scanOnWake,
  scannedThroughAt,
  settlementDelayMs,
  type ScannedThrough,
  type ScanWindow,
  type WakeScan,
} from "./schedule";
export { mapWithConcurrency, sleep } from "./concurrency";
export {
  FAILED_PASS_RETRY_DELAYS_MS,
  classifyPass,
  classifyPassError,
  nextWake,
  recordPass,
  startSchedule,
  startupRetryDelay,
  type PassOutcome,
  type ScheduleState,
} from "./retry";
export {
  MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  classifyFailure,
  HigherTimeframeUnavailableError,
  StaleCandlesError,
  withRetries,
  type AttemptResult,
  type ClassifiedFailure,
  type ScannerFailureCategory,
} from "./failures";
export { STATUS_RANK, effectiveRiskReward, rankResults, type RankableResult } from "./ranking";
export {
  SHORTLIST_RANKING_VERSION,
  SHORTLIST_SIZES,
  buildShortlist,
  exclusionFor,
  isShortlistEligible,
  reasonsFor,
  spreadAcrossMarkets,
  untrackedReasonFor,
  viewOf,
  type ExclusionReason,
  type Shortlist,
  type ShortlistCandidate,
  type ShortlistInput,
  type ShortlistSize,
  type UntrackedReason,
} from "./shortlist";
export { SUCCESSFUL_RUN_STATUSES, successfulPassWhere, type SuccessfulRunStatus } from "./runs";
export {
  eventsForOutcome,
  failureEvent,
  type LifecycleOutcome,
  type ScannerEvent,
  type ScannerEventType,
} from "./events";
