import { describe, expect, it } from "vitest";

import {
  buildResearchReport,
  engineFunnel,
  humanDecisions,
  toMetricRow,
  type ResearchEntry,
  type ResearchSetup,
} from "./aggregate";

/**
 * Research answers two separate questions — what the engine did, and what the
 * person did — and most of these tests exist to keep them separate. A single
 * blended number would describe neither.
 */

const setup = (over: Partial<ResearchSetup> = {}): ResearchSetup => ({
  id: "s1",
  symbol: "BTCUSDT",
  timeframe: "H4",
  lifecycleStatus: "SETUP_FORMING",
  score: 70,
  riskReward: 2,
  riskRewardIsSynthetic: false,
  confirmationStatus: "CONFIRMED",
  regimeDirection: "TRENDING_UP",
  regimeVolatility: "NORMAL",
  createdAt: 1_000,
  everConfirmed: false,
  everPotentialSetup: false,
  ...over,
});

const entry = (over: Partial<ResearchEntry> = {}): ResearchEntry => ({
  setupId: "s1",
  decision: "WATCHING",
  statusAtDecision: "CONFIRMATION_DETECTED",
  skipReason: null,
  decidedAt: 2_000,
  actualEntry: null,
  actualStopLoss: null,
  actualExit: null,
  quantity: null,
  fees: null,
  slippage: null,
  openedAt: null,
  closedAt: null,
  ...over,
});

describe("engineFunnel", () => {
  it("counts states a setup ever reached, not where it ended", () => {
    // A setup that confirmed and was then invalidated did both. Reading the
    // current status alone would erase the confirmation that happened.
    const funnel = engineFunnel([
      setup({ id: "a", everConfirmed: true, lifecycleStatus: "INVALIDATED" }),
      setup({ id: "b", everConfirmed: true, everPotentialSetup: true }),
      setup({ id: "c" }),
    ]);

    expect(funnel.setupsDetected).toBe(3);
    expect(funnel.reachedConfirmation).toBe(2);
    expect(funnel.reachedPotentialSetup).toBe(1);
    expect(funnel.invalidated).toBe(1);
    expect(funnel.stillOpen).toBe(2);
    expect(funnel.invalidationRate).toBeCloseTo(33.33, 1);
  });

  it("reports zeroes for an empty sample rather than NaN", () => {
    const funnel = engineFunnel([]);

    expect(funnel.invalidationRate).toBe(0);
    expect(funnel.potentialSetupRate).toBe(0);
  });
});

describe("humanDecisions", () => {
  it("counts each decision separately", () => {
    const human = humanDecisions([
      entry({ decision: "WATCHING" }),
      entry({ decision: "SKIPPED" }),
      entry({ decision: "SKIPPED" }),
      entry({ decision: "TAKEN" }),
      entry({ decision: "CLOSED" }),
      entry({ decision: "CANCELLED" }),
    ]);

    expect(human.journaled).toBe(6);
    expect(human.skipped).toBe(2);
    expect(human.taken).toBe(1);
    expect(human.closed).toBe(1);
    // Acted on = entered a position, whether or not it has finished.
    expect(human.actedOnRate).toBeCloseTo(33.33, 1);
  });

  it("groups skip reasons, commonest first", () => {
    const human = humanDecisions([
      entry({ decision: "SKIPPED", skipReason: "LOW_CONFIDENCE" }),
      entry({ decision: "SKIPPED", skipReason: "POOR_RR" }),
      entry({ decision: "SKIPPED", skipReason: "LOW_CONFIDENCE" }),
      entry({ decision: "SKIPPED" }),
      // Not a skip: must not appear.
      entry({ decision: "TAKEN", skipReason: "LOW_CONFIDENCE" }),
    ]);

    expect(human.skipReasons).toEqual([
      { reason: "LOW_CONFIDENCE", count: 2 },
      { reason: "POOR_RR", count: 1 },
      { reason: "UNSPECIFIED", count: 1 },
    ]);
  });
});

