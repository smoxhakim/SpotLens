import { afterEach, describe, expect, it, vi } from "vitest";

import { BinanceProvider } from "./binance";

const KLINE = [
  1_700_000_000_000,
  "100.5",
  "110.0",
  "95.25",
  "105.75",
  "1234.5",
  1_700_003_599_999,
  "0",
  0,
  "0",
  "0",
  "0",
];

// A Response body can only be read once, so build a fresh one per call.
function stubFetch(body: unknown) {
  const mock = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BinanceProvider", () => {
  it("maps klines into typed candles", async () => {
    stubFetch([KLINE]);
    const candles = await new BinanceProvider("https://api.test").getCandles("BTCUSDT", "H1");

    expect(candles).toEqual([
      {
        openTime: 1_700_000_000_000,
        open: 100.5,
        high: 110,
        low: 95.25,
        close: 105.75,
        volume: 1234.5,
        closeTime: 1_700_003_599_999,
      },
    ]);
  });

  it("maps each timeframe to the exchange interval", async () => {
    const mock = stubFetch([]);
    const provider = new BinanceProvider("https://api.test");

    await provider.getCandles("BTCUSDT", "M15");
    await provider.getCandles("BTCUSDT", "H4");
    await provider.getCandles("BTCUSDT", "D1");
    await provider.getCandles("BTCUSDT", "W1");

    const intervals = mock.mock.calls.map((c) =>
      new URL(c[0] as string).searchParams.get("interval"),
    );
    expect(intervals).toEqual(["15m", "4h", "1d", "1w"]);
  });

  it("caps the requested limit at the exchange maximum", async () => {
    const mock = stubFetch([]);
    await new BinanceProvider("https://api.test").getCandles("BTCUSDT", "H1", 5000);

    expect(new URL(mock.mock.calls[0][0] as string).searchParams.get("limit")).toBe("1000");
  });

  it("passes an explicit time range through", async () => {
    const mock = stubFetch([]);
    await new BinanceProvider("https://api.test").getCandles("BTCUSDT", "H1", 10, {
      from: 1_700_000_000_000,
      to: 1_700_100_000_000,
    });

    const url = new URL(mock.mock.calls[0][0] as string);
    expect(url.searchParams.get("startTime")).toBe("1700000000000");
    expect(url.searchParams.get("endTime")).toBe("1700100000000");
  });

  it("normalises a 24h ticker", async () => {
    stubFetch({
      symbol: "BTCUSDT",
      lastPrice: "96000.00",
      priceChangePercent: "-1.25",
      highPrice: "98000.00",
      lowPrice: "95000.00",
      volume: "1200.5",
      closeTime: 1_700_003_599_999,
    });

    const ticker = await new BinanceProvider("https://api.test").getTicker("btcusdt");

    expect(ticker.price).toBe(96_000);
    expect(ticker.change24hPct).toBe(-1.25);
    expect(ticker.high24h).toBe(98_000);
  });

  it("keeps only tradable spot markets", async () => {
    stubFetch({
      symbols: [
        {
          symbol: "BTCUSDT",
          status: "TRADING",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          isSpotTradingAllowed: true,
        },
        {
          symbol: "OLDUSDT",
          status: "BREAK",
          baseAsset: "OLD",
          quoteAsset: "USDT",
          isSpotTradingAllowed: true,
        },
        {
          symbol: "NOSPOT",
          status: "TRADING",
          baseAsset: "NO",
          quoteAsset: "USDT",
          isSpotTradingAllowed: false,
        },
      ],
    });

    const markets = await new BinanceProvider("https://api.test").getMarkets();
    expect(markets.map((m) => m.symbol)).toEqual(["BTCUSDT"]);
  });

  it("rejects a non-numeric price rather than returning NaN", async () => {
    stubFetch([[1, "oops", "1", "1", "1", "1", 2]]);
    await expect(
      new BinanceProvider("https://api.test").getCandles("BTCUSDT", "H1"),
    ).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("sums volume across the lookback window", async () => {
    stubFetch([
      [1, "1", "1", "1", "1", "10", 2],
      [2, "1", "1", "1", "1", "15", 3],
    ]);
    await expect(
      new BinanceProvider("https://api.test").getVolume("BTCUSDT", "H1", 2),
    ).resolves.toBe(25);
  });
});
