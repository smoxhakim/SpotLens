import { describe, expect, it } from "vitest";

import {
  BINANCE_HOSTS,
  publicMarketDataUrl,
  type BinanceVenue,
  type PublicPath,
} from "./public-endpoints";

/**
 * The demo tooling may read public market data and nothing else. These pin
 * the allow-list, so a trading path cannot be added without a test noticing.
 */
describe("publicMarketDataUrl", () => {
  it("builds the two public paths on the two known hosts, with no parameters", () => {
    expect(publicMarketDataUrl("LIVE", "/api/v3/ticker/bookTicker")).toBe(
      "https://api.binance.com/api/v3/ticker/bookTicker",
    );
    expect(publicMarketDataUrl("DEMO", "/api/v3/exchangeInfo")).toBe(
      "https://demo-api.binance.com/api/v3/exchangeInfo",
    );
  });

  it("knows exactly two hosts: the live exchange and Demo Trading", () => {
    expect(BINANCE_HOSTS).toEqual({
      LIVE: "https://api.binance.com",
      DEMO: "https://demo-api.binance.com",
    });
  });

  it("refuses any other path, including every order and account endpoint", () => {
    for (const path of [
      "/api/v3/order",
      "/api/v3/order/test",
      "/api/v3/orderList/oco",
      "/api/v3/openOrders",
      "/api/v3/account",
      "/api/v3/myTrades",
      "/sapi/v1/account/apiRestrictions",
    ]) {
      expect(() => publicMarketDataUrl("DEMO", path as PublicPath), path).toThrow(
        /Not a public market-data path/,
      );
    }
  });

  it("refuses an unknown venue, including one that names a prototype key", () => {
    for (const venue of ["TESTNET", "constructor", "toString"]) {
      expect(() => publicMarketDataUrl(venue as BinanceVenue, "/api/v3/exchangeInfo")).toThrow(
        /Unknown Binance venue/,
      );
    }
  });
});
