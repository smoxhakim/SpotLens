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
 * Retrying a scheduled pass in which every market failed.
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
 * analysis error) or for a pass that was stopped on purpose. The cost is up to
 * five passes an hour while the exchange is unreachable, each failing fast.
 *
 * Pure: the clock is passed in.
 */
export const FAILED_PASS_RETRY_DELAYS_MS: readonly number[] = [1, 2, 5, 10].map((m) => m * 60_000);

/**
 * - SUCCEEDED: COMPLETED or PARTIAL — the markets that failed failed on their own.
 * - FAILED_TRANSIENT: every market failed, and at least one for a reason that can
 *   pass (network, timeout, rate limit, 5xx, an unreachable database).
 * - FAILED_PERMANENT: every market failed, none of them for such a reason.
 * - INTERRUPTED: stopped on purpose (Ctrl-C, SIGTERM, the engine going away).
 */
export type PassOutcome = "SUCCEEDED" | "FAILED_TRANSIENT" | "FAILED_PERMANENT" | "INTERRUPTED";

export function classifyPass(summary: {
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  interrupted: boolean;
  results: { ok: boolean; failure?: { retryable: boolean } | null }[];
}): PassOutcome {
  if (summary.interrupted) return "INTERRUPTED";
  if (summary.status !== "FAILED") return "SUCCEEDED";
  return summary.results.some((r) => !r.ok && r.failure?.retryable === true)
    ? "FAILED_TRANSIENT"
    : "FAILED_PERMANENT";
}

/** Prisma's "cannot reach / timed out / closed" connection codes. */
const UNREACHABLE_DATABASE = /^P10(01|02|08|17)$/;

/**
 * A pass that threw instead of returning — typically the database being
 * unreachable before the first market was read. Transient when it can pass:
 * what `classifyFailure` calls retryable, or a connection-level database error
 * (which it files under DATABASE_ERROR, not retryable, for a single market).
 */
export function classifyPassError(error: unknown, aborted: boolean): PassOutcome {
  if (aborted) return "INTERRUPTED";
  const code =
    typeof error === "object" && error !== null
      ? ((error as { errorCode?: unknown }).errorCode ?? (error as { code?: unknown }).code)
      : undefined;
  if (typeof code === "string" && UNREACHABLE_DATABASE.test(code)) return "FAILED_TRANSIENT";
  if (error instanceof Error && /can't reach database server/i.test(error.message)) {
    return "FAILED_TRANSIENT";
  }
  return classifyFailure(error).retryable ? "FAILED_TRANSIENT" : "FAILED_PERMANENT";
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
 * started — unless it failed transiently, in which case those windows stay
 * uncovered and its first retry is scheduled as for any other pass.
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
  if (catchUp.outcome !== "FAILED_TRANSIENT") {
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
    outcome: "FAILED_TRANSIENT",
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
 * Succeeded, or failed for good: covered, and the schedule moves on — a
 * permanent failure is not retried, exactly as before. Interrupted: unchanged;
 * the loop is ending. Failed transiently: not covered, and retried after the
 * next delay — unless the retries for this scheduled window are spent, or the
 * next would not come before the window; then nothing until that window, whose
 * pass rescans these timeframes too. The attempt count starts again at each
 * new window.
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

  if (input.outcome !== "FAILED_TRANSIENT") {
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
