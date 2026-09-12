"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import { cn } from "@/lib/utils";

import {
  DEFAULT_VIEW,
  VIEW_LABELS,
  visibleCandidates,
  type ShortlistResponse,
  type TimeframeFilter,
  type ViewSize,
} from "../types";
import { OpportunityCard } from "./OpportunityCard";

/**
 * The review surface: the few candidates from the latest pass worth a look.
 *
 * One request, for the whole eligible list, and every view is a slice of it.
 * That is the only arithmetic here — the order arrives from Phase L and this
 * component has no comparison function, no threshold and no score. Switching
 * between Top 5, Top 10 and Top 15 therefore cannot change what sits above,
 * and neither can a filter.
 */

const VIEWS: ViewSize[] = ["top5", "top10", "top15", "all"];

export function OpportunitiesView() {
  const { status: authStatus } = useSession();
  const [view, setView] = useState<ViewSize>(DEFAULT_VIEW);
  const [timeframe, setTimeframe] = useState<TimeframeFilter>("all");

  const query = useQuery<ShortlistResponse>({
    // `size=ALL` once, sliced locally, rather than a request per view: four
    // round trips to reorder nothing would be four chances for two views to
    // disagree about what is third.
    queryKey: ["shortlist", "all"],
    queryFn: () => fetchApi("/api/scanner/shortlist?size=ALL"),
    enabled: authStatus === "authenticated",
  });

  const candidates = useMemo(() => query.data?.candidates ?? [], [query.data]);
  const visible = useMemo(
    () => visibleCandidates(candidates, view, timeframe),
    [candidates, view, timeframe],
  );

  const timeframes = query.data?.run.timeframes ?? [];

  if (authStatus === "loading") return <Skeleton className="h-48 w-full" />;

  if (authStatus !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Scanner results are kept with your account.</p>
          <Button asChild size="sm" className="mt-3">
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (query.isPending) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading opportunities">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  }

  if (query.isError) {
    const notFound = (query.error as { status?: number }).status === 404;

    // A 404 means no pass has been recorded, which is a state of the system
    // rather than a fault — it gets the explanation, not the error styling.
    if (notFound) return <NoScannerRun />;

    return (
      <Alert variant="destructive">
        <AlertDescription className="space-y-2">
          <p>Unable to load the latest opportunities.</p>
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const data = query.data;

  return (
    <div className="space-y-4">
      <ScanContext data={data} />

      {data.totalEligible === 0 ? (
        <NothingEligible data={data} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Toggle
              legend="How many to show"
              options={VIEWS.map((v) => ({ value: v, label: VIEW_LABELS[v] }))}
              value={view}
              onChange={setView}
            />

            {timeframes.length > 1 && (
              <Toggle
                legend="Filter by timeframe"
                // "All timeframes" rather than "All": the view toggle beside it
                // also has an "All", and two controls with the same accessible
                // name is a coin toss for anyone navigating by name.
                options={[
                  { value: "all" as const, label: "All timeframes" },
                  ...timeframes.map((t) => ({ value: t, label: TIMEFRAME_LABELS[t] })),
                ]}
                value={timeframe}
                onChange={setTimeframe}
              />
            )}
          </div>

          {visible.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                No opportunities match this filter. {data.totalEligible} are eligible on{" "}
                {timeframes.map((t) => TIMEFRAME_LABELS[t]).join(" and ")}.
              </CardContent>
            </Card>
          ) : (
            <ul className="space-y-3">
              {visible.map((candidate) => (
                <li key={`${candidate.symbol}:${candidate.timeframe}`}>
                  <OpportunityCard candidate={candidate} runId={data.run.id} />
                </li>
              ))}
            </ul>
          )}

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Ranked by the scanner, not by preference — quality is a score out of 100, never a
            probability, and a place on this list is an invitation to review the analysis rather
            than a reason to trade.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Which pass this is, and how much it looked at.
 *
 * The breadth matters as much as the shortlist: "5 of 30 eligible, from 90
 * analyses" is the honest headline, and five cards on their own would hide how
 * much was examined and refused.
 */
function ScanContext({ data }: { data: ShortlistResponse }) {
  const { run } = data;
  const when = run.completedAt ?? run.startedAt;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-baseline gap-x-4 gap-y-1 p-4 text-[11px] text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{run.marketCount}</span> markets ·{" "}
          <span className="font-medium text-foreground">
            {run.timeframes.map((t) => TIMEFRAME_LABELS[t]).join(" + ")}
          </span>{" "}
          · <span className="font-medium text-foreground">{data.totalAnalysed}</span> analyses
        </span>
        <span>
          <span className="font-medium text-foreground">{data.totalEligible}</span> eligible to
          review
        </span>
        {/* Stored UTC, shown in the reader's own zone — the only place a local
            time belongs. Naming the pass is what stops two runs being mixed. */}
        <span className="sm:ml-auto">Scanned {new Date(when).toLocaleString()}</span>
      </CardContent>
    </Card>
  );
}

function NothingEligible({ data }: { data: ShortlistResponse }) {
  const avoid = data.excluded.AVOID ?? 0;
  const highRisk = data.excluded.HIGH_RISK ?? 0;

  return (
    <Card>
      <CardContent className="space-y-2 p-6 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">
          No opportunities currently meet the review threshold.
        </p>
        <p className="text-[11px] leading-relaxed">
          The scanner analysed {data.totalAnalysed} market and timeframe combinations and none
          cleared the bar this pass — {avoid} were refused outright and {highRisk} were judged high
          risk. Most passes look like this. It is the engine being selective rather than the scanner
          finding nothing.
        </p>
      </CardContent>
    </Card>
  );
}

function NoScannerRun() {
  return (
    <Card>
      <CardContent className="space-y-2 p-6 text-sm text-muted-foreground">
        <p>No scanner results yet. The scanner is a local process, started separately:</p>
        <pre className="rounded-md bg-muted p-3 text-xs">npm run scanner</pre>
        <p className="text-[11px]">
          <code>npm run scanner:once</code> runs a single pass and exits.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * A small set of exclusive choices.
 *
 * Real buttons in a labelled group rather than a styled div: the keyboard
 * reaches them, focus is visible, and the selected one says so through
 * `aria-pressed` instead of through its colour alone.
 */
function Toggle<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div role="group" aria-label={legend} className="inline-flex rounded-md bg-muted p-1">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export type { Timeframe };
