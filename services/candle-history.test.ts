import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarketDataError, TIMEFRAME_MS, type Candle } from "@/lib/market-data/provider";
import { makeCandles } from "@/lib/test-utils/candles";

const getCandles = vi.fn();
vi.mock("@/lib/market-data", () => ({
  getMarketDataProvider: () => ({ getCandles }),
}));

const { loadCandleHistory, MAX_HISTORY_CANDLES } = await import("./candle-history");

/**
 * Pagination is what removed the 740-candle ceiling, and it is exactly the kind
 * of code that fails quietly: a duplicated page or a silently short series
 * produces numbers that look identical to correct ones.
 */

const STEP = TIMEFRAME_MS.H1;
const START = Date.UTC(2026, 0, 1);

/** A contiguous run of candles beginning at `from`. */
function page(from: number, count: number): Candle[] {
  return makeCandles(
    Array.from({ length: count }, (_, i) => 100 + i),
    { timeframe: "H1", startTime: from },
  );
}

beforeEach(() => {
  getCandles.mockReset();
  // A safe default, so a test that runs out of queued `...Once` values gets an
  // empty page rather than inheriting the previous test's implementation.
  getCandles.mockResolvedValue([]);
});

describe("paging a range", () => {
  it("returns a single page unchanged", async () => {
    getCandles.mockResolvedValueOnce(page(START, 50));

    const history = await loadCandleHistory({
      exchangeSymbol: "BTCUSDT",
      timeframe: "H1",
      from: START,
      to: START + 49 * STEP,
    });

    expect(history.candles).toHaveLength(50);
    expect(history.requests).toBe(1);
    expect(history.incomplete).toBe(false);
  });

  it("stitches several pages into one chronological series", async () => {
    getCandles
      .mockResolvedValueOnce(page(START, 1000))
      .mockResolvedValueOnce(page(START + 1000 * STEP, 1000))
      .mockResolvedValueOnce(page(START + 2000 * STEP, 400));

    const history = await loadCandleHistory({
      exchangeSymbol: "BTCUSDT",
      timeframe: "H1",
      from: START,
      to: START + 2399 * STEP,
    });

    expect(history.candles).toHaveLength(2400);
    expect(history.requests).toBe(3);

    // Strictly increasing: the property everything downstream assumes.
    for (let i = 1; i < history.candles.length; i += 1) {
      expect(history.candles[i].openTime).toBeGreaterThan(history.candles[i - 1].openTime);
    }
  });

  it("drops the repeated candle each page begins with", async () => {
    // The exchange treats `from` as inclusive, so page two starts by repeating
    // the last candle of page one. Without the filter the series would be full
    // of duplicates and every downstream count would be wrong.
    getCandles
      .mockResolvedValueOnce(page(START, 100))
      .mockResolvedValueOnce(page(START + 99 * STEP, 100));

    const history = await loadCandleHistory({
      exchangeSymbol: "BTCUSDT",
      timeframe: "H1",
      from: START,
      to: START + 198 * STEP,
    });

    const times = history.candles.map((c) => c.openTime);
    expect(new Set(times).size).toBe(times.length);
    expect(history.candles).toHaveLength(199);
  });

  it("stops rather than looping when a page makes no progress", async () => {
    // A provider returning the same page forever would otherwise be an
    // unbounded request loop against a public endpoint.
    getCandles.mockResolvedValue(page(START, 100));

    const history = await loadCandleHistory({
      exchangeSymbol: "BTCUSDT",
      timeframe: "H1",
      from: START,
      to: START + 5000 * STEP,
    });

    expect(history.requests).toBe(2);
    expect(history.incomplete).toBe(true);
    expect(history.notes.join(" ")).toMatch(/stopped returning data/i);
  });

  it("reports a provider failure instead of returning a short series as complete", async () => {
    getCandles
      .mockResolvedValueOnce(page(START, 1000))
      .mockImplementation(() => Promise.reject(new MarketDataError("BAD_RESPONSE", "garbage")));

    const history = await loadCandleHistory({
      exchangeSymbol: "BTCUSDT",
      timeframe: "H1",
      from: START,
      to: START + 3000 * STEP,
    });

    expect(history.candles).toHaveLength(1000);
    expect(history.incomplete).toBe(true);
    expect(history.notes.join(" ")).toMatch(/provider failed/i);
  });

  it("retries a transient failure rather than giving up on the range", async () => {
    getCandles
      .mockRejectedValueOnce(new MarketDataError("TIMEOUT", "slow"))
      .mockResolvedValueOnce(page(START, 100));

    const history = await loadCandleHistory({
      exchangeSymbol: "BTCUSDT",
      timeframe: "H1",
      from: START,
      to: START + 99 * STEP,
    });

    expect(history.candles).toHaveLength(100);
    expect(history.incomplete).toBe(false);
  });

  it("says so when the pair was listed later than the requested start", async () => {
    const later = START + 500 * STEP;
    getCandles.mockResolvedValueOnce(page(later, 100));

    const history = await loadCandleHistory({
      exchangeSymbol: "NEWUSDT",
      timeframe: "H1",
      from: START,
      to: later + 99 * STEP,
    });

    expect(history.notes.join(" ")).toMatch(/probably not listed yet/i);
  });

  it("reports an empty range honestly", async () => {
    getCandles.mockResolvedValueOnce([]);

    const history = await loadCandleHistory({
      exchangeSymbol: "BTCUSDT",
      timeframe: "H1",
      from: START,
      to: START + 100 * STEP,
    });

    expect(history.candles).toEqual([]);
    expect(history.incomplete).toBe(true);
  });

  it("stops at the per-run ceiling and says it stopped", async () => {
    getCandles.mockImplementation((...args: unknown[]) => {
      const limit = args[2] as number;
      const range = args[3] as { from: number };
      return Promise.resolve(page(range.from, limit));
    });

    const history = await loadCandleHistory({
      exchangeSymbol: "BTCUSDT",
      timeframe: "H1",
      from: START,
      to: START + (MAX_HISTORY_CANDLES + 5000) * STEP,
    });

    expect(history.candles.length).toBe(MAX_HISTORY_CANDLES);
    expect(history.incomplete).toBe(true);
    expect(history.notes.join(" ")).toMatch(/ceiling/i);
  });

  it("asks for the same pages in the same order every time", async () => {
    const setup = () => {
      getCandles.mockReset();
      getCandles
        .mockResolvedValueOnce(page(START, 1000))
        .mockResolvedValueOnce(page(START + 1000 * STEP, 500));
    };

    setup();
    const first = await loadCandleHistory({
      exchangeSymbol: "BTCUSDT",
      timeframe: "H1",
      from: START,
      to: START + 1499 * STEP,
    });
    const firstCalls = getCandles.mock.calls.map((c) => JSON.stringify(c[3]));

    setup();
    const second = await loadCandleHistory({
      exchangeSymbol: "BTCUSDT",
      timeframe: "H1",
      from: START,
      to: START + 1499 * STEP,
    });
    const secondCalls = getCandles.mock.calls.map((c) => JSON.stringify(c[3]));

    expect(secondCalls).toEqual(firstCalls);
    expect(second.candles.length).toBe(first.candles.length);
  });
});
