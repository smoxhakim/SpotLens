import { MarketDataError } from "./provider";

interface FetchJsonOptions {
  /** Total attempts including the first. */
  attempts?: number;
  /** Base delay for exponential backoff, in ms. */
  baseDelayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULTS = { attempts: 3, baseDelayMs: 300, timeoutMs: 10_000 };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter exponential backoff — avoids synchronised retry storms. */
function backoffDelay(base: number, attempt: number) {
  const ceiling = Math.min(base * 2 ** attempt, 8_000);
  return Math.random() * ceiling;
}

/**
 * JSON fetch with timeout, exponential backoff, and errors mapped to
 * MarketDataError so callers never have to interpret raw exchange responses.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { attempts, baseDelayMs, timeoutMs } = { ...DEFAULTS, ...options };
  let lastError: MarketDataError | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(backoffDelay(baseDelayMs, attempt - 1));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onOuterAbort);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        cache: "no-store",
      });

      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch (cause) {
          throw new MarketDataError("BAD_RESPONSE", "Provider returned malformed JSON.", {
            status: res.status,
            retryable: false,
            cause,
          });
        }
      }

      lastError = await mapErrorResponse(res);
      if (!lastError.retryable) throw lastError;
    } catch (err) {
      if (err instanceof MarketDataError) {
        if (!err.retryable) throw err;
        lastError = err;
      } else if (err instanceof Error && err.name === "AbortError") {
        // An abort from the caller is not our timeout — don't keep retrying it.
        if (options.signal?.aborted) {
          throw new MarketDataError("NETWORK_ERROR", "Request cancelled.", { retryable: false });
        }
        lastError = new MarketDataError(
          "TIMEOUT",
          `Provider request timed out after ${timeoutMs}ms.`,
        );
      } else {
        lastError = new MarketDataError(
          "NETWORK_ERROR",
          "Could not reach the market data provider.",
          {
            cause: err,
          },
        );
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  throw (
    lastError ??
    new MarketDataError("UPSTREAM_ERROR", "Market data request failed for an unknown reason.")
  );
}

async function mapErrorResponse(res: Response): Promise<MarketDataError> {
  const body = await res.text().catch(() => "");
  const snippet = body.slice(0, 300);

  // Binance: -1121 invalid symbol, -1100/-1102 bad parameter.
  if (res.status === 400 && /-1121|Invalid symbol/i.test(body)) {
    return new MarketDataError("UNKNOWN_SYMBOL", "The exchange does not list this symbol.", {
      status: res.status,
      retryable: false,
    });
  }
  // 418 = IP auto-banned after repeated 429s.
  if (res.status === 429 || res.status === 418) {
    return new MarketDataError("RATE_LIMITED", "Rate limited by the market data provider.", {
      status: res.status,
      retryable: true,
    });
  }
  if (res.status >= 500) {
    return new MarketDataError("UPSTREAM_ERROR", `Provider error ${res.status}: ${snippet}`, {
      status: res.status,
      retryable: true,
    });
  }
  return new MarketDataError("UPSTREAM_ERROR", `Provider error ${res.status}: ${snippet}`, {
    status: res.status,
    retryable: false,
  });
}
