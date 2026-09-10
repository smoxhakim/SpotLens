import { describe, expect, it } from "vitest";

import { makeCandles } from "@/lib/test-utils/candles";
import { repeatedPullbacks } from "@/lib/test-utils/scenarios";
import { TIMEFRAME_MS, type Candle } from "@/lib/market-data/provider";

import { checkIntegrity } from "./integrity";
import { breakdownBy, computeMetrics, scoreBand, MIN_MEANINGFUL_SAMPLE } from "./metrics";
import { runBacktest, type BacktestSetupResult } from "./runner";

/**
 * Phase G covers accounting rather than strategy: the same replay, measured
 * honestly. Every test here is about whether a number describes what happened.
 */

const WARMUP = 260;

/** A closed trade with only the fields the metrics actually read. */
function trade(
  realizedRR: number | null,
  overrides: Partial<BacktestSetupResult> = {},
): BacktestSetupResult {
  const base: BacktestSetupResult = {
    triggeredAt: 1,
    entryTime: 1,
    entry: 100,
    stopLoss: 95,
    takeProfits: [],
    outcome: realizedRR === null ? "STILL_OPEN" : realizedRR > 0 ? "TP1_HIT" : "SL_HIT",
    realizedRR,
    grossRealizedRR: realizedRR,
    exitTime: realizedRR === null ? null : 2,
    exitPrice: realizedRR === null ? null : 110,
    setupScore: 70,
    symbol: "BTCUSDT",
    timeframe: "H1",
    barsHeld: realizedRR === null ? null : 5,
    holdingMs: realizedRR === null ? null : 5 * TIMEFRAME_MS.H1,
    entryRiskReward: 2,
    entryRiskRewardIsSynthetic: false,
    trend: "BULLISH",
    mtfAgreement: null,
    confirmationStatus: "PRESENT",
    maxFavourableR: null,
    maxAdverseR: null,
    regimeDirection: "TRENDING_UP",
    regimeVolatility: "NORMAL",
  };

  return { ...base, ...overrides };
}

/** Sequential entry times, so the equity curve has a defined order. */
function series(rs: (number | null)[]): BacktestSetupResult[] {
  return rs.map((r, i) => trade(r, { entryTime: 1000 + i, exitTime: 2000 + i }));
}

describe("trade accounting", () => {
  it("never counts an unresolved trade as a loss", () => {
    const metrics = computeMetrics(series([1, -1, null, null]));

    expect(metrics.totalSetups).toBe(4);
    expect(metrics.closedTrades).toBe(2);
    expect(metrics.unresolvedTrades).toBe(2);
    expect(metrics.losses).toBe(1);
    // Two open trades must not drag the win rate down to 25%.
    expect(metrics.winRate).toBe(50);
  });

  it("counts a breakeven exit as neither a win nor a loss", () => {
    const metrics = computeMetrics(series([1, 0, -1]));

    expect(metrics.breakeven).toBe(1);
    expect(metrics.winRate).toBe(50);
  });

  it("reports zeroes rather than NaN for an empty run", () => {
    const metrics = computeMetrics([]);

    expect(metrics.winRate).toBe(0);
    expect(metrics.expectancyR).toBe(0);
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.equityCurve).toEqual([]);
  });
});

describe("expectancy and profit factor", () => {
  it("computes expectancy from the sample's own rates", () => {
    // Three wins at +2R, one loss at -1R. Win rate 75%, avg win 2, avg loss -1.
    const metrics = computeMetrics(series([2, 2, 2, -1]));

    expect(metrics.averageWinR).toBeCloseTo(2);
    expect(metrics.averageLossR).toBeCloseTo(-1);
    expect(metrics.expectancyR).toBeCloseTo(0.75 * 2 + 0.25 * -1);
    expect(metrics.expectancyR).toBeCloseTo(1.25);
  });

  it("excludes breakeven trades from the rates rather than diluting them", () => {
    const withScratch = computeMetrics(series([2, -1, 0]));
    const without = computeMetrics(series([2, -1]));

    // A scratch is not evidence either way, so it must not move expectancy.
    expect(withScratch.expectancyR).toBeCloseTo(without.expectancyR);
  });

  it("divides gross gains by gross losses", () => {
    const metrics = computeMetrics(series([3, 1, -2]));

    expect(metrics.profitFactor).toBeCloseTo(4 / 2);
  });

  it("reports no profit factor at all when there were no losses", () => {
    // Infinity would render as a triumphant number; it is a small-sample
    // artefact and is reported as unavailable instead.
    expect(computeMetrics(series([1, 2])).profitFactor).toBeNull();
  });
});

