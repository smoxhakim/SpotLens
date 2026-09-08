"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MarketSummary } from "@/types/market";

const CATEGORY_ORDER = [
  "LAYER1",
  "LAYER2",
  "INFRASTRUCTURE",
  "ORACLE",
  "DEFI_INFRASTRUCTURE",
  "PAYMENTS",
  "OTHER",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  LAYER1: "Layer 1",
  LAYER2: "Layer 2",
  INFRASTRUCTURE: "Infrastructure",
  ORACLE: "Oracle",
  DEFI_INFRASTRUCTURE: "DeFi infrastructure",
  PAYMENTS: "Payments",
  OTHER: "Other",
};

export function MarketDirectory({ markets }: { markets: MarketSummary[] }) {
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? markets.filter(
          (m) =>
            m.label.toLowerCase().includes(q) ||
            m.asset.name.toLowerCase().includes(q) ||
            m.asset.symbol.toLowerCase().includes(q),
        )
      : markets;

    return CATEGORY_ORDER.map((category) => ({
      category,
      items: filtered.filter((m) => m.asset.category === category),
    })).filter((group) => group.items.length > 0);
  }, [markets, query]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle>Curated markets</CardTitle>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          aria-label="Search curated markets"
          className="h-8 w-48 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
        />
      </CardHeader>
      <CardContent className="space-y-5">
        {grouped.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            No curated asset matches “{query}”.
          </p>
        )}
        {grouped.map(({ category, items }) => (
          <div key={category}>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {CATEGORY_LABELS[category]}
            </h3>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((market) => (
                <li key={market.pairId}>
                  <Link
                    href={`/market-analysis?pair=${market.exchangeSymbol}&tf=H1`}
                    className="flex items-center gap-2 rounded-md border p-2.5 transition-colors hover:bg-accent/50"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{market.label}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {market.asset.name}
                      </div>
                    </div>
                    <Badge
                      variant={
                        market.asset.riskLevel === "LOW"
                          ? "bullish"
                          : market.asset.riskLevel === "HIGH"
                            ? "bearish"
                            : "neutral"
                      }
                      className="ml-auto shrink-0 text-[10px]"
                    >
                      {market.asset.riskLevel.toLowerCase()}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
