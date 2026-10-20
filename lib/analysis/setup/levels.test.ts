import { describe, expect, it } from "vitest";

import { validateTradeLevels } from "./levels";

/**
 * stop loss < entry low ≤ entry high < TP1 ≤ TP2 ≤ TP3 — or the set is refused.
 */

const VALID = { entryLow: 58.6, entryHigh: 58.86, stopLoss: 56.46, targets: [59.09, 71.76] };

describe("validateTradeLevels", () => {
  it("accepts a long ladder in order", () => {
    expect(validateTradeLevels(VALID)).toEqual({ ok: true });
    expect(validateTradeLevels({ ...VALID, targets: [60, 62, 64] })).toEqual({ ok: true });
  });

  it("refuses the stored LTC/USDT 1h ladder, whose TP3 sits below TP2", () => {
    const check = validateTradeLevels({ ...VALID, targets: [59.09, 71.76, 67.8129] });

    expect(check).toMatchObject({ ok: false, problem: "TARGETS_OUT_OF_ORDER" });
    expect(check.ok === false && check.reason).toMatch(/TP3 sits below TP2/);
  });

  it("refuses TP2 below TP1", () => {
    expect(validateTradeLevels({ ...VALID, targets: [62, 60] })).toMatchObject({
      ok: false,
      problem: "TARGETS_OUT_OF_ORDER",
    });
  });

  it("allows equal adjacent targets, which the order permits", () => {
    expect(validateTradeLevels({ ...VALID, targets: [60, 60, 61] })).toEqual({ ok: true });
  });

  it("refuses a TP1 at or inside the entry zone", () => {
    expect(validateTradeLevels({ ...VALID, targets: [58.86, 60] })).toMatchObject({
      ok: false,
      problem: "TARGET_NOT_ABOVE_ENTRY",
    });
    expect(validateTradeLevels({ ...VALID, targets: [58.7, 60] })).toMatchObject({
      ok: false,
      problem: "TARGET_NOT_ABOVE_ENTRY",
    });
  });

  it("refuses a stop at or above the entry floor", () => {
    expect(validateTradeLevels({ ...VALID, stopLoss: 58.6 })).toMatchObject({
      ok: false,
      problem: "STOP_NOT_BELOW_ENTRY",
    });
  });

  it("refuses an inverted entry zone", () => {
    expect(validateTradeLevels({ ...VALID, entryLow: 59, entryHigh: 58.9 })).toMatchObject({
      ok: false,
      problem: "ENTRY_ZONE_INVERTED",
    });
  });

  it("refuses an empty ladder and a non-finite level", () => {
    expect(validateTradeLevels({ ...VALID, targets: [] })).toMatchObject({
      ok: false,
      problem: "NO_TARGETS",
    });
    expect(validateTradeLevels({ ...VALID, targets: [60, Number.NaN] })).toMatchObject({
      ok: false,
      problem: "NOT_A_NUMBER",
    });
  });
});
