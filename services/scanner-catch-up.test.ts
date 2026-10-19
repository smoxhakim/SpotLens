import { beforeEach, describe, expect, it, vi } from "vitest";

import { isCatchUpDue } from "@/lib/engine";

/**
 * What the startup catch-up counts as "a pass already happened".
 *
 * It used to count any run with a `completedAt` — including one in which every
 * market failed. A laptop that woke with the exchange unreachable wrote a
 * FAILED run, and the next engine start then saw "a pass started after the
 * latest window" and skipped the catch-up it needed: setups stayed as old as
 * the last *successful* scan until the next candle close. Only COMPLETED and
 * PARTIAL runs count now.
 */

interface RunRow {
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  startedAt: Date;
  completedAt: Date | null;
}

const runs: RunRow[] = [];
const findFirst = vi.fn(
  async ({
    where,
  }: {
    where: { completedAt: { not: null }; status: { in: string[] } };
    orderBy: { startedAt: "desc" };
  }) => {
    // Applies exactly the filters the query sends, so a run the real query would
    // skip is skipped here too.
    const match = runs
      .filter((r) => r.completedAt !== null && where.status.in.includes(r.status))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    return match ? { startedAt: match.startedAt } : null;
  },
);

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: { scannerRun: { findFirst: (a: never) => findFirst(a) } },
}));

const { lastSuccessfulPassStartedAt } = await import("./scanner");

const DELAY = 90_000;
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 4, h, m));
const run = (status: RunRow["status"], startedAt: Date): RunRow => ({
  status,
  startedAt,
  completedAt: status === "RUNNING" ? null : new Date(startedAt.getTime() + 60_000),
});

/** The decision the scanner script makes on startup, from the real query. */
async function catchUpDueAt(now: Date) {
  const last = await lastSuccessfulPassStartedAt();
  return isCatchUpDue({
    lastCompletedRunStartedAt: last?.getTime() ?? null,
    timeframes: ["H1"],
    now: now.getTime(),
    delayMs: DELAY,
  });
}

beforeEach(() => {
  runs.length = 0;
  findFirst.mockClear();
});

describe("startup catch-up and FAILED runs", () => {
  it("a FAILED pass after the latest window does not cancel the catch-up", async () => {
    runs.push(run("COMPLETED", at(1)), run("FAILED", at(8, 2)));

    expect(await lastSuccessfulPassStartedAt()).toEqual(at(1));
    expect(await catchUpDueAt(at(8, 20))).toBe(true);
  });

  it("a PARTIAL pass after the latest window does: its markets were scanned", async () => {
    runs.push(run("COMPLETED", at(1)), run("PARTIAL", at(8, 2)));

    expect(await lastSuccessfulPassStartedAt()).toEqual(at(8, 2));
    expect(await catchUpDueAt(at(8, 20))).toBe(false);
  });

  it("a COMPLETED pass after the latest window does, as before", async () => {
    runs.push(run("COMPLETED", at(8, 2)), run("FAILED", at(7, 2)));
    expect(await catchUpDueAt(at(8, 20))).toBe(false);
  });

  it("a pass still running is not a pass that happened", async () => {
    runs.push(run("COMPLETED", at(1)), run("RUNNING", at(8, 2)));
    expect(await catchUpDueAt(at(8, 20))).toBe(true);
  });

  it("only FAILED runs ever: treated as never scanned", async () => {
    runs.push(run("FAILED", at(7, 2)), run("FAILED", at(8, 2)));
    expect(await lastSuccessfulPassStartedAt()).toBeNull();
    expect(await catchUpDueAt(at(8, 20))).toBe(true);
  });

  it("sends the successful-pass filter to the database", async () => {
    await lastSuccessfulPassStartedAt();
    expect(findFirst).toHaveBeenCalledWith({
      where: { completedAt: { not: null }, status: { in: ["COMPLETED", "PARTIAL"] } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
  });
});
