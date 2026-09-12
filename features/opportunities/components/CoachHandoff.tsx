import Link from "next/link";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import { cn } from "@/lib/utils";

/**
 * What a candidate hands the Coach, and what the Coach will do with it later.
 *
 * The contract is four references and nothing else: the market, the timeframe,
 * the scanner run the shortlist came from, and the tracked setup when there is
 * one. A URL carrying an entry price and a score would be a second copy of
 * numbers that already exist, free to go stale the moment the next candle
 * closes; an id resolves to whatever is true when it is read.
 *
 * The run id is part of that contract rather than a convenience. A shortlist
 * belongs to one pass, and a review of "ETHUSDT on H4" without saying which
 * pass ranked it is a review of a moving target — Phase N needs to reconstruct
 * exactly the context the reader was looking at.
 *
 * Values arrive already validated, from the server component above. Nothing
 * here calls a model, and nothing claims a review has happened: saying "the
 * Coach looked at this" when no Coach exists would be worse than an empty page,
 * because a reader would believe it.
 */
export function CoachHandoff({
  symbol,
  timeframe,
  setupId,
  runId,
}: {
  symbol: string | null;
  timeframe: Timeframe | null;
  setupId: string | null;
  runId: string | null;
}) {
  const nothingPassed = symbol === null && timeframe === null && setupId === null && runId === null;

  return (
    <div className="space-y-4">
      <Alert variant="muted">
        <AlertDescription className="space-y-1">
          <p className="font-medium text-foreground">Coach review arrives in the next phase.</p>
          <p className="text-[11px] leading-relaxed">
            This page currently confirms what a candidate hands over. No analysis has been sent
            anywhere, nothing has been reviewed, and SpotLens has not formed an opinion beyond the
            deterministic one already on the analysis page.
          </p>
        </AlertDescription>
      </Alert>

      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Received context
          </h2>

          {nothingPassed ? (
            <p className="text-sm text-muted-foreground">
              No candidate was passed. Open the Coach from an opportunity or an analysis so it knows
              which market you are asking about.
            </p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
              <Field label="Market">{symbol ?? "—"}</Field>
              <Field label="Timeframe">{timeframe ? TIMEFRAME_LABELS[timeframe] : "—"}</Field>
              <Field label="Scanner run" wide>
                {runId ?? "not recorded — opened outside a scan"}
              </Field>
              <Field label="Tracked setup" wide>
                {setupId ?? "none — this market is not being tracked yet"}
              </Field>
            </dl>
          )}

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            References rather than a copy of the analysis, so the review reads the numbers as they
            are when it runs instead of as they were when the link was made.
          </p>

          {symbol && timeframe && (
            <div className="flex flex-wrap gap-2 pt-0.5">
              <Button asChild size="sm" variant="outline">
                <Link
                  href={`/market-analysis?pair=${encodeURIComponent(symbol)}&tf=${timeframe}`}
                  aria-label={`Open the full analysis for ${symbol} on ${TIMEFRAME_LABELS[timeframe]}`}
                >
                  Open the full analysis
                </Link>
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href="/opportunities">Back to opportunities</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium text-foreground", wide && "break-all")}>{children}</dd>
    </div>
  );
}
