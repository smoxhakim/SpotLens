"use client";

import { AlertTriangle } from "lucide-react";

import { incompleteAnalysisNotice, type AnalysisShortfall } from "@/lib/analysis/incomplete";
import { cn } from "@/lib/utils";

/**
 * Says an analysis is incomplete, beside the levels it qualifies.
 *
 * An analysis on stale entry candles, or without the higher timeframe it
 * needs, is shown for information only — never a potential setup, never tracked, never eligible for an alert —
 * and the reader must not have to infer that from a missing badge. The wording
 * is the engine's (`incompleteAnalysisNotice`); this only places it.
 */
export function IncompleteAnalysisNotice({
  incomplete,
  className,
}: {
  incomplete: AnalysisShortfall | null | undefined;
  className?: string;
}) {
  if (!incomplete) return null;

  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400",
        className,
      )}
    >
      <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{incompleteAnalysisNotice(incomplete)}</span>
    </p>
  );
}
