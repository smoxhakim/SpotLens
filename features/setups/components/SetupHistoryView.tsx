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
import { FreshnessBadge } from "@/features/scanner/components/FreshnessBadge";
import { useNow } from "@/features/scanner/hooks/use-now";
import { formatPrice } from "@/lib/format";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import { combinedFreshness, newestReadFreshness, type AnalysisRead } from "@/lib/scanner/freshness";
import type { SetupLifecycleStatus } from "@/lib/setups";
import {
  CLOSED_SETUP_NOTE,
  confirmationCaveat,
  isClosedSetup,
  LIFECYCLE_LABELS,
  storedLevelsWarning,
} from "@/lib/setups/labels";
import { cn } from "@/lib/utils";

export interface TrackedSetup {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  status: SetupLifecycleStatus;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskReward: number;
  riskRewardIsSynthetic: boolean;
  /** The engine's verdict when the setup was first tracked. Never updated. */
  analysisStatus: string;
  score: number;
  scoreGrade: string;
  /** Open time of the last closed candle the creating analysis read. */
  analysedAtCandle: number | null;
  createdAt: string;
  confirmedAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  eventCount: number;
  /** The latest successful scanner pass that found this setup still open. */
  lastScan: AnalysisRead | null;
}

/**
 * How fresh a setup's newest read is: the latest pass that found it still open,
 * else the analysis that created it. Its levels are the creation's either way —
 * this says whether the market has moved on since anyone looked, not whether
 * the numbers changed, because they never do.
 */
export function setupReadFreshness(setup: TrackedSetup, now: number) {
  return newestReadFreshness({
    timeframe: setup.timeframe,
    reads: [
      { analysedAtCandle: setup.analysedAtCandle, recordedAt: Date.parse(setup.createdAt) },
      setup.lastScan,
    ],
    now,
  });
}

/**
 * Colours for the lifecycle. The words come from `lib/setups/labels` — the
 * states are defined by `lib/setups`, and a component must not be the thing
 * that decides what a state means.
 */
const CAUTION = "text-amber-600 dark:text-amber-400";
const STATUS_CLASS: Record<SetupLifecycleStatus, string> = {
  SETUP_FORMING: "text-muted-foreground",
  WAITING_CONFIRMATION: CAUTION,
  CONFIRMATION_DETECTED: "text-bullish",
  POTENTIAL_SETUP: "text-bullish",
  INVALIDATED: "text-bearish",
};

