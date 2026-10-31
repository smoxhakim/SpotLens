import { describe, expect, it } from "vitest";

import { calculateRisk } from "@/lib/risk";

import { plannedLossAtStop, reviewTrade, type TrialTradeInput } from "./trades";

const HOUR = 60 * 60_000;
const at = (h: number, m = 0, s = 0) => Date.UTC(2026, 9, 31, h, m, s);
const FILL = at(10);

/**
 * A trade that keeps every trial rule. A 4h setup, Potential since it was first
 * tracked at 08:02 from the 04:00 candle, planned at 100–102 with a stop at 97
 * and a primary target of 110. Filled at 101.5 at 10:00 with 0.19 units against
 * a stop at 96.5 — 0.988 USDT lost at the stop with estimated fees — and
 * recorded as Taken five minutes after the fill. Every case changes one thing.
 */
const compliant = (overrides: Partial<TrialTradeInput> = {}): TrialTradeInput => ({
  entryId: "e1",
  symbol: "AAAUSDT",
  timeframe: "H4",
  decision: "CLOSED",
  statusAtDecision: "POTENTIAL_SETUP",
  decidedAt: FILL + 5 * 60_000,
  takenRecordedAt: FILL + 5 * 60_000,
  skipReason: null,
  lateEntry: false,
  plan: {
    entryLow: 100,
    entryHigh: 102,
    stopLoss: 97,
    measuredTarget: 110,
    measuredTargetLabel: "TP2",
    riskReward: 2.6,
    riskRewardIsSynthetic: false,
  },
  history: {
    createdAt: at(8, 2),
    events: [{ toStatus: "POTENTIAL_SETUP", at: at(8, 2) }],
    reads: [{ analysedAtCandle: at(4), availableAt: at(8, 2) }],
  },
  actualEntry: 101.5,
  actualStopLoss: 96.5,
  actualTakeProfit: 110,
  actualExit: 110,
  quantity: 0.19,
  fees: 0.04,
  slippage: null,
  exitReason: "TAKE_PROFIT",
  openedAt: FILL,
  closedAt: FILL + 6 * HOUR,
  ...overrides,
});

const codes = (input: TrialTradeInput) => reviewTrade(input).flags.map((f) => f.code);
const rules = (input: TrialTradeInput) => reviewTrade(input).rules;

const ALL_OK = {
  potentialAndOpen: "ok",
  fresh: "ok",
  withinBudget: "ok",
  primaryTarget: "ok",
  takenAfterFill: "ok",
  exitNotOnInvalidation: "ok",
} as const;

describe("reviewTrade: a compliant trade", () => {
  it("raises no flag, and takes R from the journal's own definition", () => {
    const review = reviewTrade(compliant());
    expect(review.flags).toEqual([]);
    expect(review.rules).toEqual(ALL_OK);
    expect(review.atFill).toEqual({ tracked: true, status: "POTENTIAL_SETUP", freshness: "FRESH" });
    // Risk 5 × 0.19 = 0.95; net (110 − 101.5) × 0.19 − 0.04 = 1.575.
    expect(review.outcome?.riskAmount).toBeCloseTo(0.95);
    expect(review.outcome?.netPnl).toBeCloseTo(1.575);
    expect(review.outcome?.realizedR).toBeCloseTo(1.575 / 0.95);
    expect(review.positionUsdt).toBeCloseTo(19.285);
    expect(review.plannedLossUsdt).toBeCloseTo(0.19 * (5 + 198 * 0.001));
  });
});

