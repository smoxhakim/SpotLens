"use client";

import { AlertTriangle, Check, CircleDashed, X } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalysisResult, ConfirmationResult } from "@/lib/analysis";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

import { LearnLink } from "./LearnLink";
import { RiskCalculatorLink } from "./RiskCalculatorLink";
import { WhyDisclosure } from "./WhyDisclosure";

/**
 * The numbers, directly under the chart.
 *
 * This is the page's primary answer: where the engine would enter, where it
 * would be wrong, what it is aiming at, and whether anything has confirmed yet.
 * It used to sit two thirds of the way down a long sidebar, below the score
 * breakdown and the moving averages, which meant the most consequential values
 * on the screen were the ones you had to scroll for.
 *
 * Presentation only. Every figure is `formatPrice` over a value the engine
 * produced; there is no arithmetic here, and the `.toFixed` calls match the
 * conventions the rest of the product already uses so the same setup reads the
 * same in the panel, in a Telegram message and in the risk calculator.
 */

const CONFIRMATION_META = {
  PRESENT: { label: "Present", className: "text-bullish", Icon: Check },
  NOT_PRESENT: {
    label: "Wait for confirmation",
    className: "text-amber-600 dark:text-amber-400",
    Icon: CircleDashed,
  },
  CONTRADICTED: { label: "Contradicted", className: "text-bearish", Icon: X },
} as const;

export function TradeLevelsCard({
  result,
  isPending,
  error,
}: {
  result: AnalysisResult | null;
  isPending: boolean;
  error: Error | null;
}) {
  if (isPending) {
    return (
      <Shell>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </Shell>
    );
  }

  if (!result) {
    return (
      <Shell>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Run <span className="font-medium text-foreground">Analyze Market</span> for an entry zone,
          an invalidation level, take-profit targets and risk/reward — each with the reasoning
          behind it.
        </p>
      </Shell>
    );
  }

  const setup = result.setup;

  // An AVOID withholds the levels deliberately: handing over an entry and a
  // stop for a trade the engine has just advised against undoes the refusal.
  if (!setup) {
    return (
      <Shell confirmation={result.confirmation}>
        <p className="text-xs leading-relaxed text-muted-foreground">
          No entry, stop or target levels are shown, because SpotLens does not hand over numbers for
          a trade it has just advised against.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{result.statusReason}</p>
      </Shell>
    );
  }

  const [tp1, tp2, tp3] = setup.takeProfits;

  return (
    <Shell confirmation={result.confirmation}>
      {/* One row on desktop, two columns on phones. Entry and the invalidation
          sit together because they are the pair that defines the risk; the
          targets follow in the order the engine numbered them. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
        <Level
          label="Entry zone"
          tone="entry"
          value={
            // The engine's entry is a zone. Collapsing it to a single price
            // would be inventing a precision it never claimed.
            setup.entry.low === setup.entry.high
              ? formatPrice(setup.entry.low)
              : `${formatPrice(setup.entry.low)} – ${formatPrice(setup.entry.high)}`
          }
          note={setup.entry.priceInZone ? "Price is in the zone" : "Price has not reached it"}
          why={setup.entry.reason}
        />

        <Level
          label="Stop loss"
          tone="stop"
          value={formatPrice(setup.stopLoss.price)}
          note={`Invalidation · ${(setup.stopLoss.riskPct * 100).toFixed(2)}% below entry`}
          why={setup.stopLoss.reason}
        />

        {[tp1, tp2, tp3].map((target, index) =>
          target ? (
            <Level
              key={target.label}
              label={target.label}
              tone="target"
              value={formatPrice(target.level)}
              note={`${target.rr.toFixed(1)}R`}
              why={target.reason}
            />
          ) : (
            // No invented targets: the engine found fewer than three structural
            // levels, and saying so is more useful than a blank.
            <Level
              key={`absent-${index}`}
              label={`TP${index + 1}`}
              tone="absent"
              value="—"
              note="No structural target"
            />
          ),
        )}

        <div className="min-w-0">
          <LevelLabel>R:R</LevelLabel>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span
              className={cn(
                "tabular text-lg font-semibold",
                setup.riskReward.isPoor ? "text-bearish" : "text-foreground",
              )}
            >
              1:{setup.riskReward.ratio.toFixed(1)}
            </span>
            {setup.riskReward.isSynthetic ? (
              // Phase A's qualifier. Without it the ratio reads as measured,
              // when it is the fallback ladder restating its own constant.
              <Badge variant="bearish" className="text-[9px]">
                unmeasured
              </Badge>
            ) : (
              <span className="text-[10px] text-muted-foreground">
                Measured to {setup.riskReward.measuredTo}
              </span>
            )}
          </div>
          <WhyDisclosure>{setup.riskReward.reason}</WhyDisclosure>
        </div>
      </dl>

      <div className="mt-4 border-t pt-3">
        <RiskCalculatorLink setup={setup} />
        <div className="mt-2 flex flex-wrap items-center gap-x-4">
          <LearnLink concept="risk-reward" label="Why 1:1 is a losing game" />
          <LearnLink concept="stop-loss" label="Where a stop belongs" />
        </div>
      </div>
    </Shell>
  );
}

/** Card chrome plus the confirmation strip, which every state shares. */
function Shell({
  children,
  confirmation,
}: {
  children: React.ReactNode;
  confirmation?: ConfirmationResult | null;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Trade setup
          </h2>
          {confirmation ? <ConfirmationChip confirmation={confirmation} /> : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * Confirmation, beside the levels rather than three screens away.
 *
 * The count under the label is the engine's own signal list, split by
 * direction — not a score, and not a judgement this component makes.
 */
function ConfirmationChip({ confirmation }: { confirmation: ConfirmationResult }) {
  const meta = CONFIRMATION_META[confirmation.status];
  const supporting = confirmation.signals.filter((s) => s.signal === "positive").length;
  const against = confirmation.signals.filter((s) => s.signal === "negative").length;

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Confirmation
      </span>
      <span className={cn("flex items-center gap-1 text-xs font-semibold", meta.className)}>
        <meta.Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {meta.label}
      </span>
      <span className="text-[10px] text-muted-foreground">
        {supporting} supporting · {against} against
      </span>
    </div>
  );
}

function LevelLabel({ children }: { children: React.ReactNode }) {
  return (
    <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </dt>
  );
}

const TONE_CLASS = {
  entry: "text-foreground",
  stop: "text-bearish",
  target: "text-bullish",
  absent: "text-muted-foreground",
} as const;

function Level({
  label,
  value,
  note,
  why,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  why?: string;
  tone: keyof typeof TONE_CLASS;
}) {
  return (
    <div className="min-w-0">
      <LevelLabel>{label}</LevelLabel>
      <dd className="m-0">
        <span className={cn("tabular block text-lg font-semibold leading-tight", TONE_CLASS[tone])}>
          {value}
        </span>
        {note ? (
          <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
            {note}
          </span>
        ) : null}
        {why ? <WhyDisclosure>{why}</WhyDisclosure> : null}
      </dd>
    </div>
  );
}
