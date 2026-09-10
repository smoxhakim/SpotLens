"use client";

import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import type { BacktestMetrics, BacktestSetupResult } from "@/lib/backtesting";
import { formatPrice } from "@/lib/format";
import { TIMEFRAMES, TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import type { MarketSummary } from "@/types/market";

interface BacktestResponse {
  runId: string;
  label: string;
  timeframe: Timeframe;
  /** Every candle read, warmup and evaluation window together. */
  candlesUsed: number;
  /** Candles read only as history, before the range under test. */
  warmupBars: number;
  /** Candles actually evaluated — the bars the run is a statement about. */
  evaluatedBars: number;
  higherTimeframe: Timeframe | null;
  metrics: BacktestMetrics;
  setups: BacktestSetupResult[];
  disclaimer: string;
}

const OUTCOME_VARIANT: Record<string, "bullish" | "bearish" | "neutral"> = {
  TP1_HIT: "bullish",
  TP2_HIT: "bullish",
  TP3_HIT: "bullish",
  SL_HIT: "bearish",
  NO_HIT: "neutral",
  STILL_OPEN: "neutral",
};

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function BacktestView({ markets }: { markets: MarketSummary[] }) {
  const { status } = useSession();

  const [pairId, setPairId] = useState(
    markets.find((m) => m.exchangeSymbol === "BTCUSDT")?.pairId ?? markets[0]?.pairId ?? "",
  );
  const [timeframe, setTimeframe] = useState<Timeframe>("H4");
  const [startDate, setStartDate] = useState(isoDaysAgo(120));
  const [endDate, setEndDate] = useState(isoDaysAgo(0));

  const run = useMutation<BacktestResponse, Error>({
    mutationFn: () =>
      fetchApi<BacktestResponse>("/api/backtest/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tradingPairId: pairId, timeframe, startDate, endDate }),
      }),
  });

  if (status === "loading") return <Skeleton className="h-48 w-full" />;

  if (status !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Backtest reports are saved to your account.</p>
          <Button asChild size="sm" className="mt-3">
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Replay the engine over history</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pair">Pair</Label>
              <select
                id="pair"
                value={pairId}
                onChange={(e) => setPairId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {markets.map((market) => (
                  <option key={market.pairId} value={market.pairId}>
                    {market.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="tf">Timeframe</Label>
              <select
                id="tf"
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value as Timeframe)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {TIMEFRAMES.map((tf) => (
                  <option key={tf} value={tf}>
                    {TIMEFRAME_LABELS[tf]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="from">From</Label>
              <Input
                id="from"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="to">To</Label>
              <Input
                id="to"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending || !pairId}>
            <FlaskConical className="h-4 w-4" />
            {run.isPending ? "Replaying…" : "Run backtest"}
          </Button>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            The replay needs roughly 260 candles to warm up its indicators before it can take a
            setup, so a short range will produce nothing. The first result usually comes well after
            the start date.
          </p>

          {run.isError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{run.error.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {run.data && <Report data={run.data} />}
    </div>
  );
}

function Report({ data }: { data: BacktestResponse }) {
  const { metrics } = data;

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>
            {data.label} · {TIMEFRAME_LABELS[data.timeframe]} · {data.evaluatedBars} candles
            evaluated
          </CardTitle>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {data.warmupBars} further candles were read from before the range as history, so the
            indicators were already warm on its first bar — they are not part of what was tested.
            This is a sample from the recent past, not a full historical evaluation: a run covers at
            most a few hundred candles.
            {data.higherTimeframe
              ? ` The ${TIMEFRAME_LABELS[data.higherTimeframe]} trend was read alongside it, using only candles that had closed at the time, exactly as a multi-timeframe analysis would.`
              : ""}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {metrics.numSetups === 0 ? (
            <p className="text-sm text-muted-foreground">
              No setups triggered in this range. That is a result, not a failure — the engine is
              built to pass on most conditions.
            </p>
          ) : (
            <>
              <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Stat label="Setups" value={String(metrics.numSetups)} testId="bt-setups" />
                <Stat
                  label="Win rate"
                  value={`${metrics.winRate.toFixed(0)}%`}
                  hint={`${metrics.wins}W / ${metrics.losses}L${
                    metrics.breakeven > 0 ? ` / ${metrics.breakeven}BE` : ""
                  }`}
                  testId="bt-winrate"
                />
                <Stat
                  label="Avg R"
                  value={metrics.avgRealizedRR.toFixed(2)}
                  hint="per setup"
                  testId="bt-avgr"
                />
                <Stat label="Total R" value={metrics.totalR.toFixed(1)} testId="bt-totalr" />
                <Stat
                  label="Max drawdown"
                  value={`${metrics.maxDrawdownPct.toFixed(1)}%`}
                  hint={`at ${metrics.riskPerTradePct}% risk`}
                  testId="bt-drawdown"
                />
              </dl>

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Drawdown assumes {metrics.riskPerTradePct}% of the account risked per trade —
                &ldquo;3R of drawdown&rdquo; means nothing without knowing what an R was worth. A
                trade&rsquo;s stop moves to breakeven once TP1 trades and to TP1 once TP2 trades;
                when one candle covers both a stop and a target, the stop is assumed to have come
                first, because OHLC data cannot say otherwise.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {data.setups.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Setup by setup</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b text-left">
                    <th className="px-2 py-1.5 font-medium">Triggered</th>
                    <th className="px-2 py-1.5 font-medium">Entry</th>
                    <th className="px-2 py-1.5 font-medium">Stop</th>
                    <th className="px-2 py-1.5 font-medium">Exit</th>
                    <th className="px-2 py-1.5 font-medium">Outcome</th>
                    <th className="px-2 py-1.5 text-right font-medium">R</th>
                    <th className="px-2 py-1.5 text-right font-medium">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {data.setups.map((setup) => (
                    <tr key={setup.triggeredAt} className="border-b last:border-0">
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {new Date(setup.triggeredAt).toLocaleDateString()}
                      </td>
                      <td className="tabular px-2 py-1.5">{formatPrice(setup.entry)}</td>
                      <td className="tabular px-2 py-1.5">{formatPrice(setup.stopLoss)}</td>
                      <td className="tabular px-2 py-1.5">
                        {setup.exitPrice === null ? "—" : formatPrice(setup.exitPrice)}
                      </td>
                      <td className="px-2 py-1.5">
                        <Badge
                          variant={OUTCOME_VARIANT[setup.outcome] ?? "neutral"}
                          className="text-[9px]"
                        >
                          {setup.outcome.replace(/_/g, " ").toLowerCase()}
                        </Badge>
                      </td>
                      <td
                        className={`tabular px-2 py-1.5 text-right ${
                          (setup.realizedRR ?? 0) >= 0 ? "text-bullish" : "text-bearish"
                        }`}
                      >
                        {setup.realizedRR === null ? "—" : setup.realizedRR.toFixed(2)}
                      </td>
                      <td className="tabular px-2 py-1.5 text-right text-muted-foreground">
                        {setup.setupScore}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div className="rounded-md border p-2.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular text-sm font-semibold" data-testid={testId}>
        {value}
        {hint && <span className="ml-1 text-[10px] font-normal text-muted-foreground">{hint}</span>}
      </dd>
    </div>
  );
}
