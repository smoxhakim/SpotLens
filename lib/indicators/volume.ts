import type { Candle } from "@/lib/market-data/provider";

export type VolumeTrend = "INCREASING" | "DECREASING" | "STABLE";

export interface VolumeRead {
  /** Volume of the most recent candle. */
  latest: number;
  /** Mean volume over the lookback window, excluding the latest candle. */
  average: number;
  /** latest / average. 1.0 means exactly average. */
  relative: number;
  trend: VolumeTrend;
  /** True when the latest candle traded meaningfully above its recent average. */
  isAboveAverage: boolean;
}

/** Simple mean of the last `period` values, or null if there are too few. */
export function averageVolume(candles: Candle[], period = 20): number | null {
  if (candles.length < period || period < 1) return null;
  const window = candles.slice(-period);
  return window.reduce((sum, c) => sum + c.volume, 0) / period;
}

/**
 * Volume context for the latest candle.
 *
 * The average deliberately excludes the latest candle: comparing a value
 * against an average that already contains it flattens exactly the spike we
 * are trying to detect.
 *
 * Trend compares the recent half of the window against the older half, which
 * is less jumpy than comparing single candles.
 */
export function analyzeVolume(candles: Candle[], period = 20): VolumeRead | null {
  if (candles.length < period + 1) return null;

  const latest = candles[candles.length - 1].volume;
  const priorWindow = candles.slice(-(period + 1), -1);
  const average = priorWindow.reduce((sum, c) => sum + c.volume, 0) / period;

  const half = Math.floor(period / 2);
  const older = priorWindow.slice(0, half);
  const recent = priorWindow.slice(-half);
  const olderAvg = older.reduce((s, c) => s + c.volume, 0) / (older.length || 1);
  const recentAvg = recent.reduce((s, c) => s + c.volume, 0) / (recent.length || 1);

  let trend: VolumeTrend = "STABLE";
  if (olderAvg > 0) {
    const ratio = recentAvg / olderAvg;
    // A 15% band keeps normal noise from reading as a trend.
    if (ratio >= 1.15) trend = "INCREASING";
    else if (ratio <= 0.85) trend = "DECREASING";
  }

  const relative = average > 0 ? latest / average : 0;

  return {
    latest,
    average,
    relative,
    trend,
    isAboveAverage: relative >= 1.2,
  };
}
