import { describe, expect, it } from "vitest";

import { makeCandles } from "@/lib/test-utils/candles";

import type { MarketRead } from "../market-read";
import type { PriceZone } from "../zones";
import { validateSetupLevels } from "./levels";
import { calculateRiskReward } from "./risk-reward";
import { calculateTakeProfits } from "./take-profit";
import type { EntryZone, StopLoss } from "./types";

/**
 * The take-profit ladder has to read upwards.
 *
 * The regression these cover was found in a live pass (LTC/USDT 1h): a
 * structural TP2 at the prior swing high, 5.7R away, followed by an R-multiple
 * TP3 at 4R — *below* it. The fill loop chose the multiple by slot number and
 * never compared it with what was already on the ladder.
 */

function zone(low: number, high: number): PriceZone {
  return {
    low,
    high,
    mid: (low + high) / 2,
    kind: "RESISTANCE",
    touches: 2,
    strength: 50,
    flipped: false,
    lastTouchIndex: 0,
    lastTouchTime: 0,
  };
}

function read(resistance: PriceZone[]): MarketRead {
  return { resistance } as unknown as MarketRead;
}

function entryZone(low: number, high: number): EntryZone {
  return { low, high, mid: (low + high) / 2 } as EntryZone;
}

/** Highs that rise to one peak and fall away: a single swing high at `peak`. */
function oneSwingHigh(base: number, peak: number) {
  return makeCandles(
    [base, base + 0.5, base + 1, peak, base + 1, base + 0.5, base].map((high) => ({
      close: base - 1,
      high,
      low: base - 2,
    })),
  );
}

/** No swing high at all: every candle identical. */
const FLAT = makeCandles(Array.from({ length: 7 }, () => ({ close: 50, high: 51, low: 49 })));

describe("calculateTakeProfits — an ascending ladder", () => {
  // The LTC/USDT 1h levels, as stored.
  const LTC_ENTRY = entryZone(58.6, 58.86);
  const LTC_STOP = { price: 56.4592687 } as StopLoss;
  const LTC_READ = read([zone(59.09, 59.3)]);
  const LTC_CANDLES = oneSwingHigh(60, 71.76);

  it("does not put an R-multiple TP3 below a structural TP2 (LTC/USDT 1h)", () => {
    const targets = calculateTakeProfits(LTC_READ, LTC_ENTRY, LTC_STOP, LTC_CANDLES);

    expect(targets.map((t) => [t.label, t.kind, Number(t.level.toFixed(2))])).toEqual([
      ["TP1", "STRUCTURAL", 59.09],
      ["TP2", "STRUCTURAL", 71.76],
    ]);
    // 1.5R, 2.5R and 4R all sit under the 5.7R structural target, so there is
    // no honest third target — the ladder stops short instead of reading down.
    expect(validateSetupLevels(LTC_ENTRY, LTC_STOP, targets)).toEqual({ ok: true });
  });

  it("measures the LTC ratio to the structural TP2 it was always meant to use", () => {
    const targets = calculateTakeProfits(LTC_READ, LTC_ENTRY, LTC_STOP, LTC_CANDLES);
    const rr = calculateRiskReward(LTC_ENTRY, LTC_STOP, targets)!;

    expect(rr.measuredTo).toBe("TP2");
    expect(rr.isSynthetic).toBe(false);
    expect(rr.ratio).toBeCloseTo((71.76 - 58.73) / (58.73 - 56.4592687), 6);
  });

  it("moves an R-multiple up the ladder rather than under a far structural TP1", () => {
    // One resistance at 3R, nothing else. The slot's own multiple (2.5R) would
    // sit below it; the next one (4R) does not.
    const entry = entryZone(99, 101);
    const stop = { price: 90 } as StopLoss; // risk 10
    const targets = calculateTakeProfits(read([zone(130, 131)]), entry, stop, FLAT);

    expect(targets.map((t) => [t.label, t.kind, t.level])).toEqual([
      ["TP1", "STRUCTURAL", 130],
      ["TP2", "R_MULTIPLE", 140],
    ]);
  });

  it("leaves an already-ascending ladder exactly as it was", () => {
    const entry = entryZone(99, 101);
    const stop = { price: 90 } as StopLoss;
    const targets = calculateTakeProfits(read([zone(112, 113)]), entry, stop, FLAT);

    expect(targets.map((t) => [t.label, t.kind, t.level])).toEqual([
      ["TP1", "STRUCTURAL", 112],
      ["TP2", "R_MULTIPLE", 125],
      ["TP3", "R_MULTIPLE", 140],
    ]);
  });

  it("does not offer a resistance edge inside the entry zone as a target", () => {
    // Zones are widened to a minimum width, so a resistance zone's near edge
    // can land in the upper half of the zone being bought. Above the middle is
    // not enough: a target has to clear the whole zone.
    const entry = entryZone(95, 105);
    const stop = { price: 90 } as StopLoss; // risk 10
    const targets = calculateTakeProfits(read([zone(103, 104)]), entry, stop, FLAT);

    expect(targets[0].kind).toBe("R_MULTIPLE");
    expect(targets[0].level).toBeGreaterThan(entry.high);
    expect(validateSetupLevels(entry, stop, targets)).toEqual({ ok: true });
  });
});

