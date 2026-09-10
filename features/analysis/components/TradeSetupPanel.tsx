"use client";

import { AlertTriangle, Calculator, CheckCircle2, Clock, XCircle } from "lucide-react";
import Link from "next/link";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { STATUS_LABELS, buildExplanations } from "@/lib/analysis";
import type { AnalysisResult, SetupScore, TradeStatus } from "@/lib/analysis";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

import { ConfirmationPanel } from "./ConfirmationPanel";
import { ExplanationList } from "./ExplanationList";
import { LearnLink } from "./LearnLink";
import { MtfPanel } from "./MtfPanel";
import { WhyDisclosure } from "./WhyDisclosure";

/**
 * Presentation only. The labels come from `STATUS_LABELS` in the engine — a
 * second copy of them here is how "Avoid for now" and "Avoid" end up on two
 * different screens describing the same verdict.
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
  AVOID: {
    Icon: XCircle,
    className: "border-bearish/40 bg-bearish/10 text-bearish",
  },
};

const CATEGORY_LABELS: Record<keyof SetupScore["breakdown"], string> = {
  trend: "Trend",
  supportResistance: "Support / resistance",
  volume: "Volume",
  rsi: "RSI",
  emaAlignment: "EMA alignment",
  riskReward: "Risk / reward",
};

interface TradeSetupPanelProps {
  result: AnalysisResult | null;
  isPending: boolean;
  error: Error | null;
  asOf?: number;
}

export function TradeSetupPanel({ result, isPending, error, asOf }: TradeSetupPanelProps) {
  if (isPending) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Trade setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Trade setup</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (!result) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Trade setup</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          Run <span className="font-medium text-foreground">Analyze Market</span> for an entry zone,
          stop loss, take-profit targets, risk/reward and a setup score — each with the reasoning
          behind it.
        </CardContent>
      </Card>
    );
  }

  const status = STATUS_STYLE[result.status];
  const { Icon } = status;
  const setup = result.setup;
  const explanations = buildExplanations(result);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-baseline justify-between gap-2">
          <span>Trade setup</span>
          {asOf ? (
            <span className="text-[10px] font-normal text-muted-foreground">
              as of {new Date(asOf).toLocaleString()}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className={cn("rounded-lg border p-3", status.className)}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Icon className="h-4 w-4" />
            {STATUS_LABELS[result.status].label}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed opacity-90">{result.statusReason}</p>
        </div>

        <LearnLink concept="status" label="What these four statuses mean" />

        <ExplanationList explanations={explanations} />

        {result.mtf && <MtfPanel mtf={result.mtf} />}

        {result.confirmation && <ConfirmationPanel confirmation={result.confirmation} />}

        {!setup && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            No entry, stop or target levels are shown, because SpotLens does not hand over numbers
            for a trade it has just advised against.
          </p>
        )}

        {setup && (
          <>
            <section>
              <Label>Entry zone</Label>
              <Value>
                {formatPrice(setup.entry.low)} – {formatPrice(setup.entry.high)}
              </Value>
              <WhyDisclosure>{setup.entry.reason}</WhyDisclosure>
              <LearnLink concept="support" label="Why the entry is a zone, not a price" />

              <div className="mt-2 rounded-md border border-dashed p-2">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Wait for confirmation
                </div>
                <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
                  {setup.entry.confirmations.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </section>

            <Separator />

            <section>
              <Label>Stop loss</Label>
              <Value className="text-bearish">{formatPrice(setup.stopLoss.price)}</Value>
              <p className="text-[11px] text-muted-foreground">
                {(setup.stopLoss.riskPct * 100).toFixed(2)}% below the entry
              </p>
              <WhyDisclosure>{setup.stopLoss.reason}</WhyDisclosure>
              <LearnLink concept="stop-loss" label="Where a stop belongs" />
            </section>

            <section>
              <Label>Take profit</Label>
              <ul className="space-y-2">
                {setup.takeProfits.map((target) => (
                  <li key={target.label}>
                    <div className="flex items-baseline gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {target.label}
                      </Badge>
                      <span className="tabular text-sm font-medium text-bullish">
                        {formatPrice(target.level)}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {target.rr.toFixed(1)}R
                      </span>
                    </div>
                    <WhyDisclosure>{target.reason}</WhyDisclosure>
                  </li>
                ))}
              </ul>
            </section>

            <Separator />

            <section>
              <Label>Risk / reward</Label>
              <div className="flex items-center gap-2">
                <Value className={setup.riskReward.isPoor ? "text-bearish" : undefined}>
                  1:{setup.riskReward.ratio.toFixed(1)}
                </Value>
                <span className="text-[10px] text-muted-foreground">
                  to {setup.riskReward.measuredTo}
                </span>
                {setup.riskReward.isSynthetic ? (
                  // Without this the ratio reads as a measured one. It is the
                  // fallback multiple restating itself, and it scores zero.
                  <Badge variant="bearish" className="text-[9px]">
                    unmeasured
                  </Badge>
                ) : (
                  setup.riskReward.isPoor && (
                    <Badge variant="bearish" className="text-[9px]">
                      poor
                    </Badge>
                  )
                )}
              </div>
              <WhyDisclosure>{setup.riskReward.reason}</WhyDisclosure>
              <LearnLink concept="risk-reward" label="Why 1:1 is a losing game" />
            </section>

            <RiskCalculatorLink setup={setup} />
          </>
        )}

        {/*
          Outside the block above on purpose. An AVOID withholds the levels but
          keeps the score, because the score is the evidence for the refusal —
          without it the status reason cites a number with nothing behind it.
        */}
        {result.score && <ScoreBreakdown score={result.score} />}

        <Alert variant="muted">
          <AlertDescription>{result.disclaimer}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function ScoreBreakdown({ score }: { score: SetupScore }) {
  return (
    <section>
      <Label>Setup score</Label>
      <div className="mb-2 flex items-baseline gap-2">
        <Value>{score.total}/100</Value>
        <Badge
          variant={
            score.grade === "STRONG" ? "bullish" : score.grade === "AVOID" ? "bearish" : "neutral"
          }
          className="text-[9px]"
        >
          {score.grade.toLowerCase()}
        </Badge>
      </div>

      <ul className="space-y-1.5">
        {(Object.keys(score.breakdown) as (keyof SetupScore["breakdown"])[]).map((key) => {
          const category = score.breakdown[key];
          const pct = category.max === 0 ? 0 : (category.score / category.max) * 100;
          return (
            <li key={key}>
              <div className="flex items-baseline justify-between text-[11px]">
                <span>{CATEGORY_LABELS[key]}</span>
                <span className="tabular text-muted-foreground">
                  {Math.round(category.score)}/{category.max}
                </span>
              </div>
              <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary/60" style={{ width: `${pct}%` }} />
              </div>
              <WhyDisclosure>{category.reason}</WhyDisclosure>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        The score measures how much of the evidence agrees, not the chance of the trade working. It
        is not a prediction.
      </p>
      <LearnLink concept="setup-score" label="How the score is built" />
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function Value({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("tabular text-sm font-semibold", className)}>{children}</p>;
}

/**
 * Carries the setup's levels into the risk calculator.
 *
 * A link, not a button that does something: the calculator sizes a position and
 * nothing else, and the user still has to supply a balance and a risk
 * percentage before it can. SpotLens has no order path, and this is not one.
 *
 * The target passed is the one `riskReward.measuredTo` names rather than a
 * fixed index. The engine measures to the second *qualifying* structural
 * target, which is frequently not TP2 — sending the wrong one would make the
 * calculator quietly disagree with the panel it was opened from.
 */
function RiskCalculatorLink({ setup }: { setup: NonNullable<AnalysisResult["setup"]> }) {
  const measured = setup.takeProfits.find((t) => t.label === setup.riskReward.measuredTo);

  const params = new URLSearchParams({
    entry: String(setup.entry.mid),
    stop: String(setup.stopLoss.price),
    ...(measured ? { tp: String(measured.level) } : {}),
    ...(setup.riskReward.isSynthetic ? { unmeasured: "1" } : {}),
  });

  return (
    <div className="rounded-md border border-dashed p-2">
      <Button asChild size="sm" variant="outline">
        <Link href={`/risk-calculator?${params.toString()}`}>
          <Calculator className="h-3.5 w-3.5" />
          Calculate position size
        </Link>
      </Button>
      <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
        Opens the calculator with this entry, stop and target
        {setup.riskReward.isSynthetic ? " — the target is one the engine never measured" : ""}. You
        choose the balance and the risk. Nothing is placed, and nothing is sent anywhere.
      </p>
    </div>
  );
}
