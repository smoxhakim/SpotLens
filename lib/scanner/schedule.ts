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
 * How late a wake can be and still count as on time. Timers fire a few
 * milliseconds late routinely; a wake later than this means the process could
 * not run — in practice, a laptop asleep with its lid shut.
 */
export const LATE_WAKE_TOLERANCE_MS = 60_000;

/** The most recent scan window (a close plus the settle delay) at or before `now`. */
export function latestScanWindow(
  timeframe: Timeframe,
  now: number,
  delayMs: number = DEFAULT_CLOSE_DELAY_MS,
): number {
  const lastClose = currentCandleOpen(timeframe, now);
  return lastClose + delayMs <= now
    ? lastClose + delayMs
    : lastClose - TIMEFRAME_MS[timeframe] + delayMs;
}

/**
 * The scheduled scanner's memory: for each timeframe, the latest scan window a
 * pass has covered.
 *
 * The loop used to plan from the clock alone — "the next close after now" — and
 * scan whatever that plan named when the wait ended. Two windows fell through
 * it. A plan made inside the settle period after a close skipped that close
 * (it is not "after now", and its window had not arrived), so a scanner started
 * at 10:00:30 waited for 11:01:30. And a plan made before the machine slept was
 * stale when it woke: shut at 17:10 with "H1 at 18:01:30" planned, woken at
 * 22:10, it scanned H1 only, though H4 closed at 20:00 — and H4 then waited for
 * the 00:00 close, its setups unverified and their entry-zone alerts withheld
 * for four hours. Remembering what was scanned closes both: the next plan is
 * the first window after it, whenever that is, and a wake scans every timeframe
 * with a newer window than it.
 */
export type ScannedThrough = Partial<Record<Timeframe, number>>;

/**
 * Where a scheduled scanner starts: every window up to `now` counts as covered —
 * by the startup catch-up when it ran, or deliberately skipped when it did not,
 * exactly as before. A close still inside its settle period is not covered, so
 * the first plan takes it.
 */
export function scannedThroughAt(
  timeframes: Timeframe[],
  now: number,
  delayMs: number = DEFAULT_CLOSE_DELAY_MS,
): ScannedThrough {
  return Object.fromEntries(timeframes.map((tf) => [tf, latestScanWindow(tf, now, delayMs)]));
}

/**
 * The next window worth waking for: the earliest first-window-after-covered
 * among the timeframes, and every timeframe sharing it. `at` may already be in
 * the past — then the wait is zero and the scan is due now.
 */
export function planScan(input: {
  timeframes: Timeframe[];
  scannedThrough: ScannedThrough;
  delayMs?: number;
}): ScanWindow {
  const delayMs = input.delayMs ?? DEFAULT_CLOSE_DELAY_MS;
  const next = input.timeframes.map((timeframe) => {
    const covered = input.scannedThrough[timeframe] ?? -Infinity;
    return {
      timeframe,
      at: Number.isFinite(covered)
        ? nextCandleClose(timeframe, covered - delayMs) + delayMs
        : -Infinity,
    };
  });
  const at = Math.min(...next.map((n) => n.at));
  return {
    at,
    timeframes: next
      .filter((n) => n.at === at)
      .map((n) => n.timeframe)
      .sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]),
  };
}

export interface WakeScan {
  /** Every timeframe with a window newer than what was covered. Empty: nothing is due. */
  timeframes: Timeframe[];
  /** How long after the planned window the wake came, ms (never negative). */
  lateByMs: number;
  /** Later than `LATE_WAKE_TOLERANCE_MS`: worth saying so in the log. */
  late: boolean;
}

/**
 * What to scan when the wait ends — recalculated from the clock, not taken from
 * the plan. On time it is exactly the plan's timeframes; after a sleep it is
 * every timeframe that closed meanwhile. Empty only if the clock went
 * backwards; the loop then plans again rather than scanning.
 */
export function scanOnWake(input: {
  timeframes: Timeframe[];
  scannedThrough: ScannedThrough;
  plannedAt: number;
  now: number;
  delayMs?: number;
}): WakeScan {
  const delayMs = input.delayMs ?? DEFAULT_CLOSE_DELAY_MS;
  const lateByMs = Math.max(0, input.now - input.plannedAt);
  return {
    timeframes: input.timeframes
      .filter(
        (timeframe) =>
          latestScanWindow(timeframe, input.now, delayMs) >
          (input.scannedThrough[timeframe] ?? -Infinity),
      )
      .sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]),
    lateByMs,
    late: lateByMs > LATE_WAKE_TOLERANCE_MS,
  };
}

/** Records a pass over `timeframes` at `now`. Never moves a timeframe backwards. */
export function markScanned(
  scannedThrough: ScannedThrough,
  timeframes: Timeframe[],
  now: number,
  delayMs: number = DEFAULT_CLOSE_DELAY_MS,
): ScannedThrough {
  const next = { ...scannedThrough };
  for (const tf of timeframes) {
    next[tf] = Math.max(next[tf] ?? -Infinity, latestScanWindow(tf, now, delayMs));
  }
  return next;
}

/**
 * How long to wait before the most recently closed candle is safe to analyse.
 *
 * The same settlement policy the schedule uses, expressed for a scan that is
 * starting *now* rather than one being planned. `nextScanWindow` answers "when
 * is the next close, plus settle time"; this answers "is the last close settled
 * yet, and if not, how long until it is".
 *
 * Both derive from the same boundary arithmetic and the same delay, which is
 * the point: a manual pass and a scheduled pass should not disagree about when
 * a candle is ready. They did. `scanner:once` consulted neither, so a pass run
 * seconds after a boundary analysed whatever the exchange had settled so far —
 * measured once at two candles where a pass half a minute later saw
 * forty-three — and the difference churned setups and notifications for markets
 * that had not moved.
 *
 * Returns 0 in the ordinary case, which is most of the time: a candle closes
 * once an hour and the window is ninety seconds, so a pass started at random
 * waits for nothing. It is only the minutes just after a close that are unsafe,
 * and only those that wait.
 *
 * `currentCandleOpen` is the moment the previous candle closed, so it is the
 * close being waited on. The maximum is taken across timeframes because one
 * pass covers all of them and the answer has to be safe for every one — an H1
 * that closed ten seconds ago governs even when the H4 alongside it closed an
 * hour back.
 *
 * A `delayMs` of 0 disables this entirely, which is the documented opt-out for
 * anyone who would rather have the old behaviour.
 */
export function settlementDelayMs(
  timeframes: Timeframe[],
  now: number,
  delayMs: number = DEFAULT_CLOSE_DELAY_MS,
): number {
  if (delayMs <= 0 || timeframes.length === 0) return 0;

  const waits = timeframes.map((timeframe) => {
    const lastClose = currentCandleOpen(timeframe, now);
    return Math.max(0, lastClose + delayMs - now);
  });

  return Math.max(...waits);
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
