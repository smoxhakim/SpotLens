import { describe, expect, it } from "vitest";

import { analyzeMultiTimeframe, defaultHigherTimeframe, runAnalysis } from "@/lib/analysis";
import { TIMEFRAMES, type Timeframe } from "@/lib/market-data/provider";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";

import { readsCanonicalContext } from "./context";

/** An analysis read against `higher`, exactly as the scanner builds one. */
function readAgainst(lower: Timeframe, higher: Timeframe) {
  const candles = pullbackIntoSupport();
  return runAnalysis(candles, {
    mtf: analyzeMultiTimeframe({
      lowerCandles: candles,
      higherCandles: pullbackIntoSupport(),
      lowerTimeframe: lower,
      higherTimeframe: higher,
    }),
  });
}

const SINGLE_TIMEFRAME = runAnalysis(pullbackIntoSupport());

describe("a tracked setup is written only from its canonical context", () => {
  it("admits what the scanner reads: H1 against H4, H4 against D1", () => {
    // The scanner's own construction, so its behaviour cannot change.
    expect(readsCanonicalContext("H1", readAgainst("H1", defaultHigherTimeframe("H1")!))).toBe(
      true,
    );
    expect(readsCanonicalContext("H4", readAgainst("H4", defaultHigherTimeframe("H4")!))).toBe(
      true,
    );
  });

  it("refuses an H1 analysis read against D1 or W1", () => {
    // The direct-API case: it would reconcile against the scanner's H1 setup.
    expect(readsCanonicalContext("H1", readAgainst("H1", "D1"))).toBe(false);
    expect(readsCanonicalContext("H1", readAgainst("H1", "W1"))).toBe(false);
  });

  it("holds for every timeframe: the default passes and no other higher one does", () => {
    for (const lower of TIMEFRAMES) {
      const canonical = defaultHigherTimeframe(lower);
      for (const higher of TIMEFRAMES) {
        if (TIMEFRAMES.indexOf(higher) <= TIMEFRAMES.indexOf(lower)) continue;
        expect(readsCanonicalContext(lower, readAgainst(lower, higher)), `${lower}/${higher}`).toBe(
          higher === canonical,
        );
      }
    }
  });

  it("admits a single-timeframe read only where no higher timeframe exists", () => {
    for (const timeframe of TIMEFRAMES) {
      expect(readsCanonicalContext(timeframe, SINGLE_TIMEFRAME), timeframe).toBe(
        defaultHigherTimeframe(timeframe) === null,
      );
    }
    expect(readsCanonicalContext("W1", SINGLE_TIMEFRAME)).toBe(true);
  });
});
