/**
 * Demo Trading against the live exchange: the same markets, read from both.
 *
 * Pure. Binance describes Demo's prices and order books as *similar to* the
 * live exchange, not the same — and SpotLens's levels come from live candles
 * while a Demo fill comes from Demo's own book. This measures that one
 * difference, and checks that every market SpotLens covers can carry the
 * manual workflow on Demo. It judges nothing about any setup.
 */

/** `/api/v3/ticker/bookTicker`, one market. Prices arrive as strings. */
export interface RawBookTicker {
  symbol: string;
  bidPrice: string;
  askPrice: string;
}

export interface Quote {
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
}

export interface QuoteComparison {
  symbol: string;
  live: Quote | null;
  demo: Quote | null;
  /** Demo's mid against live's, in basis points. Null when either side has no quote. */
  gapBps: number | null;
}

/**
 * A usable two-sided quote, or null.
 *
 * An empty side reads as "0", and a crossed book has no meaningful middle —
 * neither is a price, so neither is compared.
 */
export function quoteFrom(raw: RawBookTicker | undefined): Quote | null {
  if (!raw) return null;
  const bid = Number(raw.bidPrice);
  const ask = Number(raw.askPrice);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    return null;
  }
  const mid = (bid + ask) / 2;
  return { bid, ask, mid, spreadBps: ((ask - bid) / mid) * 10_000 };
}

export function compareQuotes(
  symbols: readonly string[],
  live: readonly RawBookTicker[],
  demo: readonly RawBookTicker[],
): QuoteComparison[] {
  const liveBy = new Map(live.map((row) => [row.symbol, row]));
  const demoBy = new Map(demo.map((row) => [row.symbol, row]));

  return symbols.map((symbol) => {
    const liveQuote = quoteFrom(liveBy.get(symbol));
    const demoQuote = quoteFrom(demoBy.get(symbol));
    const gapBps =
      liveQuote && demoQuote ? ((demoQuote.mid - liveQuote.mid) / liveQuote.mid) * 10_000 : null;
    return { symbol, live: liveQuote, demo: demoQuote, gapBps };
  });
}

export interface GapSummary {
  compared: number;
  unquotedOnDemo: string[];
  unquotedOnLive: string[];
  medianAbsGapBps: number | null;
  largest: { symbol: string; gapBps: number } | null;
}

export function summariseGaps(rows: readonly QuoteComparison[]): GapSummary {
  const measured = rows.filter(
    (row): row is QuoteComparison & { gapBps: number } => row.gapBps !== null,
  );
  let largest: GapSummary["largest"] = null;
  for (const row of measured) {
    if (!largest || Math.abs(row.gapBps) > Math.abs(largest.gapBps)) {
      largest = { symbol: row.symbol, gapBps: row.gapBps };
    }
  }

  return {
    compared: measured.length,
    unquotedOnDemo: rows.filter((row) => row.demo === null).map((row) => row.symbol),
    unquotedOnLive: rows.filter((row) => row.live === null).map((row) => row.symbol),
    medianAbsGapBps: median(measured.map((row) => Math.abs(row.gapBps))),
    largest,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// --- trading rules -----------------------------------------------------------

interface RawFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  minNotional?: string;
}

/** `/api/v3/exchangeInfo`, one entry of `symbols`. */
export interface RawSymbolInfo {
  symbol: string;
  status: string;
  isSpotTradingAllowed?: boolean;
  orderTypes?: string[];
  ocoAllowed?: boolean;
  otoAllowed?: boolean;
  filters?: RawFilter[];
}

/** What a manual order on one market has to respect. */
export interface MarketRules {
  symbol: string;
  trading: boolean;
  orderTypes: string[];
  ocoAllowed: boolean;
  /** Null when the venue does not report it. */
  otoAllowed: boolean | null;
  tickSize: number | null;
  stepSize: number | null;
  minQty: number | null;
  minNotional: number | null;
}

/**
 * What the manual workflow places: a limit buy in the entry zone, then an OCO
 * sell — a limit-maker take-profit paired with a stop-limit stop.
 */
export const WORKFLOW_ORDER_TYPES = ["LIMIT", "LIMIT_MAKER", "STOP_LOSS_LIMIT"] as const;

export function rulesFrom(raw: RawSymbolInfo): MarketRules {
  const filter = (type: string) => raw.filters?.find((f) => f.filterType === type);
  const num = (value: string | undefined) => {
    const n = Number(value);
    return value === undefined || !Number.isFinite(n) ? null : n;
  };

  return {
    symbol: raw.symbol,
    trading: raw.status === "TRADING" && raw.isSpotTradingAllowed !== false,
    orderTypes: [...(raw.orderTypes ?? [])].sort(),
    ocoAllowed: raw.ocoAllowed === true,
    otoAllowed: typeof raw.otoAllowed === "boolean" ? raw.otoAllowed : null,
    tickSize: num(filter("PRICE_FILTER")?.tickSize),
    stepSize: num(filter("LOT_SIZE")?.stepSize),
    minQty: num(filter("LOT_SIZE")?.minQty),
    // NOTIONAL replaced MIN_NOTIONAL; read whichever the venue still sends.
    minNotional: num((filter("NOTIONAL") ?? filter("MIN_NOTIONAL"))?.minNotional),
  };
}

/** Why the manual workflow cannot run on this market, or an empty list when it can. */
export function workflowGaps(rules: MarketRules | null): string[] {
  if (!rules) return ["not listed"];
  const gaps: string[] = [];
  if (!rules.trading) gaps.push("not trading");
  for (const type of WORKFLOW_ORDER_TYPES) {
    if (!rules.orderTypes.includes(type)) gaps.push(`${type} not offered`);
  }
  if (!rules.ocoAllowed) gaps.push("OCO not allowed");
  return gaps;
}

export interface RuleComparison {
  symbol: string;
  live: MarketRules | null;
  demo: MarketRules | null;
  /** Where Demo's rules differ from live's. Binance says they should not. */
  differences: string[];
  /** What stops the manual workflow on Demo. */
  demoWorkflowGaps: string[];
}

export function compareRules(
  symbols: readonly string[],
  live: readonly RawSymbolInfo[],
  demo: readonly RawSymbolInfo[],
): RuleComparison[] {
  const liveBy = new Map(live.map((row) => [row.symbol, rulesFrom(row)]));
  const demoBy = new Map(demo.map((row) => [row.symbol, rulesFrom(row)]));

  return symbols.map((symbol) => {
    const liveRules = liveBy.get(symbol) ?? null;
    const demoRules = demoBy.get(symbol) ?? null;
    return {
      symbol,
      live: liveRules,
      demo: demoRules,
      differences: differencesBetween(liveRules, demoRules),
      demoWorkflowGaps: workflowGaps(demoRules),
    };
  });
}

function differencesBetween(live: MarketRules | null, demo: MarketRules | null): string[] {
  if (!live && !demo) return ["listed on neither"];
  if (!demo) return ["not listed on Demo"];
  if (!live) return ["not listed on live"];

  const differences: string[] = [];
  const fields = [
    "trading",
    "ocoAllowed",
    "otoAllowed",
    "tickSize",
    "stepSize",
    "minQty",
    "minNotional",
  ] as const;
  for (const field of fields) {
    if (live[field] !== demo[field]) {
      differences.push(`${field}: live ${String(live[field])}, Demo ${String(demo[field])}`);
    }
  }
  if (live.orderTypes.join(",") !== demo.orderTypes.join(",")) {
    differences.push(
      `orderTypes: live ${live.orderTypes.join("/")}, Demo ${demo.orderTypes.join("/")}`,
    );
  }
  return differences;
}