describe("the budget: 1 USDT including estimated fees", () => {
  it("estimates the loss at the stop exactly as the risk calculator does", () => {
    const calc = calculateRisk({ balance: 100, riskPercent: 1, entry: 101.5, stopLoss: 96.5 });
    if (!calc.ok) throw new Error("calculator refused valid input");
    expect(
      plannedLossAtStop({
        entry: 101.5,
        stopLoss: 96.5,
        quantity: calc.calculation.quantity,
        feeRate: 0.001,
      }),
    ).toBeCloseTo(calc.calculation.estimatedNetLoss, 12);
  });

  it("flags the calculator's 1% size, because with fees it loses more than 1 USDT", () => {
    // 0.2 units: 1.00 of risk plus 0.04 of estimated fees.
    const review = reviewTrade(compliant({ quantity: 0.2 }));
    expect(review.plannedLossUsdt).toBeCloseTo(1.0396);
    expect(review.flags.map((f) => f.code)).toEqual(["RISK_OVER_BUDGET"]);
  });

  it("does not flag exactly 1 USDT, however the floating point lands", () => {
    // 0.3 − 0.1 is 0.19999999999999998 in floating point.
    const review = reviewTrade(
      compliant({
        actualEntry: 0.3,
        actualStopLoss: 0.1,
        quantity: 5 / (1 + 0.4 * 0.001 * 5),
        actualTakeProfit: null,
        actualExit: null,
        decision: "TAKEN",
        exitReason: null,
        plan: null,
        history: null,
      }),
    );
    expect(review.plannedLossUsdt).toBeCloseTo(1, 12);
    expect(review.flags.map((f) => f.code)).not.toContain("RISK_OVER_BUDGET");
  });

  it("flags a stop-out whose net loss went past 1 USDT — fees or a fill below the stop", () => {
    // (96.2 − 101.5) × 0.19 = −1.007, then 0.04 of fees.
    expect(codes(compliant({ actualExit: 96.2, exitReason: "STOP_LOSS" }))).toEqual([
      "LOSS_OVER_BUDGET",
    ]);
  });

  it("flags a position larger than the 100 USDT trial capital", () => {
    expect(codes(compliant({ actualStopLoss: 101, quantity: 1, actualTakeProfit: 110 }))).toEqual([
      "POSITION_OVER_CAPITAL",
    ]);
  });
});

describe("partial fills, missing exits and missing records", () => {
  it("measures a partial fill on the quantity that filled, without a false flag", () => {
    const review = reviewTrade(compliant({ quantity: 0.095, fees: 0.02 }));
    expect(review.flags).toEqual([]);
    expect(review.outcome?.riskAmount).toBeCloseTo(0.475);
    expect(review.outcome?.realizedR).toBeCloseTo((8.5 * 0.095 - 0.02) / 0.475);
  });

  it("leaves an open trade with no exit without a result, and does not call it a breach", () => {
    const review = reviewTrade(
      compliant({ decision: "TAKEN", actualExit: null, exitReason: null, closedAt: null }),
    );
    expect(review.outcome?.netPnl).toBeNull();
    expect(review.outcome?.realizedR).toBeNull();
    expect(review.flags).toEqual([]);
    // No exit yet, so the exit rule is unknown — not passed.
    expect(review.rules).toEqual({ ...ALL_OK, exitNotOnInvalidation: "unknown" });
  });

  it("flags a closed trade with no exit price", () => {
    expect(codes(compliant({ actualExit: null }))).toEqual(["NO_EXIT_RECORDED"]);
  });

  it("names what is missing, and checks nothing it cannot", () => {
    expect(codes(compliant({ actualEntry: null }))).toEqual(["NO_FILL_RECORDED"]);
    expect(codes(compliant({ actualStopLoss: null }))).toEqual(["NO_STOP_RECORDED"]);
    expect(codes(compliant({ actualTakeProfit: null }))).toEqual(["NO_TARGET_RECORDED"]);
    const noTime = reviewTrade(compliant({ openedAt: null }));
    expect(noTime.atFill).toBeNull();
    expect(noTime.flags.map((f) => f.code)).toEqual(["NO_FILL_TIME"]);
  });
});

