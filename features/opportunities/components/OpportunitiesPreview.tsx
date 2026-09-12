"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";

import { STATUS_LABELS } from "../labels";
import type { ShortlistResponse } from "../types";

/**
 * The first few opportunities, on the dashboard.
 *
 * The same endpoint and the same order as the full page — a dashboard that
 * ranked for itself would be a second answer to "what is worth reviewing", and
 * the two would disagree the first time either changed. Three entries, because
 * this is a signpost to the review surface rather than the review surface.
 *
 * Silent when there is nothing to show: an empty panel explaining that a scan
 * found nothing belongs on the page devoted to it, not on the dashboard.
 */
const PREVIEW_COUNT = 3;

export function OpportunitiesPreview() {
  const { status: authStatus } = useSession();

  const query = useQuery<ShortlistResponse>({
    // The identical key and URL the full page uses, so opening one warms the
    // other and neither can render a different list from the same cache.
    queryKey: ["shortlist", "all"],
    queryFn: () => fetchApi("/api/scanner/shortlist?size=ALL"),
    enabled: authStatus === "authenticated",
    retry: false,
  });

  if (authStatus !== "authenticated") return null;
  if (query.isPending) return <Skeleton className="h-40 w-full" />;

  // No run yet, or the request failed: the dashboard is not the place to
  // explain either, and the Opportunities page says so properly.
  if (query.isError || !query.data) return null;

  const candidates = query.data.candidates.slice(0, PREVIEW_COUNT);
  if (candidates.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-sm">
          Top opportunities
          <span className="text-[11px] font-normal text-muted-foreground">
            {query.data.totalEligible} eligible from {query.data.totalAnalysed} analyses
          </span>
          <Button asChild size="sm" variant="ghost" className="ml-auto">
            <Link href="/opportunities">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </CardTitle>
      </CardHeader>

      <CardContent className="pt-0">
        <ul className="divide-y">
          {candidates.map((candidate) => (
            <li
              key={`${candidate.symbol}:${candidate.timeframe}`}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-xs"
            >
              <span className="tabular text-[11px] text-muted-foreground">#{candidate.rank}</span>
              <Link
                href={`/opportunities`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {candidate.symbol}
              </Link>
              <span className="text-muted-foreground">
                · {TIMEFRAME_LABELS[candidate.timeframe as Timeframe] ?? candidate.timeframe}
              </span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {/* Out of 100, never a percentage. */}
                Quality {candidate.score}/100
              </span>
              <span className="w-full text-[10px] text-muted-foreground">
                {STATUS_LABELS[candidate.analysisStatus].label}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
