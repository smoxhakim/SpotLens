import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAnalysis } from "@/lib/analysis";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";
import type { MarketSummary } from "@/types/market";

/**
 * Diagnostics in the scan pipeline (Phase 5, commit 1).
 *
 * In memory and in the log only: every analysed market carries its
 * diagnostics, the pass counts them per timeframe, and nothing new reaches the
 * lifecycle or the database. A pass whose rows cannot be written now says so,
 * without touching how the run's status is handled.
 */

const BULLISH = pullbackIntoSupport();
const AFTER_CLOSE = BULLISH.at(-1)!.closeTime + 1;

vi.mock("@/services/candles", () => ({
  getCandles: async () => ({ candles: BULLISH }),
}));

const tracked: unknown[] = [];
vi.mock("@/services/setups", () => ({
  trackSetup: async (input: { result: unknown }) => {
    tracked.push(input.result);
    return { action: "NONE", setupId: null, status: null, reason: "unchanged" };
  },
}));

const db = {
  scannerRun: {
    create: vi.fn(async () => ({ id: "run-1" })),
    update: vi.fn((args: unknown) => args),
  },
  scannerResult: {
    createMany: vi.fn((args: unknown) => args),
  },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
};
const dbState = { configured: false };
vi.mock("@/lib/db/prisma", () => ({
  get isDatabaseConfigured() {
    return dbState.configured;
  },
  prisma: db,
}));

const { runScan } = await import("./scanner");

function universe(count: number): MarketSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    pairId: `pair-${i}`,
    exchangeSymbol: `S${String(i).padStart(2, "0")}USDT`,
    label: `S${i}`,
  })) as MarketSummary[];
}

const scan = () =>
  runScan({
    userId: "user-1",
    markets: universe(3),
    timeframes: ["H1"],
    maxConcurrency: 1,
    now: AFTER_CLOSE,
  });

beforeEach(() => {
  tracked.length = 0;
  dbState.configured = false;
  db.scannerRun.create.mockClear();
  db.scannerRun.update.mockClear();
  db.scannerResult.createMany.mockClear();
  db.$transaction.mockReset();
  db.$transaction.mockImplementation(async (ops: unknown[]) => ops);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("diagnostics in a pass", () => {
  it("gives every analysed market its diagnostics, and the pass a per-timeframe count", async () => {
    const summary = await scan();

    expect(summary.succeeded).toBe(3);
    for (const r of summary.results) {
      expect(r.diagnostics).not.toBeNull();
      if (r.analysisStatus === "POTENTIAL_SETUP") expect(r.diagnostics!.blockingGate).toBeNull();
      else expect(r.diagnostics!.blockingGate).not.toBeNull();
    }

    expect(summary.breakdown).toHaveLength(1);
    const [h1] = summary.breakdown;
    expect(h1.timeframe).toBe("H1");
    expect(h1.analysed).toBe(3);
    expect(h1.verdicts).toEqual({
      POTENTIAL_SETUP: summary.potentialSetups,
      WAIT_FOR_CONFIRMATION: summary.waiting,
      HIGH_RISK: summary.highRisk,
      AVOID: summary.avoided,
    });
  });

  it("hands the lifecycle a result of exactly the shape it always received", async () => {
    await scan();

    const expected = Object.keys(runAnalysis(BULLISH)).sort();
    expect(tracked).toHaveLength(3);
    for (const result of tracked) expect(Object.keys(result as object).sort()).toEqual(expected);
  });

  it("writes exactly the columns it always wrote", async () => {
    dbState.configured = true;
    await scan();

    const { data } = db.scannerResult.createMany.mock.calls[0][0] as {
      data: Record<string, unknown>[];
    };
    for (const row of data) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "scannerRunId",
          "tradingPairId",
          "timeframe",
          "status",
          "analysisStatus",
          "score",
          "riskReward",
          "riskRewardIsSynthetic",
          "analysedAtCandle",
          "trackedSetupId",
          "lifecycleStatus",
          "trend",
          "mtfAgreement",
          "regimeDirection",
          "failureCategory",
          "failureMessage",
          "attempts",
          "durationMs",
        ].sort(),
      );
    }
  });
});

describe("a pass whose results cannot be recorded", () => {
  it("logs one sanitised line, and leaves the run's status handling alone", async () => {
    dbState.configured = true;
    const error = Object.assign(
      new Error("Invalid invocation at postgresql://user:secret@db.example/spotlens"),
      { code: "P2022" },
    );
    db.$transaction.mockRejectedValueOnce(error);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const summary = await scan();

    expect(summary.succeeded).toBe(3);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0][0]);
    expect(line).toContain("results not recorded for run run-1");
    expect(line).toContain("DATABASE_ERROR");
    expect(line).toContain("P2022");
    expect(line).not.toContain("postgresql://");
    expect(line).not.toContain("secret");
    // The only status write is the one inside the failed transaction.
    expect(db.scannerRun.update).toHaveBeenCalledTimes(1);
  });
});
