"use client";

import { Check, Minus, TriangleAlert } from "lucide-react";

import type { Explanation, ExplanationSignal } from "@/lib/analysis";
import { cn } from "@/lib/utils";

import { WhyDisclosure } from "./WhyDisclosure";

/**
 * Renders the structured explanation list.
 *
 * The component knows nothing about trading. It receives `Explanation[]`,
 * already ordered and already tagged, and decides only how a positive, a
 * negative and a neutral should look. Every judgement it displays was made by
 * the engine — which is the point: the same list can be rendered here, sent to
 * a chat client, or written into a journal entry without three different
 * opinions about what a counter-trend bounce is called.
 */
const SIGNAL_META: Record<
  ExplanationSignal,
  { Icon: typeof Check; className: string; label: string }
> = {
  positive: { Icon: Check, className: "text-bullish", label: "Supports the setup" },
  negative: { Icon: TriangleAlert, className: "text-bearish", label: "Weakens the setup" },
  neutral: { Icon: Minus, className: "text-muted-foreground", label: "Neither way" },
};

export function ExplanationList({ explanations }: { explanations: Explanation[] }) {
  if (explanations.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Why this verdict
      </h3>

      <ul className="space-y-1.5">
        {explanations.map((explanation) => {
          const meta = SIGNAL_META[explanation.signal];
          const { Icon } = meta;

          return (
            <li key={explanation.id}>
              <div className="flex items-start gap-1.5">
                <Icon
                  className={cn("mt-[3px] h-3 w-3 shrink-0", meta.className)}
                  aria-hidden="true"
                />
                <span className="text-[11px] leading-relaxed">
                  <span className="sr-only">{meta.label}: </span>
                  {explanation.title}
                </span>
              </div>
              <div className="pl-[18px]">
                <WhyDisclosure>{explanation.detail}</WhyDisclosure>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
