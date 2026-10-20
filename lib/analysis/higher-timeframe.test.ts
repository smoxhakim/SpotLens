import { describe, expect, it } from "vitest";

import { TIMEFRAME_MS, type Candle } from "@/lib/market-data/provider";
import { downtrend, pullbackIntoSupport } from "@/lib/test-utils/scenarios";

import {
  HIGHER_TIMEFRAME_GRACE_MS,
  assessHigherTimeframe,
  unavailableHigherTimeframe,
} from "./higher-timeframe";
import { runAnalysis } from "./setup";

/**
 * Fail closed on the higher timeframe.
 *
 * The counter-trend veto and the bearish-alignment AVOID live on the higher
 * timeframe. An analysis without a usable one is shown for information only:
 * never POTENTIAL_SETUP, and marked `incomplete` so no caller tracks it.
 */

const SERIES = pullbackIntoSupport();
/** Just after the series' last close. */
const NOW = SERIES.at(-1)!.closeTime + 1;

describe("assessHigherTimeframe", () => {
  const assess = (candles: Candle[], extra: { now?: number; servedStale?: boolean } = {}) =>
    assessHigherTimeframe({ candles, timeframe: "H1", now: extra.now ?? NOW, ...extra });

  it("accepts a complete, ordered, current series", () => {
    expect(assess(SERIES)).toBeNull();
  });

  it("STALE when the cache answered because the exchange failed", () => {
    expect(assess(SERIES, { servedStale: true })).toMatchObject({ gap: "STALE" });
  });

  it("STALE when the newest closed candle is missing, past the grace", () => {
    const behind = SERIES.slice(0, -1);
    // One candle missing, just past grace.
    const now = behind.at(-1)!.closeTime + 1 + TIMEFRAME_MS.H1 + HIGHER_TIMEFRAME_GRACE_MS + 1;
    expect(assess(behind, { now })).toMatchObject({ gap: "STALE" });
    // Within grace — the exchange may still be settling the bar.
    expect(assess(behind, { now: now - 2 })).toBeNull();
  });

  it("UNAVAILABLE when nothing closed is there", () => {
    expect(assess([])).toMatchObject({ gap: "UNAVAILABLE" });
  });

  it("INSUFFICIENT below a trend read's minimum", () => {
    expect(assess(SERIES.slice(-59))).toMatchObject({ gap: "INSUFFICIENT" });
    expect(assess(SERIES.slice(-60))).toBeNull();
  });

  it("INVALID when out of order, duplicated, or not a price", () => {
    expect(assess([...SERIES].reverse())).toMatchObject({ gap: "INVALID" });
    expect(assess([...SERIES.slice(0, -1), SERIES.at(-2)!])).toMatchObject({ gap: "INVALID" });
    const broken = [...SERIES];
    broken[10] = { ...broken[10], close: Number.NaN };
    expect(assess(broken)).toMatchObject({ gap: "INVALID" });
    const inverted = [...SERIES];
    inverted[10] = { ...inverted[10], high: inverted[10].low - 1 };
    expect(assess(inverted)).toMatchObject({ gap: "INVALID" });
  });
});

describe("runAnalysis with a higher-timeframe shortfall", () => {
  const shortfall = unavailableHigherTimeframe("H4", "UNAVAILABLE");

  it("holds a would-be potential setup at wait, and says why", () => {
    expect(runAnalysis(SERIES).status).toBe("POTENTIAL_SETUP");

    const held = runAnalysis(SERIES, { incomplete: shortfall });
    expect(held.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(held.statusReason).toMatch(/held at wait and shown for information only/);
    expect(held.statusReason).toMatch(/not tracked and cannot trigger an entry-zone alert/);
    expect(held.incomplete).toEqual(shortfall);
  });

  it("keeps the lower-timeframe levels for information, unchanged", () => {
    const full = runAnalysis(SERIES);
    const held = runAnalysis(SERIES, { incomplete: shortfall });
    expect(held.setup).toEqual(full.setup);
    expect(held.score).toEqual(full.score);
    expect(held.confirmation).toEqual(full.confirmation);
  });

  it("leaves a verdict short of potential as it was, still marked incomplete", () => {
    const refused = runAnalysis(downtrend(), { incomplete: shortfall });
    expect(refused.status).toBe(runAnalysis(downtrend()).status);
    expect(refused.incomplete).toEqual(shortfall);
  });

  it("changes nothing for a caller that declares no shortfall", () => {
    const result = runAnalysis(SERIES);
    expect(result.incomplete).toBeNull();
    expect(result.status).toBe("POTENTIAL_SETUP");
  });
});
