/**
 * How many decimals a price of this magnitude is worth showing.
 *
 * One table, because precision is the kind of decision that goes wrong by
 * being made twice. A four-decimal market rendered to two decimals in one
 * place and four in another is not a styling difference — it is the same
 * price appearing to be two different prices, and the chart axis disagreeing
 * with the entry under it is exactly how that gets noticed too late.
 *
 * The buckets are magnitude-driven rather than per-asset because the engine
 * has no notion of tick size: a level is a float derived from candles, and the
 * useful precision follows the order of magnitude of the number itself.
 */
export function priceDecimals(value: number): number {
  const abs = Math.abs(value);
  return abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
}

/**
 * The smallest increment a price of this magnitude is quoted in.
 *
 * Charting libraries want this rather than a decimal count: it is what decides
 * where the axis puts its ticks. Derived from `priceDecimals` so the axis can
 * never tick more finely than the label can render, which is what produces two
 * adjacent gridlines carrying the same number.
 */
export function priceMinMove(value: number): number {
  return Number((10 ** -priceDecimals(value)).toFixed(8));
}

/**
 * Price formatting that adapts to the asset's order of magnitude.
 *
 * The single source of truth for how a price reads anywhere in the product —
 * panels, Telegram messages, the chart axis, the crosshair and every level
 * drawn on it. `toLocaleString` rather than `toFixed` so large numbers get
 * thousands separators, and so nothing can ever come out in scientific
 * notation: `(0.0000004).toFixed(8)` is fine but `String(0.0000004)` is
 * "4e-7", and a price axis reading 4e-7 is a price axis nobody can use.
 *
 * Deliberately never abbreviates. "75.9K" is a fine way to write a volume and
 * a useless way to write a price you are about to place an order at.
 */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const decimals = priceDecimals(value);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(
    value,
  );
}