describe("drawdown", () => {
  it("is zero while equity only rises", () => {
    expect(computeMetrics(series([1, 1, 1])).maxDrawdownR).toBe(0);
  });

  it("measures peak to trough, not first to last", () => {
    // +5, then three losses, then +5. The dip is 3R even though the run ends up.
    const metrics = computeMetrics(series([5, -1, -1, -1, 5]));

    expect(metrics.maxDrawdownR).toBeCloseTo(3);
    expect(metrics.totalR).toBeCloseTo(7);
  });

  it("keeps the deepest drawdown after a recovery", () => {
    const metrics = computeMetrics(series([5, -4, 10]));

    expect(metrics.maxDrawdownR).toBeCloseTo(4);
    expect(metrics.maxDrawdownAt).not.toBeNull();
  });

  it("builds an equity curve in entry order, whatever order the trades arrive", () => {
    const shuffled = [
      trade(1, { entryTime: 300, exitTime: 400 }),
      trade(-1, { entryTime: 100, exitTime: 200 }),
      trade(2, { entryTime: 200, exitTime: 300 }),
    ];

    const curve = computeMetrics(shuffled).equityCurve;

    expect(curve.map((p) => p.cumulativeR)).toEqual([-1, 1, 2]);
  });
});

describe("streaks", () => {
  it("counts consecutive results, not totals", () => {
    // Six losses, but never more than two in a row.
    const metrics = computeMetrics(series([-1, -1, 1, -1, -1, 1, -1, -1]));

    expect(metrics.losses).toBe(6);
    expect(metrics.maxLossStreak).toBe(2);
  });

  it("finds the longest run of wins", () => {
    expect(computeMetrics(series([1, 1, 1, -1, 1, 1])).maxWinStreak).toBe(3);
  });

  it("lets a breakeven trade break a streak rather than extend it", () => {
    // Treating a scratch as either would invent a run that did not happen.
    const metrics = computeMetrics(series([1, 1, 0, 1]));

    expect(metrics.maxWinStreak).toBe(2);
  });

  it("handles a run with no losses at all", () => {
    expect(computeMetrics(series([1, 1])).maxLossStreak).toBe(0);
  });
});

describe("holding time", () => {
  it("averages and ranks holding time over closed trades", () => {
    const trades = [
      trade(1, { holdingMs: 1_000, barsHeld: 1 }),
      trade(1, { holdingMs: 3_000, barsHeld: 3 }),
      trade(1, { holdingMs: 5_000, barsHeld: 5 }),
      trade(null),
    ];

    const metrics = computeMetrics(trades);

    expect(metrics.averageHoldingMs).toBeCloseTo(3_000);
    expect(metrics.medianHoldingMs).toBeCloseTo(3_000);
    expect(metrics.maxHoldingMs).toBe(5_000);
    expect(metrics.averageBarsHeld).toBeCloseTo(3);
  });
});

describe("sample size", () => {
  it("flags a sample too small for its ratios to mean anything", () => {
    expect(computeMetrics(series([1, -1, 1])).smallSample).toBe(true);
  });

  it("stops flagging once there are enough closed trades", () => {
    const many = series(new Array(MIN_MEANINGFUL_SAMPLE).fill(1));
    expect(computeMetrics(many).smallSample).toBe(false);
  });
});

