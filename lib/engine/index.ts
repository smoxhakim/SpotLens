/**
 * The local engine: `npm run spotlens`.
 *
 * Runs the scanner and the entry-zone monitor as two supervised processes and
 * hands one message between them — "a scan completed" — so the monitor starts
 * watching a new setup within seconds instead of at its next scheduled reload.
 * It analyses nothing and decides nothing; each child is the same script that
 * runs on its own. See `scripts/spotlens.ts`.
 */
export {
  DEFAULT_RESTART_POLICY,
  FORCE_INTERRUPT_AFTER_MS,
  createLineSplitter,
  createSupervisor,
  isForceInterrupt,
  prefixLine,
  restartDecision,
  type ChildHandle,
  type ChildName,
  type ChildSpec,
  type ChildState,
  type RestartPolicy,
  type Supervisor,
  type SupervisorDeps,
} from "./supervisor";

export {
  EXIT_ALREADY_RUNNING,
  acquireLock,
  defaultLockDir,
  holdLockOrExit,
  processIsAlive,
  type LockResult,
  type LockRole,
} from "./lock";

export {
  SCANNER_RUN_COMPLETED,
  isScannerRunCompleted,
  scannerRunCompleted,
  type ScannerRunCompletedMessage,
} from "./messages";

export { isCatchUpDue, latestDueScanWindow } from "./catch-up";
