import { describe, expect, it } from "vitest";

import {
  SHORTLIST_RANKING_VERSION,
  buildShortlist,
  exclusionFor,
  isShortlistEligible,
  reasonsFor,
  spreadAcrossMarkets,
  viewOf,
  type ShortlistInput,
} from "./shortlist";

/**
 * The shortlist decides what a person looks at, and nothing else. It owns no
 * strategy: every input here is a fact the engine already established and the
 * scanner already stored, so these tests are about prioritisation — never about
 * whether a market is worth trading.
 */

function result(overrides: Partial<ShortlistInput> = {}): ShortlistInput {
  return {
    symbol: "BTCUSDT",
    timeframe: "H1",
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    score: 70,
    riskReward: 2.4,
    riskRewardIsSynthetic: false,
    ok: true,
    lifecycleStatus: null,
    trackedSetupId: "setup-1",
    analysedAtCandle: 1_700_000_000_000,
    trend: "BULLISH",
    mtfAgreement: "ALIGNED_BULLISH",
    regimeDirection: "TRENDING_UP",
    ...overrides,
  };
}

describe("eligibility", () => {
  it("always admits the engine's highest state", () => {
    // POTENTIAL_SETUP has already cleared every rule the engine applies,
    // including the reward one, so the shortlist adds no further bar.
    expect(exclusionFor(result({ analysisStatus: "POTENTIAL_SETUP", score: 61 }))).toBeNull();
  });

  it("admits a setup waiting on confirmation when it is worth the slot", () => {
    expect(isShortlistEligible(result({ score: 60 }))).toBe(true);
    expect(isShortlistEligible(result({ score: 93 }))).toBe(true);
  });

  it("turns away a weak setup that is still waiting", () => {
    // The bar is the engine's own grade rather than a number restated here, so
    // it cannot drift from what the score means everywhere else.
    expect(exclusionFor(result({ score: 59 }))).toBe("BELOW_QUALITY_BAR");
    expect(exclusionFor(result({ score: 45 }))).toBe("BELOW_QUALITY_BAR");
  });

  it("turns away a waiting setup whose reward was never measured", () => {
    // Phase A's rule as a gate: a ratio measured to an R-multiple is the
    // fallback ladder restating its own constant, and offering that for review
    // would be offering a number the chart does not support.
    expect(exclusionFor(result({ riskRewardIsSynthetic: true, riskReward: 2.5 }))).toBe(
      "REWARD_NOT_MEASURED",
    );
    expect(exclusionFor(result({ riskReward: null, riskRewardIsSynthetic: null }))).toBe(
      "REWARD_NOT_MEASURED",
    );
  });

  it("keeps high risk out of the primary shortlist whatever it scores", () => {
    // The engine has already qualified against this one. A high raw score does
    // not undo the warning, and letting it in would put a setup the tool
    // cautioned about above a structurally healthier candidate.
    expect(exclusionFor(result({ analysisStatus: "HIGH_RISK", score: 99 }))).toBe("HIGH_RISK");
  });

  it("never admits an avoid", () => {
    expect(exclusionFor(result({ analysisStatus: "AVOID", score: 95 }))).toBe("AVOID");
  });

  it("never admits a market that failed before the engine ran", () => {
    expect(exclusionFor(result({ ok: false, analysisStatus: null, score: null }))).toBe("FAILED");
    expect(exclusionFor(result({ analysisStatus: null, score: null }))).toBe("FAILED");
  });

  it("calls a scoreless avoid an avoid, not a failure", () => {
    // The engine stops before building a score once it has decided there is no
    // responsible long here, so most AVOID results carry none — on one real
    // pass, thirty-seven of thirty-eight. Reading the score before the verdict
    // reported every one of them as a failed market on a pass where nothing
    // failed: the same exclusion, described as the wrong thing.
    expect(exclusionFor(result({ analysisStatus: "AVOID", score: null }))).toBe("AVOID");
    expect(exclusionFor(result({ analysisStatus: "AVOID", score: null, riskReward: null }))).toBe(
      "AVOID",
    );
  });

  it("still counts a genuinely failed market as failed", () => {
    // `ok: false` is the market that never reached the engine, and it must not
    // be quietly folded into one of the verdict buckets.
    expect(exclusionFor(result({ ok: false, analysisStatus: "AVOID", score: 20 }))).toBe("FAILED");
  });

  it("counts every exclusion rather than dropping it silently", () => {
    const shortlist = buildShortlist([
      result({ symbol: "AAAUSDT", analysisStatus: "POTENTIAL_SETUP" }),
      result({ symbol: "BBBUSDT", analysisStatus: "AVOID" }),
      result({ symbol: "CCCUSDT", analysisStatus: "HIGH_RISK" }),
      result({ symbol: "DDDUSDT", score: 30 }),
      result({ symbol: "EEEUSDT", riskRewardIsSynthetic: true }),
      result({ symbol: "FFFUSDT", ok: false, analysisStatus: null, score: null }),
    ]);

    expect(shortlist.totalAnalysed).toBe(6);
    expect(shortlist.totalEligible).toBe(1);
    expect(shortlist.excluded).toEqual({
      FAILED: 1,
      AVOID: 1,
      HIGH_RISK: 1,
      BELOW_QUALITY_BAR: 1,
      REWARD_NOT_MEASURED: 1,
    });
  });
});