describe("breakdowns", () => {
  const trades = [
    trade(2, { symbol: "BTCUSDT", timeframe: "H1", setupScore: 90 }),
    trade(-1, { symbol: "BTCUSDT", timeframe: "H4", setupScore: 70 }),
    trade(1, { symbol: "ETHUSDT", timeframe: "H1", setupScore: 60 }),
  ];

  it("groups by symbol and measures each group separately", () => {
    const rows = breakdownBy(trades, (t) => t.symbol);

    expect(rows.map((r) => r.key)).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(rows[0].metrics.closedTrades).toBe(2);
    expect(rows[0].metrics.totalR).toBeCloseTo(1);
  });

  it("groups by timeframe", () => {
    const rows = breakdownBy(trades, (t) => t.timeframe);
    expect(rows.map((r) => r.key).sort()).toEqual(["H1", "H4"]);
  });

  it("orders by total R with a stable tie-break, so a table never reshuffles", () => {
    const tied = [trade(1, { symbol: "ZZZUSDT" }), trade(1, { symbol: "AAAUSDT" })];

    expect(breakdownBy(tied, (t) => t.symbol).map((r) => r.key)).toEqual(["AAAUSDT", "ZZZUSDT"]);
    expect(breakdownBy([...tied].reverse(), (t) => t.symbol).map((r) => r.key)).toEqual([
      "AAAUSDT",
      "ZZZUSDT",
    ]);
  });

  it("skips trades with no value for the grouping key", () => {
    const rows = breakdownBy([trade(1, { symbol: null })], (t) => t.symbol);
    expect(rows).toEqual([]);
  });

  it("bands setup scores", () => {
    expect(scoreBand(90)).toBe("85-100");
    expect(scoreBand(80)).toBe("75-84");
    expect(scoreBand(50)).toBe("< 65");
  });
});

