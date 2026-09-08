import { AlertTriangle, FlaskConical } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

import { BacktestView } from "@/features/backtesting/components/BacktestView";
import { BACKTEST_DISCLAIMER } from "@/lib/constants/disclaimers";
import { listMarkets } from "@/services/markets";

export const metadata = { title: "Backtest — SpotLens" };
export const dynamic = "force-dynamic";

export default async function BacktestPage() {
  const markets = await listMarkets();

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <FlaskConical className="h-5 w-5" />
          Backtest
        </h1>
        <p className="text-sm text-muted-foreground">
          Replay the same engine bar by bar over history, to see how its rules would have behaved on
          data that already happened.
        </p>
      </header>

      {/* Above the tool, not below the report: the warning has to be visible
          before a result exists, and to a signed-out reader who cannot run one. */}
      <Alert variant="warning">
        <AlertTriangle />
        <AlertDescription>{BACKTEST_DISCLAIMER}</AlertDescription>
      </Alert>

      <BacktestView markets={markets} />
    </div>
  );
}
