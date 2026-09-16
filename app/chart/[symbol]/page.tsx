import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ChartWorkspace } from "@/features/market/components/ChartWorkspace";

/**
 * The dedicated chart view.
 *
 * `/chart/LTCUSDT?tf=H4` — the symbol in the path, matching `app/assets/[symbol]`,
 * and the timeframe in the query, matching `/market-analysis?pair=…&tf=…`. Both
 * halves are the conventions already in the codebase rather than a third one
 * invented for this page, so a link is a link wherever it came from.
 *
 * The timeframe token is the application's own (`H4`, not `4h`): it is what
 * `isTimeframe` validates and what every other URL in the product carries.
 */
export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = (await params).symbol.toUpperCase();
  return { title: `${symbol} chart — SpotLens` };
}

export default async function ChartPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Next 15+: both arrive as Promises.
  const { symbol } = await params;
  const query = await searchParams;
  const tf = typeof query.tf === "string" ? query.tf : undefined;

  return (
    <Suspense fallback={<Skeleton className="h-[70vh] w-full" />}>
      <ChartWorkspace symbol={symbol.toUpperCase()} timeframeParam={tf} />
    </Suspense>
  );
}
