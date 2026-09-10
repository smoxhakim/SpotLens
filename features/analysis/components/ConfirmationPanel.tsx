"use client";

import { Check, CircleDashed, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ConfirmationResult } from "@/lib/analysis";
import { cn } from "@/lib/utils";

import { WhyDisclosure } from "./WhyDisclosure";

/**
 * The deterministic confirmation state, shown as the signals themselves.
 *
 * A verdict without its evidence is a signal, which is the thing this product
 * is not. So the panel lists what the engine actually found — and just as
 * importantly, says plainly when it found nothing, because "nothing has
 * happened here yet" is the most common honest answer and the easiest one to
 * dress up as anticipation.
 */
const STATUS_META = {
  PRESENT: {
    label: "Confirmation detected",
    className: "text-bullish",
  },
  NOT_PRESENT: {
    label: "Confirmation still required",
    className: "text-muted-foreground",
  },
  CONTRADICTED: {
    label: "Confirmation contradicted",
    className: "text-bearish",
  },
} as const;

const SIGNAL_ICON = {
  positive: { Icon: Check, className: "text-bullish" },
  negative: { Icon: X, className: "text-bearish" },
  neutral: { Icon: CircleDashed, className: "text-muted-foreground" },
} as const;

export function ConfirmationPanel({ confirmation }: { confirmation: ConfirmationResult }) {
  const meta = STATUS_META[confirmation.status];

  return (
    <section>
      <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Confirmation
      </h3>

      <div className="flex items-center gap-2">
        <p className={cn("text-xs font-semibold", meta.className)}>{meta.label}</p>
        {confirmation.invalidationReason && (
          <Badge variant="bearish" className="text-[9px]">
            invalidated
          </Badge>
        )}
      </div>

      {confirmation.signals.length > 0 ? (
        <ul className="mt-1.5 space-y-1.5">
          {confirmation.signals.map((signal) => {
            const { Icon, className } = SIGNAL_ICON[signal.signal];
            return (
              <li key={signal.type}>
                <div className="flex items-start gap-1.5">
                  <Icon className={cn("mt-[3px] h-3 w-3 shrink-0", className)} aria-hidden="true" />
                  <span className="text-[11px] leading-relaxed">{signal.title}</span>
                </div>
                <div className="pl-[18px]">
                  <WhyDisclosure>{signal.detail}</WhyDisclosure>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Nothing has happened at this level yet — no rejection, no higher low, no reclaim. That is
          a normal state for a level price has only just reached.
        </p>
      )}

      <WhyDisclosure label="What counts as confirmation?">
        {confirmation.explanation} Confirmation is judged on closed candles only: a forming
        candle&apos;s wick and close can still change completely, so a rejection detected on one is
        a rejection that may not have happened.
      </WhyDisclosure>
    </section>
  );
}
