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
  snapshotOf,
  TERMINAL_STATUS,
} from "./lifecycle";
export type {
  ConfirmationPayload,
  ExistingSetup,
  PlannedCreate,
  PlannedEvent,
  PlannedTransition,
  SetupEventType,
  SetupLifecycleStatus,
  SetupOrigin,
  SetupPlan,
  SetupSnapshot,
  SetupSnapshotDetail,
} from "./types";
