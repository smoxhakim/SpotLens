import { describe, expect, it, vi } from "vitest";

import { TIMEFRAME_MS } from "@/lib/market-data/provider";
import { MarketDataError } from "@/lib/market-data/provider";
import { makeCandles } from "@/lib/test-utils/candles";

import { mapWithConcurrency } from "./concurrency";
import { eventsForOutcome, failureEvent } from "./events";
import { MAX_ATTEMPTS, classifyFailure, withRetries } from "./failures";
import { effectiveRiskReward, rankResults } from "./ranking";
import {
  DEFAULT_CLOSE_DELAY_MS,
  closedCandlesOnly,
  currentCandleOpen,
  nextCandleClose,
  nextScanWindow,
} from "./schedule";

/**
 * Everything the scanner decides lives in this module, so this is where the
 * behaviour is pinned down. The service that performs the I/O owns no rules of
 * its own.
 */

describe("candle-close scheduling", () => {
  const H1 = TIMEFRAME_MS.H1;
  const H4 = TIMEFRAME_MS.H4;

  it("floors to the open of the candle currently forming, in UTC", () => {
    const now = Date.UTC(2026, 0, 1, 9, 45, 0);
    expect(currentCandleOpen("H1", now)).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
    expect(currentCandleOpen("H4", now)).toBe(Date.UTC(2026, 0, 1, 8, 0, 0));
  });

  it("opens weekly candles on Monday, not on the epoch's Thursday", () => {
    const wednesday = Date.UTC(2026, 0, 7, 12, 0, 0);
    const open = currentCandleOpen("W1", wednesday);
    expect(new Date(open).getUTCDay()).toBe(1);
  });

  it("wakes a fixed delay after the next close", () => {
    const now = Date.UTC(2026, 0, 1, 9, 45, 0);
    const window = nextScanWindow(["H1"], now, DEFAULT_CLOSE_DELAY_MS);

    expect(window.at).toBe(Date.UTC(2026, 0, 1, 10, 0, 0) + DEFAULT_CLOSE_DELAY_MS);
    expect(window.timeframes).toEqual(["H1"]);
  });

  it("groups timeframes that close at the same instant into one pass", () => {
    // 11:45 UTC — the next H1 close is 12:00, which is also an H4 close.
    const now = Date.UTC(2026, 0, 1, 11, 45, 0);
    const window = nextScanWindow(["H1", "H4"], now, 0);

    expect(window.at).toBe(Date.UTC(2026, 0, 1, 12, 0, 0));
    // Shortest first, whatever order they were configured in.
    expect(window.timeframes).toEqual(["H1", "H4"]);
    expect(nextScanWindow(["H4", "H1"], now, 0).timeframes).toEqual(["H1", "H4"]);
  });

  it("wakes for the shorter timeframe when only it is closing", () => {
    // 09:45 — H1 closes at 10:00, H4 not until 12:00.
    const now = Date.UTC(2026, 0, 1, 9, 45, 0);
    expect(nextScanWindow(["H1", "H4"], now, 0).timeframes).toEqual(["H1"]);
  });

  it("never schedules a wake-up in the past", () => {
    const now = Date.now();
    for (const tf of ["H1", "H4", "D1"] as const) {
      expect(nextCandleClose(tf, now)).toBeGreaterThan(now);
    }
  });

  it("advances by exactly one candle each pass", () => {
    let now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const seen: number[] = [];

    for (let i = 0; i < 4; i += 1) {
      const window = nextScanWindow(["H1"], now, 0);
      seen.push(window.at);
      now = window.at + 1;
    }

    expect(seen).toEqual([H1, H1 * 2, H1 * 3, H1 * 4].map((ms) => Date.UTC(2026, 0, 1) + ms));
    expect(H4 / H1).toBe(4);
  });
});

