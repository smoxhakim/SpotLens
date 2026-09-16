"use client";

import { AlertTriangle, RefreshCw, Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AnalysisSummaryBar } from "@/features/analysis/components/AnalysisSummaryBar";
import { ExplanationSidebar } from "@/features/analysis/components/ExplanationSidebar";
import { MarketReadPanel } from "@/features/analysis/components/MarketReadPanel";
import { SecondaryAnalysis } from "@/features/analysis/components/SecondaryAnalysis";
import { TradeLevelsCard } from "@/features/analysis/components/TradeLevelsCard";
import { useAnalysis } from "@/features/analysis/hooks/useAnalysis";
import { useMarketRead } from "@/features/analysis/hooks/useMarketRead";
import { WatchlistToggle } from "@/features/watchlist/components/WatchlistToggle";
import { closes, ema } from "@/lib/indicators";
import { ANALYSIS_DISCLAIMER, SPOT_ONLY_NOTE } from "@/lib/constants/disclaimers";
import { defaultHigherTimeframe } from "@/lib/analysis";
import { classifyRegime } from "@/lib/regime";
import {
  TIMEFRAME_LABELS,
  isNoisyTimeframe,
  isTimeframe,
  type Timeframe,
} from "@/lib/market-data/provider";
import type { MarketSummary } from "@/types/market";

import { useCandles } from "../hooks/useCandles";
import { useLivePrice } from "../hooks/useLivePrice";
import { useMarkets } from "../hooks/useMarkets";
import { useTicker } from "../hooks/useTicker";
import { CandlestickChart, type EmaOverlay, type SetupLevel } from "./CandlestickChart";
import { MarketHeader } from "./MarketHeader";
import { OverlayToggles, type OverlayState } from "./OverlayToggles";
import { PairSelector } from "./PairSelector";
import { TimeframeSelector } from "./TimeframeSelector";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_TIMEFRAME: Timeframe = "H1";

const EMA_COLORS: Record<number, string> = { 20: "#38bdf8", 50: "#f59e0b", 200: "#a78bfa" };

/**
 * The market analysis workspace.
 *
 * ## The information order
 *
 * The page answers five questions, in the order a reader actually asks them:
 * what am I looking at, what is the price doing, what would the setup be, is it
 * ready, and why. So: market header, then the summary strip, then the chart,
 * then the levels directly beneath it, then the reasoning beside it, then
 * everything else folded away underneath.
 *
 * The levels used to live two thirds of the way down a single long sidebar,
 * below the explanation list, the multi-timeframe panel and the confirmation
 * signals — which meant the most consequential numbers on the screen were the
 * ones you had to scroll to find, and the sidebar was simultaneously the home
 * of the setup *and* of the reasoning about it. Splitting those is the whole
 * change: the main column carries what the setup is, the sidebar carries why.
 *
 * Nothing about the analysis moved. Every value rendered here comes from the
 * same `useAnalysis` result and the same `useMarketRead` as before; this file
 * decides layout and nothing else.
 */
