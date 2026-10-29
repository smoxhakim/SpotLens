"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import type { combinedFreshness } from "@/lib/scanner/freshness";

type Combined = ReturnType<typeof combinedFreshness>;

/**
 * Says when what is on screen no longer describes the market.
 *
 * Nothing at all while it is fresh — the timestamp beside it already says when.
 * Stale: names the timeframes a newer candle has closed on and says the
 * readings are historical. Unknown: says so, rather than letting silence read
 * as fresh. The analysis and its time stay on the page either way.
 */
export function AnalysisFreshnessNotice({
  freshness,
  asOf,
  subject = "this analysis",
}: {
  freshness: Combined;
  /** When the analysis was made, shown in the reader's own zone. */
  asOf: number | null;
  subject?: string;
}) {
  if (freshness.state === "FRESH") return null;

  const when = asOf ? ` (as of ${new Date(asOf).toLocaleString()})` : "";
  const names = (timeframes: string[]) =>
    timeframes.map((t) => TIMEFRAME_LABELS[t as Timeframe] ?? t).join(" and ");

  return (
    <Alert variant="warning" data-freshness={freshness.state}>
      <AlertDescription className="text-[11px] leading-relaxed">
        {freshness.state === "STALE" ? (
          <>
            <span className="font-medium">Out of date.</span> A newer{" "}
            {names(freshness.staleTimeframes)} candle has closed since {subject}
            {when}. Its prices, levels and zone positions are historical, not the market now — a new
            scanner pass is needed before relying on them.
          </>
        ) : (
          <>
            <span className="font-medium">Freshness unknown.</span> When {subject} was made could
            not be established{when}, so it may be out of date. Treat its prices and zone positions
            as historical.
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