describe("forming candles", () => {
  const candles = makeCandles([100, 101, 102, 103], { timeframe: "H1" });

  it("drops a candle that has not closed yet", () => {
    // A moment inside the final candle: it is still being written.
    const midLastCandle = candles.at(-1)!.openTime + 60_000;
    const closed = closedCandlesOnly(candles, midLastCandle);

    expect(closed).toHaveLength(candles.length - 1);
    expect(closed.at(-1)).toBe(candles[candles.length - 2]);
  });

  it("keeps every candle once the last one has closed", () => {
    const afterClose = candles.at(-1)!.closeTime + 1;
    expect(closedCandlesOnly(candles, afterClose)).toHaveLength(candles.length);
  });

  it("returns the same closed set at any point inside one candle", () => {
    // This is what makes a repeated scan idempotent: the input does not move
    // until the candle closes, so neither does the verdict.
    const open = candles.at(-1)!.openTime;
    const a = closedCandlesOnly(candles, open + 1_000);
    const b = closedCandlesOnly(candles, open + 59 * 60_000);

    expect(a).toEqual(b);
  });

  it("handles an empty series without inventing one", () => {
    expect(closedCandlesOnly([], Date.now())).toEqual([]);
  });
});

describe("bounded concurrency", () => {
  it("never exceeds the ceiling", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 90 }, (_, i) => i),
      4,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return null;
      },
    );

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("returns results in input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([30, 1, 20, 2], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });

    expect(out).toEqual([30, 1, 20, 2]);
  });

  it("treats a ceiling below one as one rather than deadlocking", async () => {
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n * 2)).toEqual([2, 4]);
  });

  it("runs every item even when there are fewer than the ceiling", async () => {
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n)).toEqual([1, 2]);
  });
});

