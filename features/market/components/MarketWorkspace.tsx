"use client";

import { AlertTriangle, LineChart, RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ANALYSIS_DISCLAIMER, SPOT_ONLY_NOTE } from "@/lib/constants/disclaimers";
import { isTimeframe, type Timeframe } from "@/lib/market-data/provider";
import type { MarketSummary } from "@/types/market";

import { useCandles } from "../hooks/useCandles";
import { useLivePrice } from "../hooks/useLivePrice";
import { useMarkets } from "../hooks/useMarkets";
import { useTicker } from "../hooks/useTicker";
import { CandlestickChart } from "./CandlestickChart";
import { MarketHeader } from "./MarketHeader";
import { PairSelector } from "./PairSelector";
import { TimeframeSelector } from "./TimeframeSelector";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_TIMEFRAME: Timeframe = "H1";

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

  const candles = candlesQuery.data?.candles ?? [];

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
              <CandlestickChart candles={candles} livePrice={live?.price ?? null} />
            )}
          </CardContent>
        </Card>
      </section>

      <aside className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LineChart className="h-4 w-4" />
              Market Analysis
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs text-muted-foreground">
            <p>
              The deterministic analysis engine lands next: trend and market structure, support and
              resistance zones, entry zone, stop loss, take-profit targets, risk/reward, a setup
              score, and a clear status — each with the reasoning behind it.
            </p>
            <p>
              Until then this workspace is a chart viewer. SpotLens will not show a trade setup
              before the numbers behind it are calculated and tested.
            </p>
          </CardContent>
        </Card>

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
              <a
                href={market.asset.officialWebsite}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-block text-primary underline underline-offset-2"
              >
                Official website
              </a>
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
