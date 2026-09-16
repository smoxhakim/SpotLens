"use client";

import { Badge } from "@/components/ui/badge";
import type { SetupScore } from "@/lib/analysis";

import { LearnLink } from "./LearnLink";
import { WhyDisclosure } from "./WhyDisclosure";

/**
 * How the score was arrived at, category by category.
 *
 * Secondary by design: the total belongs in the summary strip, where it is one
 * number among the handful that decide whether to read further. This is the
 * working behind it, and it is worth having without being worth the space it
 * used to occupy above the entry price.
 */
const CATEGORY_LABELS: Record<keyof SetupScore["breakdown"], string> = {
  trend: "Trend",
  supportResistance: "Support / resistance",
  volume: "Volume",
  rsi: "RSI",
  emaAlignment: "EMA alignment",
  riskReward: "Risk / reward",
};

export function ScoreBreakdown({ score }: { score: SetupScore }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="tabular text-sm font-semibold">{score.total}/100</span>
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
    </div>
  );
}
