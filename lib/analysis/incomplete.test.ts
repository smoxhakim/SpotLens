import { describe, expect, it } from "vitest";

import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";

import { unavailableHigherTimeframe } from "./higher-timeframe";
import {
  heldForIncompleteData,
  incompleteAnalysisLabel,
  incompleteAnalysisNotice,
  staleEntryTimeframe,
} from "./incomplete";
import { runAnalysis } from "./setup";

/**
 * One representation, and one copy of the words, for both kinds of incomplete
 * analysis: stale entry candles, and an unusable higher timeframe.
 */

const ENTRY = staleEntryTimeframe("H1");
const HIGHER = unavailableHigherTimeframe("H4", "UNAVAILABLE");

describe("runAnalysis with stale entry candles", () => {
  it("holds a would-be potential setup at wait, naming the stale timeframe", () => {
    const series = pullbackIntoSupport();
    expect(runAnalysis(series).status).toBe("POTENTIAL_SETUP");

    const held = runAnalysis(series, { incomplete: ENTRY });
    expect(held.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(held.incomplete).toEqual(ENTRY);
    expect(held.statusReason).toMatch(/^The 1h candles being analysed are stale/);
    expect(held.statusReason).toMatch(/A potential setup needs current data/);
  });

  it("leaves the numbers unchanged — only the verdict is held back", () => {
    const series = pullbackIntoSupport();
    const full = runAnalysis(series);
    const held = runAnalysis(series, { incomplete: ENTRY });
    expect(held.setup).toEqual(full.setup);
    expect(held.score).toEqual(full.score);
    expect(held.confirmation).toEqual(full.confirmation);
  });
});

describe("the words, in one place", () => {
  it("scopes each shortfall to its timeframe", () => {
    expect(ENTRY).toMatchObject({ scope: "ENTRY", timeframe: "H1", gap: "STALE" });
    expect(HIGHER).toMatchObject({ scope: "HIGHER", timeframe: "H4", gap: "UNAVAILABLE" });
  });

  it("explains a hold differently for entry and higher timeframes", () => {
    expect(heldForIncompleteData(ENTRY)).toMatch(/needs current data/);
    expect(heldForIncompleteData(HIGHER)).toMatch(/needs the 4h trend's agreement/);
    for (const s of [ENTRY, HIGHER]) {
      expect(heldForIncompleteData(s)).toMatch(
        /not tracked and cannot trigger an entry-zone alert/,
      );
    }
  });

  it("says the levels are not a trade plan", () => {
    expect(incompleteAnalysisNotice(ENTRY)).toMatch(/without current 1h data/);
    expect(incompleteAnalysisNotice(HIGHER)).toMatch(/without the 4h trend/);
    for (const s of [ENTRY, HIGHER]) {
      expect(incompleteAnalysisNotice(s)).toMatch(/These levels are not a trade plan\.$/);
    }
  });

  it("has a short label for the status bar", () => {
    expect(incompleteAnalysisLabel(ENTRY)).toBe("Incomplete — 1h data stale");
    expect(incompleteAnalysisLabel(HIGHER)).toBe("Incomplete — 4h data unavailable");
    expect(incompleteAnalysisLabel(unavailableHigherTimeframe("H4", "NOT_CHECKED"))).toBe(
      "Incomplete — 4h data not checked",
    );
  });

  it("never instructs a trade", () => {
    for (const s of [ENTRY, HIGHER]) {
      for (const text of [heldForIncompleteData(s), incompleteAnalysisNotice(s)]) {
        expect(text.toLowerCase()).not.toMatch(/\b(buy|sell now|enter now)\b/);
      }
    }
  });
});
