// @vitest-environment node
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toLocalInput } from "@/features/decision/components/LateEntryForm";
import { outcomeFormFrom, outcomeRequest, type OutcomeForm } from "@/features/journal/outcome-form";
import { buildLateEntryPayload } from "@/lib/journal";

/**
 * The trial report against journal records as the database stores them —
 * `Decimal` prices, `BigInt` candle times, enum strings, event payloads built
 * by the journal's own writer — through a stub that answers `findMany` and
 * nothing else. A write of any kind throws, so a passing run is also the proof
 * that the report reads only.
 *
 * The cases are the ones a manual trial produces: a clean win, a stop-out past
 * the budget, a partial fill, a trade still open with no exit, an order that
 * never filled (cancelled, and skipped as a missed entry), a watch that became
 * a take after the fill, a late entry, and an exit on invalidation.
 */

const db = vi.hoisted(() => ({
  calls: [] as { model: string; method: string; args: unknown }[],
  rows: {} as Record<string, unknown[]>,
}));

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: new Proxy(
    {},
    {
      get: (_, model: string) =>
        new Proxy(
          {},
          {
            get: (__, method: string) => {
              if (method !== "findMany") {
                throw new Error(`The report tried ${model}.${method} — it may only read.`);
              }
              return async (args: unknown) => {
                db.calls.push({ model, method, args });
                return db.rows[model] ?? [];
              };
            },
          },
        ),
    },
  ),
}));

const { buildTrialReport } = await import("./demo-trial");

const D = (value: string) => new Prisma.Decimal(value);
const t = (iso: string) => new Date(iso);
const USER = "owner-1";
const FROM = Date.parse("2026-10-30T15:00:00Z");
const TO = Date.parse("2026-11-02T08:00:00Z");

/** A 4h setup tracked at 08:02 from the 04:00 candle, Potential from creation unless told otherwise. */
function setup(id: string, symbol: string, events?: { toStatus: string; createdAt: Date }[]) {
  return {
    id,
    userId: USER,
    tradingPairId: `pair-${symbol}`,
    timeframe: "H4",
    status: "POTENTIAL_SETUP",
    entryLow: D("100.00000000"),
    entryHigh: D("102.00000000"),
    stopLoss: D("97.00000000"),
    takeProfit1: D("105.00000000"),
    takeProfit2: D("110.00000000"),
    takeProfit3: D("115.00000000"),
    riskReward: D("2.60"),
    riskRewardIsSynthetic: false,
    score: 82,
    scoreGrade: "STRONG",
    analysisStatus: "POTENTIAL_SETUP",
    snapshot: {
      createdFromCandleTime: Date.parse("2026-10-31T04:00:00Z"),
      takeProfits: [
        { label: "TP1", level: 105, kind: "STRUCTURAL", rr: 0.9, reason: "Prior high." },
        { label: "TP2", level: 110, kind: "STRUCTURAL", rr: 2.6, reason: "Range top." },
        { label: "TP3", level: 115, kind: "R_MULTIPLE", rr: 4.2, reason: "3R." },
      ],
      regime: { direction: "TRENDING_UP", volatility: "NORMAL" },
    },
    originZoneLow: D("99.5"),
    originZoneHigh: D("102.5"),
    createdAt: t("2026-10-31T08:02:00Z"),
    updatedAt: t("2026-10-31T08:02:00Z"),
    confirmedAt: null,
    invalidatedAt: null as Date | null,
    invalidationReason: null,
    analysisSnapshotId: null,
    tradingPair: { exchangeSymbol: symbol },
    events: events ?? [{ toStatus: "POTENTIAL_SETUP", createdAt: t("2026-10-31T08:02:00Z") }],
  };
}

type Overrides = Record<string, unknown>;

