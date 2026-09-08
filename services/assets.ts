import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import { ETHICAL_CHECKLISTS, type EthicalChecklistSeed } from "@/lib/ethics/checklist";
import { warnOnce } from "@/lib/log";
import { CURATED_ASSETS, type CuratedAsset } from "@/lib/market-data/curated-assets";

export interface AssetDetail {
  asset: CuratedAsset;
  checklist: EthicalChecklistSeed | null;
  /** Exchange symbol of the asset's first active pair, for chart links. */
  exchangeSymbol: string | null;
}

export async function listAssets(): Promise<CuratedAsset[]> {
  if (isDatabaseConfigured) {
    try {
      const rows = await prisma.asset.findMany({
        where: { isActive: true },
        orderBy: { symbol: "asc" },
      });
      if (rows.length > 0) {
        return rows.map((row) => ({
          symbol: row.symbol,
          name: row.name,
          category: row.category,
          officialWebsite: row.officialWebsite,
          description: row.description,
          utilityExplanation: row.utilityExplanation,
          riskLevel: row.riskLevel,
          quoteCurrencies: ["USDT"],
        }));
      }
    } catch (err) {
      warnOnce("assets:db", "[assets] database unreachable — serving the curated file.", err);
    }
  }
  return CURATED_ASSETS;
}

export async function getAssetDetail(symbol: string): Promise<AssetDetail | null> {
  const upper = symbol.toUpperCase();
  const assets = await listAssets();
  const asset = assets.find((a) => a.symbol === upper);
  if (!asset) return null;

  let checklist: EthicalChecklistSeed | null = null;

  if (isDatabaseConfigured) {
    try {
      const row = await prisma.ethicalChecklist.findFirst({
        where: { asset: { symbol: upper } },
      });
      if (row) {
        checklist = {
          symbol: upper,
          whatProjectDoes: row.whatProjectDoes,
          tokenUtility: row.tokenUtility,
          involvesInterestLending: row.involvesInterestLending,
          involvesInterestLendingNote: row.involvesInterestLendingNote ?? "",
          supportsGambling: row.supportsGambling,
          supportsGamblingNote: row.supportsGamblingNote ?? "",
          supportsProhibitedIndustries: row.supportsProhibitedIndustries,
          supportsProhibitedNote: row.supportsProhibitedNote ?? "",
          hasClearUtility: row.hasClearUtility,
          hasClearUtilityNote: row.hasClearUtilityNote ?? "",
        };
      }
    } catch (err) {
      warnOnce("checklist:db", "[assets] checklist unavailable from the database.", err);
    }
  }

  checklist ??= ETHICAL_CHECKLISTS.find((c) => c.symbol === upper) ?? null;

  return {
    asset,
    checklist,
    exchangeSymbol: `${upper}${asset.quoteCurrencies[0] ?? "USDT"}`,
  };
}
