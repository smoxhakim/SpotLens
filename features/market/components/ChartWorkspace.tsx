"use client";

import { ArrowLeft, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnalysis } from "@/features/analysis/hooks/useAnalysis";
import { useMarketRead } from "@/features/analysis/hooks/useMarketRead";
import { defaultHigherTimeframe } from "@/lib/analysis";
import { formatPercent, formatPrice } from "@/lib/format";
import { closes, ema } from "@/lib/indicators";
import { TIMEFRAME_LABELS, isTimeframe, type Timeframe } from "@/lib/market-data/provider";
import { cn } from "@/lib/utils";
import type { MarketSummary } from "@/types/market";

import { useCandles } from "../hooks/useCandles";
import { useLivePrice } from "../hooks/useLivePrice";
import { useMarkets } from "../hooks/useMarkets";
import { useTicker } from "../hooks/useTicker";
import { ChartPanel } from "./ChartPanel";
import { CompactTradeLevels } from "./CompactTradeLevels";
import { type EmaOverlay } from "./CandlestickChart";
import { OverlayToggles, type OverlayState } from "./OverlayToggles";
import { PairSelector } from "./PairSelector";
import { setupLevelsFor } from "./setup-levels";
import { TimeframeSelector } from "./TimeframeSelector";

const DEFAULT_TIMEFRAME: Timeframe = "H4";
const EMA_COLORS: Record<number, string> = { 20: "#38bdf8", 50: "#f59e0b", 200: "#a78bfa" };

/**
 * The monitoring view: one market, as much chart as the screen allows.
 *
 * Deliberately built from the same hooks the analysis page uses —
 * `useCandles`, `useLivePrice`, `useTicker`, `useAnalysis`. `useCandles` is a
 * TanStack query keyed on (pair, timeframe, limit), so moving between the two
 * pages reuses the cache rather than re-fetching, and there is exactly one
 * live-price socket implementation in the product.
 *
 * The analysis is still an explicit action here, as it is on the analysis
 * page. That is not an oversight: `useAnalysis` is a mutation precisely because
 * re-running it silently would change the numbers under someone who is
 * reading them, and a monitoring screen that quietly re-analysed on every
 * timeframe flick would be the worst place for that to happen.
 */
