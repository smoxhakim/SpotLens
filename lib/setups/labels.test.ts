import { describe, expect, it } from "vitest";

import {
  confirmationCaveat,
  LIFECYCLE_LABELS,
  lifecycleLabel,
  storedLevelsWarning,
} from "./labels";

/**
 * Confirmation evidence is worded as evidence, and never stands alone where it
 * could be read as approval.
 */
describe("lifecycle labels", () => {
  it("calls confirmation evidence, never 'detected'", () => {
    expect(LIFECYCLE_LABELS.CONFIRMATION_DETECTED).toBe("Confirmation evidence present");
    for (const label of Object.values(LIFECYCLE_LABELS)) {
      expect(label.toLowerCase()).not.toContain("detected");
    }
  });

  it("turns an unknown value into words rather than an enum", () => {
    expect(lifecycleLabel("CONFIRMATION_DETECTED")).toBe("Confirmation evidence present");
    expect(lifecycleLabel("SOMETHING_NEW")).toBe("something new");
  });
});

describe("confirmationCaveat", () => {
  it("names the high-risk verdict, which confirmation cannot change", () => {
    expect(confirmationCaveat("HIGH_RISK")).toMatch(/still rates this setup high risk/);
    expect(confirmationCaveat("HIGH_RISK")).toMatch(/confirmation cannot change that/);
  });

  it("says when a stored verdict was given rather than presenting it as current", () => {
    const stored = confirmationCaveat("HIGH_RISK", { asOf: "creation" })!;
    expect(stored).toMatch(/when it was first tracked/);
    expect(stored).not.toMatch(/still/);
  });

  it("says evidence is not approval on every verdict short of a potential setup", () => {
    for (const status of ["HIGH_RISK", "WAIT_FOR_CONFIRMATION", "AVOID"]) {
      expect(confirmationCaveat(status)).toMatch(/^Evidence is not approval/);
    }
  });

  it("adds nothing once every rule holds, or when the verdict is unknown", () => {
    expect(confirmationCaveat("POTENTIAL_SETUP")).toBeNull();
    expect(confirmationCaveat(null)).toBeNull();
  });

  it("never instructs a trade", () => {
    for (const status of ["HIGH_RISK", "WAIT_FOR_CONFIRMATION", "AVOID"]) {
      for (const asOf of ["current", "creation"] as const) {
        expect(confirmationCaveat(status, { asOf })!.toLowerCase()).not.toMatch(/\bbuy\b/);
      }
    }
  });
});

describe("storedLevelsWarning — legacy rows, flagged and never rewritten", () => {
  // LTC/USDT 1h, as stored on the local database.
  const LTC = {
    entryLow: 58.6,
    entryHigh: 58.86,
    stopLoss: 56.4592687,
    takeProfit1: 59.09,
    takeProfit2: 71.76,
    takeProfit3: 67.8129,
  };

  it("flags a stored ladder whose TP3 sits below TP2", () => {
    expect(storedLevelsWarning(LTC)).toMatch(/^TP3 sits below TP2/);
    expect(storedLevelsWarning(LTC)).toMatch(/kept exactly as recorded/);
  });

  it("says nothing about a stored ladder in order, including a short one", () => {
    expect(storedLevelsWarning({ ...LTC, takeProfit3: 75 })).toBeNull();
    expect(storedLevelsWarning({ ...LTC, takeProfit3: null })).toBeNull();
  });

  it("flags a stored TP1 inside the entry zone", () => {
    expect(storedLevelsWarning({ ...LTC, takeProfit1: 58.7 })).toMatch(/TP1 is not above/);
  });

  it("does not change the levels it reads", () => {
    const copy = { ...LTC };
    storedLevelsWarning(copy);
    expect(copy).toEqual(LTC);
  });
});
