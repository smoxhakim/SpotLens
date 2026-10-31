import { describe, expect, it } from "vitest";

import {
  compareQuotes,
  compareRules,
  quoteFrom,
  rulesFrom,
  summariseGaps,
  workflowGaps,
  type RawSymbolInfo,
} from "./venue-compare";

const book = (symbol: string, bid: string, ask: string) => ({
  symbol,
  bidPrice: bid,
  askPrice: ask,
});

describe("quoteFrom", () => {
  it("reads a two-sided book: mid and spread in basis points", () => {
    const quote = quoteFrom(book("BTCUSDT", "99.95", "100.05"));
    expect(quote?.mid).toBeCloseTo(100);
    expect(quote?.spreadBps).toBeCloseTo(10);
  });

  it("is null for an empty side, a crossed book, garbage or no row", () => {
    expect(quoteFrom(book("X", "0.00000000", "1.0"))).toBeNull();
    expect(quoteFrom(book("X", "1.0", "0.00000000"))).toBeNull();
    expect(quoteFrom(book("X", "1.1", "1.0"))).toBeNull();
    expect(quoteFrom(book("X", "abc", "1.0"))).toBeNull();
    expect(quoteFrom(undefined)).toBeNull();
  });
});

describe("compareQuotes and summariseGaps", () => {
  const symbols = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT"];
  const live = [
    book("AAAUSDT", "99.99", "100.01"),
    book("BBBUSDT", "9.999", "10.001"),
    book("CCCUSDT", "1.9999", "2.0001"),
    book("DDDUSDT", "4.99", "5.01"),
    book("NOTCURATED", "1", "2"),
  ];
  const demo = [
    // +10 bps
    book("AAAUSDT", "100.09", "100.11"),
    // -30 bps
    book("BBBUSDT", "9.969", "9.971"),
    // equal
    book("CCCUSDT", "1.9999", "2.0001"),
    // DDD not quoted on Demo
  ];

  const rows = compareQuotes(symbols, live, demo);

  it("compares only the markets asked for, in their order", () => {
    expect(rows.map((r) => r.symbol)).toEqual(symbols);
  });

  it("measures Demo's mid against live's, signed, in basis points", () => {
    expect(rows[0].gapBps).toBeCloseTo(10);
    expect(rows[1].gapBps).toBeCloseTo(-30);
    expect(rows[2].gapBps).toBeCloseTo(0);
    expect(rows[3].gapBps).toBeNull();
  });

  it("summarises by absolute gap, names the largest with its sign, and lists what was missing", () => {
    const summary = summariseGaps(rows);
    expect(summary.compared).toBe(3);
    expect(summary.medianAbsGapBps).toBeCloseTo(10);
    expect(summary.largest?.symbol).toBe("BBBUSDT");
    expect(summary.largest?.gapBps).toBeCloseTo(-30);
    expect(summary.unquotedOnDemo).toEqual(["DDDUSDT"]);
    expect(summary.unquotedOnLive).toEqual([]);
  });

  it("has no median and no largest when nothing could be compared", () => {
    const summary = summariseGaps(compareQuotes(["AAAUSDT"], [], []));
    expect(summary).toMatchObject({ compared: 0, medianAbsGapBps: null, largest: null });
  });
});

const info = (overrides: Partial<RawSymbolInfo> = {}): RawSymbolInfo => ({
  symbol: "BTCUSDT",
  status: "TRADING",
  isSpotTradingAllowed: true,
  orderTypes: [
    "LIMIT",
    "LIMIT_MAKER",
    "MARKET",
    "STOP_LOSS",
    "STOP_LOSS_LIMIT",
    "TAKE_PROFIT",
    "TAKE_PROFIT_LIMIT",
  ],
  ocoAllowed: true,
  otoAllowed: true,
  filters: [
    { filterType: "PRICE_FILTER", tickSize: "0.01000000" },
    { filterType: "LOT_SIZE", stepSize: "0.00001000", minQty: "0.00001000" },
    { filterType: "NOTIONAL", minNotional: "5.00000000" },
  ],
  ...overrides,
});

describe("rulesFrom and workflowGaps", () => {
  it("reads tick, step, minimum quantity and minimum order from the filters", () => {
    expect(rulesFrom(info())).toMatchObject({
      trading: true,
      tickSize: 0.01,
      stepSize: 0.00001,
      minQty: 0.00001,
      minNotional: 5,
      ocoAllowed: true,
      otoAllowed: true,
    });
  });

  it("falls back to MIN_NOTIONAL, and reports what the venue leaves out as null", () => {
    const rules = rulesFrom(
      info({ otoAllowed: undefined, filters: [{ filterType: "MIN_NOTIONAL", minNotional: "10" }] }),
    );
    expect(rules).toMatchObject({
      minNotional: 10,
      tickSize: null,
      stepSize: null,
      otoAllowed: null,
    });
  });

  it("finds no gap when a limit buy and an OCO sell can both be placed", () => {
    expect(workflowGaps(rulesFrom(info()))).toEqual([]);
  });

  it("names every missing piece of the workflow", () => {
    expect(
      workflowGaps(
        rulesFrom(info({ status: "BREAK", orderTypes: ["LIMIT", "MARKET"], ocoAllowed: false })),
      ),
    ).toEqual([
      "not trading",
      "LIMIT_MAKER not offered",
      "STOP_LOSS_LIMIT not offered",
      "OCO not allowed",
    ]);
    expect(workflowGaps(rulesFrom(info({ isSpotTradingAllowed: false })))).toEqual(["not trading"]);
    expect(workflowGaps(null)).toEqual(["not listed"]);
  });
});

describe("compareRules", () => {
  it("reports no difference when Demo's rules match live's, whatever the order types' order", () => {
    const [row] = compareRules(
      ["BTCUSDT"],
      [info()],
      [info({ orderTypes: [...(info().orderTypes ?? [])].reverse() })],
    );
    expect(row.differences).toEqual([]);
    expect(row.demoWorkflowGaps).toEqual([]);
  });

  it("names each rule that differs, with both values", () => {
    const [row] = compareRules(
      ["BTCUSDT"],
      [info()],
      [
        info({
          ocoAllowed: false,
          filters: [
            { filterType: "PRICE_FILTER", tickSize: "0.10000000" },
            { filterType: "LOT_SIZE", stepSize: "0.00001000", minQty: "0.00001000" },
            { filterType: "NOTIONAL", minNotional: "5.00000000" },
          ],
        }),
      ],
    );
    expect(row.differences).toEqual([
      "ocoAllowed: live true, Demo false",
      "tickSize: live 0.01, Demo 0.1",
    ]);
    expect(row.demoWorkflowGaps).toEqual(["OCO not allowed"]);
  });

  it("says when a market is missing from Demo", () => {
    const [row] = compareRules(["BTCUSDT"], [info()], []);
    expect(row.differences).toEqual(["not listed on Demo"]);
    expect(row.demoWorkflowGaps).toEqual(["not listed"]);
  });
});
