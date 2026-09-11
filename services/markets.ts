import { memoizeAsync } from "@/lib/cache";
import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import { warnOnce } from "@/lib/log";
import { CURATED_ASSETS, toExchangeSymbol } from "@/lib/market-data/curated-assets";
import { deterministicPairId } from "@/lib/market-data/pair-id";
import type { MarketSummary } from "@/types/market";

/**
 * The curated market universe.
 *
 * Reads from Postgres when it is configured (admin-editable from Phase 6); with
 * no database it falls back to the same curated file the seed script uses, so
 * the app is usable before any infrastructure exists.
 */
/**
 * The list changes only when the seed is re-run, but sits on the hot path of
 * every candle, ticker and analysis request — each of which was querying all
 * 45 pairs to resolve a single id.
 */
const MARKETS_TTL_MS = 60_000;

const loadMarkets = memoizeAsync(async (): Promise<MarketSummary[]> => {
  if (isDatabaseConfigured) {
    try {
      return await listMarketsFromDb();
    } catch (err) {
      warnOnce(
        "markets:db-unavailable",
        "[markets] database unreachable — serving the curated asset file instead.",
        err,
      );
    }
  }
  return listMarketsFromFile();
}, MARKETS_TTL_MS);

export async function listMarkets(): Promise<MarketSummary[]> {
  return loadMarkets();
}

export async function findMarketByPairId(pairId: string): Promise<MarketSummary | undefined> {
  const markets = await listMarkets();
  return markets.find((m) => m.pairId === pairId);
}

async function listMarketsFromDb(): Promise<MarketSummary[]> {
  const pairs = await prisma.tradingPair.findMany({
    where: { isActive: true, asset: { isActive: true } },
    include: { asset: true },
    orderBy: [{ asset: { symbol: "asc" } }],
  });

  return pairs.map((pair) => ({
    pairId: pair.id,
    exchangeSymbol: pair.exchangeSymbol,
    quoteCurrency: pair.quoteCurrency,
    label: `${pair.asset.symbol}/${pair.quoteCurrency}`,
    asset: {
      symbol: pair.asset.symbol,
      name: pair.asset.name,
      category: pair.asset.category,
      riskLevel: pair.asset.riskLevel,
      officialWebsite: pair.asset.officialWebsite,
      description: pair.asset.description,
      utilityExplanation: pair.asset.utilityExplanation,
    },
  }));
}

function listMarketsFromFile(): MarketSummary[] {
  return CURATED_ASSETS.flatMap((asset) =>
    asset.quoteCurrencies.map((quote) => {
      const exchangeSymbol = toExchangeSymbol(asset.symbol, quote);
      return {
        pairId: deterministicPairId(exchangeSymbol),
        exchangeSymbol,
        quoteCurrency: quote,
        label: `${asset.symbol}/${quote}`,
        asset: {
          symbol: asset.symbol,
          name: asset.name,
          category: asset.category,
          riskLevel: asset.riskLevel,
          officialWebsite: asset.officialWebsite,
          description: asset.description,
          utilityExplanation: asset.utilityExplanation,
        },
      };
    }),
  ).sort((a, b) => a.asset.symbol.localeCompare(b.asset.symbol));
}
