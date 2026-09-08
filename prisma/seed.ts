/**
 * Seeds the curated asset whitelist and its USDT spot trading pairs.
 * Idempotent: safe to re-run after editing lib/market-data/curated-assets.ts.
 *
 *   npm run prisma:seed
 */
import { PrismaClient } from "@prisma/client";

import { CURATED_ASSETS, toExchangeSymbol } from "../lib/market-data/curated-assets";

const prisma = new PrismaClient();

async function main() {
  let assetCount = 0;
  let pairCount = 0;

  for (const asset of CURATED_ASSETS) {
    const record = await prisma.asset.upsert({
      where: { symbol: asset.symbol },
      create: {
        symbol: asset.symbol,
        name: asset.name,
        category: asset.category,
        officialWebsite: asset.officialWebsite,
        description: asset.description,
        utilityExplanation: asset.utilityExplanation,
        riskLevel: asset.riskLevel,
        isActive: true,
      },
      update: {
        name: asset.name,
        category: asset.category,
        officialWebsite: asset.officialWebsite,
        description: asset.description,
        utilityExplanation: asset.utilityExplanation,
        riskLevel: asset.riskLevel,
      },
    });
    assetCount += 1;

    for (const quote of asset.quoteCurrencies) {
      await prisma.tradingPair.upsert({
        where: { assetId_quoteCurrency: { assetId: record.id, quoteCurrency: quote } },
        create: {
          assetId: record.id,
          quoteCurrency: quote,
          exchangeSymbol: toExchangeSymbol(asset.symbol, quote),
          isActive: true,
        },
        update: { exchangeSymbol: toExchangeSymbol(asset.symbol, quote) },
      });
      pairCount += 1;
    }
  }

  console.log(`Seeded ${assetCount} assets and ${pairCount} trading pairs.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
