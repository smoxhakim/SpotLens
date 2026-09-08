"use client";

import { Wifi, WifiOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCompact, formatPercent, formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MarketSummary, TickerResponse } from "@/types/market";

interface MarketHeaderProps {
  market?: MarketSummary;
  ticker?: TickerResponse;
  livePrice?: number | null;
  liveChangePct?: number | null;
  connected: boolean;
  isLoading: boolean;
}

export function MarketHeader({
  market,
  ticker,
  livePrice,
  liveChangePct,
  connected,
  isLoading,
}: MarketHeaderProps) {
  const price = livePrice ?? ticker?.ticker.price ?? null;
  const changePct = liveChangePct ?? ticker?.ticker.change24hPct ?? null;
  const up = (changePct ?? 0) >= 0;

  if (isLoading || !market) {
    return (
      <div className="flex flex-wrap items-end gap-6">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-28" />
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">{market.label}</h1>
          <Badge variant="outline" className="text-[10px]">
            {market.asset.category.replace(/_/g, " ").toLowerCase()}
          </Badge>
          <Badge
            variant={
              market.asset.riskLevel === "LOW"
                ? "bullish"
                : market.asset.riskLevel === "HIGH"
                  ? "bearish"
                  : "neutral"
            }
            className="text-[10px]"
          >
            {market.asset.riskLevel.toLowerCase()} risk
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{market.asset.name}</p>
      </div>

      <div className="flex items-baseline gap-3">
        <span
          data-testid="last-price"
          className={cn("tabular text-2xl font-semibold", up ? "text-bullish" : "text-bearish")}
        >
          {price === null ? "—" : formatPrice(price)}
        </span>
        <span className={cn("tabular text-sm font-medium", up ? "text-bullish" : "text-bearish")}>
          {formatPercent(changePct)}
        </span>
        <span className="text-[11px] text-muted-foreground">24h</span>
      </div>

      <dl className="flex gap-6 text-xs">
        <div>
          <dt className="text-muted-foreground">24h high</dt>
          <dd className="tabular font-medium">{formatPrice(ticker?.ticker.high24h)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">24h low</dt>
          <dd className="tabular font-medium">{formatPrice(ticker?.ticker.low24h)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">24h volume</dt>
          <dd className="tabular font-medium">
            {formatCompact(ticker?.ticker.volume24h)} {market.asset.symbol}
          </dd>
        </div>
      </dl>

      <div
        className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground"
        title={connected ? "Streaming live prices" : "Falling back to periodic refresh"}
      >
        {connected ? (
          <Wifi className="h-3.5 w-3.5 text-bullish" />
        ) : (
          <WifiOff className="h-3.5 w-3.5" />
        )}
        {connected ? "Live" : "Polling"}
      </div>
    </div>
  );
}
