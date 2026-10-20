import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

/**
 * `/api/scanner/shortlist`, end to end over stored rows — the route, the real
 * `getShortlist` and the real `buildShortlist` — with persistence stubbed.
 *
 * Stored rows carry no untracked reason: `ScannerResult` has no column for it.
 * What these protect is that the API says so ("not recorded") rather than
 * guessing, says "no levels" only when the stored row proves it, and never
 * reads a stored INVALIDATED on an untracked row as confirmation contradiction.
 */

function row(symbol: string, overrides: Record<string, unknown> = {}) {
  return {
    scannerRunId: "run-1",
    tradingPair: { exchangeSymbol: symbol },
    timeframe: "H4",
    status: "OK",
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    score: 80,
    riskReward: 3,
    riskRewardIsSynthetic: false,
    lifecycleStatus: null,
    trackedSetupId: null,
    analysedAtCandle: null,
    trend: "BULLISH",
    mtfAgreement: null,
    regimeDirection: null,
    ...overrides,
  };
}

const ROWS = [
  // Tracked: no reason at all.
  row("BTCUSDT", { score: 90, trackedSetupId: "setup-btc", lifecycleStatus: "SETUP_FORMING" }),
  // Untracked with levels — on the real pass, NEAR/USDT 4h. Reason not stored.
  row("NEARUSDT", { score: 86 }),
  // Untracked, and a stored INVALIDATED with no setup id: the overload an
  // earlier draft wrote. It is not evidence of contradiction.
  row("ARBUSDT", { score: 84, lifecycleStatus: "INVALIDATED" }),
  // A WAIT the engine reached without levels: no score, no reward.
  row("DOTUSDT", { score: null, riskReward: null, riskRewardIsSynthetic: null }),
];

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: {
    scannerRun: {
      findFirst: async ({ where }: { where: { status?: unknown } }) =>
        where.status === "RUNNING"
          ? null
          : {
              id: "run-1",
              status: "COMPLETED",
              startedAt: new Date(Date.UTC(2026, 9, 20, 13, 9)),
              completedAt: new Date(Date.UTC(2026, 9, 20, 13, 10)),
              timeframes: ["H4"],
              triggeredBy: "SCHEDULE",
              marketCount: 4,
            },
    },
    scannerResult: { findMany: async () => ROWS },
  },
}));

vi.mock("@/lib/api/auth-guard", () => ({
  requireUser: async () => ({ userId: "user-1" }),
  isDenied: () => false,
}));

const { GET } = await import("./route");

async function shortlist() {
  const res = await GET(new NextRequest("http://localhost/api/scanner/shortlist?size=ALL"));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    excluded: Record<string, number>;
    candidates: {
      symbol: string;
      trackedSetupId: string | null;
      untrackedReason: string | null;
      lifecycleStatus: string | null;
      reasons: string[];
    }[];
  };
}

describe("GET /api/scanner/shortlist — untracked candidates over stored rows", () => {
  it("returns no reason for a tracked candidate", async () => {
    const { candidates } = await shortlist();
    const btc = candidates.find((c) => c.symbol === "BTCUSDT")!;
    expect(btc.trackedSetupId).toBe("setup-btc");
    expect(btc.untrackedReason).toBeNull();
  });

  it("says 'not recorded' for an untracked candidate with levels, rather than guessing", async () => {
    const { candidates } = await shortlist();
    const near = candidates.find((c) => c.symbol === "NEARUSDT")!;
    expect(near.untrackedReason).toBe("NOT_RECORDED");
    expect(near.reasons[1]).toBe("Not tracked, and the reason was not recorded.");
  });

  it("never reads a stored INVALIDATED with no setup id as confirmation contradiction", async () => {
    const { candidates } = await shortlist();
    const arb = candidates.find((c) => c.symbol === "ARBUSDT")!;
    expect(arb.untrackedReason).toBe("NOT_RECORDED");
    expect(arb.reasons.join(" ")).not.toMatch(/contradicted/i);
  });

  it("counts a WAIT without levels as NO_LEVELS, not FAILED, and keeps it off the list", async () => {
    const { excluded, candidates } = await shortlist();
    expect(excluded.NO_LEVELS).toBe(1);
    expect(excluded.FAILED).toBe(0);
    expect(candidates.map((c) => c.symbol)).not.toContain("DOTUSDT");
  });

  it("ranks by the engine's facts alone — the reason moves nothing", async () => {
    const { candidates } = await shortlist();
    expect(candidates.map((c) => c.symbol)).toEqual(["BTCUSDT", "NEARUSDT", "ARBUSDT"]);
  });
});