export function MarketWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const marketsQuery = useMarkets();
  const markets = useMemo(() => marketsQuery.data ?? [], [marketsQuery.data]);

  const symbolParam = searchParams.get("pair")?.toUpperCase();
  const timeframeParam = searchParams.get("tf");
  const timeframe: Timeframe = isTimeframe(timeframeParam) ? timeframeParam : DEFAULT_TIMEFRAME;

  const market = useMemo(
    () =>
      markets.find((m) => m.exchangeSymbol === symbolParam) ??
      markets.find((m) => m.exchangeSymbol === DEFAULT_SYMBOL) ??
      markets[0],
    [markets, symbolParam],
  );

  const setParams = useCallback(
    (next: { pair?: string; tf?: Timeframe }) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next.pair) params.set("pair", next.pair);
      if (next.tf) params.set("tf", next.tf);
      router.replace(`/market-analysis?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
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

  const analysis = useAnalysis();

  // Checking the higher timeframe is on by default: it is the guard against
  // buying a bounce inside a downtrend, which is the most expensive mistake
  // this tool exists to prevent, and defaults are what most runs use.
  const [useMtf, setUseMtf] = useState(true);
  const higherTimeframe = defaultHigherTimeframe(timeframe);

  // The result belongs to the pair and timeframe it was run for; showing it
  // beside a different chart would be actively misleading.
  const analysisMatches =
    analysis.data?.pairId === market?.pairId && analysis.data?.timeframe === timeframe;
  const result = analysisMatches ? (analysis.data?.result ?? null) : null;

  // Only the nearest zone each side is drawn. Every zone at once turns the
  // chart into a ladder of dashed lines that obscures the price action the
  // zones are meant to explain; the panel still lists them all.
  const zoneOverlays = useMemo(
    () =>
      overlays.zones && read ? [...read.support.slice(0, 1), ...read.resistance.slice(0, 1)] : [],
    [overlays.zones, read],
  );

  /**
   * The setup's levels, drawn on the chart.
   *
   * A projection of values the engine already produced — the entry zone's two
   * edges, the stop, and each target under its own label. An AVOID withholds
   * the setup entirely, so there is nothing to draw, which is the correct
   * outcome rather than a special case.
   */
  const setupLevels = useMemo<SetupLevel[]>(() => {
    const setup = result?.setup;
    if (!setup) return [];

    const levels: SetupLevel[] = [
      { price: setup.entry.low, label: "Entry", kind: "entry" },
      { price: setup.stopLoss.price, label: "Stop", kind: "stop" },
      ...setup.takeProfits.map((target) => ({
        price: target.level,
        label: target.label,
        kind: "target" as const,
      })),
    ];

    // The entry is a zone; its upper edge only earns a second line when it is
    // actually a different price.
    if (setup.entry.high !== setup.entry.low) {
      levels.splice(1, 0, { price: setup.entry.high, label: "Entry", kind: "entry" });
    }

    return levels;
  }, [result]);

  const regime = useMemo(() => (read ? classifyRegime(read) : null), [read]);
  const chartLoading = candlesQuery.isPending || marketsQuery.isLoading;

  return (
    <div className="min-w-0 space-y-4">
      {/* --- controls ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-3">
        <PairSelector
          markets={markets}
          value={market}
          onChange={(m: MarketSummary) => setParams({ pair: m.exchangeSymbol })}
          disabled={marketsQuery.isLoading}
        />
        <TimeframeSelector value={timeframe} onChange={(tf) => setParams({ tf })} />
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
          Refresh
        </Button>
        <WatchlistToggle pairId={market?.pairId} />
        <div className="w-full xl:ml-auto xl:w-auto">
          <OverlayToggles value={overlays} onChange={setOverlays} />
        </div>
        {higherTimeframe && (
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={useMtf}
              onChange={(e) => setUseMtf(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            Check {TIMEFRAME_LABELS[higherTimeframe]} trend
          </label>
        )}
        <Button
          size="sm"
          disabled={!market || analysis.isPending || candles.length === 0}
          onClick={() =>
            market &&
            analysis.mutate({
              pairId: market.pairId,
              timeframe,
              higherTimeframe: useMtf ? higherTimeframe : null,
            })
          }
        >
          <Sparkles className="h-4 w-4" />
          {analysis.isPending ? "Analyzing…" : "Analyze Market"}
        </Button>
      </div>

      {/*
        One header, not two. Identity and the live price on top; what the engine
        makes of them directly underneath, sharing the same card. An earlier
        pass had these as separate blocks, which meant the pair name and the
        price each appeared twice within 80 pixels of each other.
      */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <MarketHeader
            market={market}
            ticker={tickerQuery.data}
            livePrice={live?.price}
            liveChangePct={live?.change24hPct}
            connected={connected}
            isLoading={marketsQuery.isLoading}
          />
          <AnalysisSummaryBar
            timeframe={timeframe}
            read={read}
            regime={regime}
            result={result}
            isLoading={chartLoading}
          />
        </CardContent>
      </Card>

      {/*
        Two columns on wide screens, one on everything else. The sidebar is a
        fixed 340px rather than a percentage so its prose keeps a readable
        measure instead of collapsing to four words a line on a laptop; the
        chart column takes whatever is left. On a phone the grid is a single
        column and the sidebar simply becomes the next section down — no
        narrow desktop sidebar, and no nested scroll container.
      */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {marketsQuery.isError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>
                Could not load the curated market list. {String(marketsQuery.error?.message ?? "")}
              </AlertDescription>
            </Alert>
          )}

          {candlesQuery.isError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>
                {(candlesQuery.error as Error)?.message ?? "Could not load candles."}{" "}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => void candlesQuery.refetch()}
                >
                  Retry
                </button>
              </AlertDescription>
            </Alert>
          )}

          {isNoisyTimeframe(timeframe) && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertDescription>
                On {TIMEFRAME_LABELS[timeframe]} candles most swing highs and lows are noise rather
                than levels anyone defended, and the indicators warm up on barely a few hours of
                history. The analysis is computed exactly the same way — it is the input that is
                thin. Treat anything here as a timing detail on top of a read you took from a higher
                timeframe.
              </AlertDescription>
            </Alert>
          )}

          {candlesQuery.data?.stale && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertDescription>
                The exchange is unreachable — showing the most recent cached candles. Prices may be
                behind the market.
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardContent className="p-2 sm:p-3">
              {chartLoading ? (
                <Skeleton className="h-[480px] w-full" />
              ) : candles.length === 0 ? (
                <div className="flex h-[480px] items-center justify-center text-sm text-muted-foreground">
                  No candle data available for this market yet.
                </div>
              ) : (
                <CandlestickChart
                  candles={candles}
                  livePrice={live?.price ?? null}
                  emas={emaOverlays}
                  zones={zoneOverlays}
                  levels={setupLevels}
                />
              )}
            </CardContent>
          </Card>

          {/* The change that matters: the levels are directly under the chart,
              above everything else, and visible without scrolling. */}
          <TradeLevelsCard result={result} isPending={analysis.isPending} error={analysis.error} />

          <SecondaryAnalysis result={result} market={market} />

          <MarketReadPanel read={read} isLoading={chartLoading} />

          <Alert variant="muted">
            <AlertDescription>
              {ANALYSIS_DISCLAIMER} {SPOT_ONLY_NOTE}
            </AlertDescription>
          </Alert>
        </div>

        {/* Sticky only where there is room for it to be useful. Below xl the
            sidebar is just the next block in the single-column flow. */}
        <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
          <ExplanationSidebar result={result} isPending={analysis.isPending} />
        </aside>
      </div>
    </div>
  );
}
