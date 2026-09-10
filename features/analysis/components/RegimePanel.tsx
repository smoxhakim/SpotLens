"use client";

import { Badge } from "@/components/ui/badge";
import type { MarketRegime } from "@/lib/regime";
import { cn } from "@/lib/utils";

import { WhyDisclosure } from "./WhyDisclosure";

/**
 * The environment a setup is occurring in.
 *
 * Deliberately plain. A regime is context for interpreting a verdict the engine
 * reached without it — styling it like a signal, or putting a percentage on it,
 * would turn a description into a claim about what happens next.
 */
const DIRECTION_META: Record<MarketRegime["direction"], { label: string; className: string }> = {
  TRENDING_UP: { label: "Trending up", className: "text-bullish" },
  TRENDING_DOWN: { label: "Trending down", className: "text-bearish" },
  RANGE: { label: "Range", className: "text-muted-foreground" },
  UNCLEAR: { label: "Unclear", className: "text-muted-foreground" },
};

const VOLATILITY_LABEL: Record<MarketRegime["volatility"], string> = {
  HIGH: "high volatility",
  NORMAL: "normal volatility",
  LOW: "low volatility",
};

export function RegimePanel({ regime }: { regime: MarketRegime }) {
  const direction = DIRECTION_META[regime.direction];

  return (
    <section>
      <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Market regime
      </h3>

      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("text-xs font-semibold", direction.className)}>{direction.label}</span>
        <Badge variant="outline" className="text-[9px]">
          {VOLATILITY_LABEL[regime.volatility]}
        </Badge>
        {regime.atrPercent !== null && (
          <span className="text-[10px] text-muted-foreground">
            ATR {regime.atrPercent.toFixed(2)}% of price
          </span>
        )}
      </div>

      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        {regime.direction === "TRENDING_UP" || regime.direction === "TRENDING_DOWN"
          ? `${regime.evidence} of 3 directional signals agree.`
          : "The directional signals do not agree."}{" "}
        {regime.volatility === "HIGH" &&
          "Wider swings make a normal stop easier to reach — worth considering against your usual risk, though nothing here changes it."}
        {regime.volatility === "LOW" && "Quiet conditions; moves may take longer to develop."}
      </p>

      <WhyDisclosure label="How is this decided?">
        <ul className="space-y-1">
          {regime.reasons.map((reason) => (
            <li key={reason.factor + reason.detail}>{reason.detail}</li>
          ))}
        </ul>
        <p className="mt-1.5">
          Regime is context, not a verdict. It plays no part in the setup&apos;s status, score or
          confirmation — those were decided before this was calculated — and it describes what the
          market has been doing, not what it will do next.
        </p>
      </WhyDisclosure>
    </section>
  );
}
