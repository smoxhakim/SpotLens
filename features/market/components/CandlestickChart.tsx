"use client";

import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import type { PriceZone } from "@/lib/analysis";
import type { Candle } from "@/lib/market-data/provider";

export interface EmaOverlay {
  period: number;
  color: string;
  /** Aligned to `candles`; null where the EMA is not yet defined. */
  values: (number | null)[];
}

interface CandlestickChartProps {
  candles: Candle[];
  /** Live last price, folded into the forming candle between REST refreshes. */
  livePrice?: number | null;
  height?: number;
  emas?: EmaOverlay[];
  zones?: PriceZone[];
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
export function CandlestickChart({
  candles,
  livePrice,
  height = 480,
  emas,
  zones,
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaSeriesRef = useRef<Map<number, ISeriesApi<"Line">>>(new Map());
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const hasFittedRef = useRef(false);

  // Create the chart once; data updates are handled separately so switching
  // pair or timeframe never tears down the canvas.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Captured for the cleanup below: the ref is created once and never
    // reassigned, so this is the same Map the teardown needs to clear.
    const emaSeries = emaSeriesRef.current;

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
      emaSeries.clear();
      priceLinesRef.current = [];
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

  // EMA overlays. Series are created and removed as the caller toggles them,
  // rather than rebuilding the whole chart.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || candles.length === 0) return;

    const wanted = new Map((emas ?? []).map((o) => [o.period, o]));

    for (const [period, series] of emaSeriesRef.current) {
      if (!wanted.has(period)) {
        chart.removeSeries(series);
        emaSeriesRef.current.delete(period);
      }
    }

    for (const [period, overlay] of wanted) {
      let series = emaSeriesRef.current.get(period);
      if (!series) {
        series = chart.addLineSeries({
          color: overlay.color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          title: `EMA ${period}`,
        });
        emaSeriesRef.current.set(period, series);
      }

      series.setData(
        overlay.values
          .map((value, i) =>
            value === null || !candles[i]
              ? null
              : { time: (candles[i].openTime / 1000) as UTCTimestamp, value },
          )
          .filter((p): p is { time: UTCTimestamp; value: number } => p !== null),
      );
    }
  }, [emas, candles]);

  // Support/resistance zones, drawn as the two boundaries of each area. The
  // product treats them as zones, never single lines, so both edges are shown.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];

    for (const zone of zones ?? []) {
      const color = zone.kind === "SUPPORT" ? "#22c55e" : "#ef4444";
      const label = zone.kind === "SUPPORT" ? "Support" : "Resistance";

      // Axis labels are off deliberately: several zones means a dozen
      // boundaries, and their price-scale badges pile up into an unreadable
      // stack that hides the prices themselves. The panel lists exact levels.
      priceLinesRef.current.push(
        series.createPriceLine({
          price: zone.high,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: `${label} ${formatZonePrice(zone.low)}-${formatZonePrice(zone.high)}`,
        }),
        series.createPriceLine({
          price: zone.low,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: "",
        }),
      );
    }
  }, [zones]);

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

/** Compact price label for a zone band drawn on the chart. */
function formatZonePrice(value: number): string {
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return value.toFixed(decimals);
}
