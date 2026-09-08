import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnalysisHistory } from "@/features/analysis/components/AnalysisHistory";
import { MarketDirectory } from "@/features/market/components/MarketDirectory";
import { ANALYSIS_DISCLAIMER, SPOT_ONLY_NOTE } from "@/lib/constants/disclaimers";
import { listMarkets } from "@/services/markets";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const markets = await listMarkets();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          A curated list of established spot markets. Pick one to open its chart.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground">Curated markets</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{markets.length}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground">Scope</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">Spot only — no futures, margin, or leverage</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground">Start here</CardTitle>
          </CardHeader>
          <CardContent>
            <Link
              href="/market-analysis?pair=BTCUSDT&tf=H1"
              className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2"
            >
              Open BTC/USDT chart <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </CardContent>
        </Card>
      </div>

      <AnalysisHistory />

      <MarketDirectory markets={markets} />

      <Alert variant="muted">
        <AlertDescription>
          {ANALYSIS_DISCLAIMER} {SPOT_ONLY_NOTE}
        </AlertDescription>
      </Alert>
    </div>
  );
}
