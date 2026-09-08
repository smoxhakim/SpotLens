import type { Candle } from "@/lib/market-data/provider";

import { makeCandles, type CandleSpec } from "./candles";

/**
 * Named market scenarios for the setup engine's tests.
 *
 * Each one is a shape a trader would recognise, so a failing test says
 * something about behaviour ("it offered a long in a downtrend") rather than
 * about an array of numbers.
 */

function legs(count: number, base: number, step: number, height: number): CandleSpec[] {
  const out: CandleSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const low = base + i * step;
    const high = low + height;
    out.push(
      { close: low },
      { close: low + height / 3 },
      { close: high },
      { close: high - height / 2.4 },
      { close: low + 1 },
    );
  }
  return out;
}

/** Uptrend that has pulled back into support on rising volume. */
export function pullbackIntoSupport(): Candle[] {
  const specs = legs(24, 100, 4, 12);
  const last = 100 + 23 * 4;
  specs.push(
    { close: last + 8 },
    { close: last + 4, volume: 140 },
    { close: last - 1, volume: 200 },
  );
  return makeCandles(specs);
}

/** Same setup, but the bounce is happening on unusually thin volume. */
export function pullbackOnThinVolume(): Candle[] {
  const specs = legs(24, 100, 4, 12);
  const last = 100 + 23 * 4;
  specs.push(
    { close: last + 8 },
    { close: last + 4, volume: 140 },
    { close: last - 1, volume: 60 },
  );
  return makeCandles(specs);
}

/** Sustained downtrend — a market with no long setup in it. */
export function downtrend(): Candle[] {
  const specs: CandleSpec[] = [];
  for (let i = 0; i < 24; i += 1) {
    const high = 400 - i * 4;
    const low = high - 12;
    specs.push(
      { close: high },
      { close: high - 4 },
      { close: low },
      { close: low + 5 },
      { close: high - 1 },
    );
  }
  return makeCandles(specs);
}

/** Bullish, but price has run far above the nearest support. */
export function extendedAboveSupport(): Candle[] {
  const specs = legs(24, 100, 4, 12);
  const last = 100 + 23 * 4;
  for (let i = 1; i <= 12; i += 1) specs.push({ close: last + i * 6 });
  return makeCandles(specs);
}

/** Range-bound market: repeated highs and lows at the same two levels. */
export function rangeBound(): Candle[] {
  const specs: CandleSpec[] = [];
  for (let i = 0; i < 26; i += 1) {
    specs.push({ close: 100 }, { close: 106 }, { close: 112 }, { close: 106 }, { close: 101 });
  }
  return makeCandles(specs);
}

/**
 * A long uptrend that repeatedly pulls back into its prior support — enough
 * history to warm up the EMA 200 and enough recurring opportunities for a
 * backtest to have something to replay.
 */
export function repeatedPullbacks(cycles = 90): Candle[] {
  const specs: CandleSpec[] = [];
  for (let c = 0; c < cycles; c += 1) {
    const low = 100 + c * 2;
    const high = low + 10;
    specs.push(
      { close: low, low: low - 1 },
      { close: low + 3 },
      { close: high, high: high + 1 },
      { close: high - 4 },
      // Dips back through the prior swing low, which is what puts price
      // inside the support zone rather than just near it.
      { close: low - 3, low: low - 4, volume: 150 },
    );
  }
  return makeCandles(specs);
}

/** Not enough candles for the engine to say anything responsible. */
export function thinHistory(): Candle[] {
  return makeCandles(legs(4, 100, 4, 12));
}
