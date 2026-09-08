/**
 * Seeds the curated asset whitelist and its USDT spot trading pairs.
 * Idempotent: safe to re-run after editing lib/market-data/curated-assets.ts.
 *
 *   npm run prisma:seed
 */
import { PrismaClient } from "@prisma/client";

import { ETHICAL_CHECKLISTS } from "../lib/ethics/checklist";
import { LEARN_ARTICLES } from "../lib/learn/articles";
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

  const bySymbol = new Map(
    (await prisma.asset.findMany({ select: { id: true, symbol: true } })).map((a) => [
      a.symbol,
      a.id,
    ]),
  );

  let checklistCount = 0;
  for (const entry of ETHICAL_CHECKLISTS) {
    const assetId = bySymbol.get(entry.symbol);
    if (!assetId) continue;

    const { symbol: _symbol, ...fields } = entry;
    await prisma.ethicalChecklist.upsert({
      where: { assetId },
      create: { assetId, ...fields },
      update: fields,
    });
    checklistCount += 1;
  }

  let articleCount = 0;
  for (const article of LEARN_ARTICLES) {
    await prisma.learnArticle.upsert({
      where: { slug: article.slug },
      create: {
        slug: article.slug,
        title: article.title,
        category: article.category,
        bodyMarkdown: article.bodyMarkdown,
        relatedConceptTags: article.conceptTags,
      },
      update: {
        title: article.title,
        category: article.category,
        bodyMarkdown: article.bodyMarkdown,
        relatedConceptTags: article.conceptTags,
      },
    });
    articleCount += 1;
  }

  console.log(
    `Seeded ${assetCount} assets, ${pairCount} trading pairs, ${checklistCount} ethical checklists and ${articleCount} learn articles.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
