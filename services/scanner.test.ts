import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarketDataError, type Candle, type Timeframe } from "@/lib/market-data/provider";
import { pullbackIntoSupport, downtrend } from "@/lib/test-utils/scenarios";
import type { MarketSummary } from "@/types/market";

// The database is stubbed out entirely: this exercises the pipeline, and Phase
// D already proves the lifecycle against a real one.
vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: false,
  prisma: {},
}));

const getCandles = vi.fn();
vi.mock("@/services/candles", () => ({ getCandles: (q: unknown) => getCandles(q) }));

const trackSetup = vi.fn();
vi.mock("@/services/setups", () => ({ trackSetup: (i: unknown) => trackSetup(i) }));

const { runScan } = await import("./scanner");

/**
 * The scan pipeline: forty-five markets, two timeframes, bounded concurrency,
 * and failures that stay where they happen.
 */

const BULLISH = pullbackIntoSupport();
const BEARISH = downtrend();

/** A universe of the right size, without needing the database or the file. */
function universe(count = 45): MarketSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    pairId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    exchangeSymbol: `SYM${String(i).padStart(2, "0")}USDT`,
    label: `SYM${i}/USDT`,
  })) as MarketSummary[];
}

/** Far past the last candle, so nothing is treated as still forming. */
const AFTER_CLOSE = BULLISH.at(-1)!.closeTime + 1;

beforeEach(() => {
  getCandles.mockReset();
  trackSetup.mockReset();
  getCandles.mockImplementation(async () => ({ candles: BULLISH }));
  trackSetup.mockResolvedValue({
    action: "NONE",
    setupId: null,
    status: null,
    reason: "unchanged",
  });
});

const base = { userId: "user-1", now: AFTER_CLOSE, maxConcurrency: 4 } as const;

describe("a full pass over the universe", () => {
  it("analyses every market on every timeframe", async () => {
    const summary = await runScan({ ...base, markets: universe(), timeframes: ["H1", "H4"] });

    expect(summary.marketCount).toBe(45);
    expect(summary.analysed).toBe(90);
    expect(summary.succeeded).toBe(90);
    expect(summary.failed).toBe(0);
    expect(summary.status).toBe("COMPLETED");
  });

  it("keeps the request count proportional and bounded", async () => {
    await runScan({ ...base, markets: universe(), timeframes: ["H1", "H4"] });

    // Two requests per analysis: the entry timeframe and its higher one.
    expect(getCandles).toHaveBeenCalledTimes(180);

    // And every one goes through the shared data layer, which is what keeps a
    // second Binance client from appearing.
    for (const [query] of getCandles.mock.calls) {
      expect(query).toHaveProperty("exchangeSymbol");
      expect(query).toHaveProperty("timeframe");
    }
  });

  it("never has more than the configured number of analyses in flight", async () => {
    let inFlight = 0;
    let peak = 0;

    getCandles.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { candles: BULLISH };
    });

    await runScan({ ...base, markets: universe(), timeframes: ["H1"], maxConcurrency: 4 });

    // Each analysis makes two sequential requests, so in-flight requests never
    // exceed the analysis ceiling.
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("counts the no-trade outcomes, not only the setups", async () => {
    // A scan where most markets say nothing is the tool working. A summary
    // that only counted setups would make that look like a failed scan.
    getCandles.mockImplementation(async () => ({ candles: BEARISH }));

    const summary = await runScan({
      ...base,
      now: BEARISH.at(-1)!.closeTime + 1,
      markets: universe(10),
      timeframes: ["H1"],
    });

    expect(summary.avoided).toBe(10);
    expect(summary.potentialSetups).toBe(0);
    expect(summary.succeeded).toBe(10);
  });
});

describe("failure isolation", () => {
  it("lets one market fail without touching the other forty-four", async () => {
    getCandles.mockImplementation(async (query: { exchangeSymbol: string }) => {
      if (query.exchangeSymbol.startsWith("SYM00")) {
        throw new MarketDataError("BAD_RESPONSE", "garbage payload");
      }
      return { candles: BULLISH };
    });

    const summary = await runScan({ ...base, markets: universe(), timeframes: ["H1"] });

    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(44);
    expect(summary.status).toBe("PARTIAL");

    const failure = summary.results.find((r) => !r.ok)!;
    expect(failure.symbol).toBe("SYM00USDT");
    expect(failure.failure?.category).toBe("INVALID_DATA");
  });

  it("reports FAILED only when nothing at all could be analysed", async () => {
    getCandles.mockRejectedValue(new MarketDataError("BAD_RESPONSE", "garbage"));

    const summary = await runScan({ ...base, markets: universe(5), timeframes: ["H1"] });

    expect(summary.status).toBe("FAILED");
    expect(summary.succeeded).toBe(0);
    expect(summary.events.every((e) => e.type === "ANALYSIS_FAILED")).toBe(true);
  });

  it("retries a transient fault and records how many attempts it took", async () => {
    let calls = 0;
    getCandles.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new MarketDataError("TIMEOUT", "slow");
      return { candles: BULLISH };
    });

    const summary = await runScan({ ...base, markets: universe(1), timeframes: ["H1"] });

    expect(summary.succeeded).toBe(1);
    expect(summary.results[0].attempts).toBe(2);
  });

  it("carries on when only the higher timeframe is unavailable", async () => {
    getCandles.mockImplementation(async (query: { timeframe: Timeframe }) => {
      if (query.timeframe === "H4") throw new MarketDataError("TIMEOUT", "slow");
      return { candles: BULLISH };
    });

    const summary = await runScan({ ...base, markets: universe(3), timeframes: ["H1"] });

    // Losing higher-timeframe context makes a run less informed, not wrong.
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
  });
});

