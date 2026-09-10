import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/market-data/provider";
import { makeCandles } from "@/lib/test-utils/candles";

import type { MarketRead } from "../market-read";
import type { EntryZone } from "../setup/types";
import type { PriceZone } from "../zones";
import { evaluateConfirmation } from "./engine";
import { MIN_POSITIVE_SIGNALS, type ConfirmationSignalType } from "./types";

/**
 * Confirmation asks whether the market has done anything at the level yet.
 *
 * The rules are arithmetic on closed candles, so each one is tested against the
 * exact geometry it claims to detect, and against the near-miss that must not
 * trip it.
 */

const ZONE: PriceZone = {
  low: 100,
  high: 104,
  mid: 102,
  kind: "SUPPORT",
  touches: 3,
  strength: 80,
  flipped: false,
  lastTouchIndex: 0,
  lastTouchTime: 0,
};

const ENTRY = { low: 100, high: 104, mid: 102, sourceZone: ZONE } as EntryZone;

/** A read whose volume is whatever the test needs it to be. */
function readWith(
  volume: Partial<{ relative: number; trend: string; isAboveAverage: boolean }> | null,
): MarketRead {
  return {
    volume: {
      read: volume
        ? {
            latest: 100,
            average: 100,
            relative: volume.relative ?? 1,
            trend: (volume.trend ?? "STABLE") as "INCREASING" | "DECREASING" | "STABLE",
            isAboveAverage: volume.isAboveAverage ?? false,
          }
        : null,
      reason: "",
    },
  } as MarketRead;
}

/** Flat filler so swing detection has something to chew on without signalling. */
function filler(count: number, price = 110): Candle[] {
  return makeCandles(new Array(count).fill(price));
}

function evaluate(candles: Candle[], read: MarketRead = readWith(null)) {
  return evaluateConfirmation({ read, entry: ENTRY, candles });
}

function types(
  result: { signals: { type: ConfirmationSignalType; signal: string }[] },
  direction: string,
) {
  return result.signals.filter((s) => s.signal === direction).map((s) => s.type);
}

describe("bullish rejection", () => {
  // Range 100 → 112. Lower wick 100→108 is 8/12 = 67% of the range. Close 110
  // sits at (110-100)/12 = 83% of the range. Bullish body, closes above 100.
  const rejectionCandle = { open: 108, high: 112, low: 100, close: 110, volume: 100 };

  it("detects a wick into the zone that closed back near the high", () => {
    const result = evaluate([...filler(30), ...makeCandles([rejectionCandle])]);

    expect(types(result, "positive")).toContain("BULLISH_REJECTION");
  });

  it("ignores a candle that never reached the zone", () => {
    const aboveZone = { open: 130, high: 134, low: 122, close: 132, volume: 100 };
    const result = evaluate([...filler(30), ...makeCandles([aboveZone])]);

    expect(types(result, "positive")).not.toContain("BULLISH_REJECTION");
  });

  it("ignores a long lower wick that closed weakly", () => {
    // Same wick, but the close sits mid-range rather than in the top 40%.
    const weakClose = { open: 106, high: 112, low: 100, close: 105, volume: 100 };
    const result = evaluate([...filler(30), ...makeCandles([weakClose])]);

    expect(types(result, "positive")).not.toContain("BULLISH_REJECTION");
  });

  it("ignores a strong close with no rejection wick", () => {
    const noWick = { open: 101, high: 112, low: 100.5, close: 111, volume: 100 };
    const result = evaluate([...filler(30), ...makeCandles([noWick])]);

    expect(types(result, "positive")).not.toContain("BULLISH_REJECTION");
  });

  it("reads the mirror image as the zone rejecting price downward", () => {
    // Upper wick 9/12 = 75% of the range, close at 8% of it, bearish body.
    const bearish = { open: 103, high: 112, low: 100, close: 101, volume: 100 };
    const result = evaluate([...filler(30, 108), ...makeCandles([bearish])]);

    expect(types(result, "negative")).toContain("BULLISH_REJECTION");
    expect(result.status).toBe("CONTRADICTED");
  });
});

