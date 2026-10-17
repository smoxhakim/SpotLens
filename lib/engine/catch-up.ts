import { TIMEFRAME_MS, type Timeframe } from "@/lib/market-data/provider";
import { DEFAULT_CLOSE_DELAY_MS, currentCandleOpen } from "@/lib/scanner/schedule";

/**
 * Whether the engine should scan once on startup before following the schedule.
 *
 * The scheduled scanner only ever wakes at the next candle close. Started after
 * a laptop has been closed overnight, it would leave Opportunities and the
 * watched setups as they were the night before for up to an hour — which is
 * exactly when someone opens the app to see what changed. So on startup the
 * engine asks one question: has a pass started since the most recent scan
 * window that should already have happened? If not, it scans now (still
 * through the scanner's own settle delay) and then follows the schedule as
 * before. Nothing about the schedule itself changes.
 *
 * A "scan window" is a candle close plus the settle delay, the same moment the
 * schedule wakes at. A window that has not arrived yet does not count: inside
 * the settle period after a close, the schedule is about to scan anyway.
 */
export function latestDueScanWindow(
  timeframes: Timeframe[],
  now: number,
  delayMs: number = DEFAULT_CLOSE_DELAY_MS,
): number | null {
  if (timeframes.length === 0) return null;

  const windows = timeframes.map((timeframe) => {
    const lastClose = currentCandleOpen(timeframe, now);
    const window = lastClose + delayMs;
    return window <= now ? window : lastClose - TIMEFRAME_MS[timeframe] + delayMs;
  });

  return Math.max(...windows);
}

export function isCatchUpDue(input: {
  /** When the most recent completed pass started, epoch ms. Null if none ever has. */
  lastCompletedRunStartedAt: number | null;
  timeframes: Timeframe[];
  now: number;
  delayMs?: number;
}): boolean {
  const due = latestDueScanWindow(input.timeframes, input.now, input.delayMs);
  if (due === null) return false;
  if (input.lastCompletedRunStartedAt === null) return true;
  return input.lastCompletedRunStartedAt < due;
}
