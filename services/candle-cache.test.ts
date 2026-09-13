import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAnalysis } from "@/lib/analysis";
import { closedCandlesOnly } from "@/lib/scanner";
import { TIMEFRAME_MS, type Candle } from "@/lib/market-data/provider";

/**
 * The cache must hand the engine the same candles the provider would.
 *
 * A repeated scan inside one candle was not deterministic, and the engine was
 * not at fault: `runAnalysis` is pure and was proved to agree with itself on
 * identical input. The divergence was upstream. The first pass missed the
 * cache and analysed the provider's candles; the second hit the cache and
 * analysed what had been stored — and those differed, because a candle first
 * written while it was still forming kept its partial values for ever.
 * `createMany({ skipDuplicates: true })` cannot correct a row that is already
 * there, so the partial bar outlived the candle it described.
 *
 * The consequence was setup churn: the same market at the same
 * `analysedAtCandle` scored differently, re-anchored to a different zone, and
 * notified about a market that had not moved.
 *
 * These pin the property that prevents it — a closed candle in storage holds
 * closed values — and then prove the property that matters downstream: same
 * market, same timeframe, same analysed candle, same available data, byte
 * identical input and byte identical result.
 */

const candleFindMany = vi.fn();
const candleFindFirst = vi.fn();
const candleCreateMany = vi.fn();
const candleUpsert = vi.fn();
const providerGetCandles = vi.fn();

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: {
    candle: {
      findMany: (a: unknown) => candleFindMany(a),
      findFirst: (a: unknown) => candleFindFirst(a),
      createMany: (a: unknown) => candleCreateMany(a),
      upsert: (a: unknown) => candleUpsert(a),
    },
  },
}));

vi.mock("@/lib/market-data", () => ({
  getMarketDataProvider: () => ({
    getCandles: (...args: unknown[]) => providerGetCandles(...args),
  }),
}));

const { getCandles } = await import("./candles");

const PAIR = "11111111-1111-4111-8111-111111111111";
const TF = "H1" as const;
const STEP = TIMEFRAME_MS[TF];

/** A deterministic series, so any difference in output comes from the input. */
function series(count: number, endOpenTime: number): Candle[] {
  const out: Candle[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const openTime = endOpenTime - i * STEP;
    const base = 100 + Math.sin(i / 7) * 5;
    out.push({
      openTime,
      closeTime: openTime + STEP - 1,
      open: Number(base.toFixed(8)),
      high: Number((base + 1.5).toFixed(8)),
      low: Number((base - 1.5).toFixed(8)),
      close: Number((base + 0.4).toFixed(8)),
      volume: 1_000 + i,
    });
  }
  return out;
}

/** The same candle as it looks part-way through, before it has closed. */
function partial(candle: Candle): Candle {
  return {
    ...candle,
    high: candle.open + 0.2,
    low: candle.open - 0.2,
    close: candle.open + 0.05,
    volume: candle.volume / 9,
  };
}

/**
 * The candles as data, independent of key order.
 *
 * The provider builds its objects in one order and `readCache` in another, so
 * a raw `JSON.stringify` differs while every value agrees. Key order is a
 * property of the mapping code; what has to match is the series.
 */
function canonical(candles: Candle[]): string {
  return JSON.stringify(
    candles.map((c) => [c.openTime, c.closeTime, c.open, c.high, c.low, c.close, c.volume]),
  );
}

/** A row as the reconciliation read returns it. */
function storedRowOf(c: Candle) {
  return {
    openTime: new Date(c.openTime),
    open: String(c.open),
    high: String(c.high),
    low: String(c.low),
    close: String(c.close),
    volume: String(c.volume),
  };
}

function rowsFor(candles: Candle[]) {
  return candles
    .map((c) => ({
      openTime: new Date(c.openTime),
      open: String(c.open),
      high: String(c.high),
      low: String(c.low),
      close: String(c.close),
      volume: String(c.volume),
      closeTime: new Date(c.closeTime),
    }))
    .reverse();
}

