import { Badge } from "@/components/ui/badge";
import type { AnalysisFreshness } from "@/lib/scanner/freshness";

/**
 * The per-item form of `AnalysisFreshnessNotice`: one short badge beside a card
 * whose numbers no longer describe the market. Nothing while fresh.
 */
export function FreshnessBadge({ freshness }: { freshness: AnalysisFreshness | undefined }) {
  if (!freshness || freshness.state === "FRESH") return null;

  return (
    <Badge
      variant="outline"
      data-freshness={freshness.state}
      className="border-amber-500/50 text-[10px] text-amber-700 dark:text-amber-400"
    >
      {freshness.state === "STALE" ? "Out of date" : "Freshness unknown"}
    </Badge>
  );
}
