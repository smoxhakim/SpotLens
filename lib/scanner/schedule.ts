import { TIMEFRAME_MS, type Timeframe } from "@/lib/market-data/provider";

/**
 * Candle-close scheduling.
 *
 * The scanner exists to notice things at the moment they become true, and on a
 * candle-based strategy that moment is a candle closing. Polling on a fixed
 * interval instead would do the same work several times inside one candle,
 * reach the same answer every time, and still be late for the one evaluation
 * that mattered.
 *
 * Everything here is epoch milliseconds — UTC throughout. Exchange candles are
 * UTC-aligned and the machine's local zone never enters the calculation; the UI
 * is the only place a local time is rendered.
 */

/**
 * How long to wait after a candle closes before analysing it.
 *
 * The exchange needs a moment to settle the final candle, and asking for it at
 * the instant of close reliably returns a candle that is still being written.
 * Ninety seconds is comfortably past that without making the scan feel late.
 */
export const DEFAULT_CLOSE_DELAY_MS = 90_000;

/** Timeframes the scanner covers unless configured otherwise. */
export const DEFAULT_SCAN_TIMEFRAMES: Timeframe[] = ["H1", "H4"];

/** Open time of the candle currently forming on this timeframe. */
export function currentCandleOpen(timeframe: Timeframe, now: number): number {
  const size = TIMEFRAME_MS[timeframe];

  // Weekly candles open Monday 00:00 UTC; the epoch was a Thursday.
  if (timeframe === "W1") {
    const offset = 4 * 24 * 60 * 60_000 - 7 * 24 * 60 * 60_000;
    return Math.floor((now - offset) / size) * size + offset;
  }

  return Math.floor(now / size) * size;
}

/** When the candle currently forming on this timeframe will close. */
export function nextCandleClose(timeframe: Timeframe, now: number): number {
  return currentCandleOpen(timeframe, now) + TIMEFRAME_MS[timeframe];
}

export interface ScanWindow {
  /** When the scanner should next wake, epoch ms. */
  at: number;
  /** The timeframes whose candle will have closed by then. */
  timeframes: Timeframe[];
}

/**
 * The next moment worth waking up for, and what to scan when we get there.
 *
 * Timeframes are nested — an H4 candle closing means an H1 candle closed at the
 * same instant — so a single wake-up can cover several. Grouping them means one
 * scan and one set of requests rather than two that arrive a millisecond apart.
 */
export function nextScanWindow(
  timeframes: Timeframe[],
  now: number,
  delayMs: number = DEFAULT_CLOSE_DELAY_MS,
): ScanWindow {
  const due = timeframes.map((timeframe) => ({
    timeframe,
    at: nextCandleClose(timeframe, now) + delayMs,
  }));

  const at = Math.min(...due.map((d) => d.at));

  return {
    at,
    // Sorted by candle length so a grouped scan reports its timeframes in a
    // stable order, whatever order they were configured in.
    timeframes: due
      .filter((d) => d.at === at)
      .map((d) => d.timeframe)
      .sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]),
  };
}

/**
 * Drops a candle that is still being written.
 *
 * The scanner analyses only closed candles, and this is where that is enforced
 * — the engine itself is left exactly as the manual and backtest paths use it.
 *
 * Two things follow from it. Setup transitions can never come from a wick that
 * has not finished forming, which is the most convincing kind of wrong answer
 * this tool could give. And a scan repeated inside the same candle sees byte
 * identical input, so it reaches an identical verdict and writes nothing the
 * second time — which is what makes the scanner idempotent.
 */
export function closedCandlesOnly<T extends { closeTime: number }>(candles: T[], now: number): T[] {
  if (candles.length === 0) return candles;
  return candles.filter((candle) => candle.closeTime <= now);
}