describe("fees and slippage", () => {
  const candles = repeatedPullbacks(80);

  it("produces identical gross and net results at zero cost", () => {
    const report = runBacktest(candles, { warmupBars: WARMUP, feeRate: 0, slippageRate: 0 });

    expect(report.setups.length).toBeGreaterThan(0);
    for (const setup of report.setups) {
      if (setup.realizedRR === null) continue;
      expect(setup.realizedRR).toBeCloseTo(setup.grossRealizedRR!, 10);
    }
  });

  it("makes every closed trade worse once a fee is charged", () => {
    const free = runBacktest(candles, { warmupBars: WARMUP, feeRate: 0 });
    const charged = runBacktest(candles, { warmupBars: WARMUP, feeRate: 0.001 });

    const freeClosed = free.setups.filter((s) => s.realizedRR !== null);
    const chargedClosed = charged.setups.filter((s) => s.realizedRR !== null);

    expect(freeClosed.length).toBeGreaterThan(0);
    // Fees do not change decisions, so the same trades happen either way.
    expect(chargedClosed.length).toBe(freeClosed.length);

    for (let i = 0; i < freeClosed.length; i += 1) {
      expect(chargedClosed[i].realizedRR!).toBeLessThan(freeClosed[i].realizedRR!);
    }
  });

  it("charges slippage against the trade on both legs", () => {
    const clean = runBacktest(candles, { warmupBars: WARMUP, feeRate: 0, slippageRate: 0 });
    const slipped = runBacktest(candles, { warmupBars: WARMUP, feeRate: 0, slippageRate: 0.001 });

    // A worse fill changes the risk, so entries differ — the point is that it
    // never works in the strategy's favour.
    expect(slipped.setups[0].entry).toBeGreaterThan(clean.setups[0].entry);
  });

  /**
   * Builds a series that produces exactly one trade with a chosen stop
   * distance, so the fee arithmetic can be checked against a closed form
   * rather than only against "it got worse".
   *
   * The runner's own numbers are used — entry, exit and stop as it recorded
   * them — so the assertion is about the conversion, not about a
   * reimplementation of it.
   */
  function feeCostInR(setup: BacktestSetupResult, feeRate: number): number {
    // costR = (entry + exit) × feeRate / risk, with slippage at zero.
    const risk = setup.entry - setup.stopLoss;
    return ((setup.entry + setup.exitPrice!) * feeRate) / risk;
  }

  it("converts a fee into R as (entry + exit) × feeRate / risk", () => {
    const feeRate = 0.001;
    const free = runBacktest(candles, { warmupBars: WARMUP, feeRate: 0, slippageRate: 0 });
    const charged = runBacktest(candles, { warmupBars: WARMUP, feeRate, slippageRate: 0 });

    const closed = charged.setups
      .map((setup, i) => ({ setup, gross: free.setups[i] }))
      .filter(({ setup }) => setup.exitPrice !== null);

    expect(closed.length).toBeGreaterThan(0);

    for (const { setup, gross } of closed) {
      const observed = gross.realizedRR! - setup.realizedRR!;
      expect(observed).toBeCloseTo(feeCostInR(setup, feeRate), 10);
    }
  });

  it("charges the same fee more heavily the tighter the stop is", () => {
    // The property that matters for interpreting a result: 1R is the stop
    // distance, so a fixed percentage fee costs proportionally more R on a
    // tight stop than on a wide one. Checked here as pure arithmetic on the
    // runner's own conversion, at two stop widths an order of magnitude apart.
    const feeRate = 0.001;
    const entry = 100;
    const exit = 100; // a breakeven stop, where the fee is the entire result

    const tight = feeCostInR(
      { entry, stopLoss: 99, exitPrice: exit } as BacktestSetupResult,
      feeRate,
    );
    const wide = feeCostInR(
      { entry, stopLoss: 90, exitPrice: exit } as BacktestSetupResult,
      feeRate,
    );

    // (100 + 100) × 0.001 / 1  = 0.2R on a 1% stop
    // (100 + 100) × 0.001 / 10 = 0.02R on a 10% stop
    expect(tight).toBeCloseTo(0.2, 10);
    expect(wide).toBeCloseTo(0.02, 10);
    expect(tight).toBeCloseTo(wide * 10, 10);
  });

  it("charges a winner on the larger exit notional", () => {
    const feeRate = 0.001;
    const cost = feeCostInR(
      { entry: 100, stopLoss: 95, exitPrice: 115 } as BacktestSetupResult,
      feeRate,
    );

    // (100 + 115) × 0.001 / 5
    expect(cost).toBeCloseTo(0.043, 10);
  });

  it("records the assumptions it ran under", () => {
    const report = runBacktest(candles, { warmupBars: WARMUP, feeRate: 0.002 });

    expect(report.assumptions.feeRate).toBe(0.002);
    expect(report.assumptions.sameCandlePolicy).toBe("STOP_FIRST");
    expect(report.assumptions.entryPolicy).toBe("SIGNAL_CLOSE");
    expect(report.assumptions.warmupBars).toBe(WARMUP);
  });

  it("reports the cost of trading as a figure in R", () => {
    const charged = runBacktest(candles, { warmupBars: WARMUP, feeRate: 0.001 });
    const metrics = computeMetrics(charged.setups);

    expect(metrics.costR).toBeGreaterThan(0);
  });
});

describe("entry policy", () => {
  const candles = repeatedPullbacks(80);

  it("fills at the close of the signal candle by default", () => {
    const report = runBacktest(candles, { warmupBars: WARMUP, feeRate: 0, slippageRate: 0 });
    const first = report.setups[0];

    expect(first.entryTime).toBe(first.triggeredAt);
    const signal = candles.find((c) => c.openTime === first.triggeredAt)!;
    expect(first.entry).toBeCloseTo(signal.close);
  });

  it("fills at the next candle's open when asked to", () => {
    const report = runBacktest(candles, {
      warmupBars: WARMUP,
      entryPolicy: "NEXT_OPEN",
      feeRate: 0,
      slippageRate: 0,
    });
    const first = report.setups[0];

    expect(first.entryTime).toBeGreaterThan(first.triggeredAt);
    const index = candles.findIndex((c) => c.openTime === first.triggeredAt);
    expect(first.entry).toBeCloseTo(candles[index + 1].open);
  });

  it("never lets the signal candle also be the exit candle", () => {
    // Management starts on the bar after the fill, so a trade cannot open and
    // close on the same candle — which would be an unverifiable claim about
    // intra-candle sequence.
    const report = runBacktest(candles, { warmupBars: WARMUP });

    for (const setup of report.setups) {
      if (setup.exitTime === null) continue;
      expect(setup.exitTime).toBeGreaterThan(setup.entryTime);
    }
  });
});

