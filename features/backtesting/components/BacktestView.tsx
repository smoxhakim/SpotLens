"use client";

import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical, Info } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import type {
  BacktestAssumptions,
  BacktestMetrics,
  BacktestSetupResult,
  Breakdown,
  DataCoverage,
  IntegrityIssue,
} from "@/lib/backtesting";
import { formatPrice } from "@/lib/format";
import { TIMEFRAMES, TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import type { MarketSummary } from "@/types/market";
import { cn } from "@/lib/utils";

interface Dataset {
  symbol: string;
  timeframe: Timeframe;
  coverage: DataCoverage;
  issues: IntegrityIssue[];
  failure: string | null;
}

interface BacktestResponse {
  runId: string;
  assumptions: BacktestAssumptions | null;
  datasets: Dataset[];
  metrics: BacktestMetrics;
  setups: BacktestSetupResult[];
  bySymbol: Breakdown[];
  byTimeframe: Breakdown[];
  byScoreBand: Breakdown[];
  byTargetKind: Breakdown[];
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

  const [pairIds, setPairIds] = useState<string[]>(() => {
    const btc = markets.find((m) => m.exchangeSymbol === "BTCUSDT")?.pairId;
    return btc ? [btc] : markets[0] ? [markets[0].pairId] : [];
  });
  const [timeframe, setTimeframe] = useState<Timeframe>("H4");
  const [startDate, setStartDate] = useState(isoDaysAgo(365));
  const [endDate, setEndDate] = useState(isoDaysAgo(0));
  const [feePercent, setFeePercent] = useState("0.1");

  const run = useMutation<BacktestResponse>({
    mutationFn: () =>
      fetchApi("/api/backtest/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tradingPairIds: pairIds,
          timeframes: [timeframe],
          startDate,
          endDate,
          feeRate: Number(feePercent) / 100,
        }),
      }),
  });

  if (status !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Backtests are saved to your account.</p>
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
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pair">Markets</Label>
              <select
                id="pair"
                multiple
                size={5}
                value={pairIds}
                onChange={(e) =>
                  setPairIds([...e.target.selectedOptions].map((option) => option.value))
                }
                className="flex w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {markets.map((market) => (
                  <option key={market.pairId} value={market.pairId}>
                    {market.label}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-muted-foreground">
                Hold ⌘ or Ctrl to compare several. Each one loads its own history.
              </p>
            </div>

            <div className="space-y-3">
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

              <div className="grid grid-cols-2 gap-2">
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

              <div className="space-y-1">
                <Label htmlFor="fee">Fee per side (%)</Label>
                <Input
                  id="fee"
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={feePercent}
                  onChange={(e) => setFeePercent(e.target.value)}
                  className="max-w-[120px]"
                />
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  Charged on entry and exit. A generic spot taker rate, not a claim about your
                  actual tier.
                </p>
              </div>
            </div>
          </div>

          <Button
            size="sm"
            onClick={() => run.mutate()}
            disabled={run.isPending || pairIds.length === 0}
          >
            <FlaskConical className="h-4 w-4" />
            {run.isPending ? "Replaying…" : "Run backtest"}
          </Button>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            History before the start date is loaded separately to warm the indicators, so the
            requested range is evaluated in full. Longer ranges page through the exchange and take
            proportionally longer.
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
      <Coverage datasets={data.datasets} assumptions={data.assumptions} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Historical result</CardTitle>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            What these rules did on this sample, under the assumptions above. Not a forecast, and
            not evidence about any period other than this one.
          </p>
        </CardHeader>

        <CardContent className="space-y-4">
          {metrics.totalSetups === 0 ? (
            <p className="text-sm text-muted-foreground">
              No setups triggered in this range. That is a result, not a failure — the engine is
              built to pass on most conditions.
            </p>
          ) : (
            <>
              {metrics.smallSample && (
                <Alert variant="warning">
                  <Info />
                  <AlertDescription className="text-[11px] leading-relaxed">
                    {metrics.closedTrades} closed {metrics.closedTrades === 1 ? "trade" : "trades"}{" "}
                    is a small sample. Win rate, expectancy and profit factor all swing heavily at
                    this size, and none of them should be read as a property of the strategy yet.
                  </AlertDescription>
                </Alert>
              )}

              <section>
                <SectionLabel>Trades</SectionLabel>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Setups" value={String(metrics.totalSetups)} testId="bt-setups" />
                  <Stat label="Closed" value={String(metrics.closedTrades)} />
                  <Stat label="Unresolved" value={String(metrics.unresolvedTrades)} />
                  <Stat label="Win rate" value={`${metrics.winRate.toFixed(0)}%`} />
                  <Stat label="Wins" value={String(metrics.wins)} />
                  <Stat label="Losses" value={String(metrics.losses)} />
                  <Stat label="Breakeven" value={String(metrics.breakeven)} />
                  <Stat
                    label="Avg hold"
                    value={
                      metrics.averageBarsHeld === null
                        ? "—"
                        : `${metrics.averageBarsHeld.toFixed(1)} bars`
                    }
                  />
                </dl>
                <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                  Win rate counts decided trades only. A trade stopped at breakeven after the first
                  target traded is not a loss. Unresolved trades were still open when the data ran
                  out and are excluded from every ratio rather than booked as losses.
                </p>
              </section>

              <Separator />

              <section>
                <SectionLabel>Return, in R</SectionLabel>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Total R" value={metrics.totalR.toFixed(2)} />
                  <Stat label="Average R" value={metrics.averageR.toFixed(3)} />
                  <Stat label="Median R" value={metrics.medianR.toFixed(3)} />
                  <Stat label="Expectancy" value={`${metrics.expectancyR.toFixed(3)} R`} />
                  <Stat label="Avg win" value={`${metrics.averageWinR.toFixed(2)} R`} />
                  <Stat label="Avg loss" value={`${metrics.averageLossR.toFixed(2)} R`} />
                  <Stat
                    label="Profit factor"
                    value={metrics.profitFactor === null ? "—" : metrics.profitFactor.toFixed(2)}
                  />
                  <Stat label="Cost of fees" value={`${metrics.costR.toFixed(2)} R`} />
                </dl>
                <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                  R is a multiple of the risk taken on each trade. The backtest does not model an
                  account or position sizing, so these are not currency returns and 1R does not
                  correspond to any particular sum.
                </p>
              </section>

              <Separator />

              <section>
                <SectionLabel>Drawdown and streaks</SectionLabel>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Max drawdown" value={`${metrics.maxDrawdownR.toFixed(2)} R`} />
                  <Stat
                    label="Deepest at"
                    value={
                      metrics.maxDrawdownAt === null
                        ? "—"
                        : new Date(metrics.maxDrawdownAt).toLocaleDateString()
                    }
                  />
                  <Stat label="Longest win streak" value={String(metrics.maxWinStreak)} />
                  <Stat label="Longest loss streak" value={String(metrics.maxLossStreak)} />
                </dl>
              </section>

              {metrics.equityCurve.length > 1 && <EquityCurve metrics={metrics} />}

              <Separator />

              <Distribution metrics={metrics} />

              {data.bySymbol.length > 1 && (
                <BreakdownTable title="By market" rows={data.bySymbol} />
              )}
              {data.byTimeframe.length > 1 && (
                <BreakdownTable title="By timeframe" rows={data.byTimeframe} />
              )}
              {data.byScoreBand.length > 1 && (
                <BreakdownTable title="By setup quality" rows={data.byScoreBand} />
              )}
              {data.byTargetKind.length > 1 && (
                <BreakdownTable title="By target kind" rows={data.byTargetKind} />
              )}

              <Trades setups={data.setups} />
            </>
          )}

          <Alert variant="muted">
            <AlertDescription>{data.disclaimer}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </>
  );
}

