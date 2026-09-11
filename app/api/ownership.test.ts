import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Owner scoping, asserted at the query.
 *
 * These routes all return 404 for another account's row, and always did. What
 * these tests protect is *how*: the ownership condition belongs in the `where`
 * rather than in a check performed after the row has been loaded. The
 * difference is invisible in the response and matters anyway — a scoped query
 * never brings another account's data into the process, so no later change to
 * what a handler returns can leak it, and a scoped delete cannot be separated
 * from its check by an edit that looks harmless.
 */

const analysisFindFirst = vi.fn();
const analysisDeleteMany = vi.fn();
const backtestFindFirst = vi.fn();
const watchlistDeleteMany = vi.fn();

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: {
    analysisSnapshot: {
      findFirst: (a: unknown) => analysisFindFirst(a),
      deleteMany: (a: unknown) => analysisDeleteMany(a),
    },
    backtestRun: { findFirst: (a: unknown) => backtestFindFirst(a) },
    watchlist: { deleteMany: (a: unknown) => watchlistDeleteMany(a) },
  },
}));

vi.mock("@/lib/api/auth-guard", () => ({
  requireUser: async () => ({ userId: USER }),
  isDenied: () => false,
}));

const USER = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

const analysis = await import("./analysis/[id]/route");
const backtest = await import("./backtest/[id]/route");
const watchlist = await import("./watchlist/[id]/route");

const params = Promise.resolve({ id: ID });

beforeEach(() => {
  for (const fn of [
    analysisFindFirst,
    analysisDeleteMany,
    backtestFindFirst,
    watchlistDeleteMany,
  ]) {
    fn.mockReset();
  }
  analysisFindFirst.mockResolvedValue(null);
  analysisDeleteMany.mockResolvedValue({ count: 0 });
  backtestFindFirst.mockResolvedValue(null);
  watchlistDeleteMany.mockResolvedValue({ count: 0 });
});

describe("GET /api/analysis/:id", () => {
  it("asks the database only for the caller's own row", async () => {
    await analysis.GET(new Request("http://t/"), { params });

    expect(analysisFindFirst.mock.calls[0][0].where).toEqual({ id: ID, userId: USER });
  });

  it("answers 404 — not 403 — when there is no such row for this caller", async () => {
    const res = await analysis.GET(new Request("http://t/"), { params });

    expect(res.status).toBe(404);
    // 403 would confirm the id exists, which is the leak the 404 avoids.
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
});

describe("DELETE /api/analysis/:id", () => {
  it("scopes the delete itself rather than checking first", async () => {
    analysisDeleteMany.mockResolvedValue({ count: 1 });

    const res = await analysis.DELETE(new Request("http://t/"), { params });

    expect(analysisDeleteMany.mock.calls[0][0].where).toEqual({ id: ID, userId: USER });
    expect(res.status).toBe(200);
  });

  it("deletes nothing and answers 404 for another account's row", async () => {
    // deleteMany matching nothing is how "not yours" arrives here: there is no
    // window in which the row was found but not yet checked.
    const res = await analysis.DELETE(new Request("http://t/"), { params });

    expect(res.status).toBe(404);
    expect(analysisDeleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/backtest/:id", () => {
  it("never loads another account's run, setups included", async () => {
    await backtest.GET(new Request("http://t/"), { params });

    const args = backtestFindFirst.mock.calls[0][0];
    expect(args.where).toEqual({ id: ID, userId: USER });
    // The run is fetched with all of its setups, so an unscoped read here
    // would pull an entire foreign backtest into memory before refusing it.
    expect(args.include.setups).toBeDefined();
  });

  it("answers 404 for a run that is not the caller's", async () => {
    expect((await backtest.GET(new Request("http://t/"), { params })).status).toBe(404);
  });
});

describe("DELETE /api/watchlist/:id", () => {
  it("scopes the delete to the caller", async () => {
    watchlistDeleteMany.mockResolvedValue({ count: 1 });

    const res = await watchlist.DELETE(new Request("http://t/"), { params });

    expect(watchlistDeleteMany.mock.calls[0][0].where).toEqual({ id: ID, userId: USER });
    expect(res.status).toBe(200);
  });

  it("answers 404 without removing anything it does not own", async () => {
    expect((await watchlist.DELETE(new Request("http://t/"), { params })).status).toBe(404);
  });
});
