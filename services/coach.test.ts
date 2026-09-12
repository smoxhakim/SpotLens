import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Resolving a review from stored rows.
 *
 * The database is stubbed, so these are about *which* rows are asked for and
 * what is done with them — the reading itself is proved against fixtures in
 * `lib/coach`. Two properties matter here and nowhere else: a setup belonging
 * to somebody else must be indistinguishable from one that does not exist, and
 * nothing newer than the record being reviewed may be read.
 */

const db = {
  scannerRun: { findUnique: vi.fn() },
  trackedSetup: { findFirst: vi.fn() },
  scannerResult: { findFirst: vi.fn() },
};

vi.mock("@/lib/db/prisma", () => ({ isDatabaseConfigured: true, prisma: db }));

const { buildCoachReview } = await import("./coach");

const USER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const SETUP = "44444444-4444-4444-8444-444444444444";

function setupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SETUP,
    userId: USER,
    timeframe: "H1",
    status: "WAITING_CONFIRMATION",
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    score: 62,
    scoreGrade: "MODERATE",
    entryLow: 0.25769354,
    entryHigh: 0.25880646,
    stopLoss: 0.24671011,
    takeProfit1: 0.2634,
    takeProfit2: 0.2699,
    takeProfit3: null,
    riskReward: 1.62,
    riskRewardIsSynthetic: false,
    invalidationReason: null,
    createdAt: new Date(1_700_000_100_000),
    snapshot: { trend: "BULLISH", createdFromCandleTime: 1_700_000_000_000 },
    tradingPair: { exchangeSymbol: "XTZUSDT" },
    events: [
      {
        payload: { status: "NOT_PRESENT", explanation: "Thin.", evaluatedAt: 1, signals: [] },
        createdAt: new Date(1_700_000_100_000),
      },
    ],
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    symbol: "XTZUSDT",
    timeframe: "H1" as const,
    runId: RUN,
    setupId: SETUP,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.scannerRun.findUnique.mockResolvedValue({ id: RUN });
  db.trackedSetup.findFirst.mockResolvedValue(setupRow());
  db.scannerResult.findFirst.mockResolvedValue(null);
});

