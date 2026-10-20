import { beforeEach, describe, expect, it, vi } from "vitest";

import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";

import type { PriceZone } from "../zones";
import { calculateRiskReward } from "./risk-reward";
import type { EntryZone, StopLoss, TakeProfitTarget } from "./types";

/**
 * A resistance edge inside the entry zone, and the next structure under 1R.
 *
 * The verdict here changed when targets started having to clear the whole
 * entry zone, and this pins what it changed to and why.
 *
 * Before: the in-zone edge was listed as TP1, which pushed the 0.8R structure
 * into the TP2 slot. With no structural target at 1R or more, the ratio falls
 * back to TP2 (`selectMeasuredTarget`) — so it measured 1:0.8 and the status
 * engine's ratio-below-1 rule returned AVOID.
 *
 * That AVOID was an artifact of the slot, not a rule. The rule that applies is
 * `MIN_MEANINGFUL_TARGET_R`: a structural target under 1R never stands in as
 * the measure ("does not let a structural target closer than 1R stand in as
 * the measure", risk-reward.test.ts), because 1:0.8 describes how close a level
 * is, not the opportunity. With the in-zone edge gone, the ladder is the 0.8R
 * structure then the 2.5R and 4R fallbacks, and the ratio is the 2.5R fallback
 * flagged `isSynthetic` — an unmeasured reward.
 *
 * An unmeasured reward cannot reach POTENTIAL_SETUP: the status engine holds it
 * at WAIT ("no resistance … far enough above the entry"), and the shortlist
 * refuses it (REWARD_NOT_MEASURED). Rules ahead of that one still apply: here,
 * the in-zone edge is still the nearest resistance, so price at or above it is
 * HIGH_RISK — the edge stops being a *target*, never a *resistance*.
 *
 * The real engine end to end. Only the resistance zones are replaced, and an
 * early spike puts the prior swing high beyond the 8R cap so that no structure
 * at 1R or more exists.
 */

const override = vi.hoisted(() => ({ resistance: null as PriceZone[] | null }));

vi.mock("../market-read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../market-read")>();
  return {
    ...actual,
    runMarketRead: (...args: Parameters<typeof actual.runMarketRead>) => {
      const read = actual.runMarketRead(...args);
      return override.resistance ? { ...read, resistance: override.resistance } : read;
    },
  };
});

const { runAnalysis } = await import("./index");

/** The textbook pullback, with a far swing high (well past 8R) twenty candles in. */
const CANDLES = pullbackIntoSupport().map((candle, i) =>
  i === 20 ? { ...candle, high: 400 } : candle,
);

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

// The levels the unmodified run produces, read once rather than hard-coded.
const BASELINE = runAnalysis(CANDLES);
const ENTRY = BASELINE.setup!.entry;
const STOP = BASELINE.setup!.stopLoss;
const RISK = ENTRY.mid - STOP.price;
const PRICE = BASELINE.read.price;
/** The structure under 1R. */
const NEAR = zone(ENTRY.mid + 0.8 * RISK, ENTRY.mid + 0.8 * RISK + 0.5);

beforeEach(() => {
  override.resistance = null;
});

describe("the fixture", () => {
  it("is a potential setup as it stands, with price inside the entry zone", () => {
    // So everything below is the resistance change and nothing else.
    expect(BASELINE.status).toBe("POTENTIAL_SETUP");
    expect(ENTRY.priceInZone).toBe(true);
    expect(PRICE).toBeGreaterThan(ENTRY.mid);
    expect(PRICE).toBeLessThan(ENTRY.high);
    expect(NEAR.low).toBeGreaterThan(ENTRY.high);
  });
});

