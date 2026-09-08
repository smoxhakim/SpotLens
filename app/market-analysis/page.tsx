import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { MarketWorkspace } from "@/features/market/components/MarketWorkspace";

export const metadata = { title: "Market Analysis — SpotLens" };

export default function MarketAnalysisPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[600px] w-full" />}>
      <MarketWorkspace />
    </Suspense>
  );
}
