"use client";

import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import type { Candle } from "@/lib/market-data/provider";

interface CandlestickChartProps {
  candles: Candle[];
  /** Live last price, folded into the forming candle between REST refreshes. */
  livePrice?: number | null;
  height?: number;
}

const COLORS = {
  bullish: "#22c55e",
  bearish: "#ef4444",
  grid: "rgba(148, 163, 184, 0.12)",
  text: "#94a3b8",
  border: "rgba(148, 163, 184, 0.2)",
};

/**
 * TradingView Lightweight Charts candlestick renderer.
 *
 * Deliberately presentational: it takes candles in and draws them. Phase 2 adds
 * EMA line series and support/resistance shading through the same props path.
 */
export function CandlestickChart({ candles, livePrice, height = 480 }: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const hasFittedRef = useRef(false);

  // Create the chart once; data updates are handled separately so switching
  // pair or timeframe never tears down the canvas.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: COLORS.text,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    });

    candleSeriesRef.current = chart.addCandlestickSeries({
      upColor: COLORS.bullish,
      downColor: COLORS.bearish,
      borderUpColor: COLORS.bullish,
      borderDownColor: COLORS.bearish,
      wickUpColor: COLORS.bullish,
      wickDownColor: COLORS.bearish,
    });

    volumeSeriesRef.current = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!candleSeries || !volumeSeries || candles.length === 0) return;

    candleSeries.setData(
      candles.map((c) => ({
        time: (c.openTime / 1000) as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    volumeSeries.setData(
      candles.map((c) => ({
        time: (c.openTime / 1000) as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)",
      })),
    );

    if (!hasFittedRef.current) {
      chartRef.current?.timeScale().fitContent();
      hasFittedRef.current = true;
    }
  }, [candles]);

  // Reset the "fit once" guard whenever the dataset is swapped wholesale.
  const firstOpenTime = candles[0]?.openTime;
  useEffect(() => {
    hasFittedRef.current = false;
  }, [firstOpenTime]);

  // Fold the streamed price into the forming candle so the chart tracks the
  // market between REST refreshes.
  useEffect(() => {
    const series = candleSeriesRef.current;
    const last = candles[candles.length - 1];
    if (!series || !last || livePrice == null || !Number.isFinite(livePrice)) return;

    series.update({
      time: (last.openTime / 1000) as UTCTimestamp,
      open: last.open,
      high: Math.max(last.high, livePrice),
      low: Math.min(last.low, livePrice),
      close: livePrice,
    });
  }, [livePrice, candles]);

  return (
    <div ref={containerRef} style={{ height }} className="w-full" data-testid="candlestick-chart" />
  );
}