describe("calculateTakeProfits — the shape of the ladder", () => {
  const entry = entryZone(99, 101); // mid 100
  const stop = { price: 90 } as StopLoss; // risk 10

  it("keeps a fully structural ladder in ascending order, every target from the chart", () => {
    const targets = calculateTakeProfits(
      read([zone(125, 126), zone(112, 113)]),
      entry,
      stop,
      oneSwingHigh(100, 140),
    );

    expect(targets.map((t) => [t.label, t.kind, t.level])).toEqual([
      ["TP1", "STRUCTURAL", 112],
      ["TP2", "STRUCTURAL", 125],
      ["TP3", "STRUCTURAL", 140],
    ]);
  });

  it("excludes a resistance edge exactly on the entry zone's ceiling", () => {
    const targets = calculateTakeProfits(read([zone(101, 102)]), entry, stop, FLAT);
    expect(targets.every((t) => t.kind === "R_MULTIPLE")).toBe(true);
  });

  it("admits a resistance edge just above the ceiling", () => {
    const targets = calculateTakeProfits(read([zone(101.01, 102)]), entry, stop, FLAT);
    expect(targets[0]).toMatchObject({ kind: "STRUCTURAL", level: 101.01 });
  });

  it("excludes a prior swing high exactly on the ceiling", () => {
    const targets = calculateTakeProfits(read([]), entry, stop, oneSwingHigh(95, 101));
    expect(targets.every((t) => t.kind === "R_MULTIPLE")).toBe(true);
  });

  it("returns no targets when there is no risk to measure them in", () => {
    expect(calculateTakeProfits(read([]), entry, { price: 100 } as StopLoss, FLAT)).toEqual([]);
    expect(calculateTakeProfits(read([]), entry, { price: 105 } as StopLoss, FLAT)).toEqual([]);
  });

  it("offers one target, not an invented ladder, when a lone structure sits past every multiple", () => {
    // 4.5R: above 1.5R, 2.5R and 4R alike. A single honest target beats a
    // ladder that reads downwards.
    const targets = calculateTakeProfits(read([zone(145, 146)]), entry, stop, FLAT);
    expect(targets.map((t) => [t.label, t.kind, t.level])).toEqual([["TP1", "STRUCTURAL", 145]]);

    const rr = calculateRiskReward(entry, stop, targets)!;
    expect(rr).toMatchObject({ measuredTo: "TP1", isSynthetic: false });
    expect(rr.ratio).toBeCloseTo(4.5);
  });

  it("is ascending and above the entry zone for every input — a seeded sweep", () => {
    // mulberry32: exact 32-bit integer arithmetic, so a failure reproduces.
    let seed = 20261020;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let i = 0; i < 3000; i += 1) {
      const low = 10 + rand() * 90;
      const high = low + rand() * 5;
      const e = entryZone(low, high);
      const s = { price: low - 0.01 - rand() * 10 } as StopLoss;
      const zones = Array.from({ length: Math.floor(rand() * 4) }, () => {
        const zLow = low - 5 + rand() * 80;
        return zone(zLow, zLow + rand() * 3);
      }).sort((a, b) => a.low - b.low);
      const candles = rand() < 0.5 ? FLAT : oneSwingHigh(low, low + rand() * 120);

      const targets = calculateTakeProfits(read(zones), e, s, candles);
      if (targets.length === 0) continue;

      expect(validateSetupLevels(e, s, targets), `case ${i}`).toEqual({ ok: true });
      expect(
        targets.map((t) => t.label),
        `case ${i}`,
      ).toEqual(["TP1", "TP2", "TP3"].slice(0, targets.length));
    }
  });
});