describe("higher low and structure break", () => {
  /** Two rising swing lows, then a close above the last confirmed swing high. */
  function risingLows(): Candle[] {
    return makeCandles([
      ...new Array(20).fill(120),
      118,
      112,
      118, // swing low at 112
      124, // swing high
      120,
      116,
      120, // higher swing low at 116
      126,
      128, // closes above the prior swing high
    ]);
  }

  it("detects a recent higher low", () => {
    const result = evaluate(risingLows());

    expect(types(result, "positive")).toContain("HIGHER_LOW");
  });

  it("detects a close above the most recent confirmed swing high", () => {
    const result = evaluate(risingLows());

    expect(types(result, "positive")).toContain("STRUCTURE_BREAK");
  });

  it("does not call an ordinary higher candle a structure break", () => {
    // Rising one tick at a time never closes above a confirmed swing high.
    const drift = makeCandles(Array.from({ length: 40 }, (_, i) => 110 + i * 0.1));
    const result = evaluate(drift);

    expect(types(result, "positive")).not.toContain("STRUCTURE_BREAK");
  });

  it("reads a lower low as contradicting", () => {
    // Explicit lows: `makeCandles` opens each candle at the previous close, so
    // without them the candle after a dip shares its low and the fractal rule
    // (which needs a strictly lower low) finds nothing.
    const fallingLows = makeCandles([
      ...new Array(20).fill(120),
      { close: 122 },
      { close: 116, low: 114 }, // swing low at 114
      { close: 122 },
      { close: 128, high: 130 }, // swing high between them
      { close: 122 },
      { close: 112, low: 110 }, // lower swing low at 110
      { close: 122 },
      { close: 118 },
    ]);
    const result = evaluate(fallingLows);

    expect(types(result, "negative")).toContain("HIGHER_LOW");
  });

  it("ignores a higher low that is no longer recent", () => {
    const stale = makeCandles([
      ...new Array(20).fill(120),
      118,
      112,
      118,
      124,
      120,
      116,
      120,
      // Twenty quiet candles push the swing outside the recency window.
      ...new Array(20).fill(121),
    ]);
    const result = evaluate(stale);

    expect(types(result, "positive")).not.toContain("HIGHER_LOW");
  });
});

describe("volume", () => {
  it("confirms on above-average volume that is not fading", () => {
    const result = evaluate(
      filler(30),
      readWith({ relative: 1.6, isAboveAverage: true, trend: "INCREASING" }),
    );

    expect(types(result, "positive")).toContain("VOLUME_CONFIRMATION");
  });

  it("does not confirm on above-average but fading volume", () => {
    const result = evaluate(
      filler(30),
      readWith({ relative: 1.6, isAboveAverage: true, trend: "DECREASING" }),
    );

    expect(types(result, "positive")).not.toContain("VOLUME_CONFIRMATION");
  });

  it("contradicts on thin volume", () => {
    const result = evaluate(filler(30), readWith({ relative: 0.4 }));

    expect(types(result, "negative")).toContain("VOLUME_CONFIRMATION");
    expect(result.status).toBe("CONTRADICTED");
  });

  it("says nothing when volume could not be computed", () => {
    const result = evaluate(filler(30), readWith(null));

    expect(result.signals.map((s) => s.type)).not.toContain("VOLUME_CONFIRMATION");
  });

  it("can never confirm on its own", () => {
    // The strictness rule in one assertion: volume is supporting evidence, and
    // a heavy candle proves people traded, not that they bought.
    const result = evaluate(
      filler(30),
      readWith({ relative: 2.5, isAboveAverage: true, trend: "INCREASING" }),
    );

    expect(types(result, "positive")).toEqual(["VOLUME_CONFIRMATION"]);
    expect(result.status).toBe("NOT_PRESENT");
  });
});

describe("reclaim", () => {
  it("detects a level lost and taken back", () => {
    const lostAndRegained = makeCandles([...new Array(30).fill(106), 98, 99, 106]);
    const result = evaluate(lostAndRegained);

    expect(types(result, "positive")).toContain("RECLAIM");
  });

  it("does not call price above a level it never lost a reclaim", () => {
    const neverLost = makeCandles([...new Array(30).fill(106), 105, 106, 107]);
    const result = evaluate(neverLost);

    expect(types(result, "positive")).not.toContain("RECLAIM");
  });

  it("does not count a loss too long ago to be a reclaim", () => {
    const staleLoss = makeCandles([...new Array(20).fill(106), 98, ...new Array(10).fill(106)]);
    const result = evaluate(staleLoss);

    expect(types(result, "positive")).not.toContain("RECLAIM");
  });

  it("treats a close below the zone as invalidation", () => {
    const broken = makeCandles([...new Array(30).fill(106), 99]);
    const result = evaluate(broken);

    expect(types(result, "negative")).toContain("RECLAIM");
    expect(result.status).toBe("CONTRADICTED");
    expect(result.invalidationReason).toMatch(/support zone/i);
  });
});

