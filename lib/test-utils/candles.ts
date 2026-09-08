import { TIMEFRAME_MS, type Candle, type Timeframe } from "@/lib/market-data/provider";

export interface CandleSpec {
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
}

/**
 * Builds a candle series with correctly spaced timestamps for tests.
 *
 * Accepts either bare closing prices (open/high/low are derived) or full
 * specs when a test needs to control wicks or volume.
 */
export function makeCandles(
  input: (number | CandleSpec)[],
  options: { timeframe?: Timeframe; startTime?: number } = {},
): Candle[] {
  const timeframe = options.timeframe ?? "H1";
  const step = TIMEFRAME_MS[timeframe];
  const start = options.startTime ?? Date.UTC(2024, 0, 1);

  return input.map((entry, i) => {
    const spec: CandleSpec = typeof entry === "number" ? { close: entry } : entry;
    const prevClose =
      i === 0
        ? spec.close
        : typeof input[i - 1] === "number"
          ? (input[i - 1] as number)
          : (input[i - 1] as CandleSpec).close;

    const open = spec.open ?? prevClose;
    const close = spec.close;
    const openTime = start + i * step;

    return {
      openTime,
      open,
      high: spec.high ?? Math.max(open, close),
      low: spec.low ?? Math.min(open, close),
      close,
      volume: spec.volume ?? 100,
      closeTime: openTime + step - 1,
    };
  });
}
