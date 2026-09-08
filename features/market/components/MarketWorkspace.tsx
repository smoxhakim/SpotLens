"use client";

import { AlertTriangle, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MarketReadPanel } from "@/features/analysis/components/MarketReadPanel";
import { TradeSetupPanel } from "@/features/analysis/components/TradeSetupPanel";
import { useAnalysis } from "@/features/analysis/hooks/useAnalysis";
import { useMarketRead } from "@/features/analysis/hooks/useMarketRead";
import { WatchlistToggle } from "@/features/watchlist/components/WatchlistToggle";
import { ema } from "@/lib/indicators";
import { closes } from "@/lib/indicators";
import { ANALYSIS_DISCLAIMER, SPOT_ONLY_NOTE } from "@/lib/constants/disclaimers";
import { defaultHigherTimeframe } from "@/lib/analysis";
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
import { CandlestickChart, type EmaOverlay } from "./CandlestickChart";
import { MarketHeader } from "./MarketHeader";
import { OverlayToggles, type OverlayState } from "./OverlayToggles";
import { PairSelector } from "./PairSelector";
import { TimeframeSelector } from "./TimeframeSelector";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_TIMEFRAME: Timeframe = "H1";

const EMA_COLORS: Record<number, string> = { 20: "#38bdf8", 50: "#f59e0b", 200: "#a78bfa" };

/**
 * The chart workspace: pair + timeframe selection, live header, candlestick
 * chart. Selection lives in the URL so a view can be linked and shared.
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

  // Only the nearest zone each side is drawn. Every zone at once turns the
  // chart into a ladder of dashed lines that obscures the price action the
  // zones are meant to explain; the panel still lists them all.
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

  const zoneOverlays = useMemo(
    () =>
      overlays.zones && read ? [...read.support.slice(0, 1), ...read.resistance.slice(0, 1)] : [],
    [overlays.zones, read],
  );

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="min-w-0 space-y-4">
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

        <Card>
          <CardHeader className="pb-2">
            <MarketHeader
              market={market}
              ticker={tickerQuery.data}
              livePrice={live?.price}
              liveChangePct={live?.change24hPct}
              connected={connected}
              isLoading={marketsQuery.isLoading}
            />
          </CardHeader>
          <CardContent>
            {marketsQuery.isError && (
              <Alert variant="destructive" className="mb-3">
                <AlertTriangle />
                <AlertDescription>
                  Could not load the curated market list.{" "}
                  {String(marketsQuery.error?.message ?? "")}
                </AlertDescription>
              </Alert>
            )}

            {candlesQuery.isError && (
              <Alert variant="destructive" className="mb-3">
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
              <Alert variant="warning" className="mb-3">
                <AlertTriangle />
                <AlertDescription>
                  On {TIMEFRAME_LABELS[timeframe]} candles most swing highs and lows are noise
                  rather than levels anyone defended, and the indicators warm up on barely a few
                  hours of history. The analysis is computed exactly the same way — it is the input
                  that is thin. Treat anything here as a timing detail on top of a read you took
                  from a higher timeframe.
                </AlertDescription>
              </Alert>
            )}

            {candlesQuery.data?.stale && (
              <Alert variant="warning" className="mb-3">
                <AlertTriangle />
                <AlertDescription>
                  The exchange is unreachable — showing the most recent cached candles. Prices may
                  be behind the market.
                </AlertDescription>
              </Alert>
            )}

            {candlesQuery.isPending || marketsQuery.isLoading ? (
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
              />
            )}
          </CardContent>
        </Card>
      </section>

      <aside className="min-w-0 space-y-4">
        <MarketReadPanel read={read} isLoading={candlesQuery.isPending || marketsQuery.isLoading} />

        <TradeSetupPanel
          result={analysisMatches ? (analysis.data?.result ?? null) : null}
          isPending={analysis.isPending}
          error={analysis.error}
          asOf={analysisMatches ? analysis.data?.asOf : undefined}
        />

        {market && (
          <Card>
            <CardHeader>
              <CardTitle>About {market.asset.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <p className="text-muted-foreground">{market.asset.description}</p>
              <div>
                <div className="mb-1 font-medium">What the token is used for</div>
                <p className="text-muted-foreground">{market.asset.utilityExplanation}</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link
                  href={`/assets/${market.asset.symbol}`}
                  className="text-primary underline underline-offset-2"
                >
                  Research &amp; ethical checklist
                </Link>
                <a
                  href={market.asset.officialWebsite}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-primary underline underline-offset-2"
                >
                  Official website
                </a>
              </div>
            </CardContent>
          </Card>
        )}

        <Alert variant="muted">
          <AlertDescription>
            {ANALYSIS_DISCLAIMER} {SPOT_ONLY_NOTE}
          </AlertDescription>
        </Alert>
      </aside>
    </div>
  );
}
