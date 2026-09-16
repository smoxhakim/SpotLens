"use client";

import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import type { PriceZone } from "@/lib/analysis";
import { formatPrice, priceMinMove } from "@/lib/format";
import type { Candle } from "@/lib/market-data/provider";

export interface EmaOverlay {
  period: number;
  color: string;
  /** Aligned to `candles`; null where the EMA is not yet defined. */
  values: (number | null)[];
}

/**
 * One horizontal level from a finished setup, drawn on the chart.
 *
 * Presentation only: the price is whatever the engine already decided, passed
 * straight through. Nothing here derives a level, and the chart never rounds
 * one — the label carries the same formatting the panel below it uses.
 */
export interface SetupLevel {
  price: number;
  label: string;
  kind: "entry" | "stop" | "target";
}

interface CandlestickChartProps {
  candles: Candle[];
  /** Live last price, folded into the forming candle between REST refreshes. */
  livePrice?: number | null;
  height?: number;
  emas?: EmaOverlay[];
  zones?: PriceZone[];
  /** Entry / stop / target levels from the current analysis, if one has run. */
  levels?: SetupLevel[];
  /**
   * Called as the crosshair moves, with the candle under it — or null when the
   * pointer leaves the chart.
   *
   * The chart reports; the caller decides whether to render a readout and
   * where. Keeps this component presentational and lets the compact embedded
   * chart and the full-page one show the same numbers in different chrome.
   */
  onHoverCandle?: (candle: Candle | null) => void;
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
  levels,
  onHoverCandle,
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaSeriesRef = useRef<Map<number, ISeriesApi<"Line">>>(new Map());
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const levelLinesRef = useRef<IPriceLine[]>([]);
  const onHoverRef = useRef(onHoverCandle);
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
      // The single source of truth for how a price reads, handed to the
      // library rather than re-implemented. This is what the price axis and
      // the crosshair use, so the axis, the crosshair and the entry printed
      // under the chart can no longer disagree about precision — which is how
      // a four-decimal market was showing "50.92" on the axis and "50.9200"
      // in the panel.
      localization: { priceFormatter: (price: number) => formatPrice(price) },
      autoSize: true,
    });

    candleSeriesRef.current = chart.addCandlestickSeries({
      upColor: COLORS.bullish,
      downColor: COLORS.bearish,
      borderUpColor: COLORS.bullish,
      borderDownColor: COLORS.bearish,
      wickUpColor: COLORS.bullish,
      wickDownColor: COLORS.bearish,
      // `localization.priceFormatter` covers the axis and the crosshair; the
      // series' own format is what the last-value badge and every price line's
      // axis label use. Both point at the same function. `minMove` is set from
      // the data below, once there is a price to judge the magnitude from.
      priceFormat: {
        type: "custom",
        formatter: (price: number) => formatPrice(price),
        minMove: 0.00000001,
      },
    });

    volumeSeriesRef.current = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      // No badge on the price axis. `localization.priceFormatter` is
      // chart-wide, so the volume series' last value was being rendered as a
      // *price* — "15,190.04" where the axis beside it means dollars. It was
      // wrong before this change too, just less obviously: "15.19K" sitting in
      // a price scale is a number in the wrong unit either way.
      lastValueVisible: false,
      priceLineVisible: false,
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

    // Tick granularity follows the market's own magnitude. Left at a fixed
    // 1e-8 the axis would offer eight-decimal gridlines on a $75,000 market,
    // and the labels would repeat because the formatter rounds them to two.
    const last = candles.at(-1)?.close;
    if (last !== undefined) {
      candleSeries.applyOptions({
        priceFormat: {
          type: "custom",
          formatter: (price: number) => formatPrice(price),
          minMove: priceMinMove(last),
        },
      });
    }

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
          // No on-chart title. Lightweight Charts draws it at the series' last
          // point, which is exactly where the entry, stop and target labels
          // are — and of those, the trade levels are the ones worth the pixels
          // (see the visual hierarchy note above). The toolbar already
          // identifies each EMA by the same colour.
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
          title: `${label} ${formatPrice(zone.low)} – ${formatPrice(zone.high)}`,
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

  /**
   * The setup's own levels: entry, invalidation, targets.
   *
   * The point of drawing these is that the numbers under the chart and the
   * picture above it stop being two separate things to reconcile — the reader
   * sees where the entry sits relative to price, and how far the stop is.
   *
   * Axis labels are on here, unlike the zone boundaries: there are at most five
   * of these and each one is a number the reader came for, where the zone
   * edges were a dozen dashes that buried the price scale. Kept in their own
   * effect and their own ref so a new analysis replaces the levels without
   * disturbing the support/resistance shading, which changes on a different
   * cadence.
   */
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    for (const line of levelLinesRef.current) series.removePriceLine(line);
    levelLinesRef.current = [];

    for (const level of levels ?? []) {
      const color =
        level.kind === "stop" ? "#ef4444" : level.kind === "target" ? "#22c55e" : "#38bdf8";

      levelLinesRef.current.push(
        series.createPriceLine({
          price: level.price,
          color,
          lineWidth: level.kind === "entry" ? 2 : 1,
          lineStyle: level.kind === "entry" ? LineStyle.Solid : LineStyle.Dashed,
          axisLabelVisible: true,
          title: level.label,
        }),
      );
    }
  }, [levels]);

  /**
   * OHLC under the crosshair.
   *
   * Subscribed once against a ref rather than re-subscribed whenever the
   * caller re-renders: an inline arrow function as a dependency would tear the
   * subscription down and rebuild it on every parent render, which is how a
   * chart starts dropping the first move of every hover.
   *
   * The candle handed back is the caller's own object, so the readout renders
   * the same floats the engine saw — no copy, no rounding on the way through.
   */
  // Kept current in an effect rather than assigned during render, which React
  // 19 refuses: a ref written while rendering is a write the reconciler may
  // roll back.
  useEffect(() => {
    onHoverRef.current = onHoverCandle;
  }, [onHoverCandle]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const byTime = new Map(candles.map((c) => [Math.floor(c.openTime / 1000), c]));

    const handler = (param: MouseEventParams) => {
      const time = param.time as UTCTimestamp | undefined;
      onHoverRef.current?.(time === undefined ? null : (byTime.get(time) ?? null));
    };

    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, [candles]);

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