describe("only Potential setups that are still open and fresh", () => {
  it("flags a fill while the setup was waiting for confirmation", () => {
    const review = reviewTrade(
      compliant({
        history: {
          ...compliant().history!,
          events: [
            { toStatus: "POTENTIAL_SETUP", at: at(8, 2) },
            { toStatus: "WAITING_CONFIRMATION", at: at(9, 30) },
          ],
        },
      }),
    );
    expect(review.flags.map((f) => f.code)).toEqual(["NOT_POTENTIAL_AT_FILL"]);
    expect(review.flags[0].message).toContain("waiting confirmation");
  });

  it("reads the state at the fill, not the state frozen when the entry was first journaled", () => {
    // Watched at 08:30 while still forming; Potential by the 10:00 fill.
    const review = reviewTrade(
      compliant({
        statusAtDecision: "SETUP_FORMING",
        decidedAt: at(8, 30),
        history: {
          ...compliant().history!,
          events: [
            { toStatus: "SETUP_FORMING", at: at(8, 2) },
            { toStatus: "POTENTIAL_SETUP", at: at(9, 45) },
          ],
        },
      }),
    );
    expect(review.flags).toEqual([]);
  });

  it("flags a fill after the setup closed, and one before SpotLens tracked it", () => {
    const closed = compliant({
      history: {
        ...compliant().history!,
        events: [
          { toStatus: "POTENTIAL_SETUP", at: at(8, 2) },
          { toStatus: "INVALIDATED", at: at(9, 30) },
        ],
      },
    });
    expect(codes(closed)).toEqual(["SETUP_CLOSED_AT_FILL"]);

    const early = reviewTrade(compliant({ openedAt: at(7), takenRecordedAt: at(10) }));
    expect(early.flags.map((f) => f.code)).toEqual([
      "NOT_POTENTIAL_AT_FILL",
      "FRESHNESS_UNKNOWN_AT_FILL",
    ]);
    expect(early.flags[0].message).toContain("not tracking this setup yet");
    expect(early.rules).toMatchObject({ potentialAndOpen: "NO", fresh: "unknown" });
  });

  it("flags a fill on an out-of-date analysis, and clears it when a pass had re-read it", () => {
    const late = { openedAt: at(14), takenRecordedAt: at(14, 5), closedAt: at(20) };
    expect(codes(compliant(late))).toEqual(["NOT_FRESH_AT_FILL"]);
    expect(rules(compliant(late)).fresh).toBe("NO");

    const reread = {
      ...compliant().history!,
      reads: [...compliant().history!.reads, { analysedAtCandle: at(8), availableAt: at(12, 2) }],
    };
    expect(codes(compliant({ ...late, history: reread }))).toEqual([]);
    expect(rules(compliant({ ...late, history: reread }))).toEqual(ALL_OK);
  });

  it("flags an entry with no tracked setup, and claims nothing about its state", () => {
    const review = reviewTrade(compliant({ plan: null, history: null }));
    expect(review.atFill).toBeNull();
    expect(review.flags.map((f) => f.code)).toEqual(["NO_TRACKED_SETUP"]);
    // Not an open Potential setup; and with no setup history, freshness is unknown, not failed.
    expect(review.rules).toMatchObject({
      potentialAndOpen: "NO",
      fresh: "unknown",
      primaryTarget: "unknown",
    });
  });
});

describe("the workflow", () => {
  it("flags a take-profit away from the primary target, but not tick rounding", () => {
    expect(codes(compliant({ actualTakeProfit: 112, actualExit: 112 }))).toEqual([
      "TARGET_NOT_PRIMARY",
    ]);
    expect(codes(compliant({ actualTakeProfit: 110.2, actualExit: 110.2 }))).toEqual([]);
  });

  it("flags Taken recorded before the fill, and calls one within a minute of it unknown", () => {
    expect(codes(compliant({ takenRecordedAt: FILL - HOUR }))).toEqual(["TAKEN_BEFORE_FILL"]);
    expect(rules(compliant({ takenRecordedAt: FILL - HOUR })).takenAfterFill).toBe("NO");
    for (const takenRecordedAt of [FILL - 30_000, FILL, FILL + 30_000]) {
      expect(codes(compliant({ takenRecordedAt }))).toEqual(["TAKEN_AMBIGUOUS"]);
      expect(rules(compliant({ takenRecordedAt })).takenAfterFill).toBe("unknown");
    }
    expect(rules(compliant({ takenRecordedAt: FILL + 60_000 })).takenAfterFill).toBe("ok");
  });

  it("flags an exit on invalidation as a rule breach only: the exit and its result stand as recorded", () => {
    const onInvalidation = reviewTrade(compliant({ exitReason: "INVALIDATED", actualExit: 103 }));
    expect(onInvalidation.flags.map((f) => f.code)).toEqual(["EXITED_ON_INVALIDATION"]);
    expect(onInvalidation.rules).toEqual({ ...ALL_OK, exitNotOnInvalidation: "NO" });
    expect(onInvalidation.exitReason).toBe("INVALIDATED");
    expect(onInvalidation.flags[0].message).toContain("does not by itself require closing a trade");

    // The same exit for any other reason is worth exactly the same.
    const byTarget = reviewTrade(compliant({ exitReason: "TAKE_PROFIT", actualExit: 103 }));
    expect(onInvalidation.outcome).toEqual(byTarget.outcome);
    expect(onInvalidation.outcome?.netPnl).toBeCloseTo((103 - 101.5) * 0.19 - 0.04);
  });

  it("does not ask for an exit when the setup is invalidated after the fill", () => {
    // Invalidated at 13:00 with the position open; the take-profit filled at 16:00.
    const history = {
      ...compliant().history!,
      events: [
        { toStatus: "POTENTIAL_SETUP", at: at(8, 2) },
        { toStatus: "INVALIDATED", at: at(13) },
      ],
    };
    expect(codes(compliant({ history }))).toEqual([]);
    expect(rules(compliant({ history }))).toEqual(ALL_OK);
    // Held open through the invalidation: nothing to flag either.
    const open = compliant({
      history,
      decision: "TAKEN",
      actualExit: null,
      exitReason: null,
      closedAt: null,
    });
    expect(codes(open)).toEqual([]);
  });

  it("flags a late entry", () => {
    expect(codes(compliant({ lateEntry: true }))).toEqual(["LATE_ENTRY"]);
  });
});