function Coverage({
  datasets,
  assumptions,
}: {
  datasets: Dataset[];
  assumptions: BacktestAssumptions | null;
}) {
  const incomplete = datasets.filter((d) => d.coverage.incomplete || d.failure);
  const totalRequests = datasets.reduce((sum, d) => sum + d.coverage.requests, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>What was tested</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1.5">
          {datasets.map((dataset) => (
            <li key={`${dataset.symbol}-${dataset.timeframe}`} className="text-[11px]">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{dataset.symbol}</span>
                <span className="text-muted-foreground">{TIMEFRAME_LABELS[dataset.timeframe]}</span>
                {dataset.failure ? (
                  <Badge variant="bearish" className="text-[9px]">
                    not replayed
                  </Badge>
                ) : (
                  <span className="tabular text-muted-foreground">
                    {dataset.coverage.evaluatedBars} evaluated · {dataset.coverage.warmupBars}{" "}
                    warmup · {dataset.coverage.candlesUsed} total
                  </span>
                )}
              </div>
              {dataset.coverage.actualFrom && (
                <div className="tabular text-[10px] text-muted-foreground">
                  {new Date(dataset.coverage.actualFrom).toISOString().slice(0, 10)} →{" "}
                  {dataset.coverage.actualTo
                    ? new Date(dataset.coverage.actualTo).toISOString().slice(0, 10)
                    : "—"}
                </div>
              )}
              {dataset.failure && (
                <p className="text-[10px] leading-relaxed text-bearish">{dataset.failure}</p>
              )}
              {dataset.coverage.notes.map((note) => (
                <p key={note} className="text-[10px] leading-relaxed text-muted-foreground">
                  {note}
                </p>
              ))}
            </li>
          ))}
        </ul>

        {incomplete.length > 0 && (
          <Alert variant="warning">
            <Info />
            <AlertDescription className="text-[11px] leading-relaxed">
              Some datasets are incomplete. The result still describes the data that was obtained —
              it has not been padded to look whole.
            </AlertDescription>
          </Alert>
        )}

        {assumptions && (
          <div>
            <SectionLabel>Assumptions</SectionLabel>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
              <Field label="Entry">
                {assumptions.entryPolicy === "SIGNAL_CLOSE"
                  ? "close of the signal candle"
                  : "open of the next candle"}
              </Field>
              <Field label="Same-candle SL and TP">
                {assumptions.sameCandlePolicy === "STOP_FIRST"
                  ? "stop assumed first"
                  : "target assumed first"}
              </Field>
              <Field label="Fee per side">{(assumptions.feeRate * 100).toFixed(3)}%</Field>
              <Field label="Slippage">{(assumptions.slippageRate * 100).toFixed(3)}%</Field>
              <Field label="Warmup">{assumptions.warmupBars} candles</Field>
              <Field label="Max hold">{assumptions.maxHoldBars} candles</Field>
              <Field label="Confirmation">{assumptions.confirmationEnabled ? "on" : "off"}</Field>
              <Field label="Higher timeframe">{assumptions.mtfEnabled ? "on" : "off"}</Field>
              <Field label="Provider requests">{totalRequests}</Field>
            </dl>
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
              Where one candle contained both the stop and a target, OHLC data cannot say which
              traded first. The stop is assumed to have come first, which makes results pessimistic
              rather than flattering.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Cumulative R over the closed trades, with the drawdown shaded underneath.
 *
 * Plain SVG and deliberately unglamorous: this is a research readout, and a
 * chart styled to look like a win would be arguing rather than reporting.
 */
function EquityCurve({ metrics }: { metrics: BacktestMetrics }) {
  const points = metrics.equityCurve;
  const width = 640;
  const height = 140;
  const pad = 8;

  const values = points.map((p) => p.cumulativeR);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;

  const x = (i: number) => pad + (i / Math.max(1, points.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(p.cumulativeR)}`).join(" ");
  const peak = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(p.peakR)}`).join(" ");

  return (
    <section>
      <SectionLabel>Cumulative R</SectionLabel>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Cumulative R across ${points.length} closed trades, ending at ${metrics.totalR.toFixed(2)} R`}
      >
        <line
          x1={pad}
          x2={width - pad}
          y1={y(0)}
          y2={y(0)}
          className="stroke-muted-foreground/30"
          strokeDasharray="3 3"
        />
        <path d={peak} fill="none" className="stroke-muted-foreground/30" strokeWidth="1" />
        <path d={line} fill="none" className="stroke-primary" strokeWidth="1.5" />
      </svg>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Cumulative R after each closed trade, in entry order. The faint line is the running peak;
        the gap beneath it is drawdown. Not an account balance — no position sizing is modelled.
      </p>
    </section>
  );
}

function Distribution({ metrics }: { metrics: BacktestMetrics }) {
  const max = Math.max(...metrics.rDistribution.map((b) => b.count), 1);

  return (
    <section>
      <SectionLabel>Where the results landed</SectionLabel>
      <ul className="space-y-1">
        {metrics.rDistribution.map((bucket) => (
          <li key={bucket.bucket} className="flex items-center gap-2 text-[11px]">
            <span className="w-24 shrink-0 text-muted-foreground">{bucket.bucket}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary/50"
                style={{ width: `${(bucket.count / max) * 100}%` }}
              />
            </span>
            <span className="tabular w-6 text-right text-muted-foreground">{bucket.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: Breakdown[] }) {
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
              <th className="py-1 text-right font-medium">Avg R</th>
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
                <td className="tabular py-1 text-right">{metrics.averageR.toFixed(2)}</td>
                <td className="tabular py-1 text-right">{metrics.expectancyR.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        Ordered by total R. A group at the top of this table is a group that did well in this sample
        — it is not a recommendation, and a handful of trades is not a finding.
      </p>
    </section>
  );
}

function Trades({ setups }: { setups: BacktestSetupResult[] }) {
  if (setups.length === 0) return null;

  return (
    <section>
      <SectionLabel>Trades</SectionLabel>
      <ul className="space-y-1.5">
        {setups.slice(0, 40).map((setup) => (
          <li
            key={`${setup.symbol}-${setup.triggeredAt}`}
            className="flex flex-wrap items-baseline gap-2 border-b pb-1.5 text-[11px]"
          >
            <span className="tabular text-muted-foreground">
              {new Date(setup.entryTime).toISOString().slice(0, 16).replace("T", " ")}
            </span>
            {setup.symbol && <span className="font-medium">{setup.symbol}</span>}
            <Badge variant={OUTCOME_VARIANT[setup.outcome] ?? "neutral"} className="text-[9px]">
              {setup.outcome.replace(/_/g, " ").toLowerCase()}
            </Badge>
            <span className="tabular">{formatPrice(setup.entry)}</span>
            <span className="tabular ml-auto">
              {setup.realizedRR === null ? "open" : `${setup.realizedRR.toFixed(2)} R`}
            </span>
            <span className="tabular text-muted-foreground">
              q{setup.setupScore}
              {setup.entryRiskRewardIsSynthetic && " · unmeasured"}
            </span>
          </li>
        ))}
      </ul>
      {setups.length > 40 && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          Showing the first 40 of {setups.length}.
        </p>
      )}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div data-testid={testId}>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("tabular text-sm font-semibold")}>{value}</dd>
    </div>
  );
}
