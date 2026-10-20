import { beforeEach, describe, expect, it, vi } from "vitest";

import { setupFreshness } from "@/lib/entry-zone/freshness";
import { MarketDataError } from "@/lib/market-data/provider";
import {
  MAX_ATTEMPTS,
  StaleCandlesError,
  classifyPass,
  recordPass,
  startSchedule,
} from "@/lib/scanner";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";
import type { MarketSummary } from "@/types/market";

/**
 * Stale candles are a failure, never a fresh pass.
 *
 * `getCandles` answers from the cache, flagged `stale: true`, when the exchange
 * fails. The scanner used to drop the flag: a laptop waking before its network
 * analysed every market on candles from before the latest close, called the
 * pass COMPLETED, marked the window covered, skipped the failed-pass retry, and
 * left every setup looking freshly re-confirmed to the entry-zone monitor.
 *
 * Persistence is a recording stub: rows are kept in memory, and the
 * entry-zone freshness query is answered from them with the filters the real
 * one sends. No database, no network.
 */

const CANDLES = pullbackIntoSupport();
const NOW = CANDLES.at(-1)!.closeTime + 1;

const rows: Record<string, unknown>[] = [];
const runs: { id: string; status: string; completedAt: Date | null }[] = [];

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: {
    scannerRun: {
      create: async () => {
        runs.push({ id: `run-${runs.length + 1}`, status: "RUNNING", completedAt: null });
        return { id: runs.at(-1)!.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
        const run = runs.find((r) => r.id === where.id)!;
        run.status = data.status;
        run.completedAt = new Date(NOW + 60_000);
        return run;
      },
    },
    scannerResult: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        rows.push(...data);
        return { count: data.length };
      },
      // The entry-zone monitor's freshness query, answered from the rows above
      // with the same filters it sends: OK results, for these setups, on a
      // successful (COMPLETED or PARTIAL) run.
      findMany: async ({ where }: { where: { trackedSetupId: { in: string[] } } }) =>
        rows
          .filter(
            (r) =>
              r.status === "OK" &&
              where.trackedSetupId.in.includes(r.trackedSetupId as string) &&
              ["COMPLETED", "PARTIAL"].includes(runs.find((x) => x.id === r.scannerRunId)!.status),
          )
          .map((r) => ({
            trackedSetupId: r.trackedSetupId,
            scannerRun: { completedAt: runs.find((x) => x.id === r.scannerRunId)!.completedAt },
          })),
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

/** Which (symbol, timeframe) reads are stale; everything else is fresh. */
const staleReads = new Set<string>();
async function readCandles(q: { exchangeSymbol: string; timeframe: string }) {
  const stale = staleReads.has(`${q.exchangeSymbol}:${q.timeframe}`);
  return { candles: CANDLES, stale, source: stale ? "cache-stale" : "provider" };
}
const getCandles = vi.fn(readCandles);
vi.mock("@/services/candles", () => ({ getCandles: (q: never) => getCandles(q) }));

/** Every market already has a tracked setup, which an unchanged pass re-confirms. */
const trackSetup = vi.fn(async (input: { tradingPairId: string }) => ({
  action: "NONE",
  setupId: `setup-${input.tradingPairId}`,
  status: null,
  reason: "unchanged",
  cause: "UNCHANGED",
}));
vi.mock("@/services/setups", () => ({ trackSetup: (i: never) => trackSetup(i) }));

const { runScan } = await import("./scanner");
const { latestVerifiedScans } = await import("./entry-zone-monitor");

const MARKETS = [
  { pairId: "btc", exchangeSymbol: "BTCUSDT", label: "BTC/USDT" },
  { pairId: "eth", exchangeSymbol: "ETHUSDT", label: "ETH/USDT" },
] as MarketSummary[];

const scan = () =>
  runScan({ userId: "user-1", now: NOW, markets: MARKETS, timeframes: ["H1"], maxConcurrency: 1 });

beforeEach(() => {
  rows.length = 0;
  runs.length = 0;
  staleReads.clear();
  getCandles.mockReset();
  getCandles.mockImplementation(readCandles);
  trackSetup.mockClear();
});

describe("fresh candles", () => {
  it("are analysed, tracked and recorded as an OK result — the pass is unchanged", async () => {
    const summary = await scan();

    expect(summary.status).toBe("COMPLETED");
    expect(summary.results.every((r) => r.ok)).toBe(true);
    expect(trackSetup).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.status)).toEqual(["OK", "OK"]);
  });
});

