import { describe, expect, it } from "vitest";

import { CURATED_ASSETS, findCuratedAsset, toExchangeSymbol } from "./curated-assets";

// Meme coins are out of scope per the PRD; this list is a curation guard, not a
// content filter — it catches an accidental paste, not every possible ticker.
const EXCLUDED_SYMBOLS = ["DOGE", "SHIB", "PEPE", "FLOKI", "BONK", "WIF", "MEME", "TRUMP"];

describe("curated asset list", () => {
  it("holds the PRD's target range of 30-50 assets", () => {
    expect(CURATED_ASSETS.length).toBeGreaterThanOrEqual(30);
    expect(CURATED_ASSETS.length).toBeLessThanOrEqual(50);
  });

  it("has no duplicate symbols", () => {
    const symbols = CURATED_ASSETS.map((a) => a.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("excludes meme coins", () => {
    const found = CURATED_ASSETS.filter((a) => EXCLUDED_SYMBOLS.includes(a.symbol));
    expect(found).toEqual([]);
  });

  it("documents every asset well enough for the research page", () => {
    for (const asset of CURATED_ASSETS) {
      expect(asset.symbol, `${asset.symbol} symbol`).toMatch(/^[A-Z0-9]{2,10}$/);
      expect(asset.name.length, `${asset.symbol} name`).toBeGreaterThan(1);
      expect(asset.officialWebsite, `${asset.symbol} website`).toMatch(/^https:\/\//);
      expect(asset.description.length, `${asset.symbol} description`).toBeGreaterThan(40);
      expect(asset.utilityExplanation.length, `${asset.symbol} utility`).toBeGreaterThan(40);
      expect(asset.quoteCurrencies.length, `${asset.symbol} quotes`).toBeGreaterThan(0);
    }
  });

  it("builds exchange symbols from asset and quote", () => {
    expect(toExchangeSymbol("btc", "usdt")).toBe("BTCUSDT");
  });

  it("looks assets up case-insensitively", () => {
    expect(findCuratedAsset("eth")?.name).toBe("Ethereum");
    expect(findCuratedAsset("NOPE")).toBeUndefined();
  });
});
