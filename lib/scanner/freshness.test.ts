import { describe, expect, it } from "vitest";

import { TIMEFRAME_MS } from "@/lib/market-data/provider";

import { analysisFreshness, combinedFreshness } from "./freshness";
import { DEFAULT_CLOSE_DELAY_MS, latestScanWindow } from "./schedule";

/**
 * When a displayed analysis stops describing the market.
 *
 * The last pass this was written against: started 18:06:59 UTC on 28 Oct,
 * reading the 1h candle that opened 17:00 and the 4h candle that opened 12:00.
 */
const H = 60 * 60_000;
const at = (h: number, m = 0, s = 0) => Date.UTC(2026, 9, 28, h, m, s);
const SCAN = at(18, 6, 59);
const H1_CANDLE = at(17);
const H4_CANDLE = at(12);

describe("analysisFreshness", () => {
  it("1h: fresh until the next 1h close has settled, stale from then", () => {
    const f = (now: number) =>
      analysisFreshness({ timeframe: "H1", analysedCandleOpen: H1_CANDLE, now });

    expect(f(at(18, 30)).state).toBe("FRESH");
    expect(f(at(19, 1, 29)).state).toBe("FRESH");
    expect(f(at(19, 1, 30)).state).toBe("STALE");
    expect(f(at(19, 1, 30)).staleAt).toBe(at(19) + DEFAULT_CLOSE_DELAY_MS);
  });

  it("4h: fresh until the next 4h close has settled, stale from then", () => {
    const f = (now: number) =>
      analysisFreshness({ timeframe: "H4", analysedCandleOpen: H4_CANDLE, now });

    expect(f(at(19, 30)).state).toBe("FRESH");
    expect(f(at(20, 1, 29)).state).toBe("FRESH");
    expect(f(at(20, 1, 30)).state).toBe("STALE");
  });

  it("an old scan shown on a page left open turns stale by itself as time passes", () => {
    // The page loaded while the 1h read was current. Nothing reloads; the clock
    // moves on past the next close, and the same input is now stale.
    const input = { timeframe: "H1", analysedCandleOpen: H1_CANDLE };
    expect(analysisFreshness({ ...input, now: at(18, 10) }).state).toBe("FRESH");
    expect(analysisFreshness({ ...input, now: at(18, 10) + 2 * H }).state).toBe("STALE");
    // And the morning after, as in the QA run, it is stale on 4h too.
    expect(
      analysisFreshness({ timeframe: "H4", analysedCandleOpen: H4_CANDLE, now: at(18) + 15 * H })
        .state,
    ).toBe("STALE");
  });

  it("falls back to the pass's start when the candle was not stored, with the same answer", () => {
    for (const [timeframe, candle] of [
      ["H1", H1_CANDLE],
      ["H4", H4_CANDLE],
    ] as const) {
      for (const now of [at(18, 30), at(20, 30), at(23)]) {
        expect(analysisFreshness({ timeframe, scannedAt: SCAN, now }).state).toBe(
          analysisFreshness({ timeframe, analysedCandleOpen: candle, now }).state,
        );
      }
    }
  });

  it("goes stale exactly when the scanner treats a new pass as due", () => {
    // One definition of "due": the window the scheduled loop and the catch-up
    // rule plan from. Stale means a pass after SCAN is owed and has not run.
    for (const timeframe of ["H1", "H4"] as const) {
      for (let now = at(18, 7); now < at(23); now += 7 * 60_000) {
        const due = latestScanWindow(timeframe, now) > SCAN;
        expect(
          analysisFreshness({ timeframe, scannedAt: SCAN, now }).state,
          `${timeframe} ${new Date(now).toISOString()}`,
        ).toBe(due ? "STALE" : "FRESH");
      }
    }
  });

  it("is unknown, never fresh, when it cannot be judged", () => {
    const now = at(18, 30);
    for (const timeframe of ["H1", "H4"]) {
      expect(analysisFreshness({ timeframe, now }).state).toBe("UNKNOWN");
      expect(
        analysisFreshness({ timeframe, analysedCandleOpen: null, scannedAt: null, now }).state,
      ).toBe("UNKNOWN");
      expect(analysisFreshness({ timeframe, scannedAt: Number.NaN, now }).state).toBe("UNKNOWN");
      // From the future: a fault, not a time.
      expect(
        analysisFreshness({ timeframe, analysedCandleOpen: now + TIMEFRAME_MS.H4, now }).state,
      ).toBe("UNKNOWN");
    }
    expect(analysisFreshness({ timeframe: "H2", analysedCandleOpen: H1_CANDLE, now }).state).toBe(
      "UNKNOWN",
    );
  });
});

describe("combinedFreshness", () => {
  const fresh = analysisFreshness({ timeframe: "H4", analysedCandleOpen: H4_CANDLE, now: at(19) });
  const stale = analysisFreshness({
    timeframe: "H1",
    analysedCandleOpen: H1_CANDLE,
    now: at(19, 30),
  });
  const unknown = analysisFreshness({ timeframe: "H1", now: at(19) });

  it("is stale if any shown analysis is, and names the timeframe", () => {
    expect(
      combinedFreshness([
        { timeframe: "H4", freshness: fresh },
        { timeframe: "H1", freshness: stale },
      ]),
    ).toEqual({ state: "STALE", staleTimeframes: ["H1"], unknownTimeframes: [] });
  });

  it("is unknown rather than fresh when one cannot be judged, or nothing is shown", () => {
    expect(
      combinedFreshness([
        { timeframe: "H4", freshness: fresh },
        { timeframe: "H1", freshness: unknown },
      ]).state,
    ).toBe("UNKNOWN");
    expect(combinedFreshness([]).state).toBe("UNKNOWN");
  });

  it("is fresh only when every shown analysis is", () => {
    expect(combinedFreshness([{ timeframe: "H4", freshness: fresh }]).state).toBe("FRESH");
  });
});