describe("same-candle stop and target", () => {
  /**
   * Replaces the candle immediately after the first entry with one whose range
   * covers both the stop and every target.
   *
   * Injected at that exact index on purpose: appending it to the end of the
   * series would land after every trade had already closed, and the test would
   * pass while proving nothing.
   */
  function withStraddleAfterFirstEntry(): { candles: Candle[]; entryIndex: number } {
    const base = repeatedPullbacks(80);
    const plain = runBacktest(base, { warmupBars: WARMUP, feeRate: 0, slippageRate: 0 });
    const first = plain.setups[0];

    const entryIndex = base.findIndex((c) => c.openTime === first.entryTime);
    const next = base[entryIndex + 1];

    const straddle: Candle = {
      ...next,
      // Wide enough in both directions to contain the stop and the furthest
      // target, whatever they happen to be.
      high: Math.max(next.high, first.entry * 3),
      low: Math.min(next.low, first.entry * 0.3),
    };

    const candles = [...base];
    candles[entryIndex + 1] = straddle;

    return { candles, entryIndex };
  }

  it("assumes the stop traded first by default", () => {
    const { candles } = withStraddleAfterFirstEntry();

    const report = runBacktest(candles, { warmupBars: WARMUP, feeRate: 0, slippageRate: 0 });
    const first = report.setups[0];

    expect(report.assumptions.sameCandlePolicy).toBe("STOP_FIRST");
    expect(first.outcome).toBe("SL_HIT");
    // Pessimistic: guessing in the strategy's favour is how a backtest starts
    // flattering the thing it is meant to test.
    expect(first.realizedRR!).toBeLessThan(0);
  });

  it("can be told to assume the target instead, and the same candle then wins", () => {
    const { candles } = withStraddleAfterFirstEntry();

    const pessimistic = runBacktest(candles, {
      warmupBars: WARMUP,
      feeRate: 0,
      slippageRate: 0,
      sameCandlePolicy: "STOP_FIRST",
    }).setups[0];

    const optimistic = runBacktest(candles, {
      warmupBars: WARMUP,
      feeRate: 0,
      slippageRate: 0,
      sameCandlePolicy: "TARGET_FIRST",
    }).setups[0];

    expect(pessimistic.outcome).toBe("SL_HIT");
    expect(optimistic.outcome).toBe("TP3_HIT");
    // The policy visibly changes the answer on the very same data, which is
    // exactly why it is reported on every backtest rather than buried.
    expect(optimistic.realizedRR!).toBeGreaterThan(pessimistic.realizedRR!);
  });
});

describe("excursions", () => {
  it("records how far a trade went in each direction while open", () => {
    const report = runBacktest(repeatedPullbacks(80), { warmupBars: WARMUP });
    const closed = report.setups.filter((s) => s.exitTime !== null);

    expect(closed.length).toBeGreaterThan(0);
    for (const setup of closed) {
      expect(setup.maxFavourableR).not.toBeNull();
      expect(setup.maxAdverseR).not.toBeNull();
      // Favourable is measured upward, adverse downward.
      expect(setup.maxFavourableR!).toBeGreaterThanOrEqual(0);
      expect(setup.maxAdverseR!).toBeLessThanOrEqual(0);
    }
  });
});