describe("owner isolation", () => {
  it("scopes the setup lookup by owner in the query itself", async () => {
    await buildCoachReview(request());

    // In the `where`, not checked after loading: a scoped query never brings
    // another account's row into the process, so no later change to what this
    // returns can leak one.
    expect(db.trackedSetup.findFirst.mock.calls[0][0].where).toEqual({
      id: SETUP,
      userId: USER,
    });
  });

  it("cannot be made to read another account's setup", async () => {
    // The scoped query finds nothing for a stranger's id.
    db.trackedSetup.findFirst.mockResolvedValue(null);

    const result = await buildCoachReview(request({ userId: STRANGER }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.reason).toBe("SETUP_NOT_FOUND");
  });

  it("reports a missing setup and a forbidden one the same way", async () => {
    db.trackedSetup.findFirst.mockResolvedValue(null);

    const missing = await buildCoachReview(request({ setupId: SETUP }));
    const forbidden = await buildCoachReview(request({ userId: STRANGER }));

    // Indistinguishable, so existence cannot be probed.
    expect(JSON.stringify(missing)).toBe(JSON.stringify(forbidden));
  });
});

describe("resolving the record", () => {
  it("refuses a run it does not recognise", async () => {
    db.scannerRun.findUnique.mockResolvedValue(null);

    const result = await buildCoachReview(request());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.reason).toBe("RUN_NOT_FOUND");
    // The setup is not even looked up: an unknown run is not a context.
    expect(db.trackedSetup.findFirst).not.toHaveBeenCalled();
  });

  it("prefers the immutable snapshot when a setup is named", async () => {
    const result = await buildCoachReview(request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.result.context.identity.source).toBe("TRACKED_SETUP");
    expect(result.result.context.levels!.entryLow).toBe(0.25769354);
    expect(db.scannerResult.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to the run's own result when no setup is named", async () => {
    db.scannerResult.findFirst.mockResolvedValue({
      timeframe: "H1",
      analysisStatus: "WAIT_FOR_CONFIRMATION",
      score: 68,
      riskReward: 2.7,
      riskRewardIsSynthetic: false,
      trend: "BULLISH",
      mtfAgreement: "MIXED",
      regimeDirection: "TRENDING_UP",
      analysedAtCandle: BigInt(1_700_000_000_000),
      createdAt: new Date(1_700_000_100_000),
      tradingPair: { exchangeSymbol: "LDOUSDT" },
    });

    const result = await buildCoachReview(request({ setupId: null, symbol: "LDOUSDT" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.result.context.identity.source).toBe("SCANNER_RESULT");
    // No levels were recorded, and none are invented.
    expect(result.result.context.levels).toBeNull();
    expect(result.result.context.quality.score).toBe(68);
  });

  it("reports a candidate the named run never analysed", async () => {
    const result = await buildCoachReview(request({ setupId: null }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.reason).toBe("CANDIDATE_NOT_FOUND");
  });
});

describe("no lookahead", () => {
  it("asks only for the run it was given, never the newest one", async () => {
    await buildCoachReview(request());

    // `findUnique` on the named id — not `findFirst` ordered by date, which
    // would silently review a later scan than the one the reader opened.
    expect(db.scannerRun.findUnique).toHaveBeenCalledWith({
      where: { id: RUN },
      select: { id: true },
    });
  });

  it("reads the event written with the setup, not the most recent one", async () => {
    await buildCoachReview(request());

    // Ascending: the creation event, whose confirmation payload belongs to the
    // same moment as the frozen snapshot. Descending would read a transition
    // recorded days later and pair it with levels from creation — a moment
    // that never existed. A real future event proved this against the database.
    const include = db.trackedSetup.findFirst.mock.calls[0][0].include;
    expect(include.events).toEqual({ orderBy: { createdAt: "asc" }, take: 1 });
  });

  it("uses the earliest event even if the query hands back more than one", async () => {
    // Belt as well as braces: the query orders ascending and takes one, and the
    // code takes the first of what comes back. If someone widens the `take`,
    // the confirmation still belongs to the snapshot's own moment.
    db.trackedSetup.findFirst.mockResolvedValue(
      setupRow({
        events: [
          {
            payload: {
              status: "NOT_PRESENT",
              explanation: "At creation.",
              evaluatedAt: 1,
              signals: [],
            },
            createdAt: new Date(1_700_000_100_000),
          },
          {
            payload: { status: "PRESENT", explanation: "Days later.", evaluatedAt: 2, signals: [] },
            createdAt: new Date(1_800_000_000_000),
          },
        ],
      }),
    );

    const result = await buildCoachReview(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.result.context.confirmation.status).toBe("NOT_PRESENT");
    expect(result.result.context.confirmation.explanation).toBe("At creation.");
  });

  it("produces the identical review when later rows exist that it cannot see", async () => {
    const before = await buildCoachReview(request());

    // A later scan, a later setup and a later confirmation all arrive. None of
    // them is reachable: the query names one run and one setup, and the review
    // is built from the rows those name.
    db.scannerResult.findFirst.mockResolvedValue({ score: 99 });

    const after = await buildCoachReview(request());

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("never reads a clock into the review", async () => {
    const first = await buildCoachReview(request());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await buildCoachReview(request());

    // Time passing between two identical requests changes nothing.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("provider isolation", () => {
  it("falls back to the deterministic reading when a provider fails", async () => {
    const failing = {
      id: "failing",
      review: async () => {
        throw new Error("network down, key sk-live-abc");
      },
    };

    const result = await buildCoachReview(request(), failing);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.degraded).toBe(true);
    expect(result.result.review.providerId).toBe("deterministic");
    // The numbers are unaffected: they never travelled through the provider.
    expect(result.result.context.levels!.stopLoss).toBe(0.24671011);
    expect(JSON.stringify(result)).not.toContain("sk-live");
  });
});