describe("a resistance edge inside the entry zone, with the next structure under 1R", () => {
  // The edge sits in the upper half of the zone, above the current price.
  const inZone = () => zone((PRICE + ENTRY.high) / 2, ENTRY.high + 0.5);

  it("drops the in-zone edge as a target and lists the 0.8R structure as TP1", () => {
    override.resistance = [inZone(), NEAR];
    const result = runAnalysis(CANDLES);
    const targets = result.setup!.takeProfits;

    expect(targets.map((t) => [t.label, t.kind])).toEqual([
      ["TP1", "STRUCTURAL"],
      ["TP2", "R_MULTIPLE"],
      ["TP3", "R_MULTIPLE"],
    ]);
    expect(targets[0].level).toBeCloseTo(NEAR.low, 8);
    expect(targets[0].rr).toBeCloseTo(0.8, 6);
    expect(targets.every((t) => t.level > ENTRY.high)).toBe(true);
  });

  it("measures an unmeasured reward — the 2.5R fallback, flagged — not 1:0.8", () => {
    override.resistance = [inZone(), NEAR];
    const { riskReward } = runAnalysis(CANDLES).setup!;

    expect(riskReward.measuredTo).toBe("TP2");
    expect(riskReward.isSynthetic).toBe(true);
    expect(riskReward.ratio).toBeCloseTo(2.5, 6);
    expect(riskReward.reason).toMatch(/arithmetic rather than evidence/);
  });

  it("is WAIT for an unmeasured reward — not AVOID, and never POTENTIAL_SETUP", () => {
    override.resistance = [inZone(), NEAR];
    const result = runAnalysis(CANDLES);

    expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(result.statusReason).toMatch(/no resistance zone or prior high far enough above/);
    // Levels are shown: a WAIT carries them, and every one of them is valid.
    expect(result.setup).not.toBeNull();
  });

  it("would have been 1:0.8 — and AVOID — only because of the slot the in-zone edge took", () => {
    // What the old ladder measured, reconstructed: the edge as TP1, the 0.8R
    // structure as TP2, the 4R fallback as TP3. Recorded here so the reason
    // the verdict moved is checked, not just asserted in a comment.
    const old: TakeProfitTarget[] = [
      {
        label: "TP1",
        level: inZone().low,
        rr: (inZone().low - ENTRY.mid) / RISK,
        kind: "STRUCTURAL",
        reason: "",
      },
      { label: "TP2", level: NEAR.low, rr: 0.8, kind: "STRUCTURAL", reason: "" },
      { label: "TP3", level: ENTRY.mid + 4 * RISK, rr: 4, kind: "R_MULTIPLE", reason: "" },
    ];
    const rr = calculateRiskReward(ENTRY as EntryZone, STOP as StopLoss, old)!;
    expect(rr.ratio).toBeCloseTo(0.8, 6);
    expect(rr.ratio).toBeLessThan(1); // the status engine's AVOID line

    // The same 0.8R structure as TP1 of an otherwise-fallback ladder is the
    // documented case: unmeasured, never condemned for a level near it.
    const documented = calculateRiskReward(ENTRY as EntryZone, STOP as StopLoss, [
      { ...old[1], label: "TP1" },
      { label: "TP2", level: ENTRY.mid + 2.5 * RISK, rr: 2.5, kind: "R_MULTIPLE", reason: "" },
      { label: "TP3", level: ENTRY.mid + 4 * RISK, rr: 4, kind: "R_MULTIPLE", reason: "" },
    ])!;
    expect(documented).toMatchObject({ isSynthetic: true, measuredTo: "TP2" });
  });

  it("is HIGH_RISK when price already sits at the in-zone edge — it is still resistance", () => {
    override.resistance = [zone((ENTRY.mid + PRICE) / 2, ENTRY.high + 0.5), NEAR];
    const result = runAnalysis(CANDLES);

    expect(result.status).toBe("HIGH_RISK");
    expect(result.statusReason).toMatch(/already trading in the resistance zone/);
    expect(result.setup!.takeProfits[0].level).toBeCloseTo(NEAR.low, 8);
  });

  it("never reaches POTENTIAL_SETUP however the in-zone edge and the near structure are placed", () => {
    for (const fraction of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      for (const nearR of [0.3, 0.6, 0.9, 0.99]) {
        const edge = ENTRY.mid + (ENTRY.high - ENTRY.mid) * fraction;
        const near = ENTRY.mid + nearR * RISK;
        override.resistance = [zone(edge, ENTRY.high + 0.5), zone(near, near + 0.5)];

        const result = runAnalysis(CANDLES);
        expect(result.status, `${fraction} / ${nearR}`).not.toBe("POTENTIAL_SETUP");
        if (result.setup) {
          expect(result.setup.takeProfits.every((t) => t.level > ENTRY.high)).toBe(true);
          expect(result.setup.riskReward.isSynthetic).toBe(true);
        }
      }
    }
  });
});
