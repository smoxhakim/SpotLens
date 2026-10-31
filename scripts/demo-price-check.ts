/**
 * Binance Demo Trading against the live exchange, from public market data.
 *
 *   npm run demo:prices
 *
 * Reads the best bid and ask, and the trading rules, for every curated market
 * on both hosts. Prints how far Demo's prices sit from live — SpotLens's levels
 * come from live candles, a Demo fill from Demo's own book — and whether each
 * market can carry the manual workflow on Demo, with the tick size, step size
 * and minimum order a hand-placed order has to respect.
 *
 * Public endpoints only: no API key, no signature, no order path. Every URL
 * comes from `publicMarketDataUrl`, which builds nothing else. Loads no `.env`
 * and touches no database — there is nothing in either it needs.
 */
import {
  compareQuotes,
  compareRules,
  publicMarketDataUrl,
  summariseGaps,
  type BinanceVenue,
  type PublicPath,
  type RawBookTicker,
  type RawSymbolInfo,
} from "@/lib/demo-trial";
import { formatPrice } from "@/lib/format";
import { CURATED_ASSETS, toExchangeSymbol } from "@/lib/market-data/curated-assets";
import { fetchJson } from "@/lib/market-data/http";

async function read<T>(venue: BinanceVenue, path: PublicPath) {
  const data = await fetchJson<T>(publicMarketDataUrl(venue, path), { timeoutMs: 20_000 });
  return { data, receivedAt: Date.now() };
}

async function main() {
  const symbols = CURATED_ASSETS.flatMap((asset) =>
    asset.quoteCurrencies.map((quote) => toExchangeSymbol(asset.symbol, quote)),
  );

  // The two books together, so they are read as close to one moment as possible.
  const [liveBook, demoBook] = await Promise.all([
    read<RawBookTicker[]>("LIVE", "/api/v3/ticker/bookTicker"),
    read<RawBookTicker[]>("DEMO", "/api/v3/ticker/bookTicker"),
  ]);
  const [liveInfo, demoInfo] = await Promise.all([
    read<{ symbols: RawSymbolInfo[] }>("LIVE", "/api/v3/exchangeInfo"),
    read<{ symbols: RawSymbolInfo[] }>("DEMO", "/api/v3/exchangeInfo"),
  ]);

  const quotes = compareQuotes(symbols, liveBook.data, demoBook.data);
  const summary = summariseGaps(quotes);
  const rules = compareRules(symbols, liveInfo.data.symbols, demoInfo.data.symbols);

  const out: string[] = [];
  out.push(
    "Binance Demo against live — public market data only (no API key, no orders)",
    `Quotes received: live ${iso(liveBook.receivedAt)}, Demo ${iso(demoBook.receivedAt)} ` +
      `(${Math.abs(demoBook.receivedAt - liveBook.receivedAt)} ms apart)`,
    "",
    "Prices — middle of the best bid and ask",
    table(
      ["MARKET", "LIVE MID", "DEMO MID", "GAP bps", "LIVE SPREAD bps", "DEMO SPREAD bps"],
      quotes.map((q) => [
        q.symbol,
        formatPrice(q.live?.mid),
        formatPrice(q.demo?.mid),
        q.gapBps === null ? "—" : signed(q.gapBps, 1),
        q.live ? q.live.spreadBps.toFixed(1) : "—",
        q.demo ? q.demo.spreadBps.toFixed(1) : "—",
      ]),
    ),
    "",
    `Compared ${summary.compared} of ${symbols.length} · median |gap| ` +
      `${summary.medianAbsGapBps === null ? "—" : summary.medianAbsGapBps.toFixed(1)} bps · largest ` +
      `${summary.largest ? `${signed(summary.largest.gapBps, 1)} bps (${summary.largest.symbol})` : "—"}`,
    `No two-sided quote on Demo: ${list(summary.unquotedOnDemo)} · on live: ${list(summary.unquotedOnLive)}`,
    "",
    "Trading rules on Demo — what a hand-placed order has to respect",
    table(
      ["MARKET", "TICK", "STEP", "MIN QTY", "MIN ORDER USDT", "OCO", "OTO", "WORKFLOW"],
      rules.map((r) => [
        r.symbol,
        plain(r.demo?.tickSize),
        plain(r.demo?.stepSize),
        plain(r.demo?.minQty),
        plain(r.demo?.minNotional),
        r.demo ? yesNo(r.demo.ocoAllowed) : "—",
        r.demo?.otoAllowed == null ? "—" : yesNo(r.demo.otoAllowed),
        r.demoWorkflowGaps.length === 0 ? "ok" : r.demoWorkflowGaps.join("; "),
      ]),
    ),
    "",
  );

  const differing = rules.filter((r) => r.differences.length > 0);
  out.push(
    differing.length === 0
      ? "Rules differing from live: none"
      : [
          "Rules differing from live:",
          ...differing.map((r) => `  ${r.symbol}: ${r.differences.join("; ")}`),
        ].join("\n"),
  );
  const blocked = rules.filter((r) => r.demoWorkflowGaps.length > 0);
  out.push(
    `Markets where the manual workflow (limit buy, then an OCO sell) cannot run on Demo: ` +
      list(blocked.map((r) => r.symbol)),
  );

  console.log(out.join("\n"));
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

/** A rule value as Binance writes it, never in exponent form. */
function plain(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function list(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

main().catch((err: unknown) => {
  console.error(`Price check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