describe("failure classification", () => {
  it("separates a transient provider fault from bad data", () => {
    const timeout = classifyFailure(new MarketDataError("TIMEOUT", "took too long"));
    const malformed = classifyFailure(new MarketDataError("BAD_RESPONSE", "not klines"));

    expect(timeout.category).toBe("MARKET_DATA_ERROR");
    expect(timeout.retryable).toBe(true);
    expect(malformed.category).toBe("INVALID_DATA");
    expect(malformed.retryable).toBe(false);
  });

  it("treats an unlisted symbol as bad input, not bad luck", () => {
    const unknown = classifyFailure(new MarketDataError("UNKNOWN_SYMBOL", "no such pair"));
    expect(unknown.category).toBe("INVALID_DATA");
    expect(unknown.retryable).toBe(false);
  });

  it("recognises a database error by its Prisma code", () => {
    const failure = classifyFailure(Object.assign(new Error("nope"), { code: "P2002" }));
    expect(failure.category).toBe("DATABASE_ERROR");
    expect(failure.retryable).toBe(false);
  });

  it("classifies a network blip as retryable", () => {
    expect(classifyFailure(new Error("fetch failed")).retryable).toBe(true);
    expect(classifyFailure(new Error("ECONNRESET")).category).toBe("MARKET_DATA_ERROR");
  });

  it("treats an ordinary bug as an analysis error, not something to retry", () => {
    const failure = classifyFailure(new TypeError("x is not a function"));
    expect(failure.category).toBe("ANALYSIS_ERROR");
    expect(failure.retryable).toBe(false);
  });

  it("never stores a url, a connection string or a long token", () => {
    const leaky = classifyFailure(
      new Error(
        "failed https://api.binance.com/api/v3/klines?symbol=BTC secret=abcdefghijklmnopqrstuvwxyz0123456789 postgresql://u:p@host/db",
      ),
    );

    expect(leaky.message).not.toMatch(/binance\.com/);
    expect(leaky.message).not.toMatch(/postgresql:\/\//);
    expect(leaky.message).not.toMatch(/abcdefghijklmnop/);
    expect(leaky.message).toMatch(/\[url\]/);
  });

  it("keeps stored messages short", () => {
    const long = classifyFailure(new Error("x".repeat(5_000)));
    expect(long.message.length).toBeLessThanOrEqual(200);
  });

  it("survives something that is not an Error at all", () => {
    expect(classifyFailure("just a string").category).toBe("UNKNOWN");
    expect(classifyFailure(null).retryable).toBe(false);
  });
});

describe("retries", () => {
  it("succeeds without retrying when the first attempt works", async () => {
    const task = vi.fn().mockResolvedValue("ok");
    const result = await withRetries(task, { baseDelayMs: 1 });

    expect(result.value).toBe("ok");
    expect(result.attempts).toBe(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("retries a transient fault and stops at the ceiling", async () => {
    const task = vi.fn().mockRejectedValue(new MarketDataError("TIMEOUT", "slow"));
    const result = await withRetries(task, { baseDelayMs: 1 });

    expect(task).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(result.value).toBeNull();
    expect(result.failure?.category).toBe("MARKET_DATA_ERROR");
  });

  it("does not retry a fault that will answer the same way every time", async () => {
    // Retrying a malformed payload costs time and adds load without ever
    // changing the result.
    const task = vi.fn().mockRejectedValue(new MarketDataError("BAD_RESPONSE", "garbage"));
    const result = await withRetries(task, { baseDelayMs: 1 });

    expect(task).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.failure?.category).toBe("INVALID_DATA");
  });

  it("recovers when a later attempt succeeds", async () => {
    const task = vi
      .fn()
      .mockRejectedValueOnce(new MarketDataError("NETWORK_ERROR", "blip"))
      .mockResolvedValue("recovered");

    const result = await withRetries(task, { baseDelayMs: 1 });

    expect(result.value).toBe("recovered");
    expect(result.attempts).toBe(2);
  });

  it("stops immediately once the scan is aborted", async () => {
    const controller = new AbortController();
    const task = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new MarketDataError("TIMEOUT", "slow");
    });

    const result = await withRetries(task, { baseDelayMs: 1, signal: controller.signal });

    expect(task).toHaveBeenCalledTimes(1);
    expect(result.value).toBeNull();
  });
});

describe("deterministic ranking", () => {
  const make = (
    symbol: string,
    analysisStatus: "POTENTIAL_SETUP" | "WAIT_FOR_CONFIRMATION" | "HIGH_RISK" | "AVOID" | null,
    score: number | null,
    riskReward: number | null = null,
    riskRewardIsSynthetic = false,
    timeframe = "H1",
  ) => ({ symbol, timeframe, analysisStatus, score, riskReward, riskRewardIsSynthetic });

  it("puts a potential setup above everything else", () => {
    const ranked = rankResults([
      make("AAA", "AVOID", 90),
      make("BBB", "POTENTIAL_SETUP", 60),
      make("CCC", "WAIT_FOR_CONFIRMATION", 80),
      make("DDD", "HIGH_RISK", 85),
    ]);

    expect(ranked.map((r) => r.symbol)).toEqual(["BBB", "CCC", "DDD", "AAA"]);
  });

  it("orders equal statuses by quality score, highest first", () => {
    const ranked = rankResults([
      make("AAA", "WAIT_FOR_CONFIRMATION", 55),
      make("BBB", "WAIT_FOR_CONFIRMATION", 81),
      make("CCC", "WAIT_FOR_CONFIRMATION", 70),
    ]);

    expect(ranked.map((r) => r.score)).toEqual([81, 70, 55]);
  });

  it("refuses to let an unmeasured reward outrank a measured one", () => {
    // Phase A's rule, carried into ranking: a ratio measured to an R-multiple
    // is the fallback ladder's constant restated, so it counts as zero.
    const synthetic = make("AAA", "WAIT_FOR_CONFIRMATION", 70, 2.5, true);
    const measured = make("BBB", "WAIT_FOR_CONFIRMATION", 70, 1.8, false);

    expect(effectiveRiskReward(synthetic)).toBe(0);
    expect(rankResults([synthetic, measured]).map((r) => r.symbol)).toEqual(["BBB", "AAA"]);
  });

  it("breaks a genuine tie on symbol, so the order never drifts", () => {
    const a = make("ZZZ", "WAIT_FOR_CONFIRMATION", 70, 2, false);
    const b = make("AAA", "WAIT_FOR_CONFIRMATION", 70, 2, false);

    expect(rankResults([a, b]).map((r) => r.symbol)).toEqual(["AAA", "ZZZ"]);
    // And the same list sorts the same way whichever order it arrived in.
    expect(rankResults([b, a]).map((r) => r.symbol)).toEqual(["AAA", "ZZZ"]);
  });

  it("breaks a tie between one market's two timeframes", () => {
    // A pass analyses every market on every scheduled timeframe, so this pair
    // is equal on status, score and reward. Before the timeframe tie-break the
    // order fell out of the sort's stability, which made it depend on the order
    // the jobs were built in rather than on a rule.
    const h1 = make("BTCUSDT", "WAIT_FOR_CONFIRMATION", 70, 2, false, "H1");
    const h4 = make("BTCUSDT", "WAIT_FOR_CONFIRMATION", 70, 2, false, "H4");

    expect(rankResults([h4, h1]).map((r) => r.timeframe)).toEqual(["H1", "H4"]);
    expect(rankResults([h1, h4]).map((r) => r.timeframe)).toEqual(["H1", "H4"]);
  });

  it("sinks failed markets below every analysed one", () => {
    const ranked = rankResults([make("AAA", null, null), make("BBB", "AVOID", 20)]);
    expect(ranked.map((r) => r.symbol)).toEqual(["BBB", "AAA"]);
  });

  it("does not mutate the list it was given", () => {
    const input = [make("ZZZ", "AVOID", 10), make("AAA", "POTENTIAL_SETUP", 90)];
    const before = input.map((r) => r.symbol);

    rankResults(input);

    expect(input.map((r) => r.symbol)).toEqual(before);
  });
});

describe("scanner events", () => {
  const context = { symbol: "BTCUSDT", timeframe: "H1", detail: "because" };

  it("emits nothing when the lifecycle did nothing", () => {
    // The property notifications will rest on: a quiet scan is silent.
    const events = eventsForOutcome({
      ...context,
      outcome: { action: "NONE", setupId: "s1", status: null },
    });

    expect(events).toEqual([]);
  });

  it("reports a created setup", () => {
    const [event] = eventsForOutcome({
      ...context,
      outcome: { action: "CREATE", setupId: "s1", status: "WAITING_CONFIRMATION" },
    });

    expect(event.type).toBe("SETUP_CREATED");
    expect(event.setupId).toBe("s1");
  });

  it("distinguishes an invalidation from an ordinary state change", () => {
    const changed = eventsForOutcome({
      ...context,
      outcome: { action: "TRANSITION", setupId: "s1", status: "CONFIRMATION_DETECTED" },
    });
    const dead = eventsForOutcome({
      ...context,
      outcome: { action: "TRANSITION", setupId: "s1", status: "INVALIDATED" },
    });

    expect(changed[0].type).toBe("SETUP_STATE_CHANGED");
    expect(dead[0].type).toBe("SETUP_INVALIDATED");
  });

  it("reports both halves of a replacement", () => {
    const events = eventsForOutcome({
      ...context,
      outcome: { action: "REPLACE", setupId: "s2", status: "WAITING_CONFIRMATION" },
    });

    expect(events.map((e) => e.type)).toEqual(["SETUP_INVALIDATED", "SETUP_CREATED"]);
  });

  it("carries a failure category without carrying the raw error", () => {
    const event = failureEvent({
      symbol: "BTCUSDT",
      timeframe: "H1",
      category: "MARKET_DATA_ERROR",
      message: "TIMEOUT: took too long",
    });

    expect(event.type).toBe("ANALYSIS_FAILED");
    expect(event.setupId).toBeNull();
    expect(event.failureCategory).toBe("MARKET_DATA_ERROR");
  });
});
