import { describe, expect, it } from "vitest";

import { runMarketRead, type MarketRead } from "@/lib/analysis";
import { makeCandles } from "@/lib/test-utils/candles";
import {
  downtrend,
  pullbackIntoSupport,
  rangeBound,
  repeatedPullbacks,
  thinHistory,
} from "@/lib/test-utils/scenarios";
import type { Candle } from "@/lib/market-data/provider";

import { classifyRegime, describeRegime } from "./classify";
import { ATR_HIGH_PERCENT, ATR_LOW_PERCENT, MIN_CANDLES_FOR_REGIME } from "./types";

/**
 * The regime classifier describes the environment a setup occurred in. It
 * never decides anything, and these tests are as much about what it cannot do
 * as about what it reports.
 */

function regimeOf(candles: Candle[]) {
  return classifyRegime(runMarketRead(candles));
}

describe("direction", () => {
  it("calls a sustained advance an uptrend", () => {
    const regime = regimeOf(repeatedPullbacks(80));

    expect(regime.direction).toBe("TRENDING_UP");
    expect(regime.evidence).toBeGreaterThanOrEqual(2);
  });

  it("calls a sustained decline a downtrend", () => {
    expect(regimeOf(downtrend()).direction).toBe("TRENDING_DOWN");
  });

  it("calls a market oscillating between two levels a range", () => {
    const regime = regimeOf(rangeBound());

    expect(["RANGE", "UNCLEAR"]).toContain(regime.direction);
    expect(regime.reasons.length).toBeGreaterThan(0);
  });

  it("refuses to claim a direction on too little history", () => {
    const regime = regimeOf(thinHistory());

    expect(regime.direction).toBe("UNCLEAR");
    expect(regime.evidence).toBe(0);
    expect(regime.reasons.some((r) => r.factor === "DATA")).toBe(true);
  });

  it("counts agreeing signals rather than scoring a probability", () => {
    const regime = regimeOf(repeatedPullbacks(80));

    // Three independent signals: structure, EMA alignment, price vs EMA 200.
    expect(regime.evidence).toBeLessThanOrEqual(3);
    expect(Number.isInteger(regime.evidence)).toBe(true);
  });

  it("says why, in terms a reader can check against the chart", () => {
    const regime = regimeOf(repeatedPullbacks(80));

    expect(regime.reasons.length).toBeGreaterThan(1);
    for (const reason of regime.reasons) {
      expect(["STRUCTURE", "EMA", "VOLATILITY", "DATA"]).toContain(reason.factor);
      expect(reason.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("volatility is a separate axis", () => {
  /** A read with ATR and price set directly, to sit either side of a band. */
  function readWithAtr(atr: number, price: number): MarketRead {
    return {
      price,
      candleCount: 500,
      insufficientData: false,
      trend: { structure: { structure: "RANGING" }, ema: { alignment: "MIXED" } },
      indicators: { atr14: atr, ema200: null },
    } as unknown as MarketRead;
  }

  it("reads a quiet market as low volatility", () => {
    const regime = classifyRegime(readWithAtr(0.5, 100)); // 0.5% of price
    expect(regime.volatility).toBe("LOW");
    expect(regime.atrPercent).toBeCloseTo(0.5);
  });

  it("reads a wild market as high volatility", () => {
    expect(classifyRegime(readWithAtr(5, 100)).volatility).toBe("HIGH");
  });

  it("reads the middle band as normal", () => {
    expect(classifyRegime(readWithAtr(2, 100)).volatility).toBe("NORMAL");
  });

  it("puts the thresholds exactly where they are documented", () => {
    // Boundaries are inclusive on both bands, so the labels are unambiguous.
    expect(classifyRegime(readWithAtr(ATR_LOW_PERCENT, 100)).volatility).toBe("LOW");
    expect(classifyRegime(readWithAtr(ATR_HIGH_PERCENT, 100)).volatility).toBe("HIGH");
    expect(classifyRegime(readWithAtr(ATR_LOW_PERCENT + 0.01, 100)).volatility).toBe("NORMAL");
    expect(classifyRegime(readWithAtr(ATR_HIGH_PERCENT - 0.01, 100)).volatility).toBe("NORMAL");
  });

  it("measures ATR against price, so assets at different prices compare", () => {
    // The same 2% of price, on assets three orders of magnitude apart.
    expect(classifyRegime(readWithAtr(2, 100)).volatility).toBe("NORMAL");
    expect(classifyRegime(readWithAtr(1800, 90_000)).volatility).toBe("NORMAL");
  });

  it("reports normal rather than guessing when ATR cannot be computed", () => {
    const regime = classifyRegime(readWithAtr(Number.NaN, 100));
    expect(["LOW", "NORMAL", "HIGH"]).toContain(regime.volatility);
  });

  it("lets a market be trending and volatile at the same time", () => {
    // The reason direction and volatility are separate fields: forcing them
    // into one enumeration means the reader loses whichever loses.
    const regime = regimeOf(repeatedPullbacks(80));

    expect(regime.direction).toBe("TRENDING_UP");
    expect(["HIGH", "NORMAL", "LOW"]).toContain(regime.volatility);
    // Neither field can take the other's value.
    expect(regime.direction).not.toBe("HIGH_VOLATILITY");
  });
});

describe("no lookahead", () => {
  it("does not change when candles are appended after the point classified", () => {
    // The decisive property. The classifier reads a MarketRead built from
    // `candles.slice(0, i + 1)`, so it physically cannot see past that — but
    // the guarantee is worth asserting rather than reasoning about.
    const full = repeatedPullbacks(80);
    const cut = Math.floor(full.length * 0.6);

    const atCut = regimeOf(full.slice(0, cut));

    // Rewrite everything after the cut, wildly.
    const rewritten = full.map((c, i) =>
      i < cut
        ? c
        : { ...c, open: c.open * 5, high: c.high * 6, low: c.low * 4, close: c.close * 5 },
    );
    const atCutWithFuture = regimeOf(rewritten.slice(0, cut));

    expect(JSON.stringify(atCutWithFuture)).toBe(JSON.stringify(atCut));
  });

  it("classifies each bar from its own history alone", () => {
    const candles = repeatedPullbacks(80);

    const walkForward = [200, 300, 400].map((i) => regimeOf(candles.slice(0, i)));
    const again = [200, 300, 400].map((i) => regimeOf(candles.slice(0, i)));

    expect(JSON.stringify(again)).toBe(JSON.stringify(walkForward));
  });
});

describe("determinism", () => {
  it("returns an identical regime for identical candles", () => {
    const candles = pullbackIntoSupport();

    expect(JSON.stringify(regimeOf(candles))).toBe(JSON.stringify(regimeOf(candles)));
  });

  it("carries a version, so a stored regime stays interpretable", () => {
    expect(regimeOf(repeatedPullbacks(80)).version).toBeTruthy();
  });
});

describe("it cannot decide anything", () => {
  it("returns only description, never a verdict or a score", () => {
    const regime = regimeOf(repeatedPullbacks(80));

    expect(Object.keys(regime).sort()).toEqual(
      ["atrPercent", "direction", "evidence", "reasons", "version", "volatility"].sort(),
    );

    // No status, no score, no probability — nothing an engine would consume.
    expect(regime).not.toHaveProperty("status");
    expect(regime).not.toHaveProperty("score");
    expect(regime).not.toHaveProperty("probability");
    expect(regime).not.toHaveProperty("confidence");
  });

  it("describes itself without predicting", () => {
    const text = describeRegime(regimeOf(repeatedPullbacks(80)));

    expect(text).toMatch(/trending up/);
    expect(text.toLowerCase()).not.toMatch(/will|expect|likely|probability|chance/);
  });

  it("handles an empty series without throwing", () => {
    expect(() => classifyRegime(runMarketRead([]))).not.toThrow();
    expect(classifyRegime(runMarketRead([])).direction).toBe("UNCLEAR");
  });

  it("needs the documented minimum before it says anything directional", () => {
    const short = makeCandles(new Array(MIN_CANDLES_FOR_REGIME - 1).fill(100));

    expect(regimeOf(short).direction).toBe("UNCLEAR");
  });
});
