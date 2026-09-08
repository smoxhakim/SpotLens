/**
 * Wilder's Relative Strength Index.
 *
 * Uses Wilder's smoothing (not a simple average of the last `period` changes)
 * after the initial seed, matching the standard RSI shown by charting tools.
 *
 * Returns an array aligned to the input, `null` where RSI is undefined.
 * RSI needs `period + 1` values, since it is computed from price *changes*.
 */
export function rsi(values: number[], period = 14): (number | null)[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`rsi: period must be a positive integer, received ${period}`);
  }

  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }

  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  // No losses over the window means no downside to divide by: RSI saturates.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function latestRsi(values: number[], period = 14): number | null {
  const series = rsi(values, period);
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i] !== null) return series[i];
  }
  return null;
}
