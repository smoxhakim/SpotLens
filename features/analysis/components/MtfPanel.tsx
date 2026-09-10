"use client";

import { AlertTriangle, ArrowRight, Minus, TrendingDown, TrendingUp } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { MTF_AGREEMENT_LABELS } from "@/lib/analysis";
import type { MtfAgreement, MtfSummary } from "@/lib/analysis";
import { TIMEFRAME_LABELS } from "@/lib/market-data/provider";
import { cn } from "@/lib/utils";

import { LearnLink } from "./LearnLink";
import { WhyDisclosure } from "./WhyDisclosure";

const TREND_META = {
  BULLISH: { label: "Bullish", variant: "bullish" as const, Icon: TrendingUp },
  BEARISH: { label: "Bearish", variant: "bearish" as const, Icon: TrendingDown },
  SIDEWAYS: { label: "Sideways", variant: "neutral" as const, Icon: Minus },
};

/**
 * Presentation only. The labels themselves live with the classification in
 * `lib/analysis/mtf`, so a counter-trend bounce is called the same thing here,
 * in the explanation list, and anywhere else that reads a classification.
 */
const AGREEMENT_TONE: Record<MtfAgreement, string> = {
  ALIGNED_BULLISH: "text-bullish",
  ALIGNED_BEARISH: "text-bearish",
  PULLBACK_IN_UPTREND: "text-bullish",
  COUNTER_TREND_BOUNCE: "text-bearish",
  MIXED: "text-muted-foreground",
};

export function MtfPanel({ mtf }: { mtf: MtfSummary }) {
  const higher = TREND_META[mtf.higherTrend];
  const lower = TREND_META[mtf.lowerTrend];
  const agreementTone = AGREEMENT_TONE[mtf.agreement];

  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Multi-timeframe
      </h3>

      <div className="flex items-center gap-2">
        <TimeframeTrend
          timeframe={TIMEFRAME_LABELS[mtf.higherTimeframe]}
          role="bias"
          meta={higher}
        />
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <TimeframeTrend
          timeframe={TIMEFRAME_LABELS[mtf.lowerTimeframe]}
          role="entry"
          meta={lower}
        />
      </div>

      <p className={cn("text-[11px] font-medium", agreementTone)}>
        {MTF_AGREEMENT_LABELS[mtf.agreement]}
      </p>

      {mtf.conflictNote && (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertDescription>{mtf.conflictNote}</AlertDescription>
        </Alert>
      )}

      <WhyDisclosure>
        <p>{mtf.note}</p>
        <p className="mt-1.5">
          <span className="font-medium">{TIMEFRAME_LABELS[mtf.higherTimeframe]}:</span>{" "}
          {mtf.higherReason}
        </p>
        <p className="mt-1.5">
          <span className="font-medium">{TIMEFRAME_LABELS[mtf.lowerTimeframe]}:</span>{" "}
          {mtf.lowerReason}
        </p>
      </WhyDisclosure>

      <LearnLink concept="multi-timeframe" label="Bias and entry timeframes" />
    </section>
  );
}

function TimeframeTrend({
  timeframe,
  role,
  meta,
}: {
  timeframe: string;
  role: string;
  meta: (typeof TREND_META)[keyof typeof TREND_META];
}) {
  const { Icon } = meta;
  return (
    <div className="min-w-0 flex-1 rounded-md border p-2">
      <div className="flex items-baseline gap-1.5">
        <span className="text-xs font-semibold">{timeframe}</span>
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{role}</span>
      </div>
      <Badge variant={meta.variant} className="mt-1 gap-1 text-[10px]">
        <Icon className="h-3 w-3" />
        {meta.label}
      </Badge>
    </div>
  );
}
