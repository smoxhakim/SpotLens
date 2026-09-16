"use client";

import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card";
import type { AnalysisResult } from "@/lib/analysis";
import type { MarketSummary } from "@/types/market";

import { ConfirmationPanel } from "./ConfirmationPanel";
import { CollapsibleSection } from "./CollapsibleSection";
import { MtfPanel } from "./MtfPanel";
import { ScoreBreakdown } from "./ScoreBreakdown";

/**
 * Everything worth having and not worth reading first.
 *
 * The page's job is to make the setup legible in a few seconds; the score's
 * working, the two-timeframe comparison and the asset's background all serve a
 * second, slower question. They sit below the chart and the levels, folded
 * away, so the reader reaches them by choosing to rather than by scrolling past
 * them.
 *
 * Nothing here computes. Each section hands an already-finished object to the
 * panel that has always rendered it.
 */
export function SecondaryAnalysis({
  result,
  market,
}: {
  result: AnalysisResult | null;
  market?: MarketSummary;
}) {
  const hasAnalysis = result !== null;

  if (!hasAnalysis && !market) return null;

  return (
    <Card>
      <CardContent className="px-4 py-1">
        {result?.mtf ? (
          <CollapsibleSection
            title="Multi-timeframe"
            summary="How the higher timeframe and the entry timeframe compare."
            defaultOpen
          >
            <MtfPanel mtf={result.mtf} />
          </CollapsibleSection>
        ) : null}

        {result?.confirmation ? (
          <CollapsibleSection
            title="Confirmation evidence"
            summary="Every signal the confirmation engine looked for, and what it found."
          >
            <ConfirmationPanel confirmation={result.confirmation} />
          </CollapsibleSection>
        ) : null}

        {result?.score ? (
          <CollapsibleSection
            title="Score breakdown"
            summary={`${result.score.total}/100 — how each category contributed.`}
          >
            <ScoreBreakdown score={result.score} />
          </CollapsibleSection>
        ) : null}

        {market ? (
          <CollapsibleSection
            title={`About ${market.asset.name}`}
            summary="What the token is, and where to research it."
          >
            <div className="space-y-3 text-xs">
              <p className="text-muted-foreground">{market.asset.description}</p>
              <div>
                <div className="mb-1 font-medium">What the token is used for</div>
                <p className="text-muted-foreground">{market.asset.utilityExplanation}</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link
                  href={`/assets/${market.asset.symbol}`}
                  className="text-primary underline underline-offset-2"
                >
                  Research &amp; ethical checklist
                </Link>
                <a
                  href={market.asset.officialWebsite}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-primary underline underline-offset-2"
                >
                  Official website
                </a>
              </div>
            </div>
          </CollapsibleSection>
        ) : null}
      </CardContent>
    </Card>
  );
}