beforeEach(() => {
  for (const fn of [
    candleFindMany,
    candleFindFirst,
    candleCreateMany,
    candleUpsert,
    providerGetCandles,
  ]) {
    fn.mockReset();
  }
  candleCreateMany.mockResolvedValue({ count: 0 });
  candleUpsert.mockResolvedValue({});
  candleFindFirst.mockResolvedValue(null);
});

describe("a candle stored while forming is corrected once it closes", () => {
  it("overwrites the row that was written mid-candle", async () => {
    // The 12:00 candle is already stored, partial, because a scan ran while it
    // was the live bucket. Now it has closed and the provider returns it whole.
    const now = Date.UTC(2026, 8, 13, 13, 41);
    const head = Date.UTC(2026, 8, 13, 13, 0);
    const fetched = series(5, head);
    const previouslyForming = fetched[fetched.length - 2]; // the 12:00 candle

    // The cache read for freshness finds nothing; the reconciliation read
    // finds the 12:00 row as it was stored mid-candle.
    candleFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([storedRowOf(partial(previouslyForming))]);
    providerGetCandles.mockResolvedValue(fetched);

    vi.setSystemTime(now);
    await getCandles({ pairId: PAIR, exchangeSymbol: "XTZUSDT", timeframe: TF, limit: 5 });

    // The stale row is upserted with the closed values…
    const corrected = candleUpsert.mock.calls.find(
      (call) =>
        (
          call[0] as { where: { tradingPairId_timeframe_openTime: { openTime: Date } } }
        ).where.tradingPairId_timeframe_openTime.openTime.getTime() === previouslyForming.openTime,
    );
    expect(corrected).toBeDefined();
    expect(corrected![0].update).toMatchObject({
      high: String(previouslyForming.high),
      close: String(previouslyForming.close),
      volume: String(previouslyForming.volume),
    });

    // …and is not left to `createMany`, which could not have corrected it.
    const inserted = candleCreateMany.mock.calls[0]?.[0].data ?? [];
    expect(
      inserted.some((r: { openTime: Date }) => r.openTime.getTime() === previouslyForming.openTime),
    ).toBe(false);
  });

  it("still bulk-inserts every candle that was never stored", async () => {
    const now = Date.UTC(2026, 8, 13, 13, 41);
    const fetched = series(5, Date.UTC(2026, 8, 13, 13, 0));

    candleFindMany.mockResolvedValue([]);
    providerGetCandles.mockResolvedValue(fetched);

    vi.setSystemTime(now);
    await getCandles({ pairId: PAIR, exchangeSymbol: "XTZUSDT", timeframe: TF, limit: 5 });

    // Four closed candles, none previously stored, one statement.
    expect(candleCreateMany).toHaveBeenCalledTimes(1);
    expect(candleCreateMany.mock.calls[0][0].data).toHaveLength(4);
    expect(candleCreateMany.mock.calls[0][0].skipDuplicates).toBe(true);
    // Nothing stored differs, so nothing is rewritten.
    expect(candleUpsert.mock.calls.filter((c) => c[0].update)).toHaveLength(1); // the forming head only
  });

  it("leaves a correctly stored candle alone", async () => {
    // The ordinary case: everything in the window already matches. One read,
    // no corrections, and the bulk insert skips what is already there.
    const now = Date.UTC(2026, 8, 13, 13, 41);
    const fetched = series(5, Date.UTC(2026, 8, 13, 13, 0));
    const closed = fetched.slice(0, -1);

    candleFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce(closed.map(storedRowOf));
    providerGetCandles.mockResolvedValue(fetched);

    vi.setSystemTime(now);
    await getCandles({ pairId: PAIR, exchangeSymbol: "XTZUSDT", timeframe: TF, limit: 5 });

    expect(candleCreateMany).not.toHaveBeenCalled();
    // Only the forming head is written; no closed row is rewritten.
    expect(candleUpsert).toHaveBeenCalledTimes(1);
  });
});

