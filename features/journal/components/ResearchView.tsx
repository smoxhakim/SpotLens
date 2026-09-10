"use client";

import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import type { BacktestMetrics, Breakdown } from "@/lib/backtesting";
import { TIMEFRAMES, TIMEFRAME_LABELS } from "@/lib/market-data/provider";
import type { EngineFunnel, HumanDecisions } from "@/lib/research";

interface Report {
  engine: EngineFunnel;
  human: HumanDecisions;
  outcomes: BacktestMetrics;
  bySymbol: Breakdown[];
  byTimeframe: Breakdown[];
  byScoreBand: Breakdown[];
  byConfirmation: Breakdown[];
  byRegime: Breakdown[];
  byVolatility: Breakdown[];
  byTargetKind: Breakdown[];
  smallSample: boolean;
}

export function ResearchView() {
  const { status: authStatus } = useSession();
  const [timeframe, setTimeframe] = useState("");
  const [regime, setRegime] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const params = new URLSearchParams();
  if (timeframe) params.set("timeframe", timeframe);
  if (regime) params.set("regimeDirection", regime);
  if (confirmation) params.set("confirmation", confirmation);

  const query = useQuery<{ report: Report }>({
    queryKey: ["research", timeframe, regime, confirmation],
    queryFn: () => fetchApi(`/api/research?${params.toString()}`),
    enabled: authStatus === "authenticated",
  });

  if (authStatus === "loading") return <Skeleton className="h-64 w-full" />;

  if (authStatus !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Research reads your own history.</p>
          <Button asChild size="sm" className="mt-3">
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (query.isPending) return <Skeleton className="h-64 w-full" />;

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{(query.error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const report = query.data!.report;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Select label="Timeframe" value={timeframe} onChange={setTimeframe}>
            <option value="">Any</option>
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {TIMEFRAME_LABELS[tf]}
              </option>
            ))}
          </Select>
          <Select label="Regime" value={regime} onChange={setRegime}>
            <option value="">Any</option>
            {["TRENDING_UP", "TRENDING_DOWN", "RANGE", "UNCLEAR"].map((r) => (
              <option key={r} value={r}>
                {r.toLowerCase().replace(/_/g, " ")}
              </option>
            ))}
          </Select>
          <Select label="Confirmation" value={confirmation} onChange={setConfirmation}>
            <option value="">Any</option>
            <option value="PRESENT">Reached confirmation</option>
            <option value="NOT_PRESENT">Never confirmed</option>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">What the engine produced</CardTitle>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Counts, not returns. A setup is not a trade — it happened whether or not anyone acted on
            it, and measuring it in R would mean assuming trades that never took place.
          </p>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat
              label="Setups detected"
              value={String(report.engine.setupsDetected)}
              testId="engine-detected"
            />
            <Stat label="Reached confirmation" value={String(report.engine.reachedConfirmation)} />
            <Stat label="Reached potential" value={String(report.engine.reachedPotentialSetup)} />
            <Stat label="Invalidated" value={String(report.engine.invalidated)} />
            <Stat
              label="Invalidation rate"
              value={`${report.engine.invalidationRate.toFixed(0)}%`}
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">What you decided</CardTitle>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Kept separate from the engine above. Combining them would produce one win rate that
            describes neither.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat
              label="Journaled"
              value={String(report.human.journaled)}
              testId="human-journaled"
            />
            <Stat label="Taken" value={String(report.human.taken)} />
            <Stat label="Closed" value={String(report.human.closed)} />
            <Stat label="Skipped" value={String(report.human.skipped)} />
            <Stat label="Acted on" value={`${report.human.actedOnRate.toFixed(0)}%`} />
          </dl>

          {report.human.skipReasons.length > 0 && (
            <div>
              <SectionLabel>Why you passed</SectionLabel>
              <ul className="space-y-0.5 text-[11px]">
                {report.human.skipReasons.map((reason) => (
                  <li key={reason.reason} className="flex justify-between">
                    <span>{reason.reason.toLowerCase().replace(/_/g, " ")}</span>
                    <span className="tabular text-muted-foreground">{reason.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">How your trades did</CardTitle>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Closed entries only, measured in R against the risk you actually took. A historical
            observation about this sample — not a forecast, and not a property of the strategy.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {report.outcomes.closedTrades === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No closed trades yet. Record an outcome on a taken entry and it will appear here.
            </p>
          ) : (
            <>
              {report.smallSample && (
                <Alert variant="warning">
                  <Info />
                  <AlertDescription className="text-[11px] leading-relaxed">
                    {report.outcomes.closedTrades} closed{" "}
                    {report.outcomes.closedTrades === 1 ? "trade" : "trades"} is a small sample. Win
                    rate and expectancy swing heavily at this size.
                  </AlertDescription>
                </Alert>
              )}

              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Closed" value={String(report.outcomes.closedTrades)} />
                <Stat label="Win rate" value={`${report.outcomes.winRate.toFixed(0)}%`} />
                <Stat label="Total R" value={report.outcomes.totalR.toFixed(2)} />
                <Stat label="Average R" value={report.outcomes.averageR.toFixed(2)} />
                <Stat label="Expectancy" value={`${report.outcomes.expectancyR.toFixed(2)}R`} />
                <Stat
                  label="Profit factor"
                  value={
                    report.outcomes.profitFactor === null
                      ? "—"
                      : report.outcomes.profitFactor.toFixed(2)
                  }
                />
                <Stat label="Max drawdown" value={`${report.outcomes.maxDrawdownR.toFixed(2)}R`} />
                <Stat
                  label="Streaks"
                  value={`${report.outcomes.maxWinStreak}W / ${report.outcomes.maxLossStreak}L`}
                />
              </dl>

              <Separator />

              {report.bySymbol.length > 1 && <Table title="By market" rows={report.bySymbol} />}
              {report.byTimeframe.length > 1 && (
                <Table title="By timeframe" rows={report.byTimeframe} />
              )}
              {report.byScoreBand.length > 1 && (
                <Table title="By setup quality" rows={report.byScoreBand} />
              )}
              {report.byRegime.length > 1 && <Table title="By regime" rows={report.byRegime} />}
              {report.byVolatility.length > 1 && (
                <Table title="By volatility" rows={report.byVolatility} />
              )}
              {report.byConfirmation.length > 1 && (
                <Table
                  title="By confirmation at the decision"
                  rows={report.byConfirmation}
                  note="Grouped by whether confirmation had already been seen when you decided — not by what the setup went on to do. A setup that confirmed after you entered belongs in the column you could actually see."
                />
              )}
              {report.byTargetKind.length > 1 && (
                <Table title="By target kind" rows={report.byTargetKind} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Table({ title, rows, note }: { title: string; rows: Breakdown[]; note?: string }) {
  return (
    <section>
      <SectionLabel>{title}</SectionLabel>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-medium">Group</th>
              <th className="py-1 text-right font-medium">Trades</th>
              <th className="py-1 text-right font-medium">Win rate</th>
              <th className="py-1 text-right font-medium">Total R</th>
              <th className="py-1 text-right font-medium">Expectancy</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, metrics }) => (
              <tr key={key} className="border-t">
                <td className="py-1">
                  {key}
                  {metrics.smallSample && (
                    <span className="ml-1 text-[9px] text-muted-foreground">(small sample)</span>
                  )}
                </td>
                <td className="tabular py-1 text-right">{metrics.closedTrades}</td>
                <td className="tabular py-1 text-right">{metrics.winRate.toFixed(0)}%</td>
                <td className="tabular py-1 text-right">{metrics.totalR.toFixed(2)}</td>
                <td className="tabular py-1 text-right">{metrics.expectancyR.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        {note ??
          "An observation about what already happened. A group at the top did well in this sample; it is not a recommendation, and a handful of trades is not a finding."}
      </p>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div data-testid={testId}>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular text-sm font-semibold">{value}</dd>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {children}
      </select>
    </div>
  );
}
