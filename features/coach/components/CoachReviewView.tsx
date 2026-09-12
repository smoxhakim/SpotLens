"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSession } from "next-auth/react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import {
  VERDICT_LABELS,
  type CoachContext,
  type CoachReview,
  type CoachSection,
} from "@/lib/coach";
import { ANALYSIS_DISCLAIMER } from "@/lib/constants/disclaimers";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import { cn } from "@/lib/utils";

/**
 * The review, as something to read and learn from.
 *
 * Every number on this page is rendered from `context` — the facts SpotLens
 * recorded — and every sentence from `review`. Keeping them in separate objects
 * is what makes the rule enforceable rather than aspirational: prose cannot
 * become the source of a price, because no price is read from it.
 *
 * Ordered the way a reader needs it: what this is, how it reads, what supports
 * it, what does not, then the detail. The actions at the end all lead somewhere
 * to look at, and there is deliberately no action that places anything.
 */

interface CoachResponse {
  context: CoachContext;
  review: CoachReview;
  degraded: boolean;
  /** Whether a model wrote the prose, or SpotLens's own reading did. */
  source: "MODEL" | "DETERMINISTIC";
}

/** Restrained: a verdict is a reading of evidence, never a rating of a trade. */
const VERDICT_TONE: Record<string, string> = {
  STRONG_EVIDENCE: "text-bullish",
  PROMISING_NEEDS_CONFIRMATION: "text-sky-600 dark:text-sky-400",
  MIXED_EVIDENCE: "text-amber-600 dark:text-amber-400",
  CONTRADICTED: "text-bearish",
  INSUFFICIENT_DATA: "text-muted-foreground",
};

