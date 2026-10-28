import type { Candle } from "@/lib/market-data/provider";
import { makeCandles, type CandleSpec } from "@/lib/test-utils/candles";

/**
 * Candle fixtures for the golden-master baseline (Phase 5, commit 0).
 *
 * The existing scenarios in `lib/test-utils/scenarios.ts` already reach most of
 * the engine's exits. These add the ones the audits found uncovered: a support
 * zone retested from above with the close on either side of its midpoint (D1),
 * a rejection candle that wicks through the zone and closes above it (D2), a
 * market with no support at all, and one whose stop would land at or below zero.
 *
 * Test code only — nothing in the application imports this file.
 */

/** No movement at all: no swings, no zones, ATR zero. */
export function flatMarket(): Candle[] {
  return makeCandles(new Array(80).fill(100));
}

/**
 * Price swinging between 1 and 21, ending at 11.
 *
 * Every swing low is at 1 and every swing high at 21, so structure reads as a
 * range rather than a downtrend. ATR is about 10, so the support zone around 1
 * is widened to roughly −0.75 – 2.75, and a stop half an ATR below that lands
 * below zero — which is the one way `calculateStopLoss` returns nothing once an
 * entry zone exists.
 */
export function nearZeroRange(): Candle[] {
  const closes: number[] = [];
  for (let cycle = 0; cycle < 20; cycle += 1) closes.push(1, 11, 21, 11);
  closes.push(1, 11);
  return makeCandles(closes);
}

/** The zone `zoneRetest` is built to produce: two swing lows, at 100 and 105. */
export const RETEST_ZONE = { low: 100, high: 105, mid: 102.5 } as const;

/** The ATR range within which `RETEST_ZONE` comes out exactly as built. See below. */
export const RETEST_ATR_WINDOW = { min: 20 / 3, max: 100 / 7 } as const;

/**
 * Closes for the final candle of `zoneRetest`: the zone's floor, the lower
 * half, the exact midpoint, just above it, the upper half, the ceiling, and
 * just above the ceiling. The final candle's range is fixed at 100 – 108 for
 * every one of them, so ATR — and with it the zones — is identical across the
 * set and only the close moves.
 */
export const RETEST_CLOSES: number[] = [
  100, 101, 102, 102.5, 102.51, 103, 104.99, 105, 105.01, 106, 108,
];

/**
 * Everything before the final candle of `zoneRetest`.
 *
 * Built candle by candle, with explicit highs and lows, so the swing points are
 * known rather than incidental:
 *
 *   - 50-candle plateau between 88 and 96: equal highs and lows, so no swings
 *     and a steady ATR of 8
 *   - R1–R5: a rally to 124; R1 is a swing low at 88
 *   - B1 swing high 126, B2 swing low 100, B6 swing high 130, B8 swing low 105,
 *     B12 swing high 140, then a decline back towards the zone
 *
 * Worked out by hand from the source: swing lows 88, 100, 105 and highs 126,
 * 130, 140; structure higher highs and higher lows; ATR about 10.6 at the end,
 * so the clustering tolerance is about 8 and the minimum zone width about 3.7.
 * That puts 100 and 105 in one zone, 100 – 105, which is not widened and has
 * its midpoint at exactly 102.5.
 *
 * The zone holds for any ATR in `RETEST_ATR_WINDOW`: the clustering tolerance
 * (0.75 × ATR) must reach 5 to merge 100 and 105 but stay under 12 to keep 88
 * apart, and the minimum width (0.35 × ATR) must not exceed 5, or the zone is
 * widened around its midpoint. `zones.golden.test.ts` asserts all of this —
 * the swings, the structure, the ATR, the zone — before any expectation relies
 * on it, so a slip in the derivation fails as a fixture problem rather than
 * passing as a behaviour.
 */
function zoneRetestBase(): CandleSpec[] {
  const specs: CandleSpec[] = [];

  for (let i = 0; i < 50; i += 1) {
    specs.push(
      i % 2 === 0
        ? { open: 88, high: 96, low: 88, close: 96 }
        : { open: 96, high: 96, low: 88, close: 88 },
    );
  }

  specs.push(
    { open: 88, high: 96, low: 88, close: 96 }, // R1 — swing low 88
    { open: 96, high: 104, low: 96, close: 104 }, // R2
    { open: 104, high: 112, low: 104, close: 112 }, // R3
    { open: 112, high: 120, low: 112, close: 120 }, // R4
    { open: 120, high: 124, low: 120, close: 124 }, // R5
    { open: 124, high: 126, low: 112, close: 114 }, // B1 — swing high 126
    { open: 114, high: 116, low: 100, close: 106 }, // B2 — swing low 100
    { open: 106, high: 116, low: 106, close: 114 }, // B3
    { open: 114, high: 122, low: 112, close: 120 }, // B4
    { open: 120, high: 128, low: 118, close: 126 }, // B5
    { open: 126, high: 130, low: 122, close: 124 }, // B6 — swing high 130
    { open: 124, high: 126, low: 112, close: 114 }, // B7
    { open: 114, high: 116, low: 105, close: 108 }, // B8 — swing low 105
    { open: 108, high: 116, low: 106, close: 114 }, // B9
    { open: 114, high: 120, low: 110, close: 118 }, // B10
    { open: 118, high: 126, low: 116, close: 124 }, // B11
    { open: 124, high: 140, low: 122, close: 138 }, // B12 — swing high 140
    { open: 138, high: 139, low: 126, close: 128 }, // B13
    { open: 128, high: 130, low: 116, close: 118 }, // B14
    { open: 118, high: 120, low: 106, close: 106 }, // B15
  );

  return specs;
}

/**
 * A pullback from above into the 100 – 105 support zone, closing at `close`.
 *
 * The final candle opens at 106, trades down to 100 and up to 108, so it
 * touches the zone whatever the close is. Only `close` varies.
 */
export function zoneRetest(close: number): Candle[] {
  if (close < 100 || close > 108) {
    throw new Error(`zoneRetest: close must lie within the final candle's 100 – 108 range.`);
  }
  return makeCandles([...zoneRetestBase(), { open: 106, high: 108, low: 100, close }]);
}

/**
 * The same retest, ending on a bullish rejection candle: it wicks through the
 * whole zone to 100 and closes above it at 106.5, near its high, with a lower
 * wick 43% of its range. The geometry the confirmation tests treat as a
 * rejection — closing above the zone, not inside it (audit D2).
 */
export function zoneRetestRejection(): Candle[] {
  return makeCandles([...zoneRetestBase(), { open: 103, high: 107, low: 100, close: 106.5 }]);
}
