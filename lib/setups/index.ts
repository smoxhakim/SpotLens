/**
 * Setup identity and lifecycle.
 *
 * Pure: given the stored setup and a finished `AnalysisResult`, it returns a
 * plan. `services/setups.ts` is the only thing that touches the database, which
 * keeps `lib/analysis` free of I/O and keeps these rules testable without one.
 */
export {
  lifecycleStatusFor,
  isSameOrigin,
  originOf,
  reconcileSetup,
  untrackedReasonOf,
  snapshotOf,
  TERMINAL_STATUS,
} from "./lifecycle";
export { confirmationCaveat, LIFECYCLE_LABELS, lifecycleLabel } from "./labels";
export { readsCanonicalContext } from "./context";
export {
  classifyLifecycleError,
  isStaleAnalysis,
  LifecycleConflictError,
  lifecycleLockKey,
  newestRecordedCandle,
} from "./conflict";
export type {
  LifecycleFailure,
  LifecycleFailureKind,
  RecordedCandles,
  SetupIdentity,
  TransactionPhase,
} from "./conflict";
export type {
  ConfirmationPayload,
  ExistingSetup,
  NoActionCause,
  PlannedCreate,
  PlannedEvent,
  PlannedTransition,
  SetupEventType,
  SetupLifecycleStatus,
  SetupOrigin,
  SetupPlan,
  SetupSnapshot,
  SetupSnapshotDetail,
  UntrackedReason,
} from "./types";