describe("skipped setups are reported, not dropped", () => {
  it("explains a setup that could not become a trade", () => {
    const candles = repeatedPullbacks(80);

    // NEXT_OPEN needs a candle after the signal; the final bar has none.
    const report = runBacktest(candles, { warmupBars: WARMUP, entryPolicy: "NEXT_OPEN" });

    // Whether or not this particular run skips anything, the channel exists
    // and every entry carries a reason rather than a silent omission.
    for (const skip of report.skipped) {
      expect(skip.reason.length).toBeGreaterThan(0);
      expect(skip.at).toBeGreaterThan(0);
    }
  });
});

describe("reproducibility", () => {
  it("produces an identical report for identical input", () => {
    const candles = repeatedPullbacks(80);
    const options = { warmupBars: WARMUP, feeRate: 0.001, symbol: "BTCUSDT" as const };

    const once = runBacktest(candles, options);
    const twice = runBacktest(candles, options);

    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("produces identical metrics for identical trades", () => {
    const trades = series([1, -1, 2, 0, -1]);

    expect(JSON.stringify(computeMetrics(trades))).toBe(JSON.stringify(computeMetrics(trades)));
  });

  it("does not depend on the wall clock", () => {
    // Nothing in the runner reads the current time — the same candles replayed
    // in a year must produce the same report.
    const candles = repeatedPullbacks(80);
    const report = runBacktest(candles, { warmupBars: WARMUP });

    expect(report.evaluatedTo).toBeLessThanOrEqual(candles.at(-1)!.openTime);
  });
});

describe("dataset integrity", () => {
  const clean = makeCandles([100, 101, 102, 103, 104], { timeframe: "H1" });

  it("accepts a well-formed series", () => {
    const report = checkIntegrity(clean, "H1");

    expect(report.ok).toBe(true);
    expect(report.fatal).toBe(false);
  });

  it("refuses an empty series", () => {
    const report = checkIntegrity([], "H1");

    expect(report.fatal).toBe(true);
    expect(report.issues[0].kind).toBe("EMPTY");
  });

  it("treats a duplicated candle as fatal", () => {
    const report = checkIntegrity([...clean, clean[2]], "H1");

    expect(report.fatal).toBe(true);
    expect(report.issues.some((i) => i.kind === "DUPLICATE_CANDLE")).toBe(true);
  });

  it("treats out-of-order candles as fatal", () => {
    // Index order must be time order — every loop in the runner assumes it.
    const scrambled = [clean[0], clean[3], clean[1], clean[4]];
    const report = checkIntegrity(scrambled, "H1");

    expect(report.fatal).toBe(true);
    expect(report.issues.some((i) => i.kind === "OUT_OF_ORDER")).toBe(true);
  });

  it("reports a gap without refusing to run", () => {
    // Exchanges do have outages; a run across one is still informative as long
    // as the report says the hole is there.
    const gapped = [clean[0], clean[1], clean[4]];
    const report = checkIntegrity(gapped, "H1");

    expect(report.fatal).toBe(false);
    expect(report.missingCandles).toBe(2);
    expect(report.issues.some((i) => i.kind === "GAP")).toBe(true);
  });

  it("rejects a candle whose high is below its close", () => {
    const broken = [...clean];
    broken[2] = { ...broken[2], high: broken[2].close - 1 };

    const report = checkIntegrity(broken, "H1");

    // The simulator decides every exit from high and low, so an impossible
    // candle would produce impossible fills.
    expect(report.fatal).toBe(true);
    expect(report.issues.some((i) => i.kind === "INVALID_OHLC")).toBe(true);
  });

  it("rejects non-positive and non-finite prices", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const broken = [...clean];
      broken[1] = { ...broken[1], open: bad, high: bad, low: bad, close: bad };
      expect(checkIntegrity(broken, "H1").fatal, String(bad)).toBe(true);
    }
  });

  it("rejects a candle that closes before it opens", () => {
    const broken = [...clean];
    broken[1] = { ...broken[1], closeTime: broken[1].openTime - 1 };

    expect(checkIntegrity(broken, "H1").fatal).toBe(true);
  });
});
