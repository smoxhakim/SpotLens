import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import { warnOnce } from "@/lib/log";
import { getMarketDataProvider } from "@/lib/market-data";
import { MAX_CANDLES_PER_REQUEST } from "@/lib/market-data/binance";
import {
  MarketDataError,
  TIMEFRAME_MS,
  type Candle,
  type Timeframe,
} from "@/lib/market-data/provider";

export interface CandleQuery {
  pairId: string;
  exchangeSymbol: string;
  timeframe: Timeframe;
  limit: number;
  /** Epoch ms, inclusive. */
  from?: number;
  /** Epoch ms, inclusive. */
  to?: number;
}

export interface CandleResult {
  candles: Candle[];
  stale: boolean;
  source: "cache" | "provider" | "cache-stale";
}

/** Open time of the candle currently forming for a timeframe. */
export function currentBucketOpenTime(timeframe: Timeframe, now = Date.now()): number {
  const size = TIMEFRAME_MS[timeframe];
  // Weekly candles on the exchange open Monday 00:00 UTC; the epoch was a Thursday.
  if (timeframe === "W1") {
    const offset = 4 * 24 * 60 * 60_000 - 7 * 24 * 60 * 60_000;
    return Math.floor((now - offset) / size) * size + offset;
  }
  return Math.floor(now / size) * size;
}

/**
 * Read-through candle cache.
 *
 * Postgres first; on a miss, a short read, or a stale head candle, refresh from
 * the MarketDataProvider and upsert. If the provider fails but we hold cached
 * rows, those are served with `stale: true` rather than failing the request.
 */
export async function getCandles(query: CandleQuery): Promise<CandleResult> {
  const limit = Math.max(1, Math.min(query.limit, MAX_CANDLES_PER_REQUEST));

  if (!isDatabaseConfigured) {
    const candles = await getMarketDataProvider().getCandles(
      query.exchangeSymbol,
      query.timeframe,
      limit,
      { from: query.from, to: query.to },
    );
    return { candles, stale: false, source: "provider" };
  }

  let cached: Candle[] = [];
  try {
    cached = await readCache(query, limit);
  } catch (err) {
    warnOnce(
      "candles:cache-read",
      "[candles] cache read failed — falling through to the provider.",
      err,
    );
  }

  if (isFresh(cached, query, limit)) {
    return { candles: cached, stale: false, source: "cache" };
  }

  try {
    const fetched = await getMarketDataProvider().getCandles(
      query.exchangeSymbol,
      query.timeframe,
      limit,
      { from: query.from, to: query.to },
    );
    await writeCache(query, fetched).catch((err) =>
      warnOnce("candles:cache-write", "[candles] cache write failed — serving uncached data.", err),
    );
    return { candles: fetched, stale: false, source: "provider" };
  } catch (err) {
    if (cached.length > 0) {
      console.error("[candles] provider failed, serving stale cache", err);
      return { candles: cached, stale: true, source: "cache-stale" };
    }
    throw err instanceof MarketDataError
      ? err
      : new MarketDataError("UPSTREAM_ERROR", "Could not load candles.", { cause: err });
  }
}

function isFresh(cached: Candle[], query: CandleQuery, limit: number): boolean {
  if (cached.length === 0) return false;

  // A bounded historical window is immutable once fully cached.
  if (query.to !== undefined && query.to < currentBucketOpenTime(query.timeframe)) {
    return cached.length >= limit || query.from !== undefined;
  }

  if (cached.length < limit) return false;

  const newest = cached[cached.length - 1];
  // The head candle is still forming, so anything older than the current bucket
  // means we are behind the market.
  return newest.openTime >= currentBucketOpenTime(query.timeframe);
}

async function readCache(query: CandleQuery, limit: number): Promise<Candle[]> {
  const rows = await prisma.candle.findMany({
    where: {
      tradingPairId: query.pairId,
      timeframe: query.timeframe,
      ...(query.from !== undefined || query.to !== undefined
        ? {
            openTime: {
              ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
              ...(query.to !== undefined ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    },
    orderBy: { openTime: "desc" },
    take: limit,
  });

  return rows
    .map((row) => ({
      openTime: row.openTime.getTime(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      closeTime: row.closeTime.getTime(),
    }))
    .reverse();
}

async function writeCache(query: CandleQuery, candles: Candle[]): Promise<void> {
  if (candles.length === 0) return;

  const head = currentBucketOpenTime(query.timeframe);
  const closed = candles.filter((c) => c.openTime < head);
  const forming = candles.filter((c) => c.openTime >= head);

  const toRow = (c: Candle) => ({
    tradingPairId: query.pairId,
    timeframe: query.timeframe,
    openTime: new Date(c.openTime),
    open: c.open.toString(),
    high: c.high.toString(),
    low: c.low.toString(),
    close: c.close.toString(),
    volume: c.volume.toString(),
    closeTime: new Date(c.closeTime),
  });

  // Closed candles never change, so duplicates can be skipped outright.
  if (closed.length > 0) {
    await prisma.candle.createMany({ data: closed.map(toRow), skipDuplicates: true });
  }

  // The forming candle does change — upsert it so the cache tracks the market.
  for (const candle of forming) {
    const row = toRow(candle);
    await prisma.candle.upsert({
      where: {
        tradingPairId_timeframe_openTime: {
          tradingPairId: query.pairId,
          timeframe: query.timeframe,
          openTime: row.openTime,
        },
      },
      create: row,
      update: {
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        closeTime: row.closeTime,
      },
    });
  }
}
