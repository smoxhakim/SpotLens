import { TIMEFRAME_MS, type Timeframe } from "@/lib/market-data/provider";
import { currentCandleOpen } from "@/lib/scanner/schedule";

/**
 * The rules that keep two lifecycle writers from corrupting one setup.
 *
 * Pure. `services/setups.ts` runs every reconciliation inside one transaction
 * that holds a per-identity advisory lock; this file decides what that lock is
 * keyed on, whether an analysis is too old to write, and which failures are
 * safe to retry. None of it reads a clock or a database.
 */

/** What one tracked setup is identified by — the fields `findOpenSetup` reads on. */
export interface SetupIdentity {
  userId: string;
  tradingPairId: string;
  timeframe: Timeframe;
}

/**
 * The advisory-lock key for one setup identity.
 *
 * Exactly the identity, never more and never less. A key narrower than the
 * identity — one that also named the higher timeframe, say — would let two
 * writers take different locks, read the same open setup (or the same "none"),
 * and both create one: the duplicate the lock exists to prevent. A wider key
 * would only make unrelated markets wait. The components are two UUIDs and an
 * enum, so the separator is unambiguous. Hashed to 64 bits in SQL.
 */
export function lifecycleLockKey(identity: SetupIdentity): string {
  return `spotlens:tracked-setup:${identity.userId}:${identity.tradingPairId}:${identity.timeframe}`;
}

/**
 * A guarded write found the setup no longer in the state the plan was made
 * from. Thrown inside the transaction, so everything it did is rolled back;
 * the retry re-reads under the lock and plans again from what is there.
 */
export class LifecycleConflictError extends Error {
  readonly code = "LIFECYCLE_CONFLICT";

  constructor(setupId: string, expected: string) {
    super(`Setup ${setupId} is no longer ${expected}.`);
    this.name = "LifecycleConflictError";
  }
}

// --- staleness ---------------------------------------------------------------

/** The newest candle times already recorded for one setup identity. */
export interface RecordedCandles {
  /** Newest confirmation `evaluatedAt` (a candle close time) on any event, or null. */
  newestEvaluatedAt: number | null;
  /** When the newest event that carries no `evaluatedAt` was written, or null. */
  newestUnstampedAt: number | null;
}

/**
 * Open time of the newest candle any recorded event was decided on, or null.
 *
 * An event with a confirmation payload names its candle exactly. One without —
 * the "engine offered no setup" invalidation writes a null payload — names
 * none, and on about one key in five that is the newest event. For those the
 * candle is bounded instead: whatever the writer analysed had closed before the
 * row was written, so it is at most the candle that had most recently closed
 * at `createdAt`. An upper bound can only refuse more often, never admit an
 * older analysis.
 *
 * Candle times are snapped to their bucket, so a close time written as
 * `open + size - 1` and one written as `open + size` name the same candle.
 */
export function newestRecordedCandle(
  timeframe: Timeframe,
  recorded: RecordedCandles,
): number | null {
  const candidates: number[] = [];

  if (recorded.newestEvaluatedAt !== null && recorded.newestEvaluatedAt > 0) {
    candidates.push(currentCandleOpen(timeframe, recorded.newestEvaluatedAt - 1));
  }
  if (recorded.newestUnstampedAt !== null) {
    candidates.push(
      currentCandleOpen(timeframe, recorded.newestUnstampedAt) - TIMEFRAME_MS[timeframe],
    );
  }

  return candidates.length === 0 ? null : Math.max(...candidates);
}

/**
 * Whether an analysis is older than a state already recorded for its setup.
 *
 * The status guard on every write stops a plan made from a stale *read*; it
 * does not stop a plan made from a stale *analysis*. An older candle can still
 * validly move CONFIRMATION_DETECTED back to WAITING, or re-create a level a
 * newer analysis has just invalidated. Strictly older only: the same candle
 * again is the normal repeated pass, and it must still plan (to NONE).
 *
 * `analysedCandleOpen` is the open time of the last candle the analysis read
 * (`result.read.lastCandleTime`). Zero means it read none, and is not judged.
 */
export function isStaleAnalysis(input: {
  timeframe: Timeframe;
  analysedCandleOpen: number;
  recorded: RecordedCandles;
}): boolean {
  if (input.analysedCandleOpen <= 0) return false;

  const newest = newestRecordedCandle(input.timeframe, input.recorded);
  if (newest === null) return false;

  return currentCandleOpen(input.timeframe, input.analysedCandleOpen) < newest;
}

// --- failures ----------------------------------------------------------------

/**
 * Where the transaction had got to when it failed.
 *
 * - BEGIN: the callback never ran — nothing was written.
 * - BODY: the callback threw — COMMIT was never sent, so nothing commits.
 * - COMMIT: the callback finished and the failure came after it — the one
 *   place a change can have committed while its caller sees an error.
 */
export type TransactionPhase = "BEGIN" | "BODY" | "COMMIT";

/**
 * What a failed attempt means.
 *
 * - RETRY: certainly rolled back, and transient — a second attempt re-reads
 *   under the lock and plans again, so it cannot duplicate an event.
 * - NOT_WRITTEN: certainly rolled back, not worth repeating.
 * - UNCERTAIN: may have committed. Never retried, and reported as such — a
 *   committed change whose outcome was lost also loses its notification.
 */
export type LifecycleFailureKind = "RETRY" | "NOT_WRITTEN" | "UNCERTAIN";

export interface LifecycleFailure {
  kind: LifecycleFailureKind;
  /** A code, never a message: provider text is not logged. */
  code: string;
}

/** Postgres `lock_not_available` — `lock_timeout` expired on the advisory lock. */
const LOCK_TIMEOUT = "55P03";

/**
 * Classifies a failed lifecycle transaction.
 *
 * Retried only when a rollback is certain *and* the cause is transient: a
 * guarded write that found the row moved, a lock wait that timed out, a write
 * conflict or deadlock (P2034), or a transaction that could not start in time.
 * Prisma's own transaction timeout (P2028) is never retried: it means the work
 * is slow, and repeating it only holds the key longer. An error after the
 * callback finished is UNCERTAIN unless it is that timeout refusing the commit.
 */
export function classifyLifecycleError(err: unknown, phase: TransactionPhase): LifecycleFailure {
  const code = errorCode(err);

  if (phase === "BEGIN") {
    const couldNotStart =
      code === "P2024" || (code === "P2028" && messageOf(err).includes("Unable to start"));
    return { kind: couldNotStart ? "RETRY" : "NOT_WRITTEN", code };
  }

  if (phase === "BODY") {
    const transient =
      err instanceof LifecycleConflictError || code === "P2034" || code === LOCK_TIMEOUT;
    return { kind: transient ? "RETRY" : "NOT_WRITTEN", code };
  }

  const commitRefused = code === "P2028" && /expired|already closed/i.test(messageOf(err));
  return { kind: commitRefused ? "NOT_WRITTEN" : "UNCERTAIN", code };
}

/**
 * A stable code for an error, never its message.
 *
 * A raw query that fails in Postgres surfaces as Prisma's P2010 with the
 * SQLSTATE in `meta.code`; the SQLSTATE is the more useful of the two.
 */
function errorCode(err: unknown): string {
  if (err instanceof LifecycleConflictError) return err.code;
  if (typeof err !== "object" || err === null) return "UNKNOWN";

  const record = err as { code?: unknown; meta?: { code?: unknown }; name?: unknown };
  if (record.code === "P2010" && typeof record.meta?.code === "string") return record.meta.code;
  if (typeof record.code === "string") return record.code;
  return typeof record.name === "string" ? record.name : "UNKNOWN";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "";
}
