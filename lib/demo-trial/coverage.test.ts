import { describe, expect, it } from "vitest";

import { scanCoverage } from "./coverage";

const H = 60 * 60_000;
const at = (h: number, m = 0) => Date.UTC(2026, 9, 31, h, m);
const base = { expectedEveryMs: H, toleranceMs: 15 * 60_000, failedPasses: 0 };

describe("scanCoverage", () => {
  it("finds no gap when a pass followed every hourly close", () => {
    const coverage = scanCoverage({
      ...base,
      from: at(0),
      to: at(4),
      passStarts: [at(0, 1), at(1, 1), at(2, 1), at(3, 1)],
    });
    expect(coverage.successfulPasses).toBe(4);
    expect(coverage.gaps).toEqual([]);
    // Pass to pass, an hour apart; 03:01 to the window's end at 04:00 is shorter.
    expect(coverage.longestGapMs).toBe(H);
  });

  it("names a stretch in which a candle closed unread, with its edges", () => {
    const coverage = scanCoverage({
      ...base,
      from: at(0),
      to: at(6),
      passStarts: [at(0, 1), at(1, 1), at(4, 1), at(5, 1)],
    });
    expect(coverage.gaps).toEqual([{ from: at(1, 1), to: at(4, 1), durationMs: 3 * H }]);
    expect(coverage.longestGapMs).toBe(3 * H);
  });

  it("counts the window's own edges: a late first pass and an early last one are gaps too", () => {
    const coverage = scanCoverage({ ...base, from: at(0), to: at(8), passStarts: [at(3)] });
    expect(coverage.gaps.map((g) => [g.from, g.to])).toEqual([
      [at(0), at(3)],
      [at(3), at(8)],
    ]);
  });

  it("allows the tolerance and no more", () => {
    const within = scanCoverage({ ...base, from: at(0), to: at(1, 15), passStarts: [] });
    expect(within.gaps).toEqual([]);
    const over = scanCoverage({ ...base, from: at(0), to: at(1, 16), passStarts: [] });
    expect(over.gaps).toHaveLength(1);
  });

  it("ignores passes outside the window and sorts the rest, and carries the failed count", () => {
    const coverage = scanCoverage({
      ...base,
      failedPasses: 2,
      from: at(1),
      to: at(3),
      passStarts: [at(2, 1), at(0, 30), at(1, 1), at(5)],
    });
    expect(coverage.successfulPasses).toBe(2);
    expect(coverage.failedPasses).toBe(2);
    expect(coverage.gaps).toEqual([]);
  });

  it("is empty, not zero-length, for a window that is not one", () => {
    expect(scanCoverage({ ...base, from: at(2), to: at(2), passStarts: [] })).toEqual({
      successfulPasses: 0,
      failedPasses: 0,
      longestGapMs: null,
      gaps: [],
    });
  });
});
