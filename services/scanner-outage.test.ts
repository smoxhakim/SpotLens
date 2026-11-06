import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyPass, classifyPassError } from "@/lib/scanner";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";
import type { MarketSummary } from "@/types/market";

const BULLISH = pullbackIntoSupport();
const NOW = BULLISH.at(-1)!.closeTime + 1;
let exchangeCalls = 0;
let failSymbols = new Set<string>();
type Outcome = {
  action: string;
  setupId: string | null;
  status: string | null;
  reason: string | null;
  cause?: string | null;
  events: { setupId: string; eventId: string }[];
  failure?: { kind: string; code: string; class: "TRANSIENT" | "PERMANENT" } | null;
};
let track: (id: string) => Outcome = () => created("s");
const created = (id: string): Outcome => ({
  action: "CREATE",
  setupId: id,
  status: "POTENTIAL_SETUP",
  reason: null,
  events: [{ setupId: id, eventId: `event-${id}` }],
  failure: null,
});
const failed = (cls: "TRANSIENT" | "PERMANENT", code: string): Outcome => ({
  action: "NONE",
  setupId: null,
  status: null,
  reason: null,
  events: [],
  failure: { kind: "NOT_WRITTEN", code, class: cls },
});

vi.mock("@/services/candles", () => ({
  getCandles: async (q: { exchangeSymbol: string }) => {
    exchangeCalls += 1;
    if (failSymbols.has(q.exchangeSymbol)) throw new Error("HTTP 500 from exchange");
    return { candles: BULLISH };
  },
}));
vi.mock("@/services/setups", () => ({
  trackSetup: async (i: { tradingPairId: string }) => track(i.tradingPairId),
}));

const written: {
  status?: string;
  rows?: {
    status: string;
    failureCategory?: string;
    failureMessage?: string;
    trackedSetupId?: string | null;
  }[];
} = {};
const db = {
  scannerRun: {
    create: vi.fn(async () => ({ id: "run-1" })),
    update: vi.fn((args: { data: { status: string } }) => {
      written.status = args.data.status;
      return args;
    }),
  },
  scannerResult: {
    createMany: vi.fn((args: { data: never[] }) => {
      written.rows = args.data;
      return args;
    }),
  },
  tradingPair: { findMany: vi.fn(async () => []) },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
};
const dbState = { configured: true };
vi.mock("@/lib/db/prisma", () => ({
  get isDatabaseConfigured() {
    return dbState.configured;
  },
  prisma: db,
}));

const { runScan } = await import("./scanner");
const universe = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    pairId: `pair-${i}`,
    exchangeSymbol: `S${i}USDT`,
    label: `S${i}`,
  })) as MarketSummary[];
const scan = (markets: MarketSummary[] | undefined) =>
  runScan({ userId: "u", timeframes: ["H1"], markets, maxConcurrency: 1, now: NOW });

