"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import { formatPrice } from "@/lib/format";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import type { SetupLifecycleStatus } from "@/lib/setups";
import { cn } from "@/lib/utils";

interface TrackedSetup {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  status: SetupLifecycleStatus;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit1: number | null;
  takeProfit2: number | null;
  riskReward: number;
  riskRewardIsSynthetic: boolean;
  score: number;
  scoreGrade: string;
  createdAt: string;
  confirmedAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  eventCount: number;
}

/**
 * Labels for the lifecycle, kept here because they are presentation only — the
 * states themselves are defined by `lib/setups`, and a component must not be
 * the thing that decides what a state means.
 */
const STATUS_META: Record<SetupLifecycleStatus, { label: string; className: string }> = {
  SETUP_FORMING: { label: "Forming", className: "text-muted-foreground" },
  WAITING_CONFIRMATION: {
    label: "Waiting for confirmation",
    className: "text-amber-600 dark:text-amber-400",
  },
  CONFIRMATION_DETECTED: { label: "Confirmation detected", className: "text-bullish" },
  POTENTIAL_SETUP: { label: "Potential setup", className: "text-bullish" },
  INVALIDATED: { label: "Invalidated", className: "text-bearish" },
};

export function SetupHistoryView() {
  const { status: authStatus } = useSession();

  const query = useQuery<{ setups: TrackedSetup[] }>({
    queryKey: ["setups"],
    queryFn: () => fetchApi("/api/setups?limit=50"),
    enabled: authStatus === "authenticated",
  });

  if (authStatus === "loading") return <Skeleton className="h-40 w-full" />;

  if (authStatus !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Setups are tracked against your account.</p>
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

  const setups = query.data?.setups ?? [];

  if (setups.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Nothing tracked yet. Run an analysis on a pair and, if the engine finds a level worth
          watching, it will appear here and be followed from run to run.
        </CardContent>
      </Card>
    );
  }

  return (
    <ul className="space-y-3">
      {setups.map((setup) => (
        <li key={setup.id}>
          <SetupCard setup={setup} />
        </li>
      ))}
    </ul>
  );
}

function SetupCard({ setup }: { setup: TrackedSetup }) {
  const meta = STATUS_META[setup.status];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-sm">
          <span>{setup.symbol}</span>
          <span className="text-muted-foreground">{TIMEFRAME_LABELS[setup.timeframe]}</span>
          <span className={cn("ml-auto text-xs font-semibold", meta.className)}>{meta.label}</span>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-2">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
          <Field label="Entry">
            {formatPrice(setup.entryLow)} – {formatPrice(setup.entryHigh)}
          </Field>
          <Field label="Stop">{formatPrice(setup.stopLoss)}</Field>
          <Field label="Targets">
            {setup.takeProfit1 === null ? "—" : formatPrice(setup.takeProfit1)}
            {setup.takeProfit2 === null ? "" : ` · ${formatPrice(setup.takeProfit2)}`}
          </Field>
          <Field label="Risk / reward">
            1:{setup.riskReward.toFixed(1)}
            {setup.riskRewardIsSynthetic && (
              <Badge variant="outline" className="ml-1 text-[9px]">
                unmeasured
              </Badge>
            )}
          </Field>
        </dl>

        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            Score {setup.score}/100 · {setup.scoreGrade.toLowerCase()}
          </span>
          <span>· First seen {new Date(setup.createdAt).toLocaleString()}</span>
          {setup.confirmedAt && (
            <span>· Confirmed {new Date(setup.confirmedAt).toLocaleString()}</span>
          )}
          <span>
            · {setup.eventCount} {setup.eventCount === 1 ? "event" : "events"}
          </span>
        </div>

        <p className="text-[10px] leading-relaxed text-muted-foreground">
          These are the numbers as they stood when the setup was first seen. Later analysis moves
          them; this record deliberately does not follow.
        </p>

        <JournalActions setupId={setup.id} />

        {setup.invalidationReason && (
          <Alert variant="warning">
            <AlertDescription className="text-[11px]">{setup.invalidationReason}</AlertDescription>
          </Alert>
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

/**
 * Records a decision about this setup, or opens the one already recorded.
 *
 * Journaling is not acting: it writes down what the person decided, including
 * deciding to pass. Nothing is sent to an exchange, and the request is
 * idempotent — a setup already journaled returns its existing entry rather
 * than a second one.
 */
function JournalActions({ setupId }: { setupId: string }) {
  const queryClient = useQueryClient();
  const [entryId, setEntryId] = useState<string | null>(null);

  const journal = useMutation({
    mutationFn: (decision: "WATCHING" | "SKIPPED") =>
      fetchApi<{ id: string }>("/api/journal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trackedSetupId: setupId, decision }),
      }),
    onSuccess: (data) => {
      setEntryId(data.id);
      queryClient.invalidateQueries({ queryKey: ["journal"] });
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      {entryId ? (
        <Button asChild size="sm" variant="outline" className="h-7 px-2 text-[10px]">
          <Link href={`/journal/${entryId}`}>Open journal entry</Link>
        </Button>
      ) : (
        <>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            onClick={() => journal.mutate("WATCHING")}
            disabled={journal.isPending}
          >
            Journal as watching
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[10px]"
            onClick={() => journal.mutate("SKIPPED")}
            disabled={journal.isPending}
          >
            Journal as skipped
          </Button>
        </>
      )}
      <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-[10px]">
        <Link href={`/replay/${setupId}`}>Replay</Link>
      </Button>
    </div>
  );
}