describe("plan against fill", () => {
  it("places the fill against the zone and its top, where the calculator sized from", () => {
    const vs = (actualEntry: number) => reviewTrade(compliant({ actualEntry })).vsPlan;
    expect(vs(99).entryVsZone).toBe("BELOW_ZONE");
    expect(vs(101.5).entryVsZone).toBe("IN_ZONE");
    expect(vs(102).entryVsZone).toBe("IN_ZONE");
    expect(vs(103).entryVsZone).toBe("ABOVE_ZONE");
    expect(vs(101.5).entryVsZoneTopPct).toBeCloseTo(((101.5 - 102) / 102) * 100);
  });

  it("measures a stop fill against the stop that was set, and only on a stop-out", () => {
    const stopped = reviewTrade(compliant({ actualExit: 96.2, exitReason: "STOP_LOSS" })).vsPlan;
    expect(stopped.stopFillPct).toBeCloseTo(((96.2 - 96.5) / 96.5) * 100);
    expect(stopped.targetFillPct).toBeNull();

    const won = reviewTrade(compliant({ actualExit: 110.2 })).vsPlan;
    expect(won.targetFillPct).toBeCloseTo(((110.2 - 110) / 110) * 100);
    expect(won.stopFillPct).toBeNull();
  });

  it("measures nothing against a stop that was not recorded — never the plan's stop", () => {
    const noStop = { actualStopLoss: null };

    const stopped = reviewTrade(
      compliant({ ...noStop, actualExit: 96.9, exitReason: "STOP_LOSS" }),
    );
    expect(stopped.vsPlan.stopFillPct).toBeNull();
    expect(stopped.vsPlan.stopVsPlanPct).toBeNull();
    // The plan's stop is still there, as SpotLens's level rather than the Demo order.
    expect(stopped.plan?.stopLoss).toBe(97);

    // The recorded take-profit is measured as before.
    const won = reviewTrade(compliant({ ...noStop, actualExit: 110.2 }));
    expect(won.vsPlan.targetFillPct).toBeCloseTo(((110.2 - 110) / 110) * 100);
    expect(won.vsPlan.targetVsPlanPct).toBeCloseTo(0);
  });

  it("measures nothing against a take-profit that was not recorded — never the plan's target", () => {
    const noTarget = { actualTakeProfit: null };

    const won = reviewTrade(compliant({ ...noTarget, actualExit: 110.2 }));
    expect(won.vsPlan.targetFillPct).toBeNull();
    expect(won.vsPlan.targetVsPlanPct).toBeNull();
    // The plan's target is still there, as SpotLens's level rather than the Demo order.
    expect(won.plan?.measuredTarget).toBe(110);

    // The recorded stop is measured as before.
    const stopped = reviewTrade(
      compliant({ ...noTarget, actualExit: 96.2, exitReason: "STOP_LOSS" }),
    );
    expect(stopped.vsPlan.stopFillPct).toBeCloseTo(((96.2 - 96.5) / 96.5) * 100);
    expect(stopped.vsPlan.stopVsPlanPct).toBeCloseTo(((96.5 - 97) / 97) * 100);
  });

  it("compares nothing with a plan when there is none", () => {
    expect(reviewTrade(compliant({ plan: null, history: null })).vsPlan).toMatchObject({
      entryVsZone: null,
      entryVsZoneTopPct: null,
      stopVsPlanPct: null,
      targetVsPlanPct: null,
    });
  });
});

