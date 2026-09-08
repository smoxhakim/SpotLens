import { describe, expect, it } from "vitest";

import { ANALYSIS_DISCLAIMER } from "@/lib/constants/disclaimers";
import { makeCandles } from "@/lib/test-utils/candles";

import { MIN_CANDLES_FOR_READ, runMarketRead } from "./market-read";

function trendingUp(count = 300): number[] {
  return Array.from({ length: count }, (_, i) => 100 + i * 0.5 + Math.sin(i / 4) * 3);
}

describe("runMarketRead", () => {
  it("assembles every section with a reason attached", () => {
    const read = runMarketRead(makeCandles(trendingUp()));

    expect(read.trend.reason).toBeTruthy();
    expect(read.zonesReason).toBeTruthy();
    expect(read.volume.reason).toBeTruthy();
    expect(read.rsi.reason).toBeTruthy();
    expect(read.zoneWidthNote).toBeTruthy();
  });

  it("carries the disclaimer and its version on every read", () => {
    const read = runMarketRead(makeCandles(trendingUp()));

    expect(read.disclaimer).toBe(ANALYSIS_DISCLAIMER);
    expect(read.disclaimerVersion).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("populates the indicator snapshot", () => {
    const read = runMarketRead(makeCandles(trendingUp()));

    expect(read.indicators.ema20).not.toBeNull();
    expect(read.indicators.ema50).not.toBeNull();
    expect(read.indicators.ema200).not.toBeNull();
    expect(read.indicators.rsi14).not.toBeNull();
    expect(read.indicators.atr14).not.toBeNull();
    expect(read.indicators.volumeTrend).not.toBeNull();
  });

  it("flags thin history instead of pretending to read it", () => {
    const thin = runMarketRead(makeCandles(trendingUp(20)));
    const full = runMarketRead(makeCandles(trendingUp(300)));

    expect(thin.insufficientData).toBe(true);
    expect(full.insufficientData).toBe(false);
    expect(MIN_CANDLES_FOR_READ).toBeGreaterThan(20);
  });

  it("never throws on an empty or tiny series", () => {
    expect(() => runMarketRead([])).not.toThrow();

    const read = runMarketRead([]);
    expect(read.price).toBe(0);
    expect(read.support).toEqual([]);
    expect(read.trend.trend).toBe("SIDEWAYS");
  });

  it("is deterministic — the same candles always give the same read", () => {
    const candles = makeCandles(trendingUp());
    const a = runMarketRead(candles);
    const b = runMarketRead(candles);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("only ever looks at the candles it is given", () => {
    // The read for a truncated series must not depend on later candles —
    // this is the property the Phase 7 backtester relies on.
    const full = makeCandles(trendingUp(300));
    const truncated = full.slice(0, 200);

    const a = runMarketRead(truncated);
    const b = runMarketRead(full.slice(0, 200));

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.lastCandleTime).toBe(truncated.at(-1)!.openTime);
  });

  it("ignores a half-built candle when judging volume", () => {
    // A forming candle holds only part of its period's trading. Comparing that
    // against candles that ran their full length made every fresh candle look
    // dead, which then held back valid setups for "thin volume".
    const closed = makeCandles(trendingUp(300).map((close) => ({ close, volume: 1000 })));
    const withForming = [
      ...closed,
      // A brand-new candle, 5% of the way through its period.
      ...makeCandles([{ close: closed.at(-1)!.close, volume: 50 }], {
        startTime: closed.at(-1)!.openTime + 60 * 60_000,
      }),
    ];

    const naive = runMarketRead(withForming);
    const corrected = runMarketRead(withForming, { lastCandleIsForming: true });

    // Naively, the partial candle reads as almost no volume at all.
    expect(naive.volume.read!.relative).toBeLessThan(0.2);
    // Corrected, volume is judged on the last completed candle.
    expect(corrected.volume.read!.relative).toBeCloseTo(1, 1);
  });

  it("stays deterministic — the flag is an input, never the clock", () => {
    const candles = makeCandles(trendingUp());

    // Same candles and same flag must always give the same read, which is what
    // lets the backtester replay history reproducibly.
    expect(JSON.stringify(runMarketRead(candles, { lastCandleIsForming: true }))).toBe(
      JSON.stringify(runMarketRead(candles, { lastCandleIsForming: true })),
    );
  });

  it("does not drop the only candle it has", () => {
    const single = makeCandles([{ close: 100, volume: 10 }]);
    expect(() => runMarketRead(single, { lastCandleIsForming: true })).not.toThrow();
  });

  it("reads a sustained climb as bullish", () => {
    const read = runMarketRead(makeCandles(trendingUp()));
    expect(read.trend.trend).toBe("BULLISH");
  });
});
