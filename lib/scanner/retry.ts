import { databaseFailureOf } from "@/lib/db/failure";
import { TIMEFRAME_MS, type Timeframe } from "@/lib/market-data/provider";

import { classifyFailure } from "./failures";
import {
  DEFAULT_CLOSE_DELAY_MS,
  latestScanWindow,
  markScanned,
  planScan,
  scannedThroughAt,
  type ScannedThrough,
} from "./schedule";

/**
 * Retrying a scheduled pass that failed, and deciding what a failed pass leaves
 * covered.
 *
 * The common cause is a laptop that has just woken: the timer fires before
 * Wi-Fi is back, every request fails, and the pass is FAILED. Without a retry
 * the windows it was for were simply gone until the next close — an hour for
 * H1, up to four for H4, setups unverified and their entry-zone alerts withheld
 * all that time. So a pass that failed for reasons that can pass is tried again
 * after 1, 2, 5 and 10 minutes, and never past the next scheduled window: that
 * window's own pass covers the failed timeframes as well, because a failed pass
 * leaves them uncovered.
 *
 * Bounded on every side: at most four retries per scheduled window, at most one
 * pass in flight (the loop is sequential and the scanner lock keeps it the only
 * one), and no retry at all for a failure that will not change (bad data, an
 * analysis error, a write the database refused) or for a pass that was stopped on
 * purpose. The cost is up to five passes an hour while the exchange or the database
 * is unreachable, each failing fast.
 *
 * Pure: the clock is passed in.
 */
export const FAILED_PASS_RETRY_DELAYS_MS: readonly number[] = [1, 2, 5, 10].map((m) => m * 60_000);

/**
 * - SUCCEEDED: COMPLETED or PARTIAL, with nothing wrong in the database. The markets
 *   that failed failed on their own, and everything else is stored.
 * - FAILED_TRANSIENT: a database failure that can pass, or every market failed and
 *   at least one for a reason that can pass (network, timeout, rate limit, 5xx).
 *   Left uncovered and retried.
 * - FAILED_BLOCKED: a database failure that will not pass by itself, no markets to
 *   scan, or a pass that threw for a reason a retry would not change. It cannot be
 *   called covered, because it did not cover the universe, and retrying within the
 *   hour would not help. Left uncovered with no retries: one attempt per window.
 * - FAILED_PERMANENT: every market failed at the exchange or in analysis, none for a
 *   reason that can pass. Covered, and the schedule moves on.
 * - INTERRUPTED: stopped on purpose (Ctrl-C, SIGTERM, the engine going away).
 */
export type PassOutcome =
  "SUCCEEDED" | "FAILED_TRANSIENT" | "FAILED_BLOCKED" | "FAILED_PERMANENT" | "INTERRUPTED";

/**
 * First match wins. A database failure outranks everything but a deliberate stop,
 * and a permanent one outranks a transient one, so a pass that stored only part of
 * what it should have can never read as a success, however many markets went well.
 */
export function classifyPass(summary: {
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  interrupted: boolean;
  results: {
    ok: boolean;
    failure?: { retryable: boolean; database?: "TRANSIENT" | "PERMANENT" } | null;
  }[];
  saveFailure?: { class: "TRANSIENT" | "PERMANENT" } | null;
  emptyUniverse?: boolean;
}): PassOutcome {
  if (summary.interrupted) return "INTERRUPTED";

  const database = summary.results.map((r) => r.failure?.database ?? null);
  if (summary.saveFailure) database.push(summary.saveFailure.class);
  if (database.includes("PERMANENT")) return "FAILED_BLOCKED";
  if (database.includes("TRANSIENT")) return "FAILED_TRANSIENT";

  if (summary.emptyUniverse) return "FAILED_BLOCKED";
  if (summary.status !== "FAILED") return "SUCCEEDED";
  return summary.results.some((r) => !r.ok && r.failure?.retryable === true)
    ? "FAILED_TRANSIENT"
    : "FAILED_PERMANENT";
}

/**
 * A pass that threw instead of returning, so no market result exists: the database
 * being unreachable before the first market, typically. Transient when it can pass.
 * Anything else is blocked rather than covered, because nothing was scanned.
 */
export function classifyPassError(error: unknown, aborted: boolean): PassOutcome {
  if (aborted) return "INTERRUPTED";
  const database = databaseFailureOf(error);
  if (database) return database.class === "TRANSIENT" ? "FAILED_TRANSIENT" : "FAILED_BLOCKED";
  return classifyFailure(error).retryable ? "FAILED_TRANSIENT" : "FAILED_BLOCKED";
}

/**
 * A startup read of the database — the scanner's owner — failed. How long to
 * wait before trying again, or null to give up.
 *
 * The same policy as a failed pass: only a transient error (an unreachable
 * database or network — what `classifyPassError` calls transient) is retried,
 * after 1, 2, 5 and 10 minutes, so a laptop that starts the engine before its
 * network is up waits for it instead of exiting. A permanent error (bad
 * credentials, a database that does not exist, anything else) is not retried:
 * waiting would not fix it. `failedAttempts` counts the failures so far.
 */