describe("the aggregation rule", () => {
  const rejection = { open: 108, high: 112, low: 100, close: 110, volume: 100 };

  it("requires a primary signal and a second signal to confirm", () => {
    const withVolume = evaluate(
      [...filler(30), ...makeCandles([rejection])],
      readWith({ relative: 1.6, isAboveAverage: true, trend: "INCREASING" }),
    );

    expect(withVolume.signals.filter((s) => s.signal === "positive").length).toBeGreaterThanOrEqual(
      MIN_POSITIVE_SIGNALS,
    );
    expect(withVolume.status).toBe("PRESENT");
  });

  it("holds a lone primary signal at NOT_PRESENT", () => {
    const alone = evaluate([...filler(30), ...makeCandles([rejection])]);

    expect(types(alone, "positive")).toEqual(["BULLISH_REJECTION"]);
    expect(alone.status).toBe("NOT_PRESENT");
    expect(alone.explanation).toMatch(/single piece of evidence/i);
  });

  it("lets a negative signal override any number of positives", () => {
    const contradicted = evaluate(
      [...filler(30), ...makeCandles([rejection])],
      readWith({ relative: 0.3 }),
    );

    expect(contradicted.signals.some((s) => s.signal === "positive")).toBe(true);
    expect(contradicted.status).toBe("CONTRADICTED");
  });

  it("reports NOT_PRESENT with no signals on a quiet chart", () => {
    const quiet = evaluate(filler(40));

    expect(quiet.signals).toEqual([]);
    expect(quiet.status).toBe("NOT_PRESENT");
    expect(quiet.explanation).toMatch(/no confirmation yet/i);
  });
});

describe("closed candles only", () => {
  const rejection = { open: 108, high: 112, low: 100, close: 110, volume: 100 };

  it("judges the last closed candle, not the forming one", () => {
    const candles = [...filler(30), ...makeCandles([rejection, { close: 111, volume: 100 }])];

    const judged = evaluateConfirmation({
      read: readWith(null),
      entry: ENTRY,
      candles,
      lastCandleIsForming: true,
    });

    // The rejection is the second-to-last candle, and it is what was judged.
    expect(judged.evaluatedAt).toBe(candles[candles.length - 2].closeTime);
    expect(types(judged, "positive")).toContain("BULLISH_REJECTION");
  });

  it("ignores a perfect confirmation that is still forming", () => {
    const flat = filler(30);
    const stillOpen = makeCandles([rejection], { startTime: flat.at(-1)!.closeTime + 1 });

    const judged = evaluateConfirmation({
      read: readWith(null),
      entry: ENTRY,
      candles: [...flat, ...stillOpen],
      lastCandleIsForming: true,
    });

    expect(types(judged, "positive")).not.toContain("BULLISH_REJECTION");
  });

  it("returns a well-formed result when there is nothing to judge", () => {
    const empty = evaluateConfirmation({ read: readWith(null), entry: ENTRY, candles: [] });

    expect(empty.status).toBe("NOT_PRESENT");
    expect(empty.signals).toEqual([]);
    expect(empty.evaluatedAt).toBe(0);
  });
});

describe("no lookahead", () => {
  const rejection = { open: 108, high: 112, low: 100, close: 110, volume: 100 };

  it("cannot see a confirmation that happens on a later candle", () => {
    // The load-bearing test. A perfect rejection exists in the series, but
    // only becomes visible once evaluation reaches it.
    const series = [...filler(30), ...makeCandles([rejection])];
    const before = series.slice(0, -1);

    expect(types(evaluate(before), "positive")).not.toContain("BULLISH_REJECTION");
    expect(types(evaluate(series), "positive")).toContain("BULLISH_REJECTION");
  });

  it("is unchanged by rewriting candles after the one being judged", () => {
    const series = [...filler(30), ...makeCandles([rejection])];
    const withFuture = [
      ...series,
      ...makeCandles([{ close: 500, volume: 9999 }], {
        startTime: series.at(-1)!.closeTime + 1,
      }),
    ];

    const judged = evaluate(series);
    const judgedIgnoringFuture = evaluateConfirmation({
      read: readWith(null),
      entry: ENTRY,
      candles: withFuture,
      lastCandleIsForming: true,
    });

    expect(judgedIgnoringFuture.evaluatedAt).toBe(judged.evaluatedAt);
    expect(JSON.stringify(judgedIgnoringFuture.signals)).toBe(JSON.stringify(judged.signals));
  });
});

describe("determinism", () => {
  it("returns an identical result for identical input", () => {
    const series = [
      ...filler(30),
      ...makeCandles([{ open: 108, high: 112, low: 100, close: 110, volume: 100 }]),
    ];
    const read = readWith({ relative: 1.6, isAboveAverage: true, trend: "INCREASING" });

    const once = evaluateConfirmation({ read, entry: ENTRY, candles: series });
    const twice = evaluateConfirmation({ read, entry: ENTRY, candles: series });

    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("timestamps from the candle rather than the clock", () => {
    const series = filler(30);
    const result = evaluate(series);

    expect(result.evaluatedAt).toBe(series.at(-1)!.closeTime);
  });
});
