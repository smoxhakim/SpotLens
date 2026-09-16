"use client";

import type { AnalysisResult } from "@/lib/analysis";
import { STATUS_LABELS } from "@/lib/analysis";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The setup in one strip, for the monitoring view.
 *
 * The same values the analysis page shows under its chart, in the least space
 * they can honestly occupy — this page exists to give the chart the screen, so
 * the levels get a band rather than a card. Scrolls horizontally on a phone
 * rather than wrapping into four rows and eating the chart it sits under.
 *
 * Presentation only: `formatPrice` over values the engine produced, and the
 * same status vocabulary the rest of the product uses.
 */
export function CompactTradeLevels({
  result,
  isPending,
}: {
  result: AnalysisResult | null;
  isPending: boolean;
}) {
  if (isPending) {
    return (
      <div className="rounded-lg border bg-card px-3 py-2 text-[11px] text-muted-foreground">
        Analysing…
      </div>
    );
  }

  if (!result) {
    return (
      <div className="rounded-lg border bg-card px-3 py-2 text-[11px] text-muted-foreground">
        Run <span className="font-medium text-foreground">Analyze</span> to draw the entry zone,
        invalidation and targets on this chart.
      </div>
    );
  }

  const setup = result.setup;
  const status = STATUS_LABELS[result.status].label;

  if (!setup) {
    return (
      <div className="rounded-lg border bg-card px-3 py-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{status}</span> — no levels are shown for a
        trade SpotLens has just advised against.
      </div>
    );
  }

  const [tp1, tp2, tp3] = setup.takeProfits;

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <dl className="flex w-max min-w-full items-stretch divide-x divide-border text-[11px]">
        <Cell label="Entry zone" tone="entry">
          {setup.entry.low === setup.entry.high
            ? formatPrice(setup.entry.low)
            : `${formatPrice(setup.entry.low)} – ${formatPrice(setup.entry.high)}`}
        </Cell>
        <Cell label="Stop" tone="stop">
          {formatPrice(setup.stopLoss.price)}
        </Cell>
        {[tp1, tp2, tp3].map((target, i) =>
          target ? (
            <Cell key={target.label} label={target.label} tone="target">
              {formatPrice(target.level)}
            </Cell>
          ) : (
            <Cell key={`absent-${i}`} label={`TP${i + 1}`} tone="absent">
              —
            </Cell>
          ),
        )}
        <Cell label="R:R" tone={setup.riskReward.isPoor ? "stop" : "entry"}>
          1:{setup.riskReward.ratio.toFixed(1)}
          {setup.riskReward.isSynthetic ? (
            <span className="ml-1 text-[9px] font-normal text-bearish">unmeasured</span>
          ) : null}
        </Cell>
        <Cell label="Status" tone="entry">
          {status}
        </Cell>
      </dl>
    </div>
  );
}

const TONE = {
  entry: "text-foreground",
  stop: "text-bearish",
  target: "text-bullish",
  absent: "text-muted-foreground",
} as const;

function Cell({
  label,
  children,
  tone,
}: {
  label: string;
  children: React.ReactNode;
  tone: keyof typeof TONE;
}) {
  return (
    <div className="min-w-0 flex-1 px-3 py-2">
      <dt className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={cn("tabular m-0 whitespace-nowrap text-xs font-semibold", TONE[tone])}>
        {children}
      </dd>
    </div>
  );
}