beforeEach(() => {
  exchangeCalls = 0;
  failSymbols = new Set();
  track = (id) => created(id);
  written.status = undefined;
  written.rows = undefined;
  dbState.configured = true;
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("the database states", () => {
  it("a permanent failure on one market: FAILED, BLOCKED, others kept, the failed market vouches for nothing", async () => {
    track = (id) => (id === "pair-1" ? failed("PERMANENT", "P2003") : created(id));
    const s = await scan(universe(3));
    expect(s.status).toBe("FAILED");
    expect(written.status).toBe("FAILED");
    expect(classifyPass(s)).toBe("FAILED_BLOCKED");
    expect(s.succeeded).toBe(2);
    expect(s.failed).toBe(1);
    const bad = s.results.find((r) => r.tradingPairId === "pair-1")!;
    expect(bad.ok).toBe(false);
    expect(bad.setupId).toBeNull();
    expect(bad.failure).toMatchObject({
      category: "DATABASE_ERROR",
      code: "P2003",
      database: "PERMANENT",
      retryable: false,
    });
    // Committed markets keep their rows and their events; the failed one emits no SYSTEM_ERROR.
    expect(written.rows!.filter((r) => r.status === "OK")).toHaveLength(2);
    expect(written.rows!.find((r) => r.status === "FAILED")).toMatchObject({
      failureCategory: "DATABASE_ERROR",
      failureMessage: "Database error P2003",
      trackedSetupId: null,
    });
    expect(s.events.map((e) => e.type)).toEqual(["SETUP_CREATED", "SETUP_CREATED"]);
    expect(s.observations).toHaveLength(2);
  });

  it("a transient failure on one market: FAILED, TRANSIENT", async () => {
    track = (id) => (id === "pair-1" ? failed("TRANSIENT", "P1017") : created(id));
    const s = await scan(universe(3));
    expect(s.status).toBe("FAILED");
    expect(classifyPass(s)).toBe("FAILED_TRANSIENT");
  });

  it("transient and permanent together: FAILED, BLOCKED", async () => {
    track = (id) =>
      id === "pair-0"
        ? failed("TRANSIENT", "P1017")
        : id === "pair-1"
          ? failed("PERMANENT", "P2003")
          : created(id);
    expect(classifyPass(await scan(universe(3)))).toBe("FAILED_BLOCKED");
  });

  it("exchange failure and a permanent one: FAILED, BLOCKED", async () => {
    failSymbols = new Set(["S0USDT"]);
    track = (id) => (id === "pair-1" ? failed("PERMANENT", "P2003") : created(id));
    expect(classifyPass(await scan(universe(3)))).toBe("FAILED_BLOCKED");
  });

  it("guard refusals stay COMPLETED and SUCCEEDED, whatever the cause", async () => {
    for (const cause of [
      "UNCHANGED",
      "NO_SETUP",
      "CONTRADICTED_UNTRACKED",
      "STALE_ANALYSIS",
      "NON_CANONICAL_CONTEXT",
    ]) {
      track = () => ({
        action: "NONE",
        setupId: null,
        status: null,
        reason: "r",
        cause,
        events: [],
        failure: null,
      });
      const s = await scan(universe(2));
      expect([cause, s.status, classifyPass(s)]).toEqual([cause, "COMPLETED", "SUCCEEDED"]);
    }
  });

  it("exchange failures alone keep their existing classification", async () => {
    failSymbols = new Set(["S0USDT"]);
    let s = await scan(universe(2));
    expect([s.status, classifyPass(s)]).toEqual(["PARTIAL", "SUCCEEDED"]);
  }, 30_000);

  it("zero markets: FAILED, BLOCKED, and no exchange request", async () => {
    const s = await scan([]);
    expect(s.status).toBe("FAILED");
    expect(written.status).toBe("FAILED");
    expect(classifyPass(s)).toBe("FAILED_BLOCKED");
    expect(exchangeCalls).toBe(0);
  });

  it("the market list failing throws before any exchange request, with no row and no fallback", async () => {
    db.tradingPair.findMany.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "P1001" }));
    await expect(scan(undefined)).rejects.toMatchObject({ code: "P1001" });
    expect(exchangeCalls).toBe(0);
    expect(db.scannerRun.create).not.toHaveBeenCalled();
  });

  it("no row could be created: throws, by its class, before any exchange request", async () => {
    db.scannerRun.create.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "P2024" }));
    const err = await scan(universe(1)).catch((e) => e);
    expect(classifyPassError(err, false)).toBe("FAILED_TRANSIENT");
    expect(exchangeCalls).toBe(0);
  });

  it("no database configured: throws before any exchange request, and is blocked", async () => {
    dbState.configured = false;
    const err = await scan(universe(1)).catch((e) => e);
    expect(err.name).toBe("NoDatabaseError");
    expect(classifyPassError(err, false)).toBe("FAILED_BLOCKED");
    expect(exchangeCalls).toBe(0);
  });

  it("results not saved: FAILED in memory, no run id to report on, the row remembered as unfinished", async () => {
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "P1017" }));
    const s = await scan(universe(2));
    expect(s.status).toBe("FAILED");
    expect(s.runId).toBeNull();
    expect(s.unfinishedRunId).toBe("run-1");
    expect(classifyPass(s)).toBe("FAILED_TRANSIENT");
    // Committed lifecycle events still reach delivery.
    expect(s.events).toHaveLength(2);
  });

  it("results refused permanently: BLOCKED", async () => {
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "P2022" }));
    expect(classifyPass(await scan(universe(2)))).toBe("FAILED_BLOCKED");
  });

  it("interrupted beats everything", () => {
    expect(
      classifyPass({
        status: "FAILED",
        interrupted: true,
        results: [{ ok: false, failure: { retryable: false, database: "PERMANENT" } }],
      }),
    ).toBe("INTERRUPTED");
  });

  it("the order holds on a status of PARTIAL too", () => {
    expect(
      classifyPass({
        status: "PARTIAL",
        interrupted: false,
        results: [
          { ok: true },
          { ok: false, failure: { retryable: false, database: "PERMANENT" } },
        ],
      }),
    ).toBe("FAILED_BLOCKED");
    expect(
      classifyPass({
        status: "PARTIAL",
        interrupted: false,
        results: [{ ok: true }, { ok: false, failure: { retryable: false } }],
      }),
    ).toBe("SUCCEEDED");
  });
});
