"use client";

import { useState } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import { cn } from "@/lib/utils";

import {
  REGIME_DIRECTION_LABELS,
  STATUS_LABELS,
  TREND_LABELS,
  humanise,
  labelFor,
  mtfLabel,
  qualityLabel,
  riskRewardLabel,
} from "../labels";
import type { ShortlistCandidate } from "../types";

/**
 * One candidate, as something to read rather than something to act on.
 *
 * Presentation only. Every number on this card arrived from Phase L; nothing is
 * compared, scored or ranked here. The two actions both lead somewhere to *look
 * at* — the analysis, or a second opinion — and there is deliberately no action
 * that could be mistaken for placing a trade.
 */

/**
 * Tone per status, reusing the engine's own classification.
 *
 * `STATUS_LABELS` already pairs each status with a tone, so the colour on this
 * card cannot disagree with the colour on the analysis page. Restrained on
 * purpose: green here means "the engine's highest state", never "safe".
 */
const TONE_CLASS: Record<string, string> = {
  bullish: "text-bullish",
  warning: "text-amber-600 dark:text-amber-400",
  bearish: "text-bearish",
  muted: "text-muted-foreground",
};

/** How many reasons to show before the rest go behind a disclosure. */
const REASONS_SHOWN = 2;

export function OpportunityCard({
  candidate,
  runId,
}: {
  candidate: ShortlistCandidate;
  /** The pass this candidate was ranked in, carried into the Coach handoff. */
  runId?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  // A status the table does not know is still rendered, as words: stale or
  // newer stored data is data, and the card's job is to show what it was given.
  const status = STATUS_LABELS[candidate.analysisStatus] ?? {
    label: humanise(String(candidate.analysisStatus ?? "unknown")),
    tone: "muted",
  };
  const timeframe = TIMEFRAME_LABELS[candidate.timeframe as Timeframe] ?? candidate.timeframe;

  const regime = labelFor(REGIME_DIRECTION_LABELS, candidate.regimeDirection);
  const trend = labelFor(TREND_LABELS, candidate.trend);
  const htf = mtfLabel(candidate.mtfAgreement);

  const hidden = candidate.reasons.length - REASONS_SHOWN;
  const reasons = expanded ? candidate.reasons : candidate.reasons.slice(0, REASONS_SHOWN);

  // The market's own analysis, where every number on this card came from. The
  // page is a gateway to it, not a replacement for it.
  const analyseHref = `/market-analysis?pair=${encodeURIComponent(
    candidate.symbol,
  )}&tf=${encodeURIComponent(candidate.timeframe)}`;

  // References, not a copy of the analysis: the Coach layer resolves these
  // itself, so nothing downstream can read a stale snapshot out of a URL.
  //
  // Four keys at most, and never a fifth. The run id says *which pass* ranked
  // this candidate — a shortlist belongs to one scan, and reviewing "ETHUSDT on
  // H4" without naming the pass is reviewing a moving target.
  const coachParams = new URLSearchParams({
    symbol: candidate.symbol,
    tf: candidate.timeframe,
  });
  if (candidate.trackedSetupId) coachParams.set("setupId", candidate.trackedSetupId);
  if (runId) coachParams.set("runId", runId);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className="tabular text-[11px] font-medium text-muted-foreground"
            // The canonical position, spelled out for a screen reader: "#2" on
            // its own is not obviously a rank.
            aria-label={`Ranked ${candidate.rank} of the shortlist`}
          >
            #{candidate.rank}
          </span>
          <h3 className="text-sm font-semibold">
            {candidate.symbol} <span className="text-muted-foreground">· {timeframe}</span>
          </h3>
          <span className={cn("ml-auto text-xs font-semibold", TONE_CLASS[status.tone])}>
            {status.label}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
          <Field label="Quality">{qualityLabel(candidate.score, candidate.grade)}</Field>
          <Field label="R:R">
            {riskRewardLabel(candidate)}
            {!candidate.riskRewardIsMeasured && (
              <Badge variant="outline" className="ml-1.5 text-[9px]">
                no structural target
              </Badge>
            )}
          </Field>
          {trend && <Field label="Trend">{trend}</Field>}
          {regime && <Field label="Regime">{regime}</Field>}
          {htf && (
            <div className="col-span-2">
              <dt className="text-muted-foreground">Higher timeframe</dt>
              <dd className="font-medium text-foreground">{htf}</dd>
            </div>
          )}
        </dl>

        {candidate.reasons.length > 0 && (
          <div>
            <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Why it is ranked here
            </h4>
            <ul className="space-y-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {reasons.map((reason) => (
                <li key={reason}>• {reason}</li>
              ))}
            </ul>
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="mt-1 rounded text-[11px] text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {expanded ? "Show less" : `Show ${hidden} more`}
              </button>
            )}
          </div>
        )}

        {/* Both actions lead somewhere to look at. Neither is styled as a
            call to act: a filled green button here would say "take this", and
            the whole point of the page is that it does not. The visible words
            stay short while the accessible name carries the market, so a
            screen reader does not announce fifteen identical "Analyze"s. */}
        <div className="flex flex-wrap gap-2 pt-0.5">
          <Button asChild size="sm" variant="outline">
            <Link href={analyseHref} aria-label={`Analyze ${candidate.symbol} on ${timeframe}`}>
              Analyze
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link
              href={`/coach?${coachParams.toString()}`}
              aria-label={`Ask Coach about ${candidate.symbol} on ${timeframe}`}
            >
              Ask Coach
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  );
}
