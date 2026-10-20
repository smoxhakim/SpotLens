import type { HigherTimeframeShortfall } from "@/lib/analysis/higher-timeframe";
import { MarketDataError } from "@/lib/market-data/provider";

import { sleep } from "./concurrency";

export type ScannerFailureCategory =
  "MARKET_DATA_ERROR" | "INVALID_DATA" | "ANALYSIS_ERROR" | "DATABASE_ERROR" | "UNKNOWN";

export interface ClassifiedFailure {
  category: ScannerFailureCategory;
  /** Short and sanitised — safe to store and to show. */
  message: string;
  /** Whether trying again could plausibly succeed. */
  retryable: boolean;
}

/**
 * Candles the cache served because the exchange could not be reached.
 *
 * `getCandles` falls back to cached rows when the provider fails, flagged
 * `stale: true` — useful to a chart, wrong for a scan. The cache's head is
 * older than the latest close, so analysing it re-judges a candle already
 * judged and calls that a fresh pass: the window counts as covered, the
 * failed-pass retry never runs, and every setup on it looks re-confirmed to the
 * entry-zone freshness rule. That is exactly what a laptop waking before its
 * network does on every market at once.
 *
 * So stale candles are a failure, typed: retryable, because the exchange may be
 * back on the next attempt, and through the same path as any provider fault —
 * `withRetries`, then `classifyPass`, which calls a pass where every market
 * failed this way FAILED_TRANSIENT and leaves its windows uncovered. A
 * MarketDataError so `classifyFailure` files it with the provider's own faults;
 * `UPSTREAM_ERROR` because the cause the cache swallowed is not known.
 */
export class StaleCandlesError extends MarketDataError {
  constructor(timeframe: string) {
    super(
      "UPSTREAM_ERROR",
      `Stale candles (${timeframe}): the exchange could not be reached and only cached candles from before the latest close are available, so this market was not analysed.`,
      { retryable: true },
    );
    this.name = "StaleCandlesError";
  }
}

/**
 * The higher timeframe a scanned market needs was missing, stale, short or
 * invalid, so the market was not analysed.
 *
 * Fail closed. The scanner used to analyse on one timeframe instead, which let
 * a counter-trend bounce reach POTENTIAL_SETUP — and be tracked, confirmed and
 * re-verified for entry-zone alerts — whenever the higher read failed. A stored
 * scanner row has nowhere to mark an analysis incomplete, so an incomplete one
 * is not stored as a result at all: the market fails, visibly, with the reason.
 *
 * Retryable when the data may simply arrive (UNAVAILABLE, STALE), so a pass
 * that fails this way everywhere is FAILED_TRANSIENT and retried; not when it
 * will answer the same way next minute (INSUFFICIENT, INVALID), which files
 * under INVALID_DATA like any malformed payload.
 */
export class HigherTimeframeUnavailableError extends MarketDataError {
  readonly shortfall: HigherTimeframeShortfall;

  constructor(shortfall: HigherTimeframeShortfall, options: { retryable?: boolean } = {}) {
    const transient = shortfall.gap === "UNAVAILABLE" || shortfall.gap === "STALE";
    super(
      transient ? "UPSTREAM_ERROR" : "BAD_RESPONSE",
      `Higher timeframe ${shortfall.timeframe} ${shortfall.gap.toLowerCase()}: ${shortfall.detail} Not analysed — a potential setup needs it.`,
      { retryable: options.retryable ?? transient },
    );
    this.name = "HigherTimeframeUnavailableError";
    this.shortfall = shortfall;
  }
}

/** Longest message kept. Enough to identify the fault, short enough to scan. */
const MAX_MESSAGE_LENGTH = 200;

/**
 * Turns an unknown thrown value into something safe to store.
 *
 * Deliberately lossy. A raw error can carry a request URL with query
 * parameters, a database connection string, or a stack trace naming the
 * machine's directory layout, and a table the UI renders is the wrong place for
 * any of that. What survives is a category and one sanitised line.
 */
export function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof MarketDataError) {
    // A malformed payload and a symbol the exchange does not list are both bad
    // input rather than bad luck — they will answer the same way every time.
    const invalid = error.code === "BAD_RESPONSE" || error.code === "UNKNOWN_SYMBOL";
    return {
      category: invalid ? "INVALID_DATA" : "MARKET_DATA_ERROR",
      message: sanitise(`${error.code}: ${error.message}`),
      // Taken from the provider rather than re-derived. It already decides
      // which of its own faults are transient, and a second rule here would be
      // one more place for the two to disagree.
      retryable: error.retryable,
    };
  }

  if (isPrismaError(error)) {
    return {
      category: "DATABASE_ERROR",
      message: sanitise(`Database error ${prismaCode(error)}`),
      retryable: false,
    };
  }

  if (error instanceof Error) {
    const transient = /fetch failed|network|timeout|ECONN|ETIMEDOUT|socket/i.test(error.message);
    return {
      category: transient ? "MARKET_DATA_ERROR" : "ANALYSIS_ERROR",
      message: sanitise(error.message),
      retryable: transient,
    };
  }

  return { category: "UNKNOWN", message: "An unknown error occurred.", retryable: false };
}

/**
 * Strips anything that looks like a location or a credential.
 *
 * Not a security boundary — it is defence in depth over the fact that error
 * text is written by libraries we do not control.
 */
function sanitise(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function isPrismaError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    /^P\d{4}$/.test((error as { code: string }).code)
  );
}

function prismaCode(error: unknown): string {
  return (error as { code: string }).code;
}

/** One attempt, then at most this many more. Three tries, then give up. */
export const MAX_ATTEMPTS = 3;

/** Base for exponential backoff between attempts. */
export const RETRY_BASE_DELAY_MS = 400;

export interface AttemptResult<T> {
  value: T | null;
  failure: ClassifiedFailure | null;
  attempts: number;
}

/**
 * Runs `task`, retrying only what is worth retrying.
 *
 * A malformed payload or a database constraint will fail identically however
 * many times it is asked, so retrying it costs time and adds load without ever
 * changing the answer. Only faults the provider itself calls transient are
 * tried again, and never more than `MAX_ATTEMPTS` times in total.
 */
export async function withRetries<T>(
  task: () => Promise<T>,
  options: { maxAttempts?: number; baseDelayMs?: number; signal?: AbortSignal } = {},
): Promise<AttemptResult<T>> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const baseDelay = options.baseDelayMs ?? RETRY_BASE_DELAY_MS;

  let failure: ClassifiedFailure | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { value: await task(), failure: null, attempts: attempt };
    } catch (error) {
      failure = classifyFailure(error);

      const lastAttempt = attempt === maxAttempts;
      if (!failure.retryable || lastAttempt || options.signal?.aborted) {
        return { value: null, failure, attempts: attempt };
      }

      await sleep(baseDelay * 2 ** (attempt - 1), options.signal);
    }
  }

  return { value: null, failure, attempts: maxAttempts };
}
