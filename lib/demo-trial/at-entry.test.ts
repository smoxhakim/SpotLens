import { describe, expect, it } from "vitest";

import { stateAt, statesAround, type SetupHistory } from "./at-entry";

/**
 * The setup as SpotLens showed it at one moment, rebuilt from its event log and
 * the reads behind it. A 4h setup first tracked at 08:02 from the analysis of
 * the 04:00 candle, which stays fresh until the 12:00 close has settled.
 */
const at = (h: number, m = 0, s = 0) => Date.UTC(2026, 9, 31, h, m, s);

const history = (overrides: Partial<SetupHistory> = {}): SetupHistory => ({
  createdAt: at(8, 2),
  events: [
    { toStatus: "SETUP_FORMING", at: at(8, 2) },
    { toStatus: "POTENTIAL_SETUP", at: at(9, 30) },
    { toStatus: "INVALIDATED", at: at(13, 0) },
  ],
  reads: [{ analysedAtCandle: at(4), availableAt: at(8, 2) }],
  ...overrides,
});

describe("stateAt: the lifecycle state", () => {
  it("is the latest transition at or before the moment", () => {
    expect(stateAt(history(), "H4", at(9)).status).toBe("SETUP_FORMING");
    expect(stateAt(history(), "H4", at(9, 30)).status).toBe("POTENTIAL_SETUP");
    expect(stateAt(history(), "H4", at(12)).status).toBe("POTENTIAL_SETUP");
    expect(stateAt(history(), "H4", at(13, 30)).status).toBe("INVALIDATED");
  });

  it("does not depend on the order the events arrive in", () => {
    const reversed = history({ events: [...history().events].reverse() });
    expect(stateAt(reversed, "H4", at(12)).status).toBe("POTENTIAL_SETUP");
  });

  it("is null before SpotLens tracked the setup", () => {
    expect(stateAt(history(), "H4", at(7))).toMatchObject({ tracked: false, status: null });
  });

  it("is null, but tracked, when the event log holds nothing for the moment", () => {
    expect(stateAt(history({ events: [] }), "H4", at(9))).toMatchObject({
      tracked: true,
      status: null,
    });
  });
});

describe("stateAt: freshness", () => {
  it("is fresh until a newer candle has closed and settled, stale from then", () => {
    expect(stateAt(history(), "H4", at(12, 1, 29)).freshness).toBe("FRESH");
    expect(stateAt(history(), "H4", at(12, 1, 30)).freshness).toBe("STALE");
  });

  it("counts a later pass only once it had completed by the moment", () => {
    // The pass read the 08:00 candle and completed at 12:02:10.
    const pass = { analysedAtCandle: at(8), availableAt: at(12, 2, 10) };
    const withPass = history({ reads: [...history().reads, pass] });
    // Before the pass completed, the creation read is all there was.
    expect(stateAt(withPass, "H4", at(12, 2)).freshness).toBe("STALE");
    expect(stateAt(withPass, "H4", at(12, 3)).freshness).toBe("FRESH");
  });

  it("is unknown, never fresh, with no read available yet", () => {
    expect(stateAt(history(), "H4", at(8)).freshness).toBe("UNKNOWN");
    expect(stateAt(history({ reads: [] }), "H4", at(10)).freshness).toBe("UNKNOWN");
  });

  it("credits a read that does not name its candle with nothing", () => {
    // No inference from when the row was written: no candle, no read.
    const unnamed = history({ reads: [{ analysedAtCandle: null, availableAt: at(8, 2) }] });
    expect(stateAt(unnamed, "H4", at(10)).freshness).toBe("UNKNOWN");
  });
});

describe("statesAround: the margin a typed-in time carries", () => {
  const margin = 60_000;

  it("is one state when nothing changed within the margin", () => {
    const states = statesAround(history(), "H4", at(10), margin);
    expect(new Set(states.map((s) => `${s.status}/${s.freshness}`))).toEqual(
      new Set(["POTENTIAL_SETUP/FRESH"]),
    );
  });

  it("includes a status change just after the typed moment", () => {
    const states = statesAround(history(), "H4", at(9, 29, 30), margin);
    expect(states.map((s) => s.status)).toContain("SETUP_FORMING");
    expect(states.map((s) => s.status)).toContain("POTENTIAL_SETUP");
  });

  it("includes the analysis going stale inside the margin", () => {
    const states = statesAround(history(), "H4", at(12, 1), margin);
    expect(states.map((s) => s.freshness)).toEqual(expect.arrayContaining(["FRESH", "STALE"]));
  });

  it("catches a stale stretch that starts and ends inside the margin", () => {
    // Stale from 12:01:30; a pass re-read it, completing at 12:01:50. Both edges are fresh.
    const reread = history({
      reads: [...history().reads, { analysedAtCandle: at(8), availableAt: at(12, 1, 50) }],
    });
    expect(stateAt(reread, "H4", at(12, 0, 40)).freshness).toBe("FRESH");
    expect(stateAt(reread, "H4", at(12, 2, 40)).freshness).toBe("FRESH");
    const states = statesAround(reread, "H4", at(12, 1, 40), margin);
    expect(states.map((s) => s.freshness)).toContain("STALE");
  });
});
