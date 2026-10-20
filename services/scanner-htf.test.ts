import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarketDataError, type Candle } from "@/lib/market-data/provider";
import { classifyPass } from "@/lib/scanner";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";
import type { MarketSummary } from "@/types/market";

/**
 * The scanner fails closed on the higher timeframe.
 *
 * H1 is read against H4. Without a usable H4 — unavailable, stale, short or
 * invalid — the counter-trend veto never runs, so the scanner used to analyse
 * single-timeframe and could call a bounce inside a downtrend a potential
 * setup, then track it, watch its confirmation and re-verify it for entry-zone
 * alerts. Now the market fails with the reason, and nothing downstream sees it.
 *
 * Persistence is a recording stub, and the entry-zone freshness query is
 * answered from the recorded rows with the filters the real one sends. No
 * database, no network.
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
        run.completedAt = new Date(NOW + 60_000 * runs.length);
        return run;
      },
    },
    scannerResult: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        rows.push(...data);
        return { count: data.length };
      },
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

/** What the cache answers for H4. H1 is always fresh. */
let h4: { candles: Candle[]; stale?: boolean } | Error = { candles: CANDLES };
const getCandles = vi.fn(async (q: { timeframe: string }) => {
  if (q.timeframe === "H4") {
    if (h4 instanceof Error) throw h4;
    return { candles: h4.candles, stale: h4.stale ?? false, source: "provider" };
  }
  return { candles: CANDLES, stale: false, source: "provider" };
});
vi.mock("@/services/candles", () => ({ getCandles: (q: never) => getCandles(q) }));

const trackSetup = vi.fn(async () => ({
  action: "NONE",
  setupId: "setup-btc",
  status: null,
  reason: "unchanged",
  cause: "UNCHANGED",
}));
vi.mock("@/services/setups", () => ({ trackSetup: () => trackSetup() }));

const { runScan } = await import("./scanner");
const { latestVerifiedScans } = await import("./entry-zone-monitor");

const MARKET = [{ pairId: "btc", exchangeSymbol: "BTCUSDT", label: "BTC/USDT" }] as MarketSummary[];
const scan = () =>
  runScan({ userId: "user-1", now: NOW, markets: MARKET, timeframes: ["H1"], maxConcurrency: 1 });

beforeEach(() => {
  rows.length = 0;
  runs.length = 0;
  h4 = { candles: CANDLES };
  getCandles.mockClear();
  trackSetup.mockClear();
});

/** The four things a usable analysis feeds, all checked together. */
async function expectNothingDownstream(summary: Awaited<ReturnType<typeof scan>>) {
  expect(summary.results[0].ok).toBe(false);
  expect(summary.results[0].analysisStatus).toBeNull();
  // No setup created, moved or re-confirmed.
  expect(trackSetup).not.toHaveBeenCalled();
  // No confirmation reading reaches the watcher.
  expect(summary.observations).toEqual([]);
  // The stored row is a failure with no setup, so it cannot re-verify one for
  // an entry-zone alert.
  expect(rows.at(-1)).toMatchObject({ status: "FAILED", trackedSetupId: null });
  expect((await latestVerifiedScans(["setup-btc"], new Date(0))).size).toBe(0);
}

describe("fresh H1 and H4", () => {
  it("is analysed with the H4 trend, tracked, watched and verified", async () => {
    const summary = await scan();

    expect(summary.results[0]).toMatchObject({ ok: true, mtfAgreement: "ALIGNED_BULLISH" });
    expect(trackSetup).toHaveBeenCalledTimes(1);
    expect(summary.observations).toHaveLength(1);
    expect([...(await latestVerifiedScans(["setup-btc"], new Date(0))).keys()]).toEqual([
      "setup-btc",
    ]);
  });
});

describe("an unusable H4", () => {
  it("stale (served from cache): fails retryably; nothing downstream", async () => {
    h4 = { candles: CANDLES, stale: true };
    const summary = await scan();

    expect(summary.results[0].failure).toMatchObject({ retryable: true });
    expect(summary.results[0].failure?.message).toMatch(/Higher timeframe H4 stale/);
    expect(classifyPass(summary)).toBe("FAILED_TRANSIENT");
    await expectNothingDownstream(summary);
  });

  it("stale (newest candles missing): fails retryably; nothing downstream", async () => {
    h4 = { candles: CANDLES.slice(0, -30) };
    const summary = await scan();

    expect(summary.results[0].failure?.message).toMatch(/Higher timeframe H4 stale/);
    await expectNothingDownstream(summary);
  });

  it("unavailable (a transient fetch error): fails retryably; nothing downstream", async () => {
    h4 = new MarketDataError("TIMEOUT", "slow");
    const summary = await scan();

    expect(summary.results[0].failure).toMatchObject({ retryable: true });
    expect(summary.results[0].failure?.message).toMatch(/Higher timeframe H4 unavailable/);
    await expectNothingDownstream(summary);
  });

  it("unavailable (a permanent fetch error): fails, not retried", async () => {
    h4 = new MarketDataError("UNKNOWN_SYMBOL", "not listed");
    const summary = await scan();

    expect(summary.results[0]).toMatchObject({ attempts: 1, failure: { retryable: false } });
    await expectNothingDownstream(summary);
  });

  it("insufficient: fails as invalid data, not retried; the pass fails for good", async () => {
    h4 = { candles: CANDLES.slice(-20) };
    const summary = await scan();

    expect(summary.results[0].failure).toMatchObject({
      category: "INVALID_DATA",
      retryable: false,
    });
    expect(summary.results[0].failure?.message).toMatch(/insufficient/);
    expect(classifyPass(summary)).toBe("FAILED_PERMANENT");
    await expectNothingDownstream(summary);
  });

  it("invalid (out of order): fails as invalid data; nothing downstream", async () => {
    h4 = { candles: [...CANDLES].reverse() };
    const summary = await scan();

    expect(summary.results[0].failure).toMatchObject({ category: "INVALID_DATA" });
    expect(summary.results[0].failure?.message).toMatch(/Higher timeframe H4 invalid/);
    await expectNothingDownstream(summary);
  });
});

describe("recovery", () => {
  it("analyses, tracks and re-verifies again once valid H4 data returns", async () => {
    h4 = { candles: CANDLES, stale: true };
    const failed = await scan();
    expect(failed.results[0].ok).toBe(false);
    expect(trackSetup).not.toHaveBeenCalled();

    h4 = { candles: CANDLES };
    const recovered = await scan();
    expect(recovered.results[0]).toMatchObject({ ok: true, mtfAgreement: "ALIGNED_BULLISH" });
    expect(trackSetup).toHaveBeenCalledTimes(1);
    expect(recovered.observations).toHaveLength(1);

    // Verified by the recovered pass — the second run — not by the failed one.
    const verified = await latestVerifiedScans(["setup-btc"], new Date(0));
    expect(verified.get("setup-btc")).toBe(runs[1].completedAt!.getTime());
  });
});