function entry(id: string, s: ReturnType<typeof setup> | null, overrides: Overrides = {}) {
  return {
    id,
    userId: USER,
    trackedSetupId: s?.id ?? null,
    scannerRunId: null,
    tradingPairId: null,
    timeframe: null,
    decision: "CLOSED",
    setupStatusAtDecision: s ? "POTENTIAL_SETUP" : null,
    decidedAt: t("2026-10-31T10:05:00Z"),
    skipReason: null,
    notes: null,
    actualEntry: D("101.50000000"),
    actualStopLoss: D("96.50000000"),
    actualTakeProfit: D("110.00000000"),
    actualExit: D("110.00000000"),
    quantity: D("0.19000000"),
    fees: D("0.04000000"),
    slippage: null,
    exitReason: "TAKE_PROFIT",
    openedAt: t("2026-10-31T10:00:00Z"),
    closedAt: t("2026-10-31T16:00:00Z"),
    createdAt: t("2026-10-31T10:05:00Z"),
    updatedAt: t("2026-10-31T16:00:00Z"),
    tradingPair: null,
    trackedSetup: s,
    events: [
      { toDecision: "TAKEN", createdAt: t("2026-10-31T10:05:00Z"), payload: null },
      { toDecision: "CLOSED", createdAt: t("2026-10-31T16:00:00Z"), payload: null },
    ],
    ...overrides,
  };
}

const closedAt = t("2026-10-31T12:30:00Z");

beforeEach(() => {
  db.calls.length = 0;
  db.rows = {
    journalEntry: [
      // 1. A clean win.
      entry("e-win", setup("s-win", "AAAUSDT")),
      // 2. A stop-out past the budget: (96.2 − 101.5) × 0.19 − 0.04 = −1.047.
      entry("e-stop", setup("s-stop", "BBBUSDT"), {
        actualExit: D("96.20000000"),
        exitReason: "STOP_LOSS",
      }),
      // 3. A partial fill: half the planned quantity filled.
      entry("e-partial", setup("s-partial", "CCCUSDT"), {
        quantity: D("0.09500000"),
        fees: D("0.02000000"),
      }),
      // 4. Still open: Taken, no exit.
      entry("e-open", setup("s-open", "DDDUSDT"), {
        decision: "TAKEN",
        actualExit: null,
        exitReason: null,
        closedAt: null,
        fees: D("0.02000000"),
        events: [{ toDecision: "TAKEN", createdAt: t("2026-10-31T10:05:00Z"), payload: null }],
      }),
      // 5. An order that never filled: watched, then cancelled. Never Taken.
      entry("e-cancel", setup("s-cancel", "EEEUSDT"), {
        decision: "CANCELLED",
        setupStatusAtDecision: "POTENTIAL_SETUP",
        actualEntry: null,
        actualStopLoss: null,
        actualTakeProfit: null,
        actualExit: null,
        quantity: null,
        fees: null,
        exitReason: null,
        openedAt: null,
        closedAt: null,
        events: [
          { toDecision: "WATCHING", createdAt: t("2026-10-31T09:00:00Z"), payload: null },
          { toDecision: "CANCELLED", createdAt: t("2026-10-31T14:00:00Z"), payload: null },
        ],
      }),
      // 6. An order that never filled, recorded as a skip for a missed entry.
      entry("e-missed", setup("s-missed", "FFFUSDT"), {
        decision: "SKIPPED",
        skipReason: "MISSED_ENTRY",
        actualEntry: null,
        actualStopLoss: null,
        actualTakeProfit: null,
        actualExit: null,
        quantity: null,
        fees: null,
        exitReason: null,
        openedAt: null,
        closedAt: null,
        events: [{ toDecision: "SKIPPED", createdAt: t("2026-10-31T11:00:00Z"), payload: null }],
      }),
      // 7. Watched while forming at 08:30; Potential by the fill; Taken after it.
      entry(
        "e-watched",
        setup("s-watched", "GGGUSDT", [
          { toStatus: "SETUP_FORMING", createdAt: t("2026-10-31T08:02:00Z") },
          { toStatus: "POTENTIAL_SETUP", createdAt: t("2026-10-31T09:45:00Z") },
        ]),
        {
          setupStatusAtDecision: "SETUP_FORMING",
          decidedAt: t("2026-10-31T08:30:00Z"),
          events: [
            { toDecision: "WATCHING", createdAt: t("2026-10-31T08:30:00Z"), payload: null },
            { toDecision: "TAKEN", createdAt: t("2026-10-31T10:05:00Z"), payload: null },
            { toDecision: "CLOSED", createdAt: t("2026-10-31T16:00:00Z"), payload: null },
          ],
        },
      ),
      // 8. A late entry on a setup that closed at 12:30, filled at 10:00 while it was open.
      entry(
        "e-late",
        {
          ...setup("s-late", "HHHUSDT", [
            { toStatus: "POTENTIAL_SETUP", createdAt: t("2026-10-31T08:02:00Z") },
            { toStatus: "INVALIDATED", createdAt: closedAt },
          ]),
          status: "INVALIDATED",
          invalidatedAt: closedAt,
        },
        {
          setupStatusAtDecision: "INVALIDATED",
          decidedAt: t("2026-10-31T13:00:00Z"),
          events: [
            {
              toDecision: "TAKEN",
              createdAt: t("2026-10-31T13:00:00Z"),
              payload: buildLateEntryPayload({
                source: "USER_STATED",
                acknowledged: true,
                statedEnteredAt: Date.parse("2026-10-31T10:00:00Z"),
                setupFirstSeenAt: Date.parse("2026-10-31T08:02:00Z"),
                setupClosedAt: closedAt.getTime(),
              }),
            },
            { toDecision: "CLOSED", createdAt: t("2026-10-31T16:00:00Z"), payload: null },
          ],
        },
      ),
      // 9. Exited because the setup was invalidated, at 103.
      entry("e-invalid", setup("s-invalid", "IIIUSDT"), {
        actualExit: D("103.00000000"),
        exitReason: "INVALIDATED",
      }),
    ],
    scannerRun: [
      { status: "COMPLETED", startedAt: t("2026-10-31T08:01:30Z") },
      { status: "FAILED", startedAt: t("2026-10-31T09:01:30Z") },
    ],
    notification: [
      { type: "ENTRY_ZONE_REACHED", dedupeKey: "entry-zone:s-win" },
      { type: "SETUP_INVALIDATED", dedupeKey: "evt-1" },
      // The same event on a second channel is one event.
      { type: "SETUP_INVALIDATED", dedupeKey: "evt-1" },
    ],
    trackedSetup: [],
    scannerResult: [],
  };
});

