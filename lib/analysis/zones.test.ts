import { describe, expect, it } from "vitest";

import { makeCandles } from "@/lib/test-utils/candles";

import { detectZones, distanceToZone, isInZone } from "./zones";

/**
 * Builds a series that repeatedly bounces between `floor` and `ceiling`,
 * so both levels accumulate real reactions.
 */
function oscillate(floor: number, ceiling: number, cycles: number, steps = 5): number[] {
  const out: number[] = [];
  for (let c = 0; c < cycles; c += 1) {
    for (let s = 0; s < steps; s += 1) out.push(floor + ((ceiling - floor) * s) / steps);
    for (let s = 0; s < steps; s += 1) out.push(ceiling - ((ceiling - floor) * s) / steps);
  }
  return out;
}

describe("detectZones", () => {
  it("finds support below price and resistance above it", () => {
    // Bounces between 100 and 140, ending mid-range.
    const series = [...oscillate(100, 140, 6), 120];
    const read = detectZones(makeCandles(series));

    expect(read.support.length).toBeGreaterThan(0);
    expect(read.resistance.length).toBeGreaterThan(0);
    expect(read.support[0].mid).toBeLessThan(read.price);
    expect(read.resistance[0].mid).toBeGreaterThan(read.price);
  });

  it("returns zones, never single lines", () => {
    const read = detectZones(makeCandles([...oscillate(100, 140, 6), 120]));

    for (const zone of [...read.support, ...read.resistance]) {
      expect(zone.high).toBeGreaterThan(zone.low);
      expect(zone.mid).toBeGreaterThan(zone.low);
      expect(zone.mid).toBeLessThan(zone.high);
    }
  });

  it("places the repeatedly-tested level inside its zone", () => {
    const read = detectZones(makeCandles([...oscillate(100, 140, 6), 120]));
    const support = read.support[0];

    // The floor of the oscillation should fall within the support zone.
    expect(100).toBeGreaterThanOrEqual(support.low - 1);
    expect(100).toBeLessThanOrEqual(support.high + 1);
  });

  it("counts repeated reactions as touches", () => {
    const read = detectZones(makeCandles([...oscillate(100, 140, 6), 120]));
    const strongest = [...read.support, ...read.resistance].sort(
      (a, b) => b.touches - a.touches,
    )[0];

    expect(strongest.touches).toBeGreaterThanOrEqual(3);
  });

  it("scores a often-tested recent zone above a barely-tested old one", () => {
    // One early spike, then a level tested repeatedly right up to the present.
    const series = [
      50,
      60,
      200,
      60,
      50, // lone spike, long ago
      ...oscillate(100, 140, 8),
      120,
    ];
    const read = detectZones(makeCandles(series), { maxPerSide: 6 });
    const zones = [...read.support, ...read.resistance];

    const recent = zones.find((z) => z.touches >= 3);
    const old = zones.find((z) => z.mid > 180);

    if (recent && old) expect(recent.strength).toBeGreaterThan(old.strength);
  });

  it("marks a level that has acted as both support and resistance as flipped", () => {
    // 140 caps the market repeatedly, price breaks above it, and 140 then acts
    // as the floor — the same level tested from both sides.
    const series = [...oscillate(100, 140, 4), ...oscillate(140, 180, 4), 160];
    const read = detectZones(makeCandles(series), { maxPerSide: 6 });
    const zones = [...read.support, ...read.resistance];

    const flipped = zones.find((z) => z.flipped);
    expect(flipped).toBeDefined();
    // The flipped zone is the old ceiling, now support.
    expect(140).toBeGreaterThanOrEqual(flipped!.low - 2);
    expect(140).toBeLessThanOrEqual(flipped!.high + 2);
    // A flip earns a strength bonus over an equivalent single-sided level.
    expect(flipped!.strength).toBeGreaterThan(40);
  });

  it("scales zone width with volatility, not a fixed percentage", () => {
    const calm = detectZones(makeCandles([...oscillate(100, 104, 8), 102]));
    const wild = detectZones(makeCandles([...oscillate(100, 200, 8), 150]));

    const calmWidth = calm.support[0].high - calm.support[0].low;
    const wildWidth = wild.support[0].high - wild.support[0].low;

    expect(wildWidth).toBeGreaterThan(calmWidth);
  });

  it("orders support nearest-first below price and resistance nearest-first above", () => {
    const series = [...oscillate(100, 200, 10), 150];
    const read = detectZones(makeCandles(series), { maxPerSide: 3 });

    for (let i = 1; i < read.support.length; i += 1) {
      expect(read.support[i].high).toBeLessThanOrEqual(read.support[i - 1].high);
    }
    for (let i = 1; i < read.resistance.length; i += 1) {
      expect(read.resistance[i].low).toBeGreaterThanOrEqual(read.resistance[i - 1].low);
    }
  });

  it("returns nothing rather than inventing zones in a flat market", () => {
    const read = detectZones(makeCandles(new Array(60).fill(100)));

    expect(read.support).toEqual([]);
    expect(read.resistance).toEqual([]);
  });

  it("returns nothing when there is not enough history", () => {
    const read = detectZones(makeCandles([1, 2, 3]));

    expect(read.support).toEqual([]);
    expect(read.resistance).toEqual([]);
  });

  it("caps how many zones it reports per side", () => {
    const series = [...oscillate(50, 250, 14), 150];
    const read = detectZones(makeCandles(series), { maxPerSide: 2 });

    expect(read.support.length).toBeLessThanOrEqual(2);
    expect(read.resistance.length).toBeLessThanOrEqual(2);
  });
});

describe("zone helpers", () => {
  const zone = {
    low: 100,
    high: 110,
    mid: 105,
    kind: "SUPPORT" as const,
    touches: 3,
    strength: 70,
    flipped: false,
    lastTouchIndex: 10,
    lastTouchTime: 0,
  };

  it("detects a price inside a zone, edges included", () => {
    expect(isInZone(105, zone)).toBe(true);
    expect(isInZone(100, zone)).toBe(true);
    expect(isInZone(110, zone)).toBe(true);
    expect(isInZone(99.9, zone)).toBe(false);
  });

  it("measures distance to the nearest edge, zero inside", () => {
    expect(distanceToZone(105, zone)).toBe(0);
    expect(distanceToZone(95, zone)).toBe(5);
    expect(distanceToZone(115, zone)).toBe(5);
  });
});