describe("stale candles on every market (a laptop waking before its network)", () => {
  beforeEach(() => {
    staleReads.add("BTCUSDT:H1").add("ETHUSDT:H1");
  });

  it("fail each market with a typed, retryable stale-data failure — not an empty result", async () => {
    const summary = await scan();

    for (const result of summary.results) {
      expect(result.ok).toBe(false);
      expect(result.analysisStatus).toBeNull();
      expect(result.failure).toMatchObject({ category: "MARKET_DATA_ERROR", retryable: true });
      expect(result.failure?.message).toMatch(/Stale candles \(H1\)/);
    }
  });

  it("are retried like any transient provider fault", async () => {
    const summary = await scan();

    expect(summary.results.map((r) => r.attempts)).toEqual([MAX_ATTEMPTS, MAX_ATTEMPTS]);
    // One read per attempt; the higher timeframe is never reached.
    expect(getCandles).toHaveBeenCalledTimes(2 * MAX_ATTEMPTS);
  });

  it("never reach the lifecycle or the confirmation watcher", async () => {
    const summary = await scan();

    expect(trackSetup).not.toHaveBeenCalled();
    expect(summary.observations).toEqual([]);
    expect(summary.events.every((e) => e.type === "ANALYSIS_FAILED")).toBe(true);
    expect(summary.setupsCreated + summary.stateChanges + summary.invalidations).toBe(0);
  });

  it("make the pass FAILED_TRANSIENT, which leaves its window uncovered and schedules a retry", async () => {
    const summary = await scan();
    expect(summary.status).toBe("FAILED");

    const outcome = classifyPass(summary);
    expect(outcome).toBe("FAILED_TRANSIENT");

    // Decided ten minutes after a close, as a wake would be — clear of the
    // settle window, so the next scheduled window is most of an hour away.
    const decidedAt = NOW + 10 * 60_000;
    const before = startSchedule({ timeframes: ["H1"], now: NOW - 3_600_000 });
    const after = recordPass(before, {
      timeframes: ["H1"],
      scanned: ["H1"],
      decidedAt,
      finishedAt: decidedAt + 60_000,
      outcome,
    });
    expect(after.covered).toEqual(before.covered);
    expect(after.retry).toMatchObject({ attempt: 1 });
  });

  it("record FAILED rows with no setup, so no setup is re-verified for entry-zone alerts", async () => {
    await scan();

    expect(rows.map((r) => [r.status, r.trackedSetupId])).toEqual([
      ["FAILED", null],
      ["FAILED", null],
    ]);
    const verified = await latestVerifiedScans(["setup-btc", "setup-eth"], new Date(0));
    expect(verified.size).toBe(0);
  });
});

describe("stale candles on one market", () => {
  it("fail only that market; the others are analysed and re-verified as before", async () => {
    staleReads.add("ETHUSDT:H1");
    const summary = await scan();

    expect(summary.status).toBe("PARTIAL");
    expect(summary.results.find((r) => r.symbol === "ETHUSDT")?.ok).toBe(false);
    expect(trackSetup).toHaveBeenCalledTimes(1);

    const verified = await latestVerifiedScans(["setup-btc", "setup-eth"], new Date(0));
    expect([...verified.keys()]).toEqual(["setup-btc"]);
  });

  it("lets an earlier verification age out, so the stale market's alert is withheld", async () => {
    // A fresh pass verifies ETH; then a stale one does not renew it.
    await scan();
    staleReads.add("ETHUSDT:H1");
    await scan();

    const verified = await latestVerifiedScans(["setup-eth"], new Date(0));
    const lastVerified = verified.get("setup-eth")!;
    expect(lastVerified).toBe(runs[0].completedAt!.getTime());

    // Two hours on, the H1 setup's last real verification is too old to alert on.
    const freshness = setupFreshness({
      verifiedAt: lastVerified,
      timeframe: "H1",
      now: lastVerified + 2 * 3_600_000,
      maxAgeCandles: 1,
    });
    expect(freshness.fresh).toBe(false);
  });
});

describe("a retry that finds the exchange back", () => {
  it("analyses the fresh read on the next attempt", async () => {
    let calls = 0;
    getCandles.mockImplementation(async () => {
      calls += 1;
      // First entry-timeframe read stale; everything after it fresh.
      const stale = calls === 1;
      return { candles: CANDLES, stale, source: stale ? "cache-stale" : "provider" };
    });

    const summary = await runScan({
      userId: "user-1",
      now: NOW,
      markets: MARKETS.slice(0, 1),
      timeframes: ["H1"],
      maxConcurrency: 1,
    });

    expect(summary.status).toBe("COMPLETED");
    expect(summary.results[0]).toMatchObject({ ok: true, attempts: 2 });
    expect(trackSetup).toHaveBeenCalledTimes(1);
  });
});

describe("a stale higher timeframe", () => {
  it("fails the market closed — never analysed single-timeframe instead", async () => {
    staleReads.add("BTCUSDT:H4").add("ETHUSDT:H4");
    const summary = await scan();

    // Phase 1.5: the counter-trend veto lives on the higher timeframe, so a
    // market without a usable one is not analysed at all.
    expect(summary.results.every((r) => !r.ok)).toBe(true);
    expect(summary.results[0].failure?.message).toMatch(/Higher timeframe H4 stale/);
    expect(trackSetup).not.toHaveBeenCalled();
    expect(summary.observations).toEqual([]);
  });
});

describe("StaleCandlesError", () => {
  it("is a retryable provider fault, so it takes the existing failure path", () => {
    const error = new StaleCandlesError("H4");
    expect(error).toBeInstanceOf(MarketDataError);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/not analysed/);
  });
});
