import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/market-data/provider";

import { candlesUpTo, coverageFor, eventsUpTo, markersUpTo } from "./cutoff";

/**
 * These are the no-lookahead tests for replay. Where possible they are written
 * as defect injection: change the future, and assert the reconstruction of the
 * past did not move.
 */

const HOUR = 3_600_000;

function series(count: number, from = 0): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    openTime: from + i * HOUR,
    closeTime: from + (i + 1) * HOUR - 1,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 10,
  }));
}

describe("candlesUpTo", () => {
  it("cannot reach the candle after the cutoff", () => {
    const candles = series(10);
    // Cut exactly on the close of candle index 4.
    const seen = candlesUpTo(candles, candles[4].closeTime);

    expect(seen).toHaveLength(5);
    expect(seen[seen.length - 1]).toBe(candles[4]);
    expect(seen).not.toContain(candles[5]);
  });

  it("drops the candle that was still forming at the cutoff", () => {
    const candles = series(10);
    // A moment in the middle of candle 5: it has opened but not closed.
    const midCandle = candles[5].openTime + HOUR / 2;
    const seen = candlesUpTo(candles, midCandle);

    expect(seen).toHaveLength(5);
    expect(seen).not.toContain(candles[5]);
  });

  it("is unmoved by rewriting the future", () => {
    // The decisive property. Same past, different future.
    const candles = series(10);
    const rewritten = candles.map((c, i) =>
      i <= 4 ? c : { ...c, close: c.close * 5, high: c.high * 9, low: c.low / 3 },
    );

    const cutoff = candles[4].closeTime;

    expect(candlesUpTo(rewritten, cutoff)).toEqual(candlesUpTo(candles, cutoff));
  });

  it("is unmoved by appending candles after the cutoff", () => {
    const candles = series(10);
    const cutoff = candles[4].closeTime;
    const extended = [...candles, ...series(50, 10 * HOUR)];

    expect(candlesUpTo(extended, cutoff)).toEqual(candlesUpTo(candles, cutoff));
  });

  it("returns nothing when the cutoff precedes all stored history", () => {
    expect(candlesUpTo(series(10), -1)).toEqual([]);
  });
});

describe("eventsUpTo", () => {
  it("cannot reach an event recorded after the cutoff", () => {
    const events = [{ createdAt: 100 }, { createdAt: 200 }, { createdAt: 300 }];

    expect(eventsUpTo(events, 200)).toEqual([{ createdAt: 100 }, { createdAt: 200 }]);
    expect(eventsUpTo(events, 199)).toEqual([{ createdAt: 100 }]);
  });
});

describe("markersUpTo", () => {
  const events = [
    { createdAt: 100, type: "CREATED", toStatus: "SETUP_FORMING" },
    { createdAt: 200, type: "STATUS_CHANGE", toStatus: "CONFIRMATION_DETECTED" },
    { createdAt: 300, type: "STATUS_CHANGE", toStatus: "INVALIDATED" },
  ];

  it("does not leak the future through the navigation", () => {
    // A confirmation that arrived after the decision must not appear as a
    // place to jump to — that would give away the answer without showing a
    // single future candle.
    const markers = markersUpTo(events, null, 150);

    expect(markers.map((m) => m.kind)).toEqual(["CREATED"]);
  });

  it("shows the decision only once it had been made", () => {
    expect(markersUpTo(events, 250, 200).map((m) => m.kind)).toEqual(["CREATED", "CONFIRMATION"]);
    expect(markersUpTo(events, 250, 260).map((m) => m.kind)).toEqual([
      "CREATED",
      "CONFIRMATION",
      "DECISION",
    ]);
  });

  it("orders markers stably", () => {
    const a = markersUpTo(events, 250, 1_000);
    const b = markersUpTo([...events].reverse(), 250, 1_000);

    expect(a).toEqual(b);
    expect(a.map((m) => m.at)).toEqual([100, 200, 250, 300]);
  });
});

describe("coverageFor", () => {
  const window = { intervalMs: HOUR, windowStart: 0, cutoff: 100 * HOUR };

  it("states the gap rather than filling it", () => {
    const coverage = coverageFor({ ...window, candles: series(20) });

    expect(coverage.available).toBe(20);
    expect(coverage.expected).toBe(100);
    expect(coverage.incomplete).toBe(true);
    expect(coverage.note).toMatch(/does not fetch/i);
  });

  it("says plainly when nothing is stored", () => {
    const coverage = coverageFor({ ...window, candles: [] });

    expect(coverage.incomplete).toBe(true);
    expect(coverage.from).toBeNull();
    expect(coverage.to).toBeNull();
    expect(coverage.note).toMatch(/Nothing has been fetched/i);
  });

  it("stays quiet when the window is covered", () => {
    const coverage = coverageFor({ ...window, candles: series(100) });

    expect(coverage.incomplete).toBe(false);
    expect(coverage.note).toBeNull();
  });

  it("reports the range actually shown", () => {
    const candles = series(20, 5 * HOUR);
    const coverage = coverageFor({ ...window, candles });

    expect(coverage.from).toBe(candles[0].openTime);
    expect(coverage.to).toBe(candles[19].openTime);
  });
});
