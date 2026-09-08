import { BinanceProvider } from "./binance";
import type { MarketDataProvider } from "./provider";

let provider: MarketDataProvider | undefined;

/**
 * Single access point for market data. Everything downstream depends on the
 * MarketDataProvider interface, so adding a second exchange means adding a
 * branch here and nothing else.
 */
export function getMarketDataProvider(): MarketDataProvider {
  provider ??= new BinanceProvider();
  return provider;
}

/** Test seam: inject a fake provider. */
export function setMarketDataProvider(next: MarketDataProvider | undefined) {
  provider = next;
}

export * from "./provider";
export { BinanceProvider } from "./binance";
export { CURATED_ASSETS, findCuratedAsset, toExchangeSymbol } from "./curated-assets";
export type { CuratedAsset } from "./curated-assets";