describe("toMetricRow", () => {
  it("measures R against the price the user actually paid", () => {
    // The setup planned an entry; the trade got a different one. Using the
    // plan would credit the engine for the user's fill.
    const row = toMetricRow(
      entry({
        decision: "CLOSED",
        actualEntry: 100,
        actualStopLoss: 90,
        actualExit: 120,
        quantity: 1,
      }),
      setup(),
    );

    expect(row!.entry).toBe(100);
    expect(row!.realizedRR).toBeCloseTo(2);
  });

  it("keeps what nobody recorded as null rather than zero", () => {
    const row = toMetricRow(
      entry({ actualEntry: 100, actualStopLoss: 90, actualExit: 110, quantity: 1 }),
      setup(),
    );

    // Excursion was never written down; zero would read as "never moved against
    // me", which is a claim nobody made.
    expect(row!.maxFavourableR).toBeNull();
    expect(row!.maxAdverseR).toBeNull();
    expect(row!.barsHeld).toBeNull();
  });

  it("groups by what was visible at the decision, not what came later", () => {
    // The setup went on to confirm. At the moment the person entered it had
    // not, and that is the column the trade belongs in.
    const row = toMetricRow(
      entry({
        statusAtDecision: "WAITING_CONFIRMATION",
        actualEntry: 100,
        actualStopLoss: 90,
        quantity: 1,
      }),
      setup({ everConfirmed: true, confirmationStatus: "PRESENT" }),
    );

    expect(row!.confirmationStatus).toBe("NOT_PRESENT");
  });

  it("carries the engine's own attributes across for grouping", () => {
    const row = toMetricRow(
      entry({ actualEntry: 100, actualStopLoss: 90, quantity: 1 }),
      setup({ score: 55, riskRewardIsSynthetic: true, regimeVolatility: "HIGH" }),
    );

    expect(row!.setupScore).toBe(55);
    expect(row!.entryRiskRewardIsSynthetic).toBe(true);
    expect(row!.regimeVolatility).toBe("HIGH");
  });

  it("produces nothing from an entry with no trade recorded", () => {
    expect(toMetricRow(entry(), setup())).toBeNull();
  });
});

describe("buildResearchReport", () => {
  const filters = {};

  it("counts R only from closed positions", () => {
    const report = buildResearchReport({
      setups: [setup({ id: "s1" }), setup({ id: "s2" })],
      entries: [
        entry({
          setupId: "s1",
          decision: "CLOSED",
          actualEntry: 100,
          actualStopLoss: 90,
          actualExit: 120,
          quantity: 1,
        }),
        // Open: no result yet, so it must not reach the metrics.
        entry({
          setupId: "s2",
          decision: "TAKEN",
          actualEntry: 100,
          actualStopLoss: 90,
          quantity: 1,
        }),
      ],
      filters,
    });

    expect(report.outcomes.totalSetups).toBe(1);
    expect(report.outcomes.averageR).toBeCloseTo(2);
    // But the human counts see both.
    expect(report.human.journaled).toBe(2);
    expect(report.human.taken).toBe(1);
  });

  it("keeps engine performance and decision performance apart", () => {
    // Six setups, one acted on and lost. The engine funnel must not inherit
    // that loss, and the trade result must not inherit the engine's count.
    const setups = Array.from({ length: 6 }, (_, i) =>
      setup({ id: `s${i}`, everPotentialSetup: true }),
    );

    const report = buildResearchReport({
      setups,
      entries: [
        entry({
          setupId: "s0",
          decision: "CLOSED",
          actualEntry: 100,
          actualStopLoss: 90,
          actualExit: 90,
          quantity: 1,
        }),
      ],
      filters,
    });

    expect(report.engine.setupsDetected).toBe(6);
    expect(report.engine.potentialSetupRate).toBe(100);
    expect(report.human.journaled).toBe(1);
    expect(report.outcomes.totalSetups).toBe(1);
    expect(report.outcomes.averageR).toBeCloseTo(-1);
  });

  it("flags a sample too small to read anything into", () => {
    const report = buildResearchReport({
      setups: [setup()],
      entries: [
        entry({
          decision: "CLOSED",
          actualEntry: 100,
          actualStopLoss: 90,
          actualExit: 120,
          quantity: 1,
        }),
      ],
      filters,
    });

    expect(report.smallSample).toBe(true);
  });

  it("ignores a journal entry whose setup is outside the filtered sample", () => {
    const report = buildResearchReport({
      setups: [setup({ id: "s1" })],
      entries: [
        entry({
          setupId: "missing",
          decision: "CLOSED",
          actualEntry: 100,
          actualStopLoss: 90,
          actualExit: 120,
          quantity: 1,
        }),
      ],
      filters,
    });

    expect(report.outcomes.totalSetups).toBe(0);
  });

  it("echoes the filters back so a result can be reproduced", () => {
    const used = { symbol: "ETHUSDT", minScore: 60 };
    const report = buildResearchReport({ setups: [], entries: [], filters: used });

    expect(report.filters).toEqual(used);
  });

  it("is deterministic", () => {
    const input = {
      setups: [setup({ id: "s1" })],
      entries: [
        entry({
          decision: "CLOSED",
          actualEntry: 100,
          actualStopLoss: 90,
          actualExit: 120,
          quantity: 1,
        }),
      ],
      filters,
    };

    expect(JSON.stringify(buildResearchReport(input))).toBe(
      JSON.stringify(buildResearchReport(input)),
    );
  });
});
