/**
 * The one message the engine's processes exchange.
 *
 * The scanner sends it after a pass has completed — every setup it created,
 * moved or invalidated is already in the database — and the engine relays it to
 * the entry-zone monitor, which reloads open setups at once instead of waiting
 * for its next scheduled reload. Nothing else travels between the processes:
 * no setup, no price, no level. The monitor reads those from the database the
 * same way it always does, so a message that is lost, late or duplicated can
 * only cost a reload, never change what is watched.
 */
export const SCANNER_RUN_COMPLETED = "scanner-run-completed" as const;

export interface ScannerRunCompletedMessage {
  type: typeof SCANNER_RUN_COMPLETED;
  /** Null when the pass could not record a run (no database). */
  runId: string | null;
}

export function scannerRunCompleted(runId: string | null): ScannerRunCompletedMessage {
  return { type: SCANNER_RUN_COMPLETED, runId };
}

/** Narrowing for anything that arrives over IPC, which is whatever was sent. */
export function isScannerRunCompleted(value: unknown): value is ScannerRunCompletedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === SCANNER_RUN_COMPLETED
  );
}
