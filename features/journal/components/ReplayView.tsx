"use client";

import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import { formatPrice } from "@/lib/format";
import { TIMEFRAME_LABELS, TIMEFRAME_MS, type Timeframe } from "@/lib/market-data/provider";
import type { Candle } from "@/lib/market-data/provider";

interface ReplayFrame {
  setupId: string;
  symbol: string;
  timeframe: Timeframe;
  at: number;
  candles: Candle[];
  coverage: {
    available: number;
    expected: number;
    from: number | null;
    to: number | null;
    incomplete: boolean;
    note: string | null;
  };
  markers: { at: number; label: string; kind: string }[];
  snapshot: {
    source: string;
    entryLow: number;
    entryHigh: number;
    stopLoss: number;
    takeProfit1: number | null;
    takeProfit2: number | null;
    riskReward: number;
    riskRewardIsSynthetic: boolean;
    score: number;
    scoreGrade: string;
    analysisStatus: string;
  };
  events: { id: string; toStatus: string; detail: string; createdAt: string }[];
  decision: { decision: string; decidedAt: string; notes: string | null } | null;
}

/**
 * Replays a setup as it looked at a moment.
 *
 * The time control moves the cutoff and re-requests the frame; it never filters
 * a fuller dataset already in the browser, because a dataset that contains the
 * future is one bug away from showing it.
 */
export function ReplayView({ setupId }: { setupId: string }) {
  const [at, setAt] = useState<number | null>(null);

  const query = useQuery<{ frame: ReplayFrame }>({
    queryKey: ["replay", setupId, at],
    queryFn: () => fetchApi(`/api/replay/${setupId}${at === null ? "" : `?at=${at}`}`),
  });

  if (query.isPending) return <Skeleton className="h-96 w-full" />;

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{(query.error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const frame = query.data!.frame;
  const step = TIMEFRAME_MS[frame.timeframe];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-baseline gap-2 text-sm">
            <span>{frame.symbol}</span>
            <span className="text-muted-foreground">{TIMEFRAME_LABELS[frame.timeframe]}</span>
            <Badge variant="outline" className="text-[9px]">
              historical snapshot
            </Badge>
            <span className="tabular ml-auto text-[10px] text-muted-foreground">
              as at {new Date(frame.at).toLocaleString()}
            </span>
          </CardTitle>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Only candles that had closed by this moment, only lifecycle events that had already
            happened, and the numbers SpotLens recorded at the time — not recalculated with
            today&apos;s data.
          </p>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              onClick={() => setAt(frame.at - step)}
            >
              ← candle
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              onClick={() => setAt(frame.at + step)}
            >
              candle →
            </Button>
            {frame.markers.map((marker) => (
              <Button
                key={`${marker.kind}-${marker.at}`}
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => setAt(marker.at)}
              >
                {marker.label}
              </Button>
            ))}
            {at !== null && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => setAt(null)}
              >
                reset
              </Button>
            )}
          </div>

          <Chart frame={frame} />

          {frame.coverage.note && (
            <Alert variant="warning">
              <Info />
              <AlertDescription className="text-[11px] leading-relaxed">
                {frame.coverage.note}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">What SpotLens said</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-[11px] sm:grid-cols-4">
            <Field label="Entry zone">
              {formatPrice(frame.snapshot.entryLow)} – {formatPrice(frame.snapshot.entryHigh)}
            </Field>
            <Field label="Stop">{formatPrice(frame.snapshot.stopLoss)}</Field>
            <Field label="Targets">
              {frame.snapshot.takeProfit1 === null ? "—" : formatPrice(frame.snapshot.takeProfit1)}
              {frame.snapshot.takeProfit2 !== null &&
                ` · ${formatPrice(frame.snapshot.takeProfit2)}`}
            </Field>
            <Field label="R:R">
              1:{frame.snapshot.riskReward.toFixed(2)}
              {frame.snapshot.riskRewardIsSynthetic && " (unmeasured)"}
            </Field>
            <Field label="Quality">{frame.snapshot.score}/100</Field>
            <Field label="Verdict">
              {frame.snapshot.analysisStatus.toLowerCase().replace(/_/g, " ")}
            </Field>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Known by this point</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {frame.events.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Nothing had happened to this setup yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {frame.events.map((event) => (
                <li key={event.id} className="text-[11px] leading-relaxed">
                  <span className="tabular text-muted-foreground">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>{" "}
                  — {event.toStatus.toLowerCase().replace(/_/g, " ")}
                </li>
              ))}
            </ul>
          )}

          {frame.decision && (
            <p className="text-[11px] leading-relaxed">
              <span className="font-medium">Your decision:</span>{" "}
              {frame.decision.decision.toLowerCase()}
              {frame.decision.notes ? ` — ${frame.decision.notes}` : ""}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * A plain candlestick rendering of exactly the candles the server returned.
 *
 * Deliberately simple SVG rather than the full chart component: the point is
 * to show the shape of the market at that moment, and anything that fetched
 * its own data could reintroduce the future the API just excluded.
 */
function Chart({ frame }: { frame: ReplayFrame }) {
  const candles = frame.candles;

  if (candles.length === 0) {
    return (
      <p className="py-8 text-center text-[11px] text-muted-foreground">
        No stored candles before this point.
      </p>
    );
  }

  const width = 720;
  const height = 220;
  const pad = 6;

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const levels = [frame.snapshot.entryLow, frame.snapshot.entryHigh, frame.snapshot.stopLoss];

  const max = Math.max(...highs, ...levels);
  const min = Math.min(...lows, ...levels);
  const span = max - min || 1;

  const x = (i: number) => pad + (i / Math.max(1, candles.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const barWidth = Math.max(1, (width - pad * 2) / candles.length / 1.6);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label={`${frame.symbol} ${frame.timeframe}, ${candles.length} candles up to ${new Date(frame.at).toISOString()}`}
    >
      <rect
        x={pad}
        y={y(frame.snapshot.entryHigh)}
        width={width - pad * 2}
        height={Math.max(1, y(frame.snapshot.entryLow) - y(frame.snapshot.entryHigh))}
        className="fill-primary/10"
      />
      <line
        x1={pad}
        x2={width - pad}
        y1={y(frame.snapshot.stopLoss)}
        y2={y(frame.snapshot.stopLoss)}
        className="stroke-bearish/60"
        strokeDasharray="4 3"
      />
      {candles.map((candle, i) => {
        const up = candle.close >= candle.open;
        const top = y(Math.max(candle.open, candle.close));
        const bottom = y(Math.min(candle.open, candle.close));
        return (
          <g
            key={candle.openTime}
            className={up ? "fill-bullish stroke-bullish" : "fill-bearish stroke-bearish"}
          >
            <line x1={x(i)} x2={x(i)} y1={y(candle.high)} y2={y(candle.low)} strokeWidth="1" />
            <rect
              x={x(i) - barWidth / 2}
              y={top}
              width={barWidth}
              height={Math.max(1, bottom - top)}
            />
          </g>
        );
      })}
    </svg>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular font-medium">{children}</dd>
    </div>
  );
}
