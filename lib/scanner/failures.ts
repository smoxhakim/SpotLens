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