describe("canonical ranking", () => {
  it("puts the engine's highest state above one still waiting", () => {
    const ranked = buildShortlist([
      result({ symbol: "AAAUSDT", score: 95 }),
      result({ symbol: "BBBUSDT", analysisStatus: "POTENTIAL_SETUP", score: 61 }),
    ]).allEligible;

    expect(ranked.map((c) => c.symbol)).toEqual(["BBBUSDT", "AAAUSDT"]);
  });

  it("orders equal states by quality, highest first", () => {
    const ranked = buildShortlist([
      result({ symbol: "AAAUSDT", score: 64 }),
      result({ symbol: "BBBUSDT", score: 88 }),
      result({ symbol: "CCCUSDT", score: 72 }),
    ]).allEligible;

    expect(ranked.map((c) => c.score)).toEqual([88, 72, 64]);
  });

  it("orders equal quality by the measured reward", () => {
    const ranked = buildShortlist([
      result({ symbol: "AAAUSDT", riskReward: 1.8 }),
      result({ symbol: "BBBUSDT", riskReward: 3.2 }),
    ]).allEligible;

    expect(ranked.map((c) => c.symbol)).toEqual(["BBBUSDT", "AAAUSDT"]);
  });

  it("never lets an unmeasured reward buy a ranking advantage", () => {
    // A POTENTIAL_SETUP can carry an unmeasured reward and still be eligible,
    // so the sort has to refuse it too — not just the gate.
    const ranked = buildShortlist([
      result({
        symbol: "AAAUSDT",
        analysisStatus: "POTENTIAL_SETUP",
        riskReward: 9.9,
        riskRewardIsSynthetic: true,
      }),
      result({
        symbol: "BBBUSDT",
        analysisStatus: "POTENTIAL_SETUP",
        riskReward: 1.6,
        riskRewardIsSynthetic: false,
      }),
    ]).allEligible;

    expect(ranked.map((c) => c.symbol)).toEqual(["BBBUSDT", "AAAUSDT"]);
    // And it is never reported as a ratio either.
    expect(ranked[1].riskReward).toBeNull();
    expect(ranked[1].riskRewardIsMeasured).toBe(false);
  });

  it("numbers the candidates by their place in the one canonical order", () => {
    const ranked = buildShortlist([
      result({ symbol: "AAAUSDT", score: 64 }),
      result({ symbol: "BBBUSDT", score: 88 }),
    ]).allEligible;

    expect(ranked.map((c) => c.rank)).toEqual([1, 2]);
    expect(ranked[0].symbol).toBe("BBBUSDT");
  });

  it("produces the identical list however the input was ordered", () => {
    const input = [
      result({ symbol: "CCCUSDT", score: 70, timeframe: "H4" }),
      result({ symbol: "AAAUSDT", score: 70, timeframe: "H1" }),
      result({ symbol: "CCCUSDT", score: 70, timeframe: "H1" }),
      result({ symbol: "BBBUSDT", score: 88, timeframe: "H1" }),
    ];

    const forwards = buildShortlist(input);
    const backwards = buildShortlist([...input].reverse());

    expect(JSON.stringify(forwards)).toBe(JSON.stringify(backwards));
  });

  it("returns a byte-identical result when run repeatedly", () => {
    const input = [
      result({ symbol: "AAAUSDT", score: 88 }),
      result({ symbol: "BBBUSDT", score: 88, riskReward: 3 }),
      result({ symbol: "CCCUSDT", analysisStatus: "POTENTIAL_SETUP", score: 61 }),
    ];

    const runs = [buildShortlist(input), buildShortlist(input), buildShortlist(input)];

    expect(new Set(runs.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("does not mutate the list it was given", () => {
    const input = [result({ symbol: "ZZZUSDT" }), result({ symbol: "AAAUSDT" })];
    const before = input.map((r) => r.symbol);

    buildShortlist(input);

    expect(input.map((r) => r.symbol)).toEqual(before);
  });
});

describe("market diversity", () => {
  it("gives every market a place before doubling up on one", () => {
    // On merit alone BTC would hold both of the first two slots. Five slots
    // filled by two symbols is a worse review list than five filled by five,
    // and the discovery the broad scan exists for would be lost.
    const ranked = buildShortlist([
      result({ symbol: "BTCUSDT", timeframe: "H1", score: 95 }),
      result({ symbol: "BTCUSDT", timeframe: "H4", score: 94 }),
      result({ symbol: "ETHUSDT", timeframe: "H1", score: 70 }),
    ]).allEligible;

    expect(ranked.map((c) => `${c.symbol}/${c.timeframe}`)).toEqual([
      "BTCUSDT/H1",
      "ETHUSDT/H1",
      "BTCUSDT/H4",
    ]);
  });

  it("keeps the deferred entry rather than dropping it", () => {
    const shortlist = buildShortlist([
      result({ symbol: "BTCUSDT", timeframe: "H1", score: 95 }),
      result({ symbol: "BTCUSDT", timeframe: "H4", score: 94 }),
    ]);

    expect(shortlist.totalEligible).toBe(2);
    expect(shortlist.allEligible).toHaveLength(2);
  });

  it("lets a second timeframe in once every other market has had its turn", () => {
    const ranked = buildShortlist([
      result({ symbol: "AAAUSDT", timeframe: "H1", score: 90 }),
      result({ symbol: "AAAUSDT", timeframe: "H4", score: 89 }),
      result({ symbol: "BBBUSDT", timeframe: "H1", score: 70 }),
    ]).allEligible;

    expect(ranked[2].symbol).toBe("AAAUSDT");
    expect(ranked[2].timeframe).toBe("H4");
  });

  it("preserves rank order inside each pass of the spread", () => {
    const spread = spreadAcrossMarkets([
      { symbol: "A", id: 1 },
      { symbol: "A", id: 2 },
      { symbol: "B", id: 3 },
      { symbol: "A", id: 4 },
    ]);

    expect(spread.map((e) => e.id)).toEqual([1, 3, 2, 4]);
  });
});

describe("shortlist sizes", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      result({ symbol: `S${String(i).padStart(3, "0")}USDT`, score: 90 - i }),
    );

  it("keeps every view a prefix of the one canonical order", () => {
    const shortlist = buildShortlist(many(20));

    expect(shortlist.top5).toEqual(shortlist.allEligible.slice(0, 5));
    expect(shortlist.top10).toEqual(shortlist.allEligible.slice(0, 10));
    expect(shortlist.top15).toEqual(shortlist.allEligible.slice(0, 15));

    // top5 ⊂ top10 ⊂ top15 ⊂ all, by construction rather than by coincidence.
    expect(shortlist.top10.slice(0, 5)).toEqual(shortlist.top5);
    expect(shortlist.top15.slice(0, 10)).toEqual(shortlist.top10);
    expect(shortlist.allEligible.slice(0, 15)).toEqual(shortlist.top15);
  });

  it.each([0, 1, 4, 5, 10, 15, 23])("handles a pass with %i eligible results", (count) => {
    const shortlist = buildShortlist(many(count));

    expect(shortlist.totalEligible).toBe(count);
    expect(shortlist.top5).toHaveLength(Math.min(count, 5));
    expect(shortlist.top10).toHaveLength(Math.min(count, 10));
    expect(shortlist.top15).toHaveLength(Math.min(count, 15));
    expect(shortlist.allEligible).toHaveLength(count);
  });

  it("names the views so a caller asks for a size rather than an index", () => {
    const shortlist = buildShortlist(many(20));

    expect(viewOf(shortlist, "PRIMARY")).toEqual(shortlist.top5);
    expect(viewOf(shortlist, "EXPANDED")).toEqual(shortlist.top10);
    expect(viewOf(shortlist, "EXTENDED")).toEqual(shortlist.top15);
    expect(viewOf(shortlist, "ALL")).toEqual(shortlist.allEligible);
  });

  it("stamps the rules it was built by", () => {
    expect(buildShortlist([]).rankingVersion).toBe(SHORTLIST_RANKING_VERSION);
  });
});

describe("no lookahead", () => {
  it("ignores results that were not part of the set it was given", () => {
    // A later pass finding something better cannot reach back and change where
    // an earlier candidate stood: the function sees one array and nothing else.
    const past = [result({ symbol: "AAAUSDT", score: 70 })];
    const withFuture = [...past, result({ symbol: "ZZZUSDT", analysisStatus: "POTENTIAL_SETUP" })];

    const before = buildShortlist(past);
    const after = buildShortlist(withFuture);

    expect(before.allEligible[0].rank).toBe(1);
    expect(before.allEligible[0].symbol).toBe("AAAUSDT");
    // AAA moves down in the later set, but the earlier shortlist is unchanged.
    expect(after.allEligible[1].symbol).toBe("AAAUSDT");
    expect(JSON.stringify(before.allEligible[0])).toBe(
      JSON.stringify({ ...before.allEligible[0] }),
    );
  });

  it("ranks on the candle the analysis ran on, never a later one", () => {
    // `analysedAtCandle` is carried for provenance and is not a sort key: two
    // results identical but for their candle rank in symbol order, not by
    // whichever was analysed more recently.
    const older = result({ symbol: "AAAUSDT", analysedAtCandle: 1 });
    const newer = result({ symbol: "BBBUSDT", analysedAtCandle: 2_000_000_000_000 });

    expect(buildShortlist([newer, older]).allEligible.map((c) => c.symbol)).toEqual([
      "AAAUSDT",
      "BBBUSDT",
    ]);
  });
});

describe("explanations", () => {
  it("states facts already on the result and nothing else", () => {
    const reasons = reasonsFor(
      result({ analysisStatus: "POTENTIAL_SETUP", score: 88, riskReward: 2.7 }),
    );

    expect(reasons).toContain("Every deterministic condition the engine checks now holds.");
    expect(reasons).toContain("Quality 88/100 (strong).");
    expect(reasons).toContain("Reward measured against structure at 1:2.7.");
    expect(reasons).toContain("Trend is bullish.");
    expect(reasons).toContain("Higher timeframe: aligned bullish.");
    expect(reasons).toContain("Regime: trending up.");
  });

  it("says plainly when the reward was not measurable", () => {
    const reasons = reasonsFor(
      result({ analysisStatus: "POTENTIAL_SETUP", riskRewardIsSynthetic: true, riskReward: 2.5 }),
    );

    expect(reasons).toContain("Reward is not measurable against structure.");
    expect(reasons.join(" ")).not.toContain("1:2.5");
  });

  it("omits context a stored row does not carry", () => {
    const reasons = reasonsFor(result({ trend: null, mtfAgreement: null, regimeDirection: null }));

    expect(reasons.some((r) => r.startsWith("Trend"))).toBe(false);
    expect(reasons.some((r) => r.startsWith("Regime"))).toBe(false);
    expect(reasons.some((r) => r.includes("null"))).toBe(false);
  });

  it("never calls the score a probability", () => {
    for (const status of ["POTENTIAL_SETUP", "WAIT_FOR_CONFIRMATION"] as const) {
      const text = reasonsFor(result({ analysisStatus: status }))
        .join(" ")
        .toLowerCase();

      expect(text).toContain("quality");
      expect(text).not.toContain("%");
      expect(text).not.toContain("probability");
      expect(text).not.toContain("chance");
      expect(text).not.toContain("likely");
    }
  });

  it("never tells the reader to act", () => {
    const text = buildShortlist([result({ analysisStatus: "POTENTIAL_SETUP" })])
      .allEligible.flatMap((c) => c.reasons)
      .join(" ")
      .toLowerCase();

    for (const banned of ["buy", "sell", "execute", "guaranteed", "you should", "don't miss"]) {
      expect(text, `contained "${banned}"`).not.toContain(banned);
    }
  });
});

describe("traceability", () => {
  it("carries the setup id, so a candidate opens its own analysis", () => {
    const candidate = buildShortlist([result({ trackedSetupId: "setup-42" })]).allEligible[0];

    expect(candidate.trackedSetupId).toBe("setup-42");
    expect(candidate.analysedAtCandle).toBe(1_700_000_000_000);
  });

  it("reports the engine's grade for the score it carries", () => {
    const graded = buildShortlist([
      result({ symbol: "AAAUSDT", analysisStatus: "POTENTIAL_SETUP", score: 88 }),
      result({ symbol: "BBBUSDT", analysisStatus: "POTENTIAL_SETUP", score: 61 }),
    ]).allEligible;

    expect(graded.map((c) => c.grade)).toEqual(["STRONG", "MODERATE"]);
  });
});
