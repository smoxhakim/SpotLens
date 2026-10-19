import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which pass Opportunities shows when no run is named.
 *
 * It used to be the newest run of any status. A pass writes its results only
 * when it finishes, so for the minute or two of every pass — hourly, under the
 * engine — and after any FAILED run or killed scanner, the page showed an empty
 * list as though nothing were worth reading. Now it is the newest successful
 * pass, and a newer one still running is reported separately.
 */

interface RunRow {
  id: string;
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  startedAt: Date;
  completedAt: Date | null;
}

const runs: RunRow[] = [];

const result = (runId: string) => ({
  scannerRunId: runId,
  tradingPair: { exchangeSymbol: "BTCUSDT" },
  timeframe: "H1",
  analysisStatus: "POTENTIAL_SETUP",
  score: 88,
  riskReward: 2.4,
  riskRewardIsSynthetic: false,
  status: "OK",
  lifecycleStatus: "SETUP_FORMING",
  trackedSetupId: `setup-${runId}`,
  analysedAtCandle: null,
  trend: "BULLISH",
  mtfAgreement: null,
  regimeDirection: null,
});

type Where = {
  status?: string | { in: string[] };
  completedAt?: { not: null };
  startedAt?: { gt: Date };
};

/** Applies exactly the filters `getShortlist` sends, newest first. */
function matching(where: Where = {}) {
  return runs
    .filter((r) => {
      if (typeof where.status === "string" && r.status !== where.status) return false;
      if (typeof where.status === "object" && !where.status.in.includes(r.status)) return false;
      if (where.completedAt && r.completedAt === null) return false;
      if (where.startedAt && !(r.startedAt > where.startedAt.gt)) return false;
      return true;
    })
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

const findFirst = vi.fn(async ({ where }: { where?: Where }) => {
  const run = matching(where)[0];
  return run ? { ...run, timeframes: ["H1"], triggeredBy: "SCHEDULE", marketCount: 45 } : null;
});

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: {
    scannerRun: {
      findFirst: (a: never) => findFirst(a),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const run = runs.find((r) => r.id === where.id);
        return run
          ? { ...run, timeframes: ["H1"], triggeredBy: "SCHEDULE", marketCount: 45 }
          : null;
      },
    },
    // Results exist only for a finished pass — exactly as `finishRun` writes them.
    scannerResult: {
      findMany: async ({ where }: { where: { scannerRunId: string } }) => {
        const run = runs.find((r) => r.id === where.scannerRunId);
        return run && run.status !== "RUNNING" && run.status !== "FAILED" ? [result(run.id)] : [];
      },
    },
  },
}));

const { getShortlist, PASS_IN_PROGRESS_MAX_AGE_MS } = await import("./scanner");

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 19, h, m));
const run = (id: string, status: RunRow["status"], startedAt: Date): RunRow => ({
  id,
  status,
  startedAt,
  completedAt: status === "RUNNING" ? null : new Date(startedAt.getTime() + 90_000),
});

beforeEach(() => {
  runs.length = 0;
  findFirst.mockClear();
});

describe("Opportunities: the default pass", () => {
  it("while a pass is running, shows the last completed one and says a new one is running", async () => {
    runs.push(run("good", "COMPLETED", at(10, 1)), run("now", "RUNNING", at(11, 1)));

    const result = await getShortlist({ now: at(11, 2).getTime() });

    expect(result?.run.id).toBe("good");
    expect(result?.shortlist.totalEligible).toBe(1);
    expect(result?.passInProgress).toEqual({ startedAt: at(11, 1).toISOString() });
  });

  it("after a FAILED pass, still shows the last successful one — nothing in progress", async () => {
    runs.push(run("good", "COMPLETED", at(10, 1)), run("bad", "FAILED", at(11, 1)));

    const result = await getShortlist({ now: at(11, 5).getTime() });

    expect(result?.run.id).toBe("good");
    expect(result?.shortlist.totalEligible).toBe(1);
    expect(result?.passInProgress).toBeNull();
  });

  it("a PARTIAL pass counts: its successful markets are real", async () => {
    runs.push(run("old", "COMPLETED", at(9, 1)), run("partial", "PARTIAL", at(10, 1)));
    expect((await getShortlist({ now: at(10, 5).getTime() }))?.run.id).toBe("partial");
  });

  it("a RUNNING row left by a killed scanner is not reported as in progress for ever", async () => {
    runs.push(run("good", "COMPLETED", at(10, 1)), run("orphan", "RUNNING", at(10, 30)));

    const soon = await getShortlist({ now: at(10, 31).getTime() });
    expect(soon?.passInProgress).not.toBeNull();

    const later = await getShortlist({
      now: at(10, 30).getTime() + PASS_IN_PROGRESS_MAX_AGE_MS + 60_000,
    });
    expect(later?.run.id).toBe("good");
    expect(later?.passInProgress).toBeNull();
  });

  it("a RUNNING row older than the shown pass is never reported", async () => {
    runs.push(run("orphan", "RUNNING", at(10, 1)), run("good", "COMPLETED", at(10, 5)));
    expect((await getShortlist({ now: at(10, 7).getTime() }))?.passInProgress).toBeNull();
  });

  it("no successful pass yet: nothing to show, even with one running", async () => {
    runs.push(run("first", "RUNNING", at(10, 1)));
    expect(await getShortlist({ now: at(10, 2).getTime() })).toBeNull();
  });

  it("sends the successful-pass filter for the default view", async () => {
    runs.push(run("good", "COMPLETED", at(10, 1)));
    await getShortlist({ now: at(10, 5).getTime() });
    expect(findFirst.mock.calls[0][0]).toEqual({
      where: { completedAt: { not: null }, status: { in: ["COMPLETED", "PARTIAL"] } },
      orderBy: { startedAt: "desc" },
    });
  });
});

describe("Opportunities: an explicit run id", () => {
  it("is returned as it is, whatever its status, with no in-progress lookup", async () => {
    runs.push(run("good", "COMPLETED", at(10, 1)), run("bad", "FAILED", at(11, 1)));

    const result = await getShortlist({ runId: "bad", now: at(11, 5).getTime() });

    expect(result?.run.id).toBe("bad");
    expect(result?.run.status).toBe("FAILED");
    expect(result?.passInProgress).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("an unknown id is null", async () => {
    expect(await getShortlist({ runId: "nope" })).toBeNull();
  });
});
