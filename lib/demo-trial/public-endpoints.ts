/**
 * The only Binance URLs the demo tooling may build.
 *
 * Public market data on two hosts — the live exchange SpotLens already reads,
 * and Demo Trading — and nothing else. Neither path takes an API key or a
 * signature, and neither can place, cancel or query an order, so the
 * comparison cannot become a trading client by accident: a new path has to be
 * added to this list on purpose, where a review will see it.
 */
export const BINANCE_HOSTS = {
  LIVE: "https://api.binance.com",
  DEMO: "https://demo-api.binance.com",
} as const;

export type BinanceVenue = keyof typeof BINANCE_HOSTS;

const PUBLIC_PATHS = ["/api/v3/ticker/bookTicker", "/api/v3/exchangeInfo"] as const;

export type PublicPath = (typeof PUBLIC_PATHS)[number];

/**
 * A public market-data URL for one venue.
 *
 * Checked at runtime as well as by type, because a cast or a plain-JS caller
 * gets past the type. It takes no parameters at all, so there is nothing to
 * carry a key, a timestamp or a signature. Every market is read and filtered
 * afterwards: a symbol list naming one market a venue does not list makes
 * Binance refuse the whole request.
 */
export function publicMarketDataUrl(venue: BinanceVenue, path: PublicPath): string {
  const host = Object.prototype.hasOwnProperty.call(BINANCE_HOSTS, venue)
    ? BINANCE_HOSTS[venue]
    : null;
  if (!host) throw new Error(`Unknown Binance venue: ${String(venue)}`);
  if (!(PUBLIC_PATHS as readonly string[]).includes(path)) {
    throw new Error(`Not a public market-data path: ${String(path)}`);
  }
  return `${host}${path}`;
}