export function ChartWorkspace({
  symbol,
  timeframeParam,
}: {
  symbol: string;
  timeframeParam?: string;
}) {
  const router = useRouter();

  const marketsQuery = useMarkets();
  const markets = useMemo(() => marketsQuery.data ?? [], [marketsQuery.data]);

  const timeframe: Timeframe = isTimeframe(timeframeParam) ? timeframeParam : DEFAULT_TIMEFRAME;
  const market = useMemo(() => markets.find((m) => m.exchangeSymbol === symbol), [markets, symbol]);

  const go = useCallback(
    (next: { symbol?: string; tf?: Timeframe }) => {
      const nextSymbol = next.symbol ?? symbol;
      const nextTf = next.tf ?? timeframe;
      router.replace(`/chart/${nextSymbol}?tf=${nextTf}`, { scroll: false });
    },
    [router, symbol, timeframe],
  );

  const tickerQuery = useTicker(market?.pairId);
  const candlesQuery = useCandles({ pairId: market?.pairId, timeframe });
  const { price: live, connected } = useLivePrice(market?.exchangeSymbol);

  const candles = useMemo(() => candlesQuery.data?.candles ?? [], [candlesQuery.data]);
  const read = useMarketRead(candles);

  const [overlays, setOverlays] = useState<OverlayState>({
    ema20: true,
    ema50: true,
    ema200: true,
    zones: true,
  });

  const emaOverlays = useMemo<EmaOverlay[]>(() => {
    if (candles.length === 0) return [];
    const series = closes(candles);
    const wanted: number[] = [];
    if (overlays.ema20) wanted.push(20);
    if (overlays.ema50) wanted.push(50);
    if (overlays.ema200) wanted.push(200);
    return wanted.map((period) => ({
      period,
      color: EMA_COLORS[period],
      values: ema(series, period),
    }));
  }, [candles, overlays]);

  const zoneOverlays = useMemo(
    () =>
      overlays.zones && read ? [...read.support.slice(0, 1), ...read.resistance.slice(0, 1)] : [],
    [overlays.zones, read],
  );

  const analysis = useAnalysis();
  const higherTimeframe = defaultHigherTimeframe(timeframe);

  // The result belongs to the market and timeframe it was run for. Switching
  // either one must drop it rather than leave last market's levels drawn over
  // this one's candles.
  const analysisMatches =
    analysis.data?.pairId === market?.pairId && analysis.data?.timeframe === timeframe;
  const result = analysisMatches ? (analysis.data?.result ?? null) : null;

  const setupLevels = useMemo(() => setupLevelsFor(result?.setup ?? null), [result]);

  // The chart fills what is left after the header and the levels strip. A
  // number rather than a CSS height because Lightweight Charts sizes its
  // canvas from one.
  const [chartHeight, setChartHeight] = useState(520);
  useEffect(() => {
    const measure = () => {
      // Header, toolbar, readout and levels strip come to roughly 300px on a
      // desktop and rather more once the controls wrap on a phone.
      const chrome = window.innerWidth < 640 ? 430 : 330;
      setChartHeight(Math.max(320, window.innerHeight - chrome));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  /**
   * The price, in order of freshness.
   *
   * The last closed candle is the final fallback rather than an em dash. It is
   * the same number the chart is already drawing and the OHLC strip is already
   * showing as C, from the same `useCandles` data — not a second source — so a
   * slow or rate-limited ticker leaves this screen showing a real price
   * instead of a dash on a page whose entire job is displaying one.
   */
  const price = live?.price ?? tickerQuery.data?.ticker.price ?? candles.at(-1)?.close ?? null;
  // The 24h change has no such fallback: candles for this timeframe cannot
  // produce it, and inventing one from a partial window would be a wrong
  // number rather than a missing one.
  const changePct = live?.change24hPct ?? tickerQuery.data?.ticker.change24hPct ?? null;
  const up = (changePct ?? 0) >= 0;
  const loading = candlesQuery.isPending || marketsQuery.isLoading;

  const backHref = `/market-analysis?pair=${symbol}&tf=${timeframe}`;

  if (!marketsQuery.isLoading && !market) {
    return (
      <div className="space-y-4">
        <BackLink href="/market-analysis" />
        <Alert variant="destructive">
          <AlertDescription>
            {symbol} is not in the curated market list. Pick a market from the analysis page.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      {/* --- header: where am I, what is it doing ------------------------- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BackLink href={backHref} />

        <div className="flex items-baseline gap-2">
          <h1 className="text-base font-semibold">{market?.label ?? symbol}</h1>
          <Badge variant="outline" className="text-[10px]">
            {TIMEFRAME_LABELS[timeframe]}
          </Badge>
        </div>

        <div className="flex items-baseline gap-2">
          <span
            data-testid="chart-last-price"
            className={cn("tabular text-xl font-semibold", up ? "text-bullish" : "text-bearish")}
          >
            {formatPrice(price)}
          </span>
          <span className={cn("tabular text-xs font-medium", up ? "text-bullish" : "text-bearish")}>
            {formatPercent(changePct)}
          </span>
          <span className="text-[10px] text-muted-foreground">24h</span>
        </div>

        <span
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          title={connected ? "Streaming live prices" : "Falling back to periodic refresh"}
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              connected ? "bg-bullish" : "bg-muted-foreground",
            )}
          />
          {/* Never colour alone: the word is the status. */}
          {connected ? "Live" : "Polling"}
        </span>
      </div>

      {/* --- toolbar: horizontally scrollable on a phone ------------------ */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="flex w-max min-w-full flex-wrap items-center gap-2 sm:flex-nowrap">
          <PairSelector
            markets={markets}
            value={market}
            onChange={(m: MarketSummary) => go({ symbol: m.exchangeSymbol })}
            disabled={marketsQuery.isLoading}
          />
          <TimeframeSelector value={timeframe} onChange={(tf) => go({ tf })} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void candlesQuery.refetch();
              void tickerQuery.refetch();
            }}
            disabled={candlesQuery.isFetching}
            aria-label="Refresh market data"
          >
            <RefreshCw className={candlesQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          </Button>
          <OverlayToggles value={overlays} onChange={setOverlays} />
          <Button
            size="sm"
            className="ml-auto"
            disabled={!market || analysis.isPending || candles.length === 0}
            onClick={() =>
              market &&
              analysis.mutate({
                pairId: market.pairId,
                timeframe,
                higherTimeframe,
              })
            }
          >
            <Sparkles className="h-4 w-4" />
            {analysis.isPending ? "Analyzing…" : "Analyze"}
          </Button>
        </div>
      </div>

      {candlesQuery.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {(candlesQuery.error as Error)?.message ?? "Could not load candles."}
          </AlertDescription>
        </Alert>
      )}

      {loading ? (
        <Skeleton className="w-full" style={{ height: chartHeight }} />
      ) : candles.length === 0 ? (
        <div
          className="flex items-center justify-center text-sm text-muted-foreground"
          style={{ height: chartHeight }}
        >
          No candle data available for this market yet.
        </div>
      ) : (
        <ChartPanel
          candles={candles}
          livePrice={live?.price ?? null}
          emas={emaOverlays}
          zones={zoneOverlays}
          levels={setupLevels}
          height={chartHeight}
        />
      )}

      <CompactTradeLevels result={result} isPending={analysis.isPending} />
    </div>
  );
}

function BackLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Back to analysis
    </Link>
  );
}
