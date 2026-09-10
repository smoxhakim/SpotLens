import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The research query against a stubbed database.
 *
 * What is being checked is mostly where the work happens: filters belong in
 * SQL so a wide date range does not load a year of scanning into memory, and
 * the event history has to arrive with the setups rather than one query per row.
 */

const findMany = vi.fn();

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: { trackedSetup: { findMany: (a: unknown) => findMany(a) } },
}));

const { MAX_RESEARCH_ROWS, runResearch } = await import("./research");

const DAY = 86_400_000;
const CREATED = Date.UTC(2026, 5, 1);

function setupRow(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    timeframe: "H4",
    status: "SETUP_FORMING",
    score: 70,
    riskReward: 2,
    riskRewardIsSynthetic: false,
    createdAt: new Date(CREATED),
    snapshot: { regime: { direction: "TRENDING_UP", volatility: "NORMAL" } },
    tradingPair: { exchangeSymbol: "BTCUSDT" },
    events: [{ toStatus: "SETUP_FORMING" }],
    journalEntry: null,
    ...over,
  };
}

function journalRow(over: Record<string, unknown> = {}) {
  return {
    decision: "CLOSED",
    setupStatusAtDecision: "WAITING_CONFIRMATION",
    skipReason: null,
    decidedAt: new Date(CREATED + DAY),
    actualEntry: 100,
    actualStopLoss: 90,
    actualExit: 120,
    quantity: 1,
    fees: null,
    slippage: null,
    openedAt: null,
    closedAt: null,
    ...over,
  };
}

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

describe("the query", () => {
  it("scopes to the caller and caps how much history one request can pull", async () => {
    await runResearch({ userId: "user-1", filters: {} });

    const args = findMany.mock.calls[0][0];
    expect(args.where.userId).toBe("user-1");
    expect(args.take).toBe(MAX_RESEARCH_ROWS);
  });

  it("pushes the date range, symbol, timeframe and score into SQL", async () => {
    await runResearch({
      userId: "user-1",
      filters: {
        from: CREATED,
        to: CREATED + 30 * DAY,
        symbol: "ETHUSDT",
        timeframe: "H1",
        minScore: 60,
        maxScore: 90,
      },
    });

    const where = findMany.mock.calls[0][0].where;
    expect(where.createdAt).toEqual({
      gte: new Date(CREATED),
      lte: new Date(CREATED + 30 * DAY),
    });
    expect(where.tradingPair).toEqual({ exchangeSymbol: "ETHUSDT" });
    expect(where.timeframe).toBe("H1");
    expect(where.score).toEqual({ gte: 60, lte: 90 });
  });

  it("translates 'measured reward only' into the stored flag", async () => {
    await runResearch({ userId: "user-1", filters: { measuredRewardOnly: true } });
    expect(findMany.mock.calls[0][0].where.riskRewardIsSynthetic).toBe(false);

    await runResearch({ userId: "user-1", filters: { measuredRewardOnly: false } });
    expect(findMany.mock.calls[1][0].where.riskRewardIsSynthetic).toBe(true);
  });

  it("loads events and journal entries with the setups, not per setup", async () => {
    // The N+1 here would be thousands of round trips over a year of scanning.
    await runResearch({ userId: "user-1", filters: {} });

    const include = findMany.mock.calls[0][0].include;
    expect(include.events).toBeDefined();
    expect(include.journalEntry).toBeDefined();
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe("what comes back", () => {
  it("counts a state the setup ever reached, not only its last one", async () => {
    findMany.mockResolvedValue([
      setupRow({
        status: "INVALIDATED",
        events: [{ toStatus: "SETUP_FORMING" }, { toStatus: "POTENTIAL_SETUP" }],
      }),
    ]);

    const report = await runResearch({ userId: "user-1", filters: {} });

    expect(report.engine.reachedPotentialSetup).toBe(1);
    expect(report.engine.invalidated).toBe(1);
  });

  it("reads the regime off the stored snapshot", async () => {
    findMany.mockResolvedValue([setupRow({ journalEntry: journalRow() })]);

    const report = await runResearch({ userId: "user-1", filters: {} });

    expect(report.byRegime.map((b) => b.key)).toEqual(["TRENDING_UP"]);
  });

  it("survives a snapshot with no regime recorded", async () => {
    // Setups stored before Phase H have no regime block at all.
    findMany.mockResolvedValue([setupRow({ snapshot: {}, journalEntry: journalRow() })]);

    const report = await runResearch({ userId: "user-1", filters: {} });

    expect(report.engine.setupsDetected).toBe(1);
    expect(report.outcomes.totalSetups).toBe(1);
  });

  it("filters on regime after loading, since it lives in the snapshot", async () => {
    findMany.mockResolvedValue([
      setupRow({ id: "a" }),
      setupRow({ id: "b", snapshot: { regime: { direction: "RANGE", volatility: "LOW" } } }),
    ]);

    const report = await runResearch({ userId: "user-1", filters: { regimeDirection: "RANGE" } });

    expect(report.engine.setupsDetected).toBe(1);
  });

  it("groups a trade by the confirmation state at the decision", async () => {
    // The setup confirmed later. The trade was entered before that, so it must
    // not be sorted into the confirmed bucket.
    findMany.mockResolvedValue([
      setupRow({
        events: [{ toStatus: "SETUP_FORMING" }, { toStatus: "CONFIRMATION_DETECTED" }],
        journalEntry: journalRow({ setupStatusAtDecision: "WAITING_CONFIRMATION" }),
      }),
    ]);

    const report = await runResearch({ userId: "user-1", filters: {} });

    expect(report.byConfirmation.map((b) => b.key)).toEqual(["NOT_PRESENT"]);
    // The engine funnel still records that the setup did confirm.
    expect(report.engine.reachedConfirmation).toBe(1);
  });

  it("keeps the engine's count separate from the user's", async () => {
    findMany.mockResolvedValue([
      setupRow({ id: "a" }),
      setupRow({ id: "b" }),
      setupRow({ id: "c", journalEntry: journalRow() }),
    ]);

    const report = await runResearch({ userId: "user-1", filters: {} });

    expect(report.engine.setupsDetected).toBe(3);
    expect(report.human.journaled).toBe(1);
    expect(report.outcomes.totalSetups).toBe(1);
    expect(report.outcomes.averageR).toBeCloseTo(2);
  });

  it("echoes the filters back", async () => {
    const filters = { symbol: "BTCUSDT", minScore: 50 };

    expect((await runResearch({ userId: "user-1", filters })).filters).toEqual(filters);
  });
});
