"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Minus,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { MTF_AGREEMENT_LABELS, STATUS_LABELS } from "@/lib/analysis";
import type { AnalysisResult, MarketRead, TradeStatus } from "@/lib/analysis";
import type { MarketRegime } from "@/lib/regime";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import { cn } from "@/lib/utils";

/**
 * The answer to "what am I looking at, and what does SpotLens make of it?" in
 * one strip.
 *
 * Presentation only. Every value here is read off a finished `MarketRead` or
 * `AnalysisResult` — the price, the trend, the regime, the score and the status
 * were all decided before this component existed, and it neither derives nor
 * rounds anything the engine did not.
 *
 * Deliberately a row of small facts rather than a stack of cards. The chart is
 * the thing worth looking at, and a header that competes with it for height is
 * a header that pushes the setup below the fold.
 */

const TREND_META = {
  BULLISH: { label: "Bullish", className: "text-bullish", Icon: TrendingUp },
  BEARISH: { label: "Bearish", className: "text-bearish", Icon: TrendingDown },
  SIDEWAYS: { label: "Sideways", className: "text-muted-foreground", Icon: Minus },
} as const;

const REGIME_LABELS: Record<MarketRegime["direction"], string> = {
  TRENDING_UP: "Trending up",
  TRENDING_DOWN: "Trending down",
  RANGE: "Range",
  UNCLEAR: "Unclear",
};

/**
 * Status styling, keyed off the engine's own four statuses.
 *
 * Each carries an icon as well as a colour, because a verdict communicated by
 * colour alone is a verdict a colour-blind reader has to guess at — and this is
 * the single most consequential word on the page.
 */
const STATUS_STYLE: Record<TradeStatus, { Icon: typeof CheckCircle2; className: string }> = {
  POTENTIAL_SETUP: {
    Icon: CheckCircle2,
    className: "border-bullish/40 bg-bullish/10 text-bullish",
  },
  WAIT_FOR_CONFIRMATION: {
    Icon: Clock,
    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  HIGH_RISK: {
    Icon: AlertTriangle,
    className: "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  },
  AVOID: { Icon: XCircle, className: "border-bearish/40 bg-bearish/10 text-bearish" },
};

export function AnalysisSummaryBar({
  timeframe,
  read,
  regime,
  result,
  isLoading,
}: {
  timeframe: Timeframe;
  read: MarketRead | null;
  regime: MarketRegime | null;
  /** Null until an analysis has been run for this pair and timeframe. */
  result: AnalysisResult | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-wrap items-center gap-6 border-t pt-3">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
    );
  }

  const trend = read ? TREND_META[read.trend.trend] : null;
  const status = result ? STATUS_STYLE[result.status] : null;

  return (
    // Sits inside the market header's own card, below the identity and the live
    // price. Deliberately not a second card with the symbol repeated: the
    // market is named once on this page, and the price is the big live one
    // above rather than a stale copy beside it.
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-3">
      <Fact label="Timeframe">
        <span className="text-sm font-semibold">{TIMEFRAME_LABELS[timeframe]}</span>
      </Fact>

      {trend && read ? (
        <Fact label="Trend">
          <span className={cn("flex items-center gap-1 text-sm font-semibold", trend.className)}>
            <trend.Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {trend.label}
          </span>
        </Fact>
      ) : null}

      {regime ? (
        <Fact label="Regime">
          <span className="text-sm font-medium">{REGIME_LABELS[regime.direction]}</span>
        </Fact>
      ) : null}

      {result?.score ? (
        <Fact label="Quality">
          {/* "Quality", never "probability" — the score weighs how much of the
              evidence agrees, and a percentage sign here would read as a
              forecast. */}
          <span className="tabular text-sm font-semibold">{result.score.total}/100</span>
        </Fact>
      ) : null}

      {result?.mtf ? (
        <Fact label="Higher timeframe">
          <span className="text-sm font-medium">{MTF_AGREEMENT_LABELS[result.mtf.agreement]}</span>
        </Fact>
      ) : null}

      {result && status ? (
        <div
          className={cn(
            "ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold",
            status.className,
          )}
        >
          <status.Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {STATUS_LABELS[result.status].label}
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