export function SetupHistoryView() {
  const { status: authStatus } = useSession();
  const now = useNow();

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
    <div className="space-y-3">
      <OpenSetupsFreshness setups={setups} now={now} />
      <ul className="space-y-3">
        {setups.map((setup) => (
          <li key={setup.id}>
            <SetupCard setup={setup} now={now} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The page-level count, so a list of stale setups cannot scroll past as if it
 * were current. Open setups only: a closed one is a record whatever its age,
 * and says so on its own card. Nothing while every open setup is fresh.
 */
export function OpenSetupsFreshness({ setups, now }: { setups: TrackedSetup[]; now: number }) {
  const open = setups.filter((setup) => !isClosedSetup(setup.status));
  const judged = open.map((setup) => ({
    timeframe: setup.timeframe,
    freshness: setupReadFreshness(setup, now).freshness,
  }));
  const stale = judged.filter((entry) => entry.freshness.state === "STALE").length;
  const unknown = judged.filter((entry) => entry.freshness.state === "UNKNOWN").length;
  if (stale === 0 && unknown === 0) return null;

  const { staleTimeframes } = combinedFreshness(judged);
  const names = staleTimeframes.map((t) => TIMEFRAME_LABELS[t as Timeframe] ?? t).join(" and ");

  return (
    <Alert variant="warning" data-freshness={stale > 0 ? "STALE" : "UNKNOWN"}>
      <AlertDescription className="text-[11px] leading-relaxed">
        {stale > 0 ? (
          <>
            <span className="font-medium">Out of date.</span> {stale} of {open.length} open setups
            were last read by a scan before the newest {names} candle closed. Their levels are
            historical, not the market now — a new scanner pass is needed before relying on them.
            {unknown > 0 && ` Freshness is unknown for ${unknown} more.`} Each is marked below.
          </>
        ) : (
          <>
            <span className="font-medium">Freshness unknown.</span> For {unknown} of {open.length}{" "}
            open setups, when a scan last read them could not be established, so they may be out of
            date. Treat their levels as historical. Each is marked below.
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function SetupCard({ setup, now }: { setup: TrackedSetup; now: number }) {
  // Evidence on a setup that was never promoted is not a green light — least of
  // all on one the engine rated high risk.
  const caveat =
    setup.status === "CONFIRMATION_DETECTED"
      ? (confirmationCaveat(setup.analysisStatus, { asOf: "creation" }) ??
        "Evidence is not approval: the setup is not a potential setup now.")
      : null;
  const statusClass = caveat ? CAUTION : STATUS_CLASS[setup.status];
  const levelsWarning = storedLevelsWarning(setup);
  // Two separate facts: the lifecycle (closed or not) and, for an open setup,
  // whether a scan has read the latest closed candle. A closed setup has no
  // freshness to speak of — it is a record.
  const closed = isClosedSetup(setup.status);
  const { freshness } = setupReadFreshness(setup, now);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-sm">
          <span>{setup.symbol}</span>
          <span className="text-muted-foreground">{TIMEFRAME_LABELS[setup.timeframe]}</span>
          {!closed && <FreshnessBadge freshness={freshness} />}
          <span className={cn("ml-auto text-xs font-semibold", statusClass)}>
            {LIFECYCLE_LABELS[setup.status]}
          </span>
          {setup.analysisStatus === "HIGH_RISK" && (
            <Badge variant="outline" className="text-[9px]">
              high risk
            </Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-2">
        {closed && (
          <p className="text-[11px] font-medium leading-relaxed text-muted-foreground">
            {CLOSED_SETUP_NOTE}
          </p>
        )}
        {caveat && <p className="text-[11px] leading-relaxed text-muted-foreground">{caveat}</p>}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
          <Field label="Entry">
            {formatPrice(setup.entryLow)} – {formatPrice(setup.entryHigh)}
          </Field>
          <Field label="Stop">{formatPrice(setup.stopLoss)}</Field>
          <Field label="Targets">
            {setup.takeProfit1 === null ? "—" : formatPrice(setup.takeProfit1)}
            {setup.takeProfit2 === null ? "" : ` · ${formatPrice(setup.takeProfit2)}`}
            {setup.takeProfit3 === null ? "" : ` · ${formatPrice(setup.takeProfit3)}`}
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

        {levelsWarning && (
          <Alert variant="warning">
            <AlertDescription className="text-[11px]">{levelsWarning}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            Score {setup.score}/100 · {setup.scoreGrade.toLowerCase()}
          </span>
          <span>· First seen {new Date(setup.createdAt).toLocaleString()}</span>
          {setup.confirmedAt && (
            <span>· Confirmed {new Date(setup.confirmedAt).toLocaleString()}</span>
          )}
          {!closed && (
            <span>
              ·{" "}
              {setup.lastScan?.recordedAt
                ? `Last found open by a scan ${new Date(setup.lastScan.recordedAt).toLocaleString()}`
                : "Not read by a scan since"}
            </span>
          )}
          <span>
            · {setup.eventCount} {setup.eventCount === 1 ? "event" : "events"}
          </span>
        </div>

        <p className="text-[10px] leading-relaxed text-muted-foreground">
          These are the numbers as they stood when the setup was first seen. Later analysis moves
          them; this record deliberately does not follow.
        </p>

        <JournalActions setupId={setup.id} closed={closed} />

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
 *
 * A closed setup can still be journaled as skipped — passing on it is worth
 * recording — but not as watching: there is nothing left to watch.
 */
function JournalActions({ setupId, closed }: { setupId: string; closed: boolean }) {
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
          {!closed && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[10px]"
              onClick={() => journal.mutate("WATCHING")}
              disabled={journal.isPending}
            >
              Journal as watching
            </Button>
          )}
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