export function CoachReviewView({
  symbol,
  timeframe,
  runId,
  setupId,
}: {
  symbol: string | null;
  timeframe: Timeframe | null;
  runId: string | null;
  setupId: string | null;
}) {
  const { status: authStatus } = useSession();
  const complete = symbol !== null && timeframe !== null && runId !== null;

  const params = new URLSearchParams();
  if (symbol) params.set("symbol", symbol);
  if (timeframe) params.set("tf", timeframe);
  if (runId) params.set("runId", runId);
  if (setupId) params.set("setupId", setupId);

  const query = useQuery<CoachResponse>({
    queryKey: ["coach", symbol, timeframe, runId, setupId],
    queryFn: () => fetchApi(`/api/coach?${params.toString()}`),
    enabled: authStatus === "authenticated" && complete,
    retry: false,
  });

  if (authStatus === "loading") return <Skeleton className="h-64 w-full" />;

  if (authStatus !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Coach reviews read your own recorded analyses.</p>
          <Button asChild size="sm" className="mt-3">
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!complete) {
    return (
      <Card>
        <CardContent className="space-y-2 p-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Nothing to review yet.</p>
          <p className="text-[11px] leading-relaxed">
            Open the Coach from an opportunity so it knows which market, timeframe and scan you are
            asking about. A review needs the analysis SpotLens recorded, not a market name.
          </p>
          <Button asChild size="sm" variant="outline" className="mt-1">
            <Link href="/opportunities">Browse opportunities</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (query.isPending) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading the Coach review">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (query.isError) {
    const status = (query.error as { status?: number }).status;

    return (
      <Alert variant={status === 404 ? "muted" : "destructive"}>
        <AlertDescription className="space-y-2">
          <p className="font-medium text-foreground">
            {status === 404
              ? "No recorded analysis matches that reference."
              : "Coach review is temporarily unavailable."}
          </p>
          <p className="text-[11px] leading-relaxed">
            {status === 404
              ? "The scan this was opened from may have been replaced, or the setup is no longer one of yours. The analysis itself is still available."
              : "The SpotLens analysis is unaffected — it is deterministic and does not depend on the Coach."}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {status !== 404 && (
              <Button size="sm" variant="outline" onClick={() => query.refetch()}>
                Try again
              </Button>
            )}
            {symbol && timeframe && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/market-analysis?pair=${symbol}&tf=${timeframe}`}>
                  Open the analysis
                </Link>
              </Button>
            )}
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  const { context, review, degraded, source } = query.data;
  const levels = context.levels;

  return (
    <div className="space-y-4">
      {/* Which reading this is, said plainly. A reader deciding how much weight
          to give a paragraph deserves to know whether a model wrote it, and a
          page that quietly swapped between the two would be the worse
          failure — the numbers are identical either way, the prose is not. */}
      <Alert variant="muted">
        <AlertDescription className="space-y-1 text-[11px] leading-relaxed">
          {degraded ? (
            <p>
              <span className="font-medium text-foreground">
                The AI Coach was unavailable, so this is SpotLens&apos;s own reading.
              </span>{" "}
              Nothing is missing from it — the numbers and the evidence are the same either way.
            </p>
          ) : source === "MODEL" ? (
            <p>
              <span className="font-medium text-foreground">AI Coach review.</span> The
              interpretation below is generated from the SpotLens analysis on this page. It does not
              execute trades and does not replace SpotLens&apos;s deterministic levels — every
              number here is SpotLens&apos;s, and the model was never asked for one.
            </p>
          ) : (
            <p>
              <span className="font-medium text-foreground">
                SpotLens&apos;s own deterministic reading.
              </span>{" "}
              No AI Coach is configured, so this is the engine explaining its own analysis.
            </p>
          )}
        </AlertDescription>
      </Alert>

      {/* --- what this is, and how it reads ------------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="text-sm font-semibold">
              {context.identity.symbol}{" "}
              <span className="text-muted-foreground">
                ·{" "}
                {TIMEFRAME_LABELS[context.identity.timeframe as Timeframe] ??
                  context.identity.timeframe}
              </span>
            </h2>
            <span className={cn("ml-auto text-xs font-semibold", VERDICT_TONE[review.verdict])}>
              {VERDICT_LABELS[review.verdict]}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
            <Field label="Quality">
              {context.quality.score}/100 · {context.quality.grade.toLowerCase()}
              <span className="block text-[10px] font-normal text-muted-foreground">
                deterministic SpotLens score
              </span>
            </Field>
            <Field label="R:R">
              {levels === null
                ? "Not recorded"
                : levels.riskRewardIsSynthetic
                  ? "Not measurable"
                  : `1:${levels.riskReward.toFixed(1)} · Measured`}
              {levels?.riskRewardIsSynthetic && (
                <Badge variant="outline" className="ml-1.5 text-[9px]">
                  unmeasured
                </Badge>
              )}
            </Field>
            {context.market.trend && <Field label="Trend">{humanise(context.market.trend)}</Field>}
            {context.market.regimeDirection && (
              <Field label="Regime">
                {humanise(context.market.regimeDirection)}
                {context.market.regimeVolatility
                  ? ` · ${context.market.regimeVolatility.toLowerCase()} volatility`
                  : ""}
              </Field>
            )}
            {context.market.mtfAgreement && (
              <Field label="Higher timeframe" wide>
                {humanise(context.market.mtfAgreement)}
              </Field>
            )}
          </dl>

          <p className="text-xs leading-relaxed">{review.summary}</p>
        </CardContent>
      </Card>

      <Section section={review.strengths} marker="✓" />
      <Section section={review.concerns} marker="⚠" />
      <Section section={review.confirmationReview} />

      {/* --- the levels, shown from the context and never from the prose --- */}
      {levels && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {review.riskRewardReview.title}
            </h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
              <Field label="Entry">
                {levels.entryLow} – {levels.entryHigh}
              </Field>
              <Field label="Stop">{levels.stopLoss}</Field>
              {levels.takeProfits.map((target) => (
                <Field key={target.label} label={target.label}>
                  {target.level}
                </Field>
              ))}
            </dl>
            <Points points={review.riskRewardReview.points} />
          </CardContent>
        </Card>
      )}
      {!levels && <Section section={review.riskRewardReview} />}

      <Section section={review.invalidationReview} />
      <Section section={review.chartChecks} numbered />

      {/* --- everything here leads somewhere to look at ------------------- */}
      <Card>
        <CardContent className="flex flex-wrap gap-2 p-4">
          <Button asChild size="sm" variant="outline">
            <Link
              href={`/market-analysis?pair=${context.identity.symbol}&tf=${context.identity.timeframe}`}
            >
              Open the full analysis
            </Link>
          </Button>
          {context.identity.setupId && (
            <Button asChild size="sm" variant="ghost">
              <Link href="/setups">View tracked setups</Link>
            </Button>
          )}
          <Button asChild size="sm" variant="ghost">
            <Link href="/opportunities">Back to opportunities</Link>
          </Button>
        </CardContent>
      </Card>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {ANALYSIS_DISCLAIMER} The Coach reads the analysis SpotLens recorded and explains it; it
        does not produce the numbers, and the decision is yours.
      </p>

      <ProvenanceNote context={context} />
    </div>
  );
}

function Section({
  section,
  marker,
  numbered,
}: {
  section: CoachSection;
  marker?: string;
  numbered?: boolean;
}) {
  if (section.points.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {section.title}
        </h3>
        <Points points={section.points} marker={marker} numbered={numbered} />
      </CardContent>
    </Card>
  );
}

function Points({
  points,
  marker,
  numbered,
}: {
  points: string[];
  marker?: string;
  numbered?: boolean;
}) {
  if (numbered) {
    return (
      <ol className="list-inside list-decimal space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ol>
    );
  }

  return (
    <ul className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
      {points.map((point) => (
        <li key={point}>
          {marker ? `${marker} ` : "• "}
          {point}
        </li>
      ))}
    </ul>
  );
}

/**
 * Which record this review read.
 *
 * A review of a setup from three days ago is a review of three days ago, and
 * saying so is the difference between history and a stale opinion.
 */
function ProvenanceNote({ context }: { context: CoachContext }) {
  const when = context.identity.analysedAtCandle ?? context.identity.recordedAt;

  return (
    <p className="text-[10px] leading-relaxed text-muted-foreground">
      Read from{" "}
      {context.identity.source === "TRACKED_SETUP"
        ? "the immutable snapshot taken when this setup was first tracked"
        : "the scanner result recorded for this pass"}
      {when ? `, as it stood at ${new Date(when).toLocaleString()}` : ""}. Nothing later than that
      was used.
    </p>
  );
}

function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  );
}

function humanise(value: string): string {
  const words = value.toLowerCase().replace(/_/g, " ").trim();
  return words.length === 0 ? "—" : words[0].toUpperCase() + words.slice(1);
}