describe("a repeated scan inside one candle sees identical input", () => {
  it("gives byte-identical closed candles from the provider and from the cache", async () => {
    const now = Date.UTC(2026, 8, 13, 13, 41);
    const head = Date.UTC(2026, 8, 13, 13, 0);
    const fetched = series(40, head);
    const previouslyForming = fetched[fetched.length - 2];

    vi.setSystemTime(now);

    // --- pass one: cache miss, provider answers, storage is corrected -------
    candleFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([storedRowOf(partial(previouslyForming))]);
    providerGetCandles.mockResolvedValue(fetched);

    const first = await getCandles({
      pairId: PAIR,
      exchangeSymbol: "XTZUSDT",
      timeframe: TF,
      limit: 40,
    });

    // What the fix wrote: the corrected row plus the bulk insert. Rebuilding
    // storage from those writes is what pass two will read.
    const stored = new Map<number, Candle>();
    for (const row of candleCreateMany.mock.calls[0][0].data as { openTime: Date }[]) {
      const r = row as unknown as Record<string, string | Date>;
      stored.set((r.openTime as Date).getTime(), {
        openTime: (r.openTime as Date).getTime(),
        closeTime: (r.closeTime as Date).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      });
    }
    for (const call of candleUpsert.mock.calls) {
      const r = call[0].create as Record<string, string | Date>;
      stored.set((r.openTime as Date).getTime(), {
        openTime: (r.openTime as Date).getTime(),
        closeTime: (r.closeTime as Date).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      });
    }

    // --- pass two: cache hit, seconds later, same candle -------------------
    const cached = [...stored.values()].sort((a, b) => a.openTime - b.openTime);
    candleFindMany.mockResolvedValue(rowsFor(cached));
    providerGetCandles.mockReset();
    vi.setSystemTime(now + 35_000);

    const second = await getCandles({
      pairId: PAIR,
      exchangeSymbol: "XTZUSDT",
      timeframe: TF,
      limit: 40,
    });

    expect(second.source).toBe("cache");
    expect(providerGetCandles).not.toHaveBeenCalled();

    const a = closedCandlesOnly(first.candles, now);
    const b = closedCandlesOnly(second.candles, now + 35_000);

    // The same analysed candle, and the same bytes behind it.
    expect(b.at(-1)!.openTime).toBe(a.at(-1)!.openTime);
    expect(b).toHaveLength(a.length);
    expect(canonical(b)).toBe(canonical(a));

    // Which is what makes the verdict stable. The engine was never the
    // problem; being handed the same input is.
    const resultA = runAnalysis(a, { lastCandleIsForming: false });
    const resultB = runAnalysis(b, { lastCandleIsForming: false });

    expect(resultB.status).toBe(resultA.status);
    expect(resultB.score?.total).toBe(resultA.score?.total);
    expect(JSON.stringify(resultB.setup?.entry)).toBe(JSON.stringify(resultA.setup?.entry));
    expect(JSON.stringify(resultB)).toBe(JSON.stringify(resultA));
  });

  it("would have diverged without the correction", async () => {
    // The old behaviour, reproduced: the partial row survives, so the cached
    // read and the provider read disagree about a candle that has closed —
    // and the engine, given different bytes, reaches a different verdict.
    const head = Date.UTC(2026, 8, 13, 13, 0);
    const fetched = series(40, head);
    const idx = fetched.length - 2;

    const trueClosed = closedCandlesOnly(fetched, Date.UTC(2026, 8, 13, 13, 41));
    const poisoned = trueClosed.map((c, i) => (i === idx ? partial(fetched[idx]) : c));

    expect(canonical(poisoned)).not.toBe(canonical(trueClosed));

    const clean = runAnalysis(trueClosed, { lastCandleIsForming: false });
    const stale = runAnalysis(poisoned, { lastCandleIsForming: false });

    // Different input, different answer — which is exactly the churn observed.
    expect(JSON.stringify(stale)).not.toBe(JSON.stringify(clean));
  });
});
