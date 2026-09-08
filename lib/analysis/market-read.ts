import {
  analyzeVolume,
  closes,
  latestAtr,
  latestEma,
  latestRsi,
  type VolumeRead,
} from "@/lib/indicators";
import { ANALYSIS_DISCLAIMER, DISCLAIMER_VERSION } from "@/lib/constants/disclaimers";
import type { Candle } from "@/lib/market-data/provider";

import { explainRsi } from "./explain/rsi";
import { explainTrend } from "./explain/trend";
import { explainVolume } from "./explain/volume";
import { explainZoneWidth, explainZones } from "./explain/zones";
import { DEFAULT_SWING_LOOKBACK } from "./structure";
import { EMA_PERIODS, detectTrend, type TrendRead } from "./trend";
import { detectZones, type PriceZone, type ZoneOptions } from "./zones";

export interface MarketReadIndicators {
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number | null;
  avgVolume: number | null;
  volumeTrend: VolumeRead["trend"] | null;
}

export interface MarketRead {
  price: number;
  candleCount: number;
  lastCandleTime: number;
  trend: TrendRead & { reason: string };
  support: PriceZone[];
  resistance: PriceZone[];
  zonesReason: string;
  zoneWidthNote: string;
  volume: { read: VolumeRead | null; reason: string };
  rsi: { value: number | null; reason: string };
  indicators: MarketReadIndicators;
  /** True when there is too little history for the read to mean anything. */
  insufficientData: boolean;
  disclaimer: string;
  disclaimerVersion: string;
}

export interface MarketReadOptions extends ZoneOptions {
  swingLookback?: number;
  rsiPeriod?: number;
  volumePeriod?: number;
  /**
   * Whether the final candle is still open.
   *
   * Passed in rather than derived from the clock, so the engine stays a pure
   * function of its inputs — the backtester replays closed candles and must
   * get identical results every time.
   */
  lastCandleIsForming?: boolean;
}

/**
 * Minimum candles before a read is worth showing. Below this the EMA 200 and
 * the swing series are both too thin to say anything honest.
 */
export const MIN_CANDLES_FOR_READ = 60;

/**
 * Assembles the full market read from the deterministic pieces: trend, zones,
 * volume, RSI — each with its own plain-language reason.
 *
 * Pure: candles in, read out. No I/O, no framework. That is what lets the same
 * function run in the browser for the live panel, on the server for a persisted
 * analysis, and inside the backtester bar by bar.
 */
export function runMarketRead(candles: Candle[], options: MarketReadOptions = {}): MarketRead {
  const swingLookback = options.swingLookback ?? DEFAULT_SWING_LOOKBACK;
  const rsiPeriod = options.rsiPeriod ?? 14;
  const volumePeriod = options.volumePeriod ?? 20;

  const price = candles.at(-1)?.close ?? 0;
  const series = closes(candles);

  const trendRead = detectTrend(candles, swingLookback);
  const zones = detectZones(candles, { ...options, swingLookback });
  const rsiValue = latestRsi(series, rsiPeriod);

  // Volume is the one measure that cannot read a half-built candle.
  //
  // Price, RSI and the moving averages are all levels — a forming candle's
  // close is a real price right now. Volume is an accumulation: sixteen minutes
  // into an hour it holds sixteen minutes of trading, and comparing that
  // against candles that had a full hour makes every fresh candle look dead.
  // That fed straight into the status engine, which held back valid setups for
  // "thin volume" that was only thin because the hour had just started.
  const volumeCandles =
    options.lastCandleIsForming && candles.length > 1 ? candles.slice(0, -1) : candles;
  const volumeRead = analyzeVolume(volumeCandles, volumePeriod);

  return {
    price,
    candleCount: candles.length,
    lastCandleTime: candles.at(-1)?.openTime ?? 0,
    trend: { ...trendRead, reason: explainTrend(trendRead) },
    support: zones.support,
    resistance: zones.resistance,
    zonesReason: explainZones(zones),
    zoneWidthNote: explainZoneWidth(zones),
    volume: { read: volumeRead, reason: explainVolume(volumeRead) },
    rsi: { value: rsiValue, reason: explainRsi(rsiValue) },
    indicators: {
      ema20: latestEma(series, EMA_PERIODS.fast),
      ema50: latestEma(series, EMA_PERIODS.medium),
      ema200: latestEma(series, EMA_PERIODS.slow),
      rsi14: rsiValue,
      atr14: latestAtr(candles, 14),
      avgVolume: volumeRead?.average ?? null,
      volumeTrend: volumeRead?.trend ?? null,
    },
    insufficientData: candles.length < MIN_CANDLES_FOR_READ,
    disclaimer: ANALYSIS_DISCLAIMER,
    disclaimerVersion: DISCLAIMER_VERSION,
  };
}
