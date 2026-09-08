import type { AssetCategory, RiskLevel } from "@/lib/market-data/curated-assets";
import type { Candle, Ticker, Timeframe } from "@/lib/market-data/provider";

/** A curated asset plus one of its tradable spot pairs — the selector's unit. */
export interface MarketSummary {
  pairId: string;
  exchangeSymbol: string;
  quoteCurrency: string;
  /** Display form, e.g. "BTC/USDT". */
  label: string;
  asset: {
    symbol: string;
    name: string;
    category: AssetCategory;
    riskLevel: RiskLevel;
    officialWebsite: string;
    description: string;
    utilityExplanation: string;
  };
}

export interface MarketsResponse {
  markets: MarketSummary[];
}

export interface TickerResponse {
  pairId: string;
  symbol: string;
  ticker: Ticker;
}

export interface CandlesResponse {
  pairId: string;
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  /** True when the provider was unreachable and cached candles were served. */
  stale: boolean;
  source: "cache" | "provider" | "cache-stale";
}

export interface ApiErrorResponse {
  error: { code: string; message: string };
}
