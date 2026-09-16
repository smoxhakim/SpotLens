"use client";

import { Check, Minus, TriangleAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EXPLANATION_CATEGORY_LABELS, EXPLANATION_ORDER, buildExplanations } from "@/lib/analysis";
import type { AnalysisResult, Explanation, ExplanationSignal } from "@/lib/analysis";
import { cn } from "@/lib/utils";

import { CollapsibleSection } from "./CollapsibleSection";

/**
 * The sidebar's single question: why is SpotLens saying this?
 *
 * It renders `buildExplanations(result)` and nothing else. That list is already
 * ordered, already categorised and already worded by the engine, so there is no
 * second opinion here about what a counter-trend bounce should be called — and
 * no setup values, because a number repeated beside its own explanation is a
 * number that can drift from the one under the chart.
 *
 * Grouping is by category in the engine's own `EXPLANATION_ORDER`: context
 * first, then the evidence, then the verdict that follows from it. A category
 * the engine had nothing to say about is omitted rather than padded.
 */

const SIGNAL_META: Record<
  ExplanationSignal,
  { Icon: typeof Check; className: string; label: string }
> = {
  positive: { Icon: Check, className: "text-bullish", label: "Supports the setup" },
  negative: { Icon: TriangleAlert, className: "text-bearish", label: "Weakens the setup" },
  neutral: { Icon: Minus, className: "text-muted-foreground", label: "Neither way" },
};

export function ExplanationSidebar({
  result,
  isPending,
}: {
  result: AnalysisResult | null;
  isPending: boolean;
}) {
  if (isPending) {
    return (
      <Panel>
        <div className="space-y-2 py-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </Panel>
    );
  }

  if (!result) {
    return (
      <Panel>
        <p className="py-3 text-[11px] leading-relaxed text-muted-foreground">
          Once an analysis has run, this is where the reasoning behind every part of it lives — what
          the trend read is built on, what the level is worth, whether volume agrees, and why the
          verdict came out the way it did.
        </p>
      </Panel>
    );
  }

  const explanations = buildExplanations(result);

  const groups = EXPLANATION_ORDER.map((category) => ({
    category,
    items: explanations.filter((e) => e.category === category),
  })).filter((group) => group.items.length > 0);

  if (groups.length === 0) {
    return (
      <Panel>
        <p className="py-3 text-[11px] leading-relaxed text-muted-foreground">
          This analysis produced no reasoning to show.
        </p>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="-mt-1">
        {groups.map((group, index) => {
          // The strongest signal in the group decides the icon: if anything
          // here argues against the setup, that is what the closed heading
          // should show, not the first item that happened to be positive.
          const lead =
            group.items.find((item) => item.signal === "negative") ??
            group.items.find((item) => item.signal === "positive") ??
            group.items[0];
          const meta = SIGNAL_META[lead.signal];

          return (
            <CollapsibleSection
              key={group.category}
              title={EXPLANATION_CATEGORY_LABELS[group.category]}
              summary={lead.title}
              // The first section opens by default. Predictable beats clever:
              // the reader learns where the open one is instead of hunting for
              // whichever the page decided mattered most this time.
              defaultOpen={index === 0}
              icon={<meta.Icon className={cn("h-3.5 w-3.5", meta.className)} aria-hidden="true" />}
              // The icon carries the signal visually; this is the same fact for
              // anyone not looking at it, so the verdict is never colour-only.
              iconLabel={meta.label}
            >
              <ul className="space-y-2.5">
                {group.items.map((item) => (
                  <ExplanationDetail
                    key={item.id}
                    explanation={item}
                    // A single-item group already shows its title as the
                    // heading's summary line, so repeating it two lines below
                    // is the same sentence twice. With siblings the titles earn
                    // their place: they are what tells the findings apart.
                    showTitle={group.items.length > 1}
                  />
                ))}
              </ul>
            </CollapsibleSection>
          );
        })}
      </div>
    </Panel>
  );
}

function ExplanationDetail({
  explanation,
  showTitle,
}: {
  explanation: Explanation;
  showTitle: boolean;
}) {
  const meta = SIGNAL_META[explanation.signal];

  if (!showTitle) {
    return (
      <li className="text-[11px] leading-relaxed text-muted-foreground">{explanation.detail}</li>
    );
  }

  return (
    <li>
      <div className="flex items-start gap-1.5">
        <meta.Icon className={cn("mt-[3px] h-3 w-3 shrink-0", meta.className)} aria-hidden="true" />
        <span className="text-[11px] font-medium leading-relaxed">
          <span className="sr-only">{meta.label}: </span>
          {explanation.title}
        </span>
      </div>
      <p className="mt-1 pl-[18px] text-[11px] leading-relaxed text-muted-foreground">
        {explanation.detail}
      </p>
    </li>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Explanations
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}
