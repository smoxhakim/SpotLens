/**
 * Exponential moving average.
 *
 * Seeded with a simple moving average of the first `period` values, which is
 * the convention TradingView and most exchanges use — a raw first-value seed
 * makes early output drift noticeably from other charting tools.
 *
 * Returns an array aligned to the input: indices before the series can be
 * computed are `null`, so callers never silently read a misaligned value.
 */
export function ema(values: number[], period: number): (number | null)[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`ema: period must be a positive integer, received ${period}`);
  }

  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const multiplier = 2 / (period + 1);

  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] - prev) * multiplier + prev;
    out[i] = prev;
  }

  return out;
}

/** The most recent defined EMA value, or null if the series is too short. */
export function latestEma(values: number[], period: number): number | null {
  const series = ema(values, period);
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i] !== null) return series[i];
  }
  return null;
}
