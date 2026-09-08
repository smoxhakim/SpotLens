"use client";

import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import type { TradeStatus } from "@/lib/analysis";
import { formatPrice } from "@/lib/format";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";

import { WhyDisclosure } from "./WhyDisclosure";

interface HistoryItem {
  id: string;
  label: string;
  timeframe: Timeframe;
  trend: string;
  status: TradeStatus;
  statusReason: string;
  setupScore: number;
  riskRewardRatio: number;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  createdAt: string;
}

const STATUS_VARIANT: Record<TradeStatus, "bullish" | "bearish" | "neutral"> = {
  POTENTIAL_SETUP: "bullish",
  WAIT_FOR_CONFIRMATION: "neutral",
  HIGH_RISK: "neutral",
  AVOID: "bearish",
};

/**
 * Past analyses, newest first.
 *
 * Kept on the Dashboard rather than given its own nav item: the PRD fixes the
 * sidebar's six destinations, and "what did I look at recently" is a dashboard
 * question.
 */
export function AnalysisHistory() {
  const { status } = useSession();

  const query = useQuery<{ items: HistoryItem[] }>({
    queryKey: ["analysis-history"],
    queryFn: () => fetchApi("/api/analysis/history?limit=10"),
    enabled: status === "authenticated",
  });

  if (status !== "authenticated") return null;
  if (query.isPending) return <Skeleton className="h-32 w-full" />;

  const items = query.data?.items ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <History className="h-4 w-4" />
          Recent analyses
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            Nothing yet. Runs are saved automatically once you are signed in.
          </p>
        ) : (
          <ul className="divide-y">
            {items.map((item) => (
              <li key={item.id} className="py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/market-analysis?pair=${item.label.replace("/", "")}&tf=${item.timeframe}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {item.label}
                  </Link>
                  <span className="text-[10px] text-muted-foreground">
                    {TIMEFRAME_LABELS[item.timeframe]}
                  </span>
                  <Badge variant={STATUS_VARIANT[item.status]} className="text-[9px]">
                    {item.status.replace(/_/g, " ").toLowerCase()}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {item.setupScore}/100 · 1:{Number(item.riskRewardRatio).toFixed(1)}
                  </span>
                  <time
                    className="ml-auto text-[10px] text-muted-foreground"
                    dateTime={item.createdAt}
                  >
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                </div>

                <WhyDisclosure label="What it said">
                  <p>{item.statusReason}</p>
                  <p className="tabular mt-1.5">
                    Entry {formatPrice(item.entryLow)} – {formatPrice(item.entryHigh)} · Stop{" "}
                    {formatPrice(item.stopLoss)}
                  </p>
                  <p className="mt-1.5 italic">
                    These are the levels as they were calculated at the time, not current advice.
                  </p>
                </WhyDisclosure>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
