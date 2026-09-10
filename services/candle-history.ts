import { warnOnce } from "@/lib/log";
import { getMarketDataProvider } from "@/lib/market-data";
import { MAX_CANDLES_PER_REQUEST } from "@/lib/market-data/binance";
import { TIMEFRAME_MS, type Candle, type Timeframe } from "@/lib/market-data/provider";
import { withRetries } from "@/lib/scanner";

/**
 * Paginated historical candle loading.
 *
 * The exchange serves at most 1000 candles per request, which used to be the
 * hard ceiling on how much history a backtest could cover: the warmup came out
 * of the same page, leaving 740 bars of actual evaluation. That is about a
 * month of hourly data — enough to produce a number, nowhere near enough for
 * the number to mean anything.
 *
 * This walks the range forward one page at a time. Each page starts after the
 * last candle already collected, so pages cannot overlap, and the result is
 * chronological by construction rather than by a sort that would hide a
 * provider returning something unexpected.
 */

/**
 * Ceiling on candles per backtest.
 *
 * Not a provider limit — a memory and patience limit. Fifty thousand hourly
 * candles is about five and a half years, past which a local machine is doing
 * a lot of work to refine a number that deeper history is unlikely to change.
 */
export const MAX_HISTORY_CANDLES = 50_000;

/** Requests per load, so a bad range cannot spin forever. */
export const MAX_PAGES = Math.ceil(MAX_HISTORY_CANDLES / MAX_CANDLES_PER_REQUEST) + 2;

export interface CandleHistory {
  candles: Candle[];
  /** Provider requests made, so the cost of a run is visible on the report. */
  requests: number;
  /** True when the range could not be filled completely. */
  incomplete: boolean;
  notes: string[];
}

export interface HistoryQuery {
  exchangeSymbol: string;
  timeframe: Timeframe;
  /** Inclusive, epoch ms. */
  from: number;
  /** Inclusive, epoch ms. */
  to: number;
  /** Hard ceiling for this load. Defaults to `MAX_HISTORY_CANDLES`. */
  maxCandles?: number;
}

/**
 * Loads every candle in `[from, to]`, paging as needed.
 *
 * Deterministic: the same range always issues the same requests in the same
 * order and returns the same series. Transient provider failures are retried
 * through the scanner's existing policy rather than a second one written here.
 *
 * Stops early and says so rather than looping when the provider stops making
 * progress — a page that returns nothing new means the range is exhausted or
 * the provider is misbehaving, and both are worth reporting instead of
 * silently returning a short series that looks complete.
 */
export async function loadCandleHistory(query: HistoryQuery): Promise<CandleHistory> {
  const step = TIMEFRAME_MS[query.timeframe];
  const maxCandles = Math.min(query.maxCandles ?? MAX_HISTORY_CANDLES, MAX_HISTORY_CANDLES);
  const provider = getMarketDataProvider();

  const candles: Candle[] = [];
  const notes: string[] = [];
  let requests = 0;
  let cursor = query.from;
  let incomplete = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (cursor > query.to || candles.length >= maxCandles) break;

    const remaining = maxCandles - candles.length;
    const limit = Math.min(MAX_CANDLES_PER_REQUEST, remaining);

    const attempt = await withRetries(() =>
      provider.getCandles(query.exchangeSymbol, query.timeframe, limit, {
        from: cursor,
        to: query.to,
      }),
    );

    requests += 1;

    if (!attempt.value) {
      incomplete = true;
      notes.push(
        `The provider failed after ${attempt.attempts} ${
          attempt.attempts === 1 ? "attempt" : "attempts"
        } while loading from ${new Date(cursor).toISOString()}: ${
          attempt.failure?.message ?? "unknown error"
        }`,
      );
      break;
    }

    // Only candles strictly after the last one kept. The exchange treats
    // `from` as inclusive, so without this every page would repeat its first
    // candle and the series would be full of duplicates.
    const last = candles.at(-1);
    const fresh = last ? attempt.value.filter((c) => c.openTime > last.openTime) : attempt.value;

    if (fresh.length === 0) {
      // No progress. Either the range is genuinely exhausted, or the provider
      // is returning the same page — and looping on the second would be an
      // unbounded request loop against a public endpoint.
      if (cursor <= query.to && candles.length > 0 && (last?.openTime ?? 0) + step <= query.to) {
        incomplete = true;
        notes.push(
          `The provider stopped returning data after ${new Date(
            last!.openTime,
          ).toISOString()}, before the requested end.`,
        );
      }
      break;
    }

    candles.push(...fresh);
    cursor = fresh[fresh.length - 1].openTime + step;
  }

  if (candles.length >= maxCandles) {
    incomplete = true;
    notes.push(
      `Stopped at the ${maxCandles}-candle ceiling for one backtest; the requested range is longer than that.`,
    );
  }

  if (candles.length === 0) {
    incomplete = true;
    notes.push("The provider returned no candles for this range.");
  } else {
    // The exchange simply has no data before a pair was listed. Worth saying
    // plainly rather than letting a short series look like a complete one.
    const firstOpen = candles[0].openTime;
    if (firstOpen > query.from + step) {
      notes.push(
        `Data begins at ${new Date(firstOpen).toISOString()}, later than the requested start — the pair was probably not listed yet.`,
      );
    }
  }

  if (requests > 1) {
    warnOnce(
      "candle-history:paged",
      `[candle-history] paged loads are in use (${requests} requests for one range).`,
    );
  }

  return { candles, requests, incomplete, notes };
}