describe("closed candles only", () => {
  it("never hands the engine a candle that is still forming", async () => {
    const midCandle = BULLISH.at(-1)!.openTime + 1_000;

    await runScan({ ...base, now: midCandle, markets: universe(1), timeframes: ["H1"] });

    const passed = trackSetup.mock.calls[0][0].result;
    // The analysis was run on the previous candle, not the one being written.
    expect(passed.read.lastCandleTime).toBe(BULLISH[BULLISH.length - 2].openTime);
  });

  it("fails the market cleanly when no candle has closed yet", async () => {
    const summary = await runScan({
      ...base,
      now: BULLISH[0].openTime - 1,
      markets: universe(1),
      timeframes: ["H1"],
    });

    expect(summary.failed).toBe(1);
    expect(summary.results[0].failure?.message).toMatch(/no closed candles/i);
  });
});

describe("idempotency", () => {
  it("produces an identical analysis when re-run inside the same candle", async () => {
    // The scanner's half of the guarantee: the input does not move until the
    // candle closes, so the verdict cannot either. Phase D's lifecycle then
    // writes nothing for an unchanged verdict.
    const midCandle = BULLISH.at(-1)!.openTime + 5_000;
    const options = {
      ...base,
      now: midCandle,
      markets: universe(3),
      timeframes: ["H1"] as Timeframe[],
    };

    await runScan({ ...options });
    const first = trackSetup.mock.calls.map((c) => JSON.stringify(c[0].result));

    trackSetup.mockClear();
    await runScan({ ...options });
    const second = trackSetup.mock.calls.map((c) => JSON.stringify(c[0].result));

    expect(second).toEqual(first);
  });

  it("emits no events when the lifecycle reports nothing changed", async () => {
    const summary = await runScan({ ...base, markets: universe(45), timeframes: ["H1"] });

    expect(trackSetup).toHaveBeenCalledTimes(45);
    expect(summary.events).toEqual([]);
    expect(summary.setupsCreated).toBe(0);
    expect(summary.stateChanges).toBe(0);
  });

  it("reports events exactly once when the lifecycle does act", async () => {
    trackSetup.mockResolvedValue({
      action: "CREATE",
      setupId: "setup-1",
      status: "POTENTIAL_SETUP",
      reason: null,
    });

    const summary = await runScan({ ...base, markets: universe(2), timeframes: ["H1"] });

    expect(summary.setupsCreated).toBe(2);
    expect(summary.events).toHaveLength(2);
  });

  it("delegates identity to the lifecycle rather than deciding it again", async () => {
    await runScan({ ...base, markets: universe(1), timeframes: ["H1"] });

    const call = trackSetup.mock.calls[0][0];
    expect(call).toMatchObject({ userId: "user-1", timeframe: "H1" });
    expect(call.result).toHaveProperty("confirmation");
  });
});

describe("ranking", () => {
  it("returns every market ranked, losers included", async () => {
    getCandles.mockImplementation(async (query: { exchangeSymbol: string }) => ({
      candles: query.exchangeSymbol === "SYM00USDT" ? BULLISH : BEARISH,
    }));

    const summary = await runScan({ ...base, markets: universe(5), timeframes: ["H1"] });

    expect(summary.results).toHaveLength(5);
    // The one potential setup sorts to the top; the four avoids follow.
    expect(summary.results[0].analysisStatus).toBe("POTENTIAL_SETUP");
    expect(summary.results.slice(1).every((r) => r.analysisStatus === "AVOID")).toBe(true);
  });

  it("orders the same results the same way every time", async () => {
    const options = { ...base, markets: universe(20), timeframes: ["H1"] as Timeframe[] };

    const a = await runScan({ ...options });
    const b = await runScan({ ...options });

    expect(b.results.map((r) => r.symbol)).toEqual(a.results.map((r) => r.symbol));
  });
});

describe("aborting", () => {
  it("stops starting new markets once the scan is cancelled", async () => {
    const controller = new AbortController();
    let started = 0;

    getCandles.mockImplementation(async () => {
      started += 1;
      if (started === 3) controller.abort();
      return { candles: BULLISH as Candle[] };
    });

    const summary = await runScan({
      ...base,
      markets: universe(45),
      timeframes: ["H1"],
      signal: controller.signal,
      maxConcurrency: 1,
    });

    expect(started).toBeLessThan(45);
    expect(summary.analysed).toBe(45);
  });
});
