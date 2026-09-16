"use client";

import { Calculator } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { AnalysisResult } from "@/lib/analysis";

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
export function RiskCalculatorLink({ setup }: { setup: NonNullable<AnalysisResult["setup"]> }) {
  const measured = setup.takeProfits.find((t) => t.label === setup.riskReward.measuredTo);

  const params = new URLSearchParams({
    entry: String(setup.entry.mid),
    stop: String(setup.stopLoss.price),
    ...(measured ? { tp: String(measured.level) } : {}),
    ...(setup.riskReward.isSynthetic ? { unmeasured: "1" } : {}),
  });

  return (
    <div>
      <Button asChild size="sm" variant="outline">
        <Link href={`/risk-calculator?${params.toString()}`}>
          <Calculator className="h-3.5 w-3.5" />
          Calculate position size
        </Link>
      </Button>
      <p className="mt-1.5 max-w-prose text-[10px] leading-relaxed text-muted-foreground">
        Opens the calculator with this entry, stop and target
        {setup.riskReward.isSynthetic ? " — the target is one the engine never measured" : ""}. You
        choose the balance and the risk. Nothing is placed, and nothing is sent anywhere.
      </p>
    </div>
  );
}
