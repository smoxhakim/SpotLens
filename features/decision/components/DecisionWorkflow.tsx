"use client";

import { useQuery } from "@tanstack/react-query";
import { Calculator, LineChart, MessageCircleQuestion } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import type { CoachContext } from "@/lib/coach";
import { ANALYSIS_DISCLAIMER } from "@/lib/constants/disclaimers";
import type { JournalDecision, JournalSkipReason } from "@/lib/journal";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import { riskCalculatorParams, type RiskPrefill } from "@/lib/risk";

import { DecisionPanel, type DecisionTarget } from "./DecisionPanel";

/**
 * The decision surface: everything the reader needs in front of them at once.
 *
 * What SpotLens recorded, where the Coach and the calculator are, and the
 * decision itself — in that order, because a decision belongs after the
 * evidence rather than beside it.
 *
 * The facts come from `/api/decision/context`, which resolves stored rows and
 * cannot reach a model. Opening this page costs nothing and calls nothing; the
 * Coach is one press away and stays that way.
 */

interface DecisionContextResponse {
  context: CoachContext;
  prefill: RiskPrefill | null;
  journal: {
    id: string;
    decision: JournalDecision;
    notes: string | null;
    skipReason: JournalSkipReason | null;
    decidedAt: string;
    coachReviewed: boolean;
  } | null;
}

export function DecisionWorkflow({
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

  const query = useQuery<DecisionContextResponse>({
    queryKey: ["decision-context", symbol, timeframe, runId, setupId],
    queryFn: () => fetchApi(`/api/decision/context?${params.toString()}`),
    enabled: authStatus === "authenticated" && complete,
    retry: false,
  });

  if (authStatus === "loading") return <Skeleton className="h-64 w-full" />;

  if (authStatus !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Decisions are recorded against your own account.</p>
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
          <p className="font-medium text-foreground">Nothing to decide about yet.</p>
          <p className="text-[11px] leading-relaxed">
            Open this from an opportunity so it knows which market, timeframe and scan you are
            deciding about. A decision is recorded against the analysis SpotLens made, not against a
            market name.
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
      <div className="space-y-3" aria-busy="true" aria-label="Loading the analysis">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
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
              : "That could not be loaded."}
          </p>
          <p className="text-[11px] leading-relaxed">
            {status === 404
              ? "The scan this was opened from may have been replaced, or the setup is no longer one of yours. Nothing was recorded."
              : "Nothing was recorded. The analysis itself is unaffected."}
          </p>
          <Button asChild size="sm" variant="outline">
            <Link href="/opportunities">Back to opportunities</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { context, prefill, journal } = query.data;
  const levels = context.levels;
  const tfLabel =
    TIMEFRAME_LABELS[context.identity.timeframe as Timeframe] ?? context.identity.timeframe;

  const target: DecisionTarget = {
    symbol: context.identity.symbol,
    timeframe: context.identity.timeframe,
    runId: context.identity.runId,
    setupId: context.identity.setupId,
  };

  const coachHref = `/coach?${params.toString()}`;
  const analysisHref = `/market-analysis?pair=${encodeURIComponent(
    context.identity.symbol,
  )}&tf=${encodeURIComponent(context.identity.timeframe)}`;
  const riskHref = prefill
    ? `/risk-calculator?${riskCalculatorParams(prefill, {
        symbol: context.identity.symbol,
        timeframe: context.identity.timeframe,
        runId: context.identity.runId,
        setupId: context.identity.setupId,
      }).toString()}`
    : null;

  return (
    <div className="space-y-4">
      {/* --- what SpotLens recorded ---------------------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="text-sm font-semibold">
              {context.identity.symbol} <span className="text-muted-foreground">· {tfLabel}</span>
            </h2>
            <span className="ml-auto text-xs font-semibold text-muted-foreground">
              {humanise(context.verdictInputs.analysisStatus)}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
            <Field label="Quality">
              {context.quality.score}/100 · {context.quality.grade.toLowerCase()}
              <span className="block text-[10px] font-normal text-muted-foreground">
                a deterministic ranking score, not a probability
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
            {levels && (
              <>
                <Field label="Entry">
                  {levels.entryLow} – {levels.entryHigh}
                </Field>
                <Field label="Stop">{levels.stopLoss}</Field>
                {levels.takeProfits.map((tp) => (
                  <Field key={tp.label} label={tp.label}>
                    {tp.level}
                  </Field>
                ))}
              </>
            )}
            {context.confirmation.status && (
              <Field label="Confirmation">{humanise(context.confirmation.status)}</Field>
            )}
            {context.market.regimeDirection && (
              <Field label="Regime">
                {humanise(context.market.regimeDirection)}
                {context.market.regimeVolatility
                  ? ` · ${context.market.regimeVolatility.toLowerCase()} volatility`
                  : ""}
              </Field>
            )}
            {context.verdictInputs.lifecycleStatus && (
              <Field label="Lifecycle" wide>
                {humanise(context.verdictInputs.lifecycleStatus)}
              </Field>
            )}
          </dl>

          {context.statusReason && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {context.statusReason}
            </p>
          )}

          {levels === null && (
            <Alert variant="muted">
              <AlertDescription className="text-[11px] leading-relaxed">
                <span className="font-medium text-foreground">
                  SpotLens scored this market but never tracked a setup for it.
                </span>{" "}
                There is no entry, stop, target or ratio on the record, and none will be invented
                for one. You can still record a decision — it will say plainly that this was an
                untracked opportunity.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* --- the two places to look before deciding ------------------------ */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Before you decide
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={analysisHref}>
                <LineChart className="h-3.5 w-3.5" />
                Full analysis
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={coachHref}>
                <MessageCircleQuestion className="h-3.5 w-3.5" />
                Ask Coach
              </Link>
            </Button>
            {riskHref && (
              <Button asChild size="sm" variant="outline">
                <Link href={riskHref}>
                  <Calculator className="h-3.5 w-3.5" />
                  Size a position
                </Link>
              </Button>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            None of these is required. You can decide without asking the Coach and without sizing
            anything — they are there when they help.
            {journal?.coachReviewed && " A Coach review was read before an earlier decision here."}
          </p>
        </CardContent>
      </Card>

      <DecisionPanel target={target} existing={journal} />

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {ANALYSIS_DISCLAIMER} Recording a decision writes it down; it places nothing and sends
        nothing to an exchange.
      </p>
    </div>
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
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  );
}

function humanise(value: string): string {
  const words = value.toLowerCase().replace(/_/g, " ").trim();
  return words.length === 0 ? "—" : words[0].toUpperCase() + words.slice(1);
}
