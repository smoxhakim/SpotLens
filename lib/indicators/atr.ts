import type { Candle } from "@/lib/market-data/provider";

/**
 * True Range: the largest of the current bar's range, and its extension above
 * or below the previous close. Counting the gap is the point — a bar that opens
 * far from the last close was volatile even if its own high-to-low span is
 * small.
 */
export function trueRange(candles: Candle[]): number[] {
  return candles.map((candle, i) => {
    const range = candle.high - candle.low;
    if (i === 0) return range;

    const prevClose = candles[i - 1].close;
    return Math.max(range, Math.abs(candle.high - prevClose), Math.abs(candle.low - prevClose));
  });
}

/**
 * Average True Range, Wilder-smoothed.
 *
 * Used as the unit of "how far is far" throughout the analysis: zone widths and
 * stop distances expressed in ATR adapt to each asset and timeframe on their
 * own, where a fixed percentage would be far too wide for BTC on a 1D chart and
 * far too tight for a small cap on 15m.
 *
 * Returns an array aligned to the input, `null` where undefined.
 */
export function atr(candles: Candle[], period = 14): (number | null)[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`atr: period must be a positive integer, received ${period}`);
  }

  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period) return out;

  const tr = trueRange(candles);

  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += tr[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < candles.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }

  return out;
}

export function latestAtr(candles: Candle[], period = 14): number | null {
  const series = atr(candles, period);
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i] !== null) return series[i];
  }
  return null;
}