describe("missing or ambiguous records stay unknown, never ok", () => {
  it("judges only entry, stop, exit, quantity and fees when the form's fill time, take-profit, exit reason and close time are blank", () => {
    // Left blank on the form, or recorded before the form had these fields.
    const review = reviewTrade(
      compliant({ openedAt: null, actualTakeProfit: null, exitReason: null, closedAt: null }),
    );
    expect(review.rules).toEqual({
      potentialAndOpen: "unknown",
      fresh: "unknown",
      withinBudget: "ok",
      primaryTarget: "unknown",
      takenAfterFill: "unknown",
      exitNotOnInvalidation: "unknown",
    });
    expect(review.flags.map((f) => f.code)).toEqual([
      "NO_FILL_TIME",
      "NO_TARGET_RECORDED",
      "NO_EXIT_REASON",
    ]);
    // The result is still measured from what was recorded.
    expect(review.outcome?.realizedR).toBeCloseTo(1.575 / 0.95);
  });

  it("calls a status change within a minute of the fill time unknown, either way", () => {
    // Became Potential 40s after the typed fill time: the fill may have met either state.
    const becamePotential = {
      ...compliant().history!,
      events: [
        { toStatus: "WAITING_CONFIRMATION", at: at(8, 2) },
        { toStatus: "POTENTIAL_SETUP", at: at(10, 0, 40) },
      ],
    };
    expect(codes(compliant({ history: becamePotential }))).toEqual(["STATUS_AMBIGUOUS_AT_FILL"]);
    expect(rules(compliant({ history: becamePotential })).potentialAndOpen).toBe("unknown");

    // Invalidated 30s after it.
    const closedJustAfter = {
      ...compliant().history!,
      events: [
        { toStatus: "POTENTIAL_SETUP", at: at(8, 2) },
        { toStatus: "INVALIDATED", at: at(10, 0, 30) },
      ],
    };
    expect(rules(compliant({ history: closedJustAfter })).potentialAndOpen).toBe("unknown");
  });

  it("calls a status the event log does not hold unknown", () => {
    const noEvents = { ...compliant().history!, events: [] };
    expect(codes(compliant({ history: noEvents }))).toEqual(["SETUP_HISTORY_INCOMPLETE"]);
    expect(rules(compliant({ history: noEvents })).potentialAndOpen).toBe("unknown");
  });

  it("calls freshness unknown when it changed within a minute of the fill, or no read names its candle", () => {
    // The 04:00 analysis goes stale at 12:01:30; a fill typed 12:01 may have met either side.
    const nearStale = { openedAt: at(12, 1), takenRecordedAt: at(12, 10), closedAt: at(16) };
    expect(codes(compliant(nearStale))).toEqual(["FRESHNESS_AMBIGUOUS_AT_FILL"]);
    expect(rules(compliant(nearStale)).fresh).toBe("unknown");

    const unnamed = {
      ...compliant().history!,
      reads: [{ analysedAtCandle: null, availableAt: at(8, 2) }],
    };
    expect(codes(compliant({ history: unnamed }))).toEqual(["FRESHNESS_UNKNOWN_AT_FILL"]);
    expect(rules(compliant({ history: unnamed })).fresh).toBe("unknown");
  });

  it("calls Taken-after-fill unknown when the journal holds no Taken event", () => {
    expect(codes(compliant({ takenRecordedAt: null }))).toEqual(["NO_TAKEN_RECORD"]);
    expect(rules(compliant({ takenRecordedAt: null })).takenAfterFill).toBe("unknown");
  });

  it("calls the primary target unknown when the setup has none measured", () => {
    const plan = { ...compliant().plan!, measuredTarget: null, measuredTargetLabel: null };
    expect(codes(compliant({ plan }))).toEqual(["NO_PRIMARY_TARGET"]);
    expect(rules(compliant({ plan })).primaryTarget).toBe("unknown");
  });

  it("calls the budget unknown without a stop, but never ok over capital", () => {
    expect(rules(compliant({ actualStopLoss: null })).withinBudget).toBe("unknown");
    expect(rules(compliant({ actualStopLoss: null, quantity: 1 })).withinBudget).toBe("NO");
  });

  it("calls a closed trade's exit rule unknown without a reason, and a manual exit after invalidation unknown", () => {
    expect(codes(compliant({ exitReason: null }))).toEqual(["NO_EXIT_REASON"]);
    expect(rules(compliant({ exitReason: null })).exitNotOnInvalidation).toBe("unknown");

    const invalidatedAt13 = {
      ...compliant().history!,
      events: [
        { toStatus: "POTENTIAL_SETUP", at: at(8, 2) },
        { toStatus: "INVALIDATED", at: at(13) },
      ],
    };
    const manual = { exitReason: "MANUAL_EXIT", actualExit: 104, history: invalidatedAt13 };
    // Closed by hand at 16:00, after the 13:00 invalidation.
    expect(codes(compliant(manual))).toEqual(["EXIT_MAY_FOLLOW_INVALIDATION"]);
    expect(rules(compliant(manual)).exitNotOnInvalidation).toBe("unknown");
    // With no close time, the order of the two cannot be told.
    expect(rules(compliant({ ...manual, closedAt: null })).exitNotOnInvalidation).toBe("unknown");
    // Closed by hand at 12:00, before it: the invalidation cannot have driven it.
    expect(rules(compliant({ ...manual, closedAt: at(12) })).exitNotOnInvalidation).toBe("ok");
    // A setup never invalidated cannot have driven a manual exit.
    expect(rules(compliant({ exitReason: "MANUAL_EXIT", actualExit: 104 }))).toEqual(ALL_OK);
  });
});
