"use client";

import { useState } from "react";

import { formatPrice } from "@/lib/format";
import type { Candle } from "@/lib/market-data/provider";
import type { PriceZone } from "@/lib/analysis";
import { cn } from "@/lib/utils";

import { CandlestickChart, type EmaOverlay, type SetupLevel } from "./CandlestickChart";

/**
 * The chart plus the readout above it.
 *
 * Exists so the embedded chart on the analysis page and the full-page one show
 * the same numbers through the same code — the alternative is two OHLC strips
 * that round differently, which is the class of bug this whole change is
 * about.
 *
 * Every price here goes through `formatPrice`, the one formatter the axis and
 * the crosshair also use.
 */
export function ChartPanel({
  candles,
  livePrice,
  emas,
  zones,
  levels,
  height,
  className,
  actions,
}: {
  candles: Candle[];
  livePrice?: number | null;
  emas?: EmaOverlay[];
  zones?: PriceZone[];
  levels?: SetupLevel[];
  height?: number;
  className?: string;
  /** Rendered at the right of the readout row — "Open chart", and the like. */
  actions?: React.ReactNode;
}) {
  const [hovered, setHovered] = useState<Candle | null>(null);

  // The last candle when the pointer is away, so the strip is never blank and
  // never has to say "hover for values".
  const shown = hovered ?? candles.at(-1) ?? null;
  const up = shown ? shown.close >= shown.open : true;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {shown ? (
          <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]">
            <Ohlc label="O" value={shown.open} />
            <Ohlc label="H" value={shown.high} />
            <Ohlc label="L" value={shown.low} />
            <Ohlc label="C" value={shown.close} className={up ? "text-bullish" : "text-bearish"} />
          </dl>
        ) : null}

        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </div>

      <CandlestickChart
        candles={candles}
        livePrice={livePrice}
        emas={emas}
        zones={zones}
        levels={levels}
        {...(height === undefined ? {} : { height })}
        onHoverCandle={setHovered}
      />
    </div>
  );
}

function Ohlc({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("tabular m-0 font-medium", className)}>{formatPrice(value)}</dd>
    </div>
  );
}
