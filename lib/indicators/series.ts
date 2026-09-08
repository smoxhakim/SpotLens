import type { Candle } from "@/lib/market-data/provider";

/** Extractors so indicator calls read as `ema(closes(candles), 20)`. */
export const closes = (candles: Candle[]): number[] => candles.map((c) => c.close);
export const highs = (candles: Candle[]): number[] => candles.map((c) => c.high);
export const lows = (candles: Candle[]): number[] => candles.map((c) => c.low);
export const volumes = (candles: Candle[]): number[] => candles.map((c) => c.volume);
