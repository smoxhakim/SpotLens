import { describe, expect, it } from "vitest";

import { makeCandles } from "@/lib/test-utils/candles";

import { explainEmaAlignment, explainTrend } from "./explain/trend";
import { detectTrend, readEmas } from "./trend";

/** Staircase up: each leg makes a higher high and a higher low. */
function uptrend(legs = 12, base = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < legs; i += 1) {
    const low = base + i * 10;
    const high = low + 15;
    out.push(low, low + 5, high, high - 4, low + 3);
  }
  return out;
}

function downtrend(legs = 12, base = 300): number[] {
  return uptrend(legs, 0)
    .map((v) => base - v)
    .filter((v) => v > 0);
}

/**
 * A long decline, then a small staircase of higher highs and higher lows that
 * never reaches the moving averages — the classic bounce inside a downtrend.
 * Swing structure reads bullish while every EMA condition is still bearish.
 */
function bounceInDowntrend(): number[] {
  const slope = 4;
  const length = 400;
  const start = 200 + length * slope;
  const decline = Array.from({ length }, (_, i) => start - i * slope);
  const base = decline[decline.length - 1];

  const bounce: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    const low = base + i;
    bounce.push(low, low + 0.8, low + 2, low + 1.2, low + 0.3);
  }

  return [...decline, ...bounce];
}

describe("readEmas", () => {
  it("reports bullish alignment when every condition holds", () => {
    const read = readEmas(makeCandles(Array.from({ length: 400 }, (_, i) => 100 + i)));

    expect(read.alignment).toBe("BULLISH");
    expect(read.checks).toEqual({
      priceVsEma50: "ABOVE",
      ema20VsEma50: "ABOVE",
      ema50VsEma200: "ABOVE",
    });
  });

  it("reports bearish alignment when every condition fails", () => {
    const read = readEmas(makeCandles(Array.from({ length: 400 }, (_, i) => 500 - i)));

    expect(read.alignment).toBe("BEARISH");
    expect(Object.values(read.checks).every((c) => c === "BELOW")).toBe(true);
  });

  it("is UNAVAILABLE rather than guessing when history is too short", () => {
    const read = readEmas(makeCandles([1, 2, 3]));

    expect(read.alignment).toBe("UNAVAILABLE");
    expect(read.ema20).toBeNull();
  });

  it("reads a flat market as level, not bearish", () => {
    // Every "is X above Y" is false when the averages are equal. Treating that
    // as bearish would call a dead-flat market a downtrend.
    const read = readEmas(makeCandles(new Array(300).fill(100)));

    expect(read.alignment).toBe("MIXED");
    expect(Object.values(read.checks).every((c) => c === "LEVEL")).toBe(true);
  });

  it("reports MIXED when the conditions genuinely disagree", () => {
    // Long decline then a rally strong enough to lift price and the EMA 20
    // over the EMA 50, while the EMA 50 is still under the EMA 200.
    const series = [
      ...Array.from({ length: 300 }, (_, i) => 500 - i),
      ...Array.from({ length: 30 }, (_, i) => 200 + i * 4),
    ];
    const read = readEmas(makeCandles(series));

    expect(read.alignment).toBe("MIXED");
    expect(read.checks.ema50VsEma200).toBe("BELOW");
    expect(read.checks.priceVsEma50).toBe("ABOVE");
  });
});

describe("detectTrend", () => {
  it("calls a staircase of higher highs and higher lows bullish", () => {
    const read = detectTrend(makeCandles(uptrend()), 2);

    expect(read.trend).toBe("BULLISH");
    expect(read.structure.structure).toBe("UPTREND");
    expect(read.conflict).toBe(false);
  });

  it("calls a staircase of lower highs and lower lows bearish", () => {
    const read = detectTrend(makeCandles(downtrend()), 2);

    expect(read.trend).toBe("BEARISH");
    expect(read.structure.structure).toBe("DOWNTREND");
  });

  it("reports HIGH confidence only when structure and EMAs agree", () => {
    // 400 candles of steady climb: both signals point the same way.
    const read = detectTrend(makeCandles(uptrend(80)), 2);

    expect(read.trend).toBe("BULLISH");
    expect(read.ema.alignment).toBe("BULLISH");
    expect(read.confidence).toBe("HIGH");
  });

  it("refuses to pick a side when structure and EMAs conflict", () => {
    const read = detectTrend(makeCandles(bounceInDowntrend()), 2);

    expect(read.structure.structure).toBe("UPTREND");
    expect(read.ema.alignment).toBe("BEARISH");
    expect(read.conflict).toBe(true);
    expect(read.trend).toBe("SIDEWAYS");
    expect(read.confidence).toBe("LOW");
  });

  it("stays sideways in a flat market", () => {
    const read = detectTrend(makeCandles(new Array(300).fill(100)), 2);

    expect(read.trend).toBe("SIDEWAYS");
  });

  it("does not claim a trend it cannot evidence", () => {
    const read = detectTrend(makeCandles([10, 11, 12]), 2);

    expect(read.trend).toBe("SIDEWAYS");
    expect(read.confidence).toBe("LOW");
    expect(read.structure.structure).toBe("UNDETERMINED");
  });
});

describe("explainTrend", () => {
  it("names the actual swing prices behind an uptrend call", () => {
    const read = detectTrend(makeCandles(uptrend()), 2);
    const text = explainTrend(read);

    expect(text).toMatch(/higher high/i);
    expect(text).toMatch(/higher low/i);
    expect(text).toMatch(/uptrend structure/i);
  });

  it("says plainly why a conflict produced no direction", () => {
    const text = explainTrend(detectTrend(makeCandles(bounceInDowntrend()), 2));

    expect(text).toMatch(/disagree/i);
    expect(text).toMatch(/unclear/i);
  });

  it("explains missing data instead of asserting a trend", () => {
    const text = explainTrend(detectTrend(makeCandles([10, 11, 12]), 2));
    expect(text).toMatch(/not enough/i);
  });

  it("lists which moving-average conditions held", () => {
    const read = readEmas(makeCandles(Array.from({ length: 400 }, (_, i) => 100 + i)));
    const text = explainEmaAlignment(read);

    expect(text).toMatch(/price is above the EMA 50/);
    expect(text).toMatch(/EMA 50 is above the EMA 200/);
  });
});
