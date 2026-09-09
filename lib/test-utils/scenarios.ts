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

/**
 * Sideways market whose risk/reward comes out below 1:1.
 *
 * Two resistance shelves sit close overhead while a late flush leaves the most
 * recent swing low far below, so the stop is wide and both structural targets
 * land inside 1R. Risk/reward is measured to TP2, and the fallback R-multiples
 * can never produce a ratio under 1 — it takes two real resistance zones, both
 * within 1R and far enough apart to survive de-duplication.
 */
export function poorRiskReward(): Candle[] {
  const specs: CandleSpec[] = [];
  const shelf = (top: number, mid: number) => {
    specs.push(
      { close: 100 },
      { close: mid },
      { close: top, high: top + 0.5 },
      { close: mid },
      { close: 100.5 },
    );
  };

  for (let i = 0; i < 8; i += 1) shelf(106, 103);
  for (let i = 0; i < 6; i += 1) shelf(122, 110);
  for (let i = 0; i < 6; i += 1) shelf(106, 103);

  // A closing flush — swing points are read from closes, not wicks, so only a
  // close this low pushes the invalidation level away from the entry zone.
  specs.push({ close: 75, low: 74 });
  for (let i = 1; i <= 6; i += 1) specs.push({ close: 75 + 27 * (i / 6) });

  return makeCandles(specs);
}

/**
 * A setup that scores below the AVOID grade while risk/reward still clears 1:1.
 *
 * Nothing here is individually disqualifying: the market is ranging, the entry
 * zone has been tested only twice, the moving averages are stacked bearishly,
 * volume is thin and the payoff is barely above break-even. Together they leave
 * too little evidence to act on. Keeping the ratio above 1 matters — otherwise
 * the risk/reward rule would return AVOID first and this path would never run.
 */
export function weakEvidence(): Candle[] {
  const specs: CandleSpec[] = [];
  const shelf = (base: number, top: number) => {
    specs.push(
      { close: base },
      { close: (base + top) / 2 },
      { close: top, high: top + 0.5 },
      { close: (base + top) / 2 },
      { close: base + 0.5 },
    );
  };

  for (let i = 0; i < 10; i += 1) shelf(108, 136);
  for (let i = 0; i < 10; i += 1) shelf(106, 118);

  // Only two visits to the level that becomes the entry zone, so it stays
  // lightly tested, and on thin volume throughout.
  for (let i = 0; i < 2; i += 1) {
    specs.push(
      { close: 100, volume: 25 },
      { close: 104, volume: 25 },
      { close: 100.5, volume: 25 },
      { close: 105, volume: 25 },
    );
  }

  specs.push({ close: 74, volume: 25 });
  for (let i = 1; i <= 6; i += 1) specs.push({ close: 74 + 28 * (i / 6), volume: 25 });

  return makeCandles(specs);
}
