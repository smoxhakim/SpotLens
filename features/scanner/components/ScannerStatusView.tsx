"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSession } from "next-auth/react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import { cn } from "@/lib/utils";

interface ScannerRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  timeframes: Timeframe[];
  triggeredBy: string;
  marketCount: number;
  analysed: number;
  succeeded: number;
  failed: number;
  potentialSetups: number;
  waiting: number;
  highRisk: number;
  avoided: number;
  setupsCreated: number;
  stateChanges: number;
  invalidations: number;
  durationMs: number | null;
}

const STATUS_META: Record<ScannerRun["status"], { label: string; className: string }> = {
  RUNNING: { label: "Running", className: "text-muted-foreground" },
  COMPLETED: { label: "Completed", className: "text-bullish" },
  PARTIAL: { label: "Partial", className: "text-amber-600 dark:text-amber-400" },
  FAILED: { label: "Failed", className: "text-bearish" },
};

export function ScannerStatusView() {
  const { status: authStatus } = useSession();

  const query = useQuery<{ runs: ScannerRun[] }>({
    queryKey: ["scanner-runs"],
    queryFn: () => fetchApi("/api/scanner/runs?limit=10"),
    enabled: authStatus === "authenticated",
  });

  if (authStatus === "loading") return <Skeleton className="h-40 w-full" />;

  if (authStatus !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Scanner history is kept with your account.</p>
          <Button asChild size="sm" className="mt-3">
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (query.isPending) return <Skeleton className="h-40 w-full" />;

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{(query.error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const runs = query.data?.runs ?? [];

  if (runs.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-2 p-6 text-sm text-muted-foreground">
          <p>The scanner has not run yet. It is a local process, started separately:</p>
          <pre className="rounded-md bg-muted p-3 text-xs">npm run scanner</pre>
          <p className="text-[11px]">
            It wakes shortly after each candle closes rather than polling, so a scan happens once
            per candle and not once per minute. <code>npm run scanner:once</code> runs a single pass
            and exits.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <ul className="space-y-3">
      {runs.map((run) => (
        <li key={run.id}>
          <RunCard run={run} />
        </li>
      ))}
    </ul>
  );
}

function RunCard({ run }: { run: ScannerRun }) {
  const meta = STATUS_META[run.status];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-sm">
          {/* Stored in UTC; rendered in the reader's zone, which is the only
              place a local time belongs. */}
          <span>{new Date(run.startedAt).toLocaleString()}</span>
          <span className="text-muted-foreground">
            {run.timeframes.map((t) => TIMEFRAME_LABELS[t]).join(" + ")}
          </span>
          {run.triggeredBy === "MANUAL" && (
            <Badge variant="outline" className="text-[9px]">
              manual
            </Badge>
          )}
          <span className={cn("ml-auto text-xs font-semibold", meta.className)}>{meta.label}</span>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
          <Field label="Markets">{run.marketCount}</Field>
          <Field label="Analysed">
            {run.succeeded}/{run.analysed}
          </Field>
          <Field label="Failed">{run.failed}</Field>
          <Field label="Duration">
            {run.durationMs === null ? "—" : `${(run.durationMs / 1000).toFixed(1)}s`}
          </Field>
        </dl>

        <div>
          <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            What the markets said
          </h4>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
            <Field label="Potential setup">{run.potentialSetups}</Field>
            <Field label="Waiting">{run.waiting}</Field>
            <Field label="High risk">{run.highRisk}</Field>
            <Field label="Avoid">{run.avoided}</Field>
          </dl>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            Most markets saying wait or avoid is the engine working as intended, not a scan that
            found nothing.
          </p>
        </div>

        {(run.setupsCreated > 0 || run.stateChanges > 0 || run.invalidations > 0) && (
          <div>
            <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              What changed
            </h4>
            <dl className="grid grid-cols-3 gap-x-4 text-[11px]">
              <Field label="Setups created">{run.setupsCreated}</Field>
              <Field label="State changes">{run.stateChanges}</Field>
              <Field label="Invalidations">{run.invalidations}</Field>
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular font-medium text-foreground">{children}</dd>
    </div>
  );
}
