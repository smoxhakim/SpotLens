import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scanner runs left RUNNING by a scanner that never finished its pass.
 *
 * A second Ctrl-C, the engine's stop timeout, its crash hook or `kill -9` all
 * end a scanner mid-pass, and nothing ever closed that run: it stayed RUNNING
 * for ever. The scanner now closes such runs as FAILED after taking its lock
 * and between its passes — but never one young enough to belong to a live pass.
 */

interface RunRow {
  id: string;
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  startedAt: Date;
  completedAt: Date | null;
}

const runs: RunRow[] = [];

type Where = { status: string; completedAt: null; startedAt: { lt: Date } };
type Data = { status: RunRow["status"]; completedAt: Date };

const updateMany = vi.fn(async ({ where, data }: { where: Where; data: Data }) => {
  // Applies exactly the filters the query sends.
  const hit = runs.filter(
    (r) =>
      r.status === where.status &&
      r.completedAt === where.completedAt &&
      r.startedAt < where.startedAt.lt,
  );
  for (const r of hit) Object.assign(r, data);
  return { count: hit.length };
});

const dbState = { configured: true };
vi.mock("@/lib/db/prisma", () => ({
  get isDatabaseConfigured() {
    return dbState.configured;
  },
  prisma: { scannerRun: { updateMany: (a: never) => updateMany(a) } },
}));

const { closeAbandonedRuns, ABANDONED_RUN_AFTER_MS } = await import("./scanner");

const NOW = Date.UTC(2026, 9, 20, 12);
const ago = (ms: number) => new Date(NOW - ms);
const H = 60 * 60_000;

beforeEach(() => {
  runs.length = 0;
  updateMany.mockClear();
  dbState.configured = true;
});

describe("closeAbandonedRuns", () => {
  it("closes a RUNNING run older than any pass can be, as FAILED, completed now", async () => {
    runs.push({ id: "dead", status: "RUNNING", startedAt: ago(5 * H), completedAt: null });

    expect(await closeAbandonedRuns(NOW)).toBe(1);
    expect(runs[0]).toMatchObject({ status: "FAILED", completedAt: new Date(NOW) });
  });

  it("never touches a RUNNING run young enough to be a live pass — here or on another machine", async () => {
    runs.push(
      { id: "live", status: "RUNNING", startedAt: ago(2 * 60_000), completedAt: null },
      {
        id: "slow",
        status: "RUNNING",
        startedAt: ago(ABANDONED_RUN_AFTER_MS - 1),
        completedAt: null,
      },
      { id: "edge", status: "RUNNING", startedAt: ago(ABANDONED_RUN_AFTER_MS), completedAt: null },
    );

    expect(await closeAbandonedRuns(NOW)).toBe(0);
    expect(runs.every((r) => r.status === "RUNNING" && r.completedAt === null)).toBe(true);
  });

  it("the bound is longer than the worst-case pass (every request timing out)", () => {
    // 90 analyses, 4 at a time, 2 fetches each, 3 scanner × 3 HTTP attempts × 15 s.
    const worstCasePassMs = Math.ceil(90 / 4) * 2 * 3 * 3 * 15_000;
    expect(ABANDONED_RUN_AFTER_MS).toBeGreaterThan(worstCasePassMs);
  });

  it("leaves finished runs exactly as they were", async () => {
    const finished: RunRow[] = (["COMPLETED", "PARTIAL", "FAILED"] as const).map((status, i) => ({
      id: status,
      status,
      startedAt: ago(10 * H),
      completedAt: ago(10 * H - (i + 1) * 60_000),
    }));
    runs.push(...finished.map((r) => ({ ...r })));

    expect(await closeAbandonedRuns(NOW)).toBe(0);
    expect(runs).toEqual(finished);
  });

  it("sends exactly this filter — RUNNING, unfinished, older than the bound", async () => {
    await closeAbandonedRuns(NOW);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: "RUNNING",
        completedAt: null,
        startedAt: { lt: new Date(NOW - ABANDONED_RUN_AFTER_MS) },
      },
      data: { status: "FAILED", completedAt: new Date(NOW) },
    });
  });

  it("does nothing without a database", async () => {
    dbState.configured = false;
    expect(await closeAbandonedRuns(NOW)).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
