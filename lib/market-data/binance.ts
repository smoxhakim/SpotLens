import { fetchJson } from "./http";
import {
  MarketDataError,
  type Candle,
  type CandleRange,
  type Market,
  type MarketDataProvider,
  type Ticker,
  type Timeframe,
} from "./provider";

/** Binance kline interval per SpotLens timeframe. */
const INTERVAL: Record<Timeframe, string> = {
  M15: "15m",
  H1: "1h",
  H4: "4h",
  D1: "1d",
  W1: "1w",
};

/** Binance caps klines at 1000 rows per request. */
export const MAX_CANDLES_PER_REQUEST = 1000;

type RawKline = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time
  ...unknown[],
];

interface RawExchangeInfo {
  symbols: {
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    isSpotTradingAllowed: boolean;
  }[];
}

interface RawTicker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  closeTime: number;
}

function num(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new MarketDataError("BAD_RESPONSE", `Provider returned a non-numeric ${field}.`, {
      retryable: false,
    });
  }
  return parsed;
}

/**
 * Binance public REST implementation. Public market-data endpoints only — no
 * API key is used, and no endpoint touched here is capable of trading.
 */
export class BinanceProvider implements MarketDataProvider {
  private readonly baseUrl: string;

  constructor(baseUrl: string = process.env.BINANCE_API_BASE_URL || "https://api.binance.com") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async getMarkets(): Promise<Market[]> {
    const data = await fetchJson<RawExchangeInfo>(
      this.url("/api/v3/exchangeInfo", { permissions: "SPOT" }),
      { timeoutMs: 15_000 },
    );
    return data.symbols
      .filter((s) => s.status === "TRADING" && s.isSpotTradingAllowed)
      .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }));
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const raw = await fetchJson<RawTicker24h>(
      this.url("/api/v3/ticker/24hr", { symbol: symbol.toUpperCase() }),
    );
    return {
      symbol: raw.symbol,
      price: num(raw.lastPrice, "price"),
      change24hPct: num(raw.priceChangePercent, "24h change"),
      high24h: num(raw.highPrice, "24h high"),
      low24h: num(raw.lowPrice, "24h low"),
      volume24h: num(raw.volume, "24h volume"),
      at: raw.closeTime,
    };
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit = 300,
    range: CandleRange = {},
  ): Promise<Candle[]> {
    const capped = Math.max(1, Math.min(limit, MAX_CANDLES_PER_REQUEST));
    const raw = await fetchJson<RawKline[]>(
      this.url("/api/v3/klines", {
        symbol: symbol.toUpperCase(),
        interval: INTERVAL[timeframe],
        limit: capped,
        startTime: range.from,
        endTime: range.to,
      }),
      { timeoutMs: 15_000 },
    );

    if (!Array.isArray(raw)) {
      throw new MarketDataError("BAD_RESPONSE", "Provider returned an unexpected kline payload.", {
        retryable: false,
      });
    }

    return raw.map((k) => ({
      openTime: k[0],
      open: num(k[1], "open"),
      high: num(k[2], "high"),
      low: num(k[3], "low"),
      close: num(k[4], "close"),
      volume: num(k[5], "volume"),
      closeTime: k[6],
    }));
  }

  async getVolume(symbol: string, timeframe: Timeframe, lookback = 20): Promise<number> {
    const candles = await this.getCandles(symbol, timeframe, lookback);
    return candles.reduce((sum, c) => sum + c.volume, 0);
  }
}