export function startupRetryDelay(error: unknown, failedAttempts: number): number | null {
  if (classifyPassError(error, false) !== "FAILED_TRANSIENT") return null;
  return FAILED_PASS_RETRY_DELAYS_MS[failedAttempts - 1] ?? null;
}

export interface ScheduleState {
  /** What each timeframe has been scanned through. A failed-transient pass leaves it alone. */
  covered: ScannedThrough;
  /** A retry of a failed pass, bounded by the scheduled window `until`. */
  retry: { at: number; attempt: number; until: number } | null;
  /** Retries exhausted: nothing before this scheduled window, which rescans what failed. */
  notBefore: number | null;
}

/**
 * Where the schedule starts. Without a catch-up pass, everything settled by
 * `now` counts as covered. A catch-up pass covers what had settled when it
 * started — unless it failed transiently or was blocked, in which case those
 * windows stay uncovered and the schedule treats it as it would any other pass.
 */
export function startSchedule(input: {
  timeframes: Timeframe[];
  now: number;
  delayMs?: number;
  catchUp?: { decidedAt: number; finishedAt: number; outcome: PassOutcome } | null;
}): ScheduleState {
  const delayMs = input.delayMs ?? DEFAULT_CLOSE_DELAY_MS;
  const fresh = (covered: ScannedThrough): ScheduleState => ({
    covered,
    retry: null,
    notBefore: null,
  });

  const catchUp = input.catchUp;
  if (!catchUp) return fresh(scannedThroughAt(input.timeframes, input.now, delayMs));
  if (catchUp.outcome !== "FAILED_TRANSIENT" && catchUp.outcome !== "FAILED_BLOCKED") {
    return fresh(scannedThroughAt(input.timeframes, catchUp.decidedAt, delayMs));
  }

  // Covered up to the window before the one the catch-up was for.
  const before: ScannedThrough = Object.fromEntries(
    input.timeframes.map((tf) => [
      tf,
      latestScanWindow(tf, catchUp.decidedAt, delayMs) - TIMEFRAME_MS[tf],
    ]),
  );
  return recordPass(fresh(before), {
    timeframes: input.timeframes,
    scanned: input.timeframes,
    decidedAt: catchUp.decidedAt,
    finishedAt: catchUp.finishedAt,
    outcome: catchUp.outcome,
    delayMs,
  });
}

/** When to wake next, and whether that wake is a retry (and which). */
export function nextWake(input: {
  state: ScheduleState;
  timeframes: Timeframe[];
  delayMs?: number;
}): { at: number; retryAttempt: number | null } {
  const { state } = input;
  if (state.retry) return { at: state.retry.at, retryAttempt: state.retry.attempt };
  const planned = planScan({
    timeframes: input.timeframes,
    scannedThrough: state.covered,
    delayMs: input.delayMs,
  }).at;
  return { at: Math.max(planned, state.notBefore ?? -Infinity), retryAttempt: null };
}

/**
 * The schedule after a pass over `scanned`, decided at `decidedAt` and finished
 * at `finishedAt`.
 *
 * Succeeded, or failed for good at the exchange: covered, and the schedule moves
 * on. Interrupted: unchanged; the loop is ending. Blocked: not covered, not retried,
 * and nothing until the next window, whose pass rescans these timeframes too. So a
 * database failure that will not pass costs one attempt a window and still keeps H4
 * due until a pass succeeds. Failed transiently: not covered, and retried after the
 * next delay — unless the retries for this scheduled window are spent, or the next
 * would not come before the window; then the same as blocked. The attempt count
 * starts again at each new window.
 */
export function recordPass(
  state: ScheduleState,
  input: {
    timeframes: Timeframe[];
    scanned: Timeframe[];
    decidedAt: number;
    finishedAt: number;
    outcome: PassOutcome;
    delayMs?: number;
  },
): ScheduleState {
  const delayMs = input.delayMs ?? DEFAULT_CLOSE_DELAY_MS;

  if (input.outcome === "INTERRUPTED") return state;

  if (input.outcome === "SUCCEEDED" || input.outcome === "FAILED_PERMANENT") {
    return {
      covered: markScanned(state.covered, input.scanned, input.decidedAt, delayMs),
      retry: null,
      notBefore: null,
    };
  }

  // The next scheduled window after this pass ended — the bound on retrying.
  const nextWindowAt = planScan({
    timeframes: input.timeframes,
    scannedThrough: scannedThroughAt(input.timeframes, input.finishedAt, delayMs),
    delayMs,
  }).at;

  if (input.outcome === "FAILED_BLOCKED") {
    return { covered: state.covered, retry: null, notBefore: nextWindowAt };
  }

  const attempt = state.retry && state.retry.until === nextWindowAt ? state.retry.attempt + 1 : 1;
  const delay = FAILED_PASS_RETRY_DELAYS_MS[attempt - 1];

  if (delay !== undefined && input.finishedAt + delay < nextWindowAt) {
    return {
      covered: state.covered,
      retry: { at: input.finishedAt + delay, attempt, until: nextWindowAt },
      notBefore: null,
    };
  }
  return { covered: state.covered, retry: null, notBefore: nextWindowAt };
}
