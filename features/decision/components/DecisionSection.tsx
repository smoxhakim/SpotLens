"use client";

import { useQuery } from "@tanstack/react-query";
import { Calculator } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import type { CoachContext } from "@/lib/coach";
import type { JournalDecision, JournalSkipReason } from "@/lib/journal";
import { riskCalculatorParams, type RiskPrefill } from "@/lib/risk";

import { DecisionPanel, type CoachReadingRef } from "./DecisionPanel";

/**
 * The decision, offered wherever the reader already has the evidence.
 *
 * On the Coach page this sits under the review, so agreeing, disagreeing or
 * ignoring it are all one press away and none of them is the default. The
 * Coach's reading and the reader's decision stay in separate cards on purpose:
 * they are separate facts, and a layout that merged them would imply the second
 * followed from the first.
 *
 * It reads `/api/decision/context` for the journal state and the calculator
 * prefill — the facts endpoint, which cannot reach a model. Sharing the query
 * key with the decision page means moving between the two costs no extra
 * request.
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

export function DecisionSection({
  context,
  coach,
}: {
  context: CoachContext;
  /**
   * The reading that is on screen right now. Recorded as "a review was read",
   * never as an approval — the reader is free to decide the opposite, and this
   * says nothing about which way they went.
   */
  coach?: CoachReadingRef | null;
}) {
  const { symbol, timeframe, runId, setupId } = context.identity;

  const params = new URLSearchParams({ symbol, tf: timeframe, runId });
  if (setupId) params.set("setupId", setupId);

  const query = useQuery<DecisionContextResponse>({
    queryKey: ["decision-context", symbol, timeframe, runId, setupId],
    queryFn: () => fetchApi(`/api/decision/context?${params.toString()}`),
    retry: false,
  });

  if (query.isPending) return <Skeleton className="h-48 w-full" />;

  // A failure here loses the decision panel, not the review. Saying so beats a
  // blank space, and the decision page is still reachable on its own.
  if (query.isError) {
    return (
      <Card>
        <CardContent className="space-y-2 p-4 text-[11px] leading-relaxed text-muted-foreground">
          <p className="text-sm font-medium text-foreground">
            The decision panel could not be loaded.
          </p>
          <p>Nothing was recorded. The review above is unaffected.</p>
          <Button asChild size="sm" variant="outline">
            <Link href={`/decision?${params.toString()}`}>Open the decision page</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { prefill, journal } = query.data;

  const riskHref = prefill
    ? `/risk-calculator?${riskCalculatorParams(prefill, {
        symbol,
        timeframe,
        runId,
        setupId,
      }).toString()}`
    : null;

  return (
    <div className="space-y-4">
      {riskHref && (
        <Card>
          <CardContent className="space-y-1.5 p-4">
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Before you decide
            </h3>
            <Button asChild size="sm" variant="outline">
              <Link href={riskHref}>
                <Calculator className="h-3.5 w-3.5" />
                Size a position
              </Link>
            </Button>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Opens the calculator with this entry, stop and target
              {prefill?.riskRewardIsSynthetic
                ? " — the target is one the engine never measured"
                : ""}
              . You choose the balance and the risk; it does arithmetic and nothing else.
            </p>
          </CardContent>
        </Card>
      )}

      <DecisionPanel
        target={{ symbol, timeframe, runId, setupId }}
        existing={journal}
        coach={coach}
      />
    </div>
  );
}