async function report() {
  return buildTrialReport({ userId: USER, from: FROM, to: TO, generatedAt: TO });
}

describe("buildTrialReport on stored journal records", () => {
  it("reads only, and scopes every owned query to the owner", async () => {
    await report();
    expect(new Set(db.calls.map((c) => c.method))).toEqual(new Set(["findMany"]));
    for (const model of ["journalEntry", "notification", "trackedSetup"]) {
      const call = db.calls.find((c) => c.model === model);
      expect(call, model).toBeDefined();
      expect((call?.args as { where: { userId: string } }).where.userId).toBe(USER);
    }
    const reads = db.calls.find((c) => c.model === "scannerResult");
    expect(
      (reads?.args as { where: { trackedSetupId: { in: string[] } } }).where.trackedSetupId.in,
    ).toEqual(["s-win", "s-stop", "s-partial", "s-open", "s-watched", "s-late", "s-invalid"]);
  });

  it("credits a pass only if it assessed that setup, succeeded, and had completed", async () => {
    await report();
    const reads = db.calls.find((c) => c.model === "scannerResult");
    expect((reads?.args as { where: unknown }).where).toMatchObject({
      status: "OK",
      scannerRun: { completedAt: { not: null }, status: { in: ["COMPLETED", "PARTIAL"] } },
    });
  });

  it("finds a trade Taken inside the window from a watch decided before it", async () => {
    await report();
    const call = db.calls.find((c) => c.model === "journalEntry");
    expect((call?.args as { where: { OR: unknown[] } }).where.OR).toContainEqual({
      events: { some: { createdAt: { gte: new Date(FROM), lte: new Date(TO) } } },
    });
  });

  it("lists positions only, and counts the orders that never filled apart", async () => {
    const text = await report();
    expect(text).toContain("9 journaled:");
    expect(text).toContain("Orders that never filled: 1 cancelled · 1 skipped as a missed entry.");
    expect(text).not.toContain("EEEUSDT");
    expect(text).not.toContain("FFFUSDT");
    expect(text.match(/^\| \d+ \| [A-Z]+USDT H4 \|/gm)).toHaveLength(7);
  });

  it("reads Decimal prices as the numbers they store, and measures R the journal's way", async () => {
    const text = await report();
    expect(text).toContain(
      "| 1 | AAAUSDT H4 | closed | 101.5000 | 96.5000 | 110.0000 | 110.0000 | take profit | 0.19 |",
    );
    expect(text).toContain(`+${(1.575 / 0.95).toFixed(2)}R`);
  });

  it("flags the stop-out past the budget, and nothing about the partial fill", async () => {
    const text = await report();
    expect(text).toContain("- #2 Lost 1.0470 USDT net, more than the 1 USDT budget");
    expect(text).not.toMatch(/- #3 /);
    // Measured on the quantity that filled: risk 0.475, net 8.5 × 0.095 − 0.02.
    expect(text).toContain(`+${((8.5 * 0.095 - 0.02) / 0.475).toFixed(2)}R`);
  });

  it("leaves the open trade without a result, and says it is still open", async () => {
    const text = await report();
    expect(text).toMatch(/\| 4 \| DDDUSDT H4 \| taken \|[^\n]*\| — \| — \|\n/);
    expect(text).toContain("Still open at the end of the window: 1");
  });

  it("judges the watched-then-taken trade by its state at the fill, not at the watch", async () => {
    const text = await report();
    expect(text).toContain("| 5 | ok | ok | ok | ok | ok | ok |");
  });

  it("marks the late entry and the exit on invalidation", async () => {
    const text = await report();
    expect(text).toContain("- #6 Recorded as a late entry on a closed setup");
    expect(text).toContain("| 7 | ok | ok | ok | ok | ok | NO |");
    expect(text).toContain("- #7 Exit reason recorded as invalidated.");
    // The exit and its result are as recorded: (103 − 101.5) × 0.19 − 0.04.
    expect(text).toMatch(
      /\| 7 \| IIIUSDT H4 \| closed \|[^\n]*\| 103\.0000 \| invalidated \|[^\n]*\| 0\.2450 \|/,
    );
  });

  it("finds the primary target through the engine's own rule, from the stored snapshot", async () => {
    // TP2 is the second structural target at or above the meaningful-R floor;
    // a take-profit at 110 is it, so no trade is flagged for its target.
    expect(await report()).not.toContain("from the primary target");
  });

  it("counts one notification per event, and the passes in the window", async () => {
    const text = await report();
    expect(text).toContain("Notifications: ENTRY_ZONE_REACHED 1 · SETUP_INVALIDATED 1");
    expect(text).toContain("Successful scanner passes: 1 · failed: 1");
  });
});

describe("buildTrialReport: freshness at the fill, from the passes behind the setup", () => {
  /** Filled at 14:00, when the creating 04:00 analysis had been stale since 12:01:30. */
  const lateFill = () =>
    entry("e-fresh", setup("s-fresh", "JJJUSDT"), {
      openedAt: t("2026-10-31T14:00:00Z"),
      closedAt: t("2026-10-31T18:00:00Z"),
      events: [
        { toDecision: "TAKEN", createdAt: t("2026-10-31T14:05:00Z"), payload: null },
        { toDecision: "CLOSED", createdAt: t("2026-10-31T18:00:00Z"), payload: null },
      ],
    });
  const pass = (setupId: string, candle: string, completedAt: string) => ({
    trackedSetupId: setupId,
    analysedAtCandle: BigInt(Date.parse(candle)),
    scannerRun: { completedAt: t(completedAt) },
  });
  const freshColumn = (text: string) => text.match(/^\| 1 \| (\w+) \| (\w+) \|/m)?.[2];

  it("is stale with only the creating read", async () => {
    db.rows.journalEntry = [lateFill()];
    expect(freshColumn(await report())).toBe("NO");
  });

  it("is fresh when a completed pass had re-read that setup's market", async () => {
    db.rows.journalEntry = [lateFill()];
    // Read the 08:00 candle (fresh until 16:01:30), completed at 12:02.
    db.rows.scannerResult = [pass("s-fresh", "2026-10-31T08:00:00Z", "2026-10-31T12:02:00Z")];
    expect(freshColumn(await report())).toBe("ok");
  });

  it("does not credit a pass that read another setup, or completed after the fill", async () => {
    db.rows.journalEntry = [lateFill()];
    db.rows.scannerResult = [
      pass("s-other", "2026-10-31T08:00:00Z", "2026-10-31T12:02:00Z"),
      pass("s-fresh", "2026-10-31T08:00:00Z", "2026-10-31T14:30:00Z"),
    ];
    expect(freshColumn(await report())).toBe("NO");
  });
});

describe("buildTrialReport: a trade recorded through the journal's own form", () => {
  /**
   * The stored row for what the form sends, written as `recordOutcome` writes
   * it: a field the request leaves out is null. The times are typed as local
   * wall-clock values, exactly as the inputs hold them.
   */
  function recordedThroughForm(values: Partial<OutcomeForm>, close: boolean) {
    const request = outcomeRequest({ ...outcomeFormFrom(null), ...values }, null, close);
    if (!request.ok) throw new Error(request.message);
    const sent = request.body as Record<string, number | string | undefined>;
    const price = (key: string) => (sent[key] === undefined ? null : D(String(sent[key])));
    const time = (key: string) => (sent[key] === undefined ? null : new Date(sent[key] as number));
    return {
      actualEntry: price("actualEntry"),
      actualStopLoss: price("actualStopLoss"),
      actualTakeProfit: price("actualTakeProfit"),
      actualExit: price("actualExit"),
      quantity: price("quantity"),
      fees: price("fees"),
      slippage: price("slippage"),
      exitReason: sent.exitReason ?? null,
      openedAt: time("openedAt"),
      closedAt: time("closedAt"),
    };
  }
  const local = (iso: string) => toLocalInput(Date.parse(iso));

  it("judges every rule from what the form now records", async () => {
    const recorded = recordedThroughForm(
      {
        actualEntry: "101.5",
        actualStopLoss: "96.5",
        actualTakeProfit: "110",
        actualExit: "110",
        quantity: "0.19",
        fees: "0.04",
        exitReason: "TAKE_PROFIT",
        openedAt: local("2026-10-31T10:00:00Z"),
        closedAt: local("2026-10-31T16:00:00Z"),
      },
      true,
    );
    expect(recorded.openedAt).toEqual(t("2026-10-31T10:00:00Z"));
    db.rows.journalEntry = [entry("e-form", setup("s-form", "KKKUSDT"), recorded)];

    expect(await report()).toContain("| 1 | ok | ok | ok | ok | ok | ok |");
  });

  it("judges an open partial fill at its fill time, and leaves only its exit unknown", async () => {
    const recorded = recordedThroughForm(
      {
        actualEntry: "101.5",
        actualStopLoss: "96.5",
        actualTakeProfit: "110",
        quantity: "0.095",
        fees: "0.02",
        openedAt: local("2026-10-31T10:00:00Z"),
      },
      false,
    );
    expect(recorded).toMatchObject({ actualExit: null, exitReason: null, closedAt: null });
    db.rows.journalEntry = [
      entry("e-form-open", setup("s-form-open", "LLLUSDT"), {
        ...recorded,
        decision: "TAKEN",
        events: [{ toDecision: "TAKEN", createdAt: t("2026-10-31T10:05:00Z"), payload: null }],
      }),
    ];

    expect(await report()).toContain("| 1 | ok | ok | ok | ok | ok | unknown |");
  });

  it("leaves every rule it cannot see unknown when those fields are left blank", async () => {
    // Fill time, take-profit, exit reason and close time not recorded — blank on
    // the form, or recorded before the form had them.
    db.rows.journalEntry = [
      entry("e-form", setup("s-form", "KKKUSDT"), {
        actualTakeProfit: null,
        exitReason: null,
        openedAt: null,
        closedAt: null,
      }),
    ];
    const text = await report();
    expect(text).toContain("| 1 | unknown | unknown | ok | unknown | unknown | unknown |");
    expect(text).toContain(`+${(1.575 / 0.95).toFixed(2)}R`);
  });
});
