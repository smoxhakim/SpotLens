"use client";

import { useQuery } from "@tanstack/react-query";
import { NotebookPen } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import { formatPrice } from "@/lib/format";
import type { JournalDecision } from "@/lib/journal";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import { cn } from "@/lib/utils";

export interface JournalEntrySummary {
  id: string;
  decision: JournalDecision;
  skipReason: string | null;
  notes: string | null;
  setupStatusAtDecision: string | null;
  decidedAt: string;
  /** Which kind of record the decision was made against. */
  source: "TRACKED_SETUP" | "SCANNER_RESULT";
  symbol: string | null;
  timeframe: Timeframe | null;
  /** Whether a Coach review had been read. Never whether one approved anything. */
  coachReviewed: boolean;
  /** The scanner's verdict, for a market that was scored but never tracked. */
  opportunity: {
    runId: string;
    scannedAt: string | null;
    analysisStatus: string | null;
    score: number | null;
    scoreGrade: string | null;
  } | null;
  setup: {
    id: string;
    symbol: string;
    timeframe: Timeframe;
    currentStatus: string;
    entryLow: number;
    entryHigh: number;
    stopLoss: number;
    riskReward: number;
    riskRewardIsSynthetic: boolean;
    score: number;
    scoreGrade: string;
    analysisStatus: string;
  } | null;
  trade: { realizedR: number | null; netPnl: number | null } | null;
}

/** Presentation only. The states themselves are defined in `lib/journal`. */
export const DECISION_META: Record<JournalDecision, { label: string; className: string }> = {
  WATCHING: { label: "Watching", className: "text-muted-foreground" },
  SKIPPED: { label: "Skipped", className: "text-muted-foreground" },
  TAKEN: { label: "Taken", className: "text-bullish" },
  CANCELLED: { label: "Cancelled", className: "text-muted-foreground" },
  CLOSED: { label: "Closed", className: "text-foreground" },
};

const FILTERS: (JournalDecision | "ALL")[] = [
  "ALL",
  "WATCHING",
  "TAKEN",
  "CLOSED",
  "SKIPPED",
  "CANCELLED",
];

export function JournalList() {
  const { status: authStatus } = useSession();
  const [filter, setFilter] = useState<JournalDecision | "ALL">("ALL");

  const query = useQuery<{ entries: JournalEntrySummary[]; nextCursor: string | null }>({
    queryKey: ["journal", filter],
    queryFn: () =>
      fetchApi(`/api/journal?limit=50${filter === "ALL" ? "" : `&decision=${filter}`}`),
    enabled: authStatus === "authenticated",
  });

  if (authStatus === "loading") return <Skeleton className="h-40 w-full" />;

  if (authStatus !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Your journal is kept with your account.</p>
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

  const entries = query.data?.entries ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((option) => (
          <Button
            key={option}
            size="sm"
            variant={filter === option ? "default" : "outline"}
            className="h-7 px-2 text-[11px]"
            onClick={() => setFilter(option)}
          >
            {option === "ALL" ? "All" : DECISION_META[option].label}
          </Button>
        ))}
      </div>

      {entries.length === 0 ? (
        <Card>
          <CardContent className="space-y-2 p-6 text-sm text-muted-foreground">
            <p>Nothing journaled yet.</p>
            <p className="text-[11px] leading-relaxed">
              Pick something from{" "}
              <Link href="/opportunities" className="underline">
                Opportunities
              </Link>{" "}
              or{" "}
              <Link href="/setups" className="underline">
                Setups
              </Link>{" "}
              and record what you decided — including deciding to pass. A skipped setup is data too:
              without it, research only sees the trades you took.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2" data-testid="journal-entries">
          {entries.map((entry) => (
            <li key={entry.id}>
              <EntryCard entry={entry} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryCard({ entry }: { entry: JournalEntrySummary }) {
  const meta = DECISION_META[entry.decision];
  const setup = entry.setup;
  const symbol = setup?.symbol ?? entry.symbol ?? "Unknown market";
  const timeframe = setup?.timeframe ?? entry.timeframe;

  return (
    <Card>
      <CardContent className="space-y-1.5 p-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <NotebookPen className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Link href={`/journal/${entry.id}`} className="text-xs font-semibold hover:underline">
            {symbol}
          </Link>
          <span className="text-[10px] text-muted-foreground">
            {timeframe ? TIMEFRAME_LABELS[timeframe] : "—"}
          </span>
          <span className={cn("text-[11px] font-medium", meta.className)}>{meta.label}</span>
          {entry.trade?.realizedR !== null && entry.trade !== null && (
            <Badge
              variant={entry.trade.realizedR! > 0 ? "bullish" : "bearish"}
              className="text-[9px]"
            >
              {entry.trade.realizedR!.toFixed(2)}R
            </Badge>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground">
            {new Date(entry.decidedAt).toLocaleString()}
          </span>
        </div>

        {/* A tracked setup shows what SpotLens planned; an untracked one shows
            the verdict and the score, which is all the scanner produced for it.
            No entry, stop or ratio is displayed for the second kind, because
            none exists — and a dash in those places would read as missing data
            rather than as the honest answer. */}
        {setup ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] sm:grid-cols-4">
            <Field label="SpotLens entry">
              {formatPrice(setup.entryLow)} – {formatPrice(setup.entryHigh)}
            </Field>
            <Field label="Stop">{formatPrice(setup.stopLoss)}</Field>
            <Field label="Quality">{setup.score}/100</Field>
            <Field label="R:R">
              1:{setup.riskReward.toFixed(1)}
              {setup.riskRewardIsSynthetic && " (unmeasured)"}
            </Field>
          </dl>
        ) : (
          <div className="space-y-1">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] sm:grid-cols-4">
              <Field label="Quality">
                {entry.opportunity?.score === null || entry.opportunity?.score === undefined
                  ? "—"
                  : `${entry.opportunity.score}/100`}
              </Field>
              <Field label="Verdict">
                {entry.opportunity?.analysisStatus
                  ? entry.opportunity.analysisStatus.toLowerCase().replace(/_/g, " ")
                  : "—"}
              </Field>
            </dl>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Untracked opportunity — SpotLens scored this market but never tracked a setup for it,
              so there are no levels on the record.
            </p>
          </div>
        )}

        {entry.coachReviewed && (
          <p className="text-[10px] text-muted-foreground">
            A Coach review was read before deciding.
          </p>
        )}

        {entry.skipReason && (
          <p className="text-[10px] text-muted-foreground">
            Skipped: {entry.skipReason.toLowerCase().replace(/_/g, " ")}
          </p>
        )}
        {entry.notes && <p className="text-[11px] leading-relaxed">{entry.notes}</p>}
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular font-medium">{children}</dd>
    </div>
  );
}
