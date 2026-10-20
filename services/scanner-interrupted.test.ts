import { beforeEach, describe, expect, it, vi } from "vitest";

import { successfulPassWhere } from "@/lib/scanner";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";
import type { MarketSummary } from "@/types/market";

/**
 * A pass stopped part-way — Ctrl-C, SIGTERM, the engine going away.
 *
 * The markets it never reached failed, the ones it did succeeded, and so it was
 * recorded PARTIAL: a successful pass. That cancelled the next startup
 * catch-up (setups stayed unverified until the next close) and let the pass
 * vouch for setup freshness. An interrupted pass is now FAILED. A pass whose
 * failures were the exchange's own is still PARTIAL.
 */

const BULLISH = pullbackIntoSupport();
const AFTER_CLOSE = BULLISH.at(-1)!.closeTime + 1;

let controller = new AbortController();
let calls = 0;
let abortOnCall = 0;
let failSymbols = new Set<string>();

vi.mock("@/services/candles", () => ({
  getCandles: async (q: { exchangeSymbol: string }) => {
    calls += 1;
    if (calls === abortOnCall) controller.abort(); // the stop arrives during this request
    if (failSymbols.has(q.exchangeSymbol)) throw new Error("HTTP 500 from exchange");
    return { candles: BULLISH };
  },
}));
let abortWhileTracking: string | null = null;
vi.mock("@/services/setups", () => ({
  // Called once per market, after its analysis succeeded.
  trackSetup: async (input: { tradingPairId: string }) => {
    if (input.tradingPairId === abortWhileTracking) controller.abort();
    return { action: "NONE", setupId: null, status: null, reason: "unchanged" };
  },
}));

const written: { status?: string; completedAt?: Date; results?: number } = {};
const db = {
  scannerRun: {
    create: vi.fn(async () => ({ id: "run-1" })),
    update: vi.fn((args: { data: { status: string; completedAt: Date } }) => {
      written.status = args.data.status;
      written.completedAt = args.data.completedAt;
      return args;
    }),
  },
  scannerResult: {
    createMany: vi.fn((args: { data: unknown[] }) => {
      written.results = args.data.length;
      return args;
    }),
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

function scan(markets = universe(20)) {
  return runScan({
    userId: "user-1",
    markets,
    timeframes: ["H1"],
    maxConcurrency: 1,
    now: AFTER_CLOSE,
    signal: controller.signal,
  });
}

beforeEach(() => {
  controller = new AbortController();
  calls = 0;
  abortOnCall = 0;
  abortWhileTracking = null;
  failSymbols = new Set();
  dbState.configured = false;
  for (const key of Object.keys(written)) delete written[key as keyof typeof written];
  vi.clearAllMocks();
});

describe("an interrupted pass", () => {
  it("is FAILED, not PARTIAL — so it is not a successful pass", async () => {
    abortOnCall = 3; // Ctrl-C while the third market is fetched

    const summary = await scan();

    expect(summary.interrupted).toBe(true);
    expect(summary.status).toBe("FAILED");
    expect(summary.succeeded).toBeGreaterThan(0); // some markets did finish…
    expect(summary.failed).toBeGreaterThan(10); // …and most were never reached
    expect(successfulPassWhere().status.in).not.toContain(summary.status);
  });

  it("is stored FAILED with its results — the markets it reached keep their rows", async () => {
    dbState.configured = true;
    abortOnCall = 3;

    const summary = await scan();

    expect(written.status).toBe("FAILED");
    expect(written.completedAt).toBeInstanceOf(Date);
    expect(written.results).toBe(summary.analysed);
  });

  it("stopped before any market: FAILED", async () => {
    controller.abort();
    const summary = await scan();
    expect(summary).toMatchObject({ interrupted: true, status: "FAILED", succeeded: 0 });
  });

  it("a stop after every market succeeded interrupted nothing: still COMPLETED", async () => {
    abortWhileTracking = "pair-19"; // the last market, after its analysis succeeded
    const summary = await scan();
    expect(summary).toMatchObject({ interrupted: false, status: "COMPLETED", failed: 0 });
  });
});

describe("a pass that was not interrupted keeps the existing statuses", () => {
  it("some markets failing on their own: PARTIAL, as before", async () => {
    failSymbols = new Set(["S03USDT", "S07USDT"]);
    const summary = await scan();
    expect(summary).toMatchObject({ interrupted: false, status: "PARTIAL", failed: 2 });
  });

  it("every market failing: FAILED", async () => {
    failSymbols = new Set(universe(5).map((m) => m.exchangeSymbol));
    const summary = await scan(universe(5));
    expect(summary).toMatchObject({ interrupted: false, status: "FAILED", succeeded: 0 });
  });

  it("no failures: COMPLETED", async () => {
    expect(await scan(universe(5))).toMatchObject({ interrupted: false, status: "COMPLETED" });
  });

  it("an empty universe is COMPLETED, as before", async () => {
    expect(await scan([])).toMatchObject({ interrupted: false, status: "COMPLETED", analysed: 0 });
  });
});
