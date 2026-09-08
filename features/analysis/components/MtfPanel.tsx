"use client";

import { AlertTriangle, ArrowRight, Minus, TrendingDown, TrendingUp } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { MtfAgreement, MtfSummary } from "@/lib/analysis";
import { TIMEFRAME_LABELS } from "@/lib/market-data/provider";
import { cn } from "@/lib/utils";

import { WhyDisclosure } from "./WhyDisclosure";

const TREND_META = {
  BULLISH: { label: "Bullish", variant: "bullish" as const, Icon: TrendingUp },
  BEARISH: { label: "Bearish", variant: "bearish" as const, Icon: TrendingDown },
  SIDEWAYS: { label: "Sideways", variant: "neutral" as const, Icon: Minus },
};

const AGREEMENT_META: Record<MtfAgreement, { label: string; className: string }> = {
  ALIGNED_BULLISH: { label: "Timeframes aligned", className: "text-bullish" },
  ALIGNED_BEARISH: { label: "Both bearish", className: "text-bearish" },
  PULLBACK_IN_UPTREND: { label: "Pullback in an uptrend", className: "text-bullish" },
  COUNTER_TREND_BOUNCE: { label: "Counter-trend bounce", className: "text-bearish" },
  MIXED: { label: "No clear higher-timeframe direction", className: "text-muted-foreground" },
};

export function MtfPanel({ mtf }: { mtf: MtfSummary }) {
  const higher = TREND_META[mtf.higherTrend];
  const lower = TREND_META[mtf.lowerTrend];
  const agreement = AGREEMENT_META[mtf.agreement];

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

      <p className={cn("text-[11px] font-medium", agreement.className)}>{agreement.label}</p>

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
