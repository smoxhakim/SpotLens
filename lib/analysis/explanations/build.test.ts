import { describe, expect, it } from "vitest";

import { analyzeMultiTimeframe } from "../mtf";
import { runAnalysis, type AnalysisResult } from "../setup";
import type { Candle } from "@/lib/market-data/provider";
import { makeCandles } from "@/lib/test-utils/candles";
import {
  downtrend,
  extendedAboveSupport,
  pullbackIntoSupport,
  poorRiskReward,
  pullbackOnThinVolume,
  rangeBound,
  thinHistory,
} from "@/lib/test-utils/scenarios";

import { buildExplanations } from "./build";
import { EXPLANATION_ORDER, type Explanation, type ExplanationCategory } from "./types";

/**
 * The explanation layer explains; it never decides.
 *
 * Two properties matter more than any individual wording. The list must say
 * the same thing the engine decided — a factor the score treats as worthless
 * cannot read as encouraging — and it must be a pure function of the result,
 * so the same analysis always produces the same document.
 */

function explain(result: AnalysisResult): Explanation[] {
  return buildExplanations(result);
}

function find(result: AnalysisResult, category: ExplanationCategory): Explanation | undefined {
  return explain(result).find((e) => e.category === category);
}

function mtfFor(lower: Candle[], higher: Candle[]) {
  return analyzeMultiTimeframe({
    lowerCandles: lower,
    higherCandles: higher,
    lowerTimeframe: "H1",
    higherTimeframe: "H4",
  });
}

describe("trend", () => {
  it("reads a bullish trend as supporting the setup", () => {
    const trend = find(runAnalysis(pullbackIntoSupport()), "TREND")!;

    expect(trend.signal).toBe("positive");
    expect(trend.title).toMatch(/bullish/i);
    // The detail is the engine's own sentence, not a second opinion.
    expect(trend.detail).toBe(runAnalysis(pullbackIntoSupport()).read.trend.reason);
  });

  it("reads a bearish trend as weakening it", () => {
    const trend = find(runAnalysis(downtrend()), "TREND")!;

    expect(trend.signal).toBe("negative");
    expect(trend.title).toMatch(/bearish/i);
  });

  it("reads a range as neither", () => {
    const trend = find(runAnalysis(rangeBound()), "TREND")!;

    expect(trend.signal).toBe("neutral");
  });
});

describe("structure", () => {
  it("describes an uptrend structure positively", () => {
    const structure = find(runAnalysis(pullbackIntoSupport()), "STRUCTURE")!;

    expect(structure.signal).toBe("positive");
    expect(structure.title).toMatch(/higher highs/i);
  });

  it("describes a downtrend structure negatively", () => {
    const structure = find(runAnalysis(downtrend()), "STRUCTURE")!;

    expect(structure.signal).toBe("negative");
    expect(structure.title).toMatch(/lower highs/i);
  });

  it("does not claim a direction when structure cannot be read", () => {
    // A flat series has no confirmed swing points to label.
    const flat = runAnalysis(makeCandles(new Array(80).fill(100)));

    expect(flat.read.trend.structure.structure).not.toBe("UPTREND");
    expect(find(flat, "STRUCTURE")!.signal).toBe("neutral");
  });
});

describe("multi-timeframe", () => {
  it("is omitted entirely on a single-timeframe run", () => {
    // Reporting "no higher timeframe was consulted" would describe the absence
    // of a question rather than answer one.
    expect(find(runAnalysis(pullbackIntoSupport()), "MTF")).toBeUndefined();
  });

  it("reads agreement as support", () => {
    const lower = pullbackIntoSupport();
    const mtf = find(runAnalysis(lower, { mtf: mtfFor(lower, lower) }), "MTF")!;

    expect(mtf.signal).toBe("positive");
    expect(mtf.title).toBe("Timeframes aligned");
  });

  it("reads a counter-trend bounce as weakening the setup, and names the veto", () => {
    const lower = pullbackIntoSupport();
    const result = runAnalysis(lower, { mtf: mtfFor(lower, downtrend()) });
    const mtf = find(result, "MTF")!;

    expect(mtf.signal).toBe("negative");
    expect(mtf.title).toBe("Counter-trend bounce");
    // The engine's warning leads the detail — it is the reason for the veto.
    expect(mtf.detail).toMatch(/rally inside a downtrend/i);
    expect(result.status).toBe("AVOID");
  });

  it("reads an unclear higher timeframe as neither", () => {
    const lower = pullbackIntoSupport();
    const mtf = find(runAnalysis(lower, { mtf: mtfFor(lower, rangeBound()) }), "MTF");

    if (mtf) expect(mtf.signal).toBe("neutral");
  });
});

describe("support and resistance", () => {
  it("reports support below with a target above as support for the setup", () => {
    const zones = find(runAnalysis(pullbackIntoSupport()), "SUPPORT_RESISTANCE")!;

    expect(zones.signal).toBe("positive");
    expect(zones.title).toMatch(/support below/i);
  });

  it("says so when no zone stands out at all", () => {
    const zones = find(runAnalysis(makeCandles(new Array(80).fill(100))), "SUPPORT_RESISTANCE")!;

    expect(zones.signal).toBe("neutral");
    expect(zones.title).toMatch(/no clear zones/i);
  });

  it("flags price already trading inside resistance", () => {
    // The same condition the status engine treats as high risk.
    const results = [pullbackIntoSupport(), extendedAboveSupport(), rangeBound()]
      .map((c) => runAnalysis(c))
      .filter((r) => {
        const nearest = r.read.resistance[0];
        return nearest && r.read.price >= nearest.low;
      });

    for (const result of results) {
      const zones = find(result, "SUPPORT_RESISTANCE")!;
      expect(zones.signal).toBe("negative");
      expect(zones.title).toMatch(/inside resistance/i);
    }
  });
});

describe("momentum and volume", () => {
  it("reads an overbought reading as weakening the entry", () => {
    const momentum = find(runAnalysis(extendedAboveSupport()), "MOMENTUM")!;

    expect(momentum.signal).toBe("negative");
    expect(momentum.title).toMatch(/overbought/i);
  });

  it("stays neutral through the mid-range, where the prose and the score differ", () => {
    const momentum = find(runAnalysis(pullbackIntoSupport()), "MOMENTUM")!;

    expect(momentum.signal).toBe("neutral");
  });

  it("reads thin volume as weakening the setup", () => {
    const result = runAnalysis(pullbackOnThinVolume());
    const volume = find(result, "VOLUME")!;
    const relative = result.read.volume.read!.relative;

    expect(relative).toBeLessThanOrEqual(0.6);
    expect(volume.signal).toBe("negative");
  });

  it("reads volume above average as supportive", () => {
    const volume = find(runAnalysis(pullbackIntoSupport()), "VOLUME")!;

    expect(volume.signal).toBe("positive");
  });
});

describe("risk and reward — the Phase A rule, restated", () => {
  it("presents a measured ratio as support for the setup", () => {
    const result = runAnalysis(pullbackIntoSupport());
    const rr = find(result, "RISK_REWARD")!;

    expect(result.setup!.riskReward.isSynthetic).toBe(false);
    expect(rr.signal).toBe("positive");
    expect(rr.title).toMatch(/risk\/reward 1:/i);
  });

  it("presents an unmeasured ratio as negative, never neutral", () => {
    // Neutral would read as "no strong opinion" beside a healthy-looking
    // 1:2.5, which is the exact impression Phase A exists to prevent.
    const result = runAnalysis(extendedAboveSupport());
    const rr = find(result, "RISK_REWARD")!;

    expect(result.setup!.riskReward.isSynthetic).toBe(true);
    expect(rr.signal).toBe("negative");
    expect(rr.title).toBe("No measurable structural target");
    expect(rr.detail).toMatch(/earns nothing towards the setup score/i);
  });

  it("gives a synthetic ratio a different explanation from a structural one", () => {
    const synthetic = find(runAnalysis(extendedAboveSupport()), "RISK_REWARD")!;
    const structural = find(runAnalysis(pullbackIntoSupport()), "RISK_REWARD")!;

    expect(synthetic.id).not.toBe(structural.id);
    expect(synthetic.title).not.toBe(structural.title);
    expect(synthetic.signal).not.toBe(structural.signal);
  });

  it("keeps explaining risk and reward on an AVOID that withheld the levels", () => {
    // An AVOID reached on a ratio below 1 withholds the setup but keeps the
    // score, because the score is the evidence for the refusal. The reasoning
    // has to survive with it.
    const result = runAnalysis(poorRiskReward());

    expect(result.status).toBe("AVOID");
    expect(result.setup).toBeNull();
    expect(result.score).not.toBeNull();

    const rr = find(result, "RISK_REWARD")!;
    expect(rr.detail).toBe(result.score!.breakdown.riskReward.reason);
    expect(rr.signal).toBe("negative");
  });

  it("omits risk and reward when the run stopped before a setup was built", () => {
    // A bearish trend is refused before any levels exist, so there is no ratio
    // to describe and none is invented.
    const result = runAnalysis(downtrend());

    expect(result.score).toBeNull();
    expect(find(result, "RISK_REWARD")).toBeUndefined();
  });
});

describe("price position and confirmation", () => {
  it("reports price sitting in the entry zone as support", () => {
    const position = find(runAnalysis(pullbackIntoSupport()), "PRICE_POSITION")!;

    expect(position.signal).toBe("positive");
    expect(position.title).toMatch(/in the entry zone/i);
  });

  it("reports chasing as weakening the setup", () => {
    const position = find(runAnalysis(extendedAboveSupport()), "PRICE_POSITION")!;

    expect(position.signal).toBe("negative");
    expect(position.detail).toMatch(/chasing/i);
  });

  it("omits both when no setup was built", () => {
    const result = runAnalysis(downtrend());

    expect(find(result, "PRICE_POSITION")).toBeUndefined();
    expect(find(result, "CONFIRMATION")).toBeUndefined();
  });

  it("reports the deterministic confirmation verdict rather than guessing", () => {
    // Changed in Phase C. Until the confirmation engine existed this could only
    // restate the entry checklist, because nothing computed whether any of it
    // had happened. It now reports what the engine decided — and only what the
    // engine decided.
    const result = runAnalysis(pullbackIntoSupport());
    const confirmation = find(result, "CONFIRMATION")!;

    expect(result.confirmation!.status).toBe("PRESENT");
    expect(confirmation.signal).toBe("positive");
    expect(confirmation.detail).toBe(result.confirmation!.explanation);
  });

  it("still frames an unconfirmed setup as outstanding", () => {
    const result = runAnalysis(extendedAboveSupport());
    const confirmation = find(result, "CONFIRMATION")!;

    expect(result.confirmation!.status).not.toBe("PRESENT");
    expect(confirmation.signal).not.toBe("positive");
    expect(confirmation.title).toMatch(/still to be seen|contradicted/i);
  });
});

describe("status", () => {
  const cases: { name: string; candles: () => Candle[] }[] = [
    { name: "pullback", candles: pullbackIntoSupport },
    { name: "extended", candles: extendedAboveSupport },
    { name: "downtrend", candles: downtrend },
    { name: "range", candles: rangeBound },
    { name: "thin history", candles: thinHistory },
  ];

  it("always ends on the verdict, carrying the engine's own reason", () => {
    for (const { name, candles } of cases) {
      const result = runAnalysis(candles());
      const list = explain(result);
      const last = list[list.length - 1];

      expect(last.category, name).toBe("STATUS");
      expect(last.detail, name).toBe(result.statusReason);
    }
  });

  it("maps each verdict to the right signal", () => {
    const seen = new Map<string, string>();

    for (const { candles } of cases) {
      const result = runAnalysis(candles());
      const status = find(result, "STATUS")!;
      seen.set(result.status, status.signal);
    }

    for (const [status, signal] of seen) {
      const expected =
        status === "POTENTIAL_SETUP"
          ? "positive"
          : status === "WAIT_FOR_CONFIRMATION"
            ? "neutral"
            : "negative";
      expect(signal, status).toBe(expected);
    }
  });

  it("covers all four verdicts across the scenarios and an MTF veto", () => {
    const lower = pullbackIntoSupport();
    const statuses = new Set([
      ...cases.map(({ candles }) => runAnalysis(candles()).status),
      runAnalysis(lower, { mtf: mtfFor(lower, downtrend()) }).status,
    ]);

    expect(statuses.has("POTENTIAL_SETUP")).toBe(true);
    expect(statuses.has("WAIT_FOR_CONFIRMATION")).toBe(true);
    expect(statuses.has("AVOID")).toBe(true);
  });

  it("never speaks with certainty about an outcome", () => {
    const banned = /guaranteed|sure win|will go up|must buy|high probability of profit/i;

    for (const { name, candles } of cases) {
      for (const explanation of explain(runAnalysis(candles()))) {
        expect(`${explanation.title} ${explanation.detail}`, name).not.toMatch(banned);
      }
    }
  });
});

describe("ordering and determinism", () => {
  it("returns categories in the declared order", () => {
    const lower = pullbackIntoSupport();
    const list = explain(runAnalysis(lower, { mtf: mtfFor(lower, lower) }));

    const positions = list.map((e) => EXPLANATION_ORDER.indexOf(e.category));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("produces an identical list for identical input", () => {
    const lower = pullbackIntoSupport();
    const result = runAnalysis(lower, { mtf: mtfFor(lower, lower) });

    expect(JSON.stringify(explain(result))).toBe(JSON.stringify(explain(result)));
    expect(JSON.stringify(buildExplanations(runAnalysis(pullbackIntoSupport())))).toBe(
      JSON.stringify(buildExplanations(runAnalysis(pullbackIntoSupport()))),
    );
  });

  it("gives every explanation a unique, stable id", () => {
    for (const candles of [pullbackIntoSupport, extendedAboveSupport, downtrend, rangeBound]) {
      const list = explain(runAnalysis(candles()));
      const ids = list.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("does not touch the analysis it was given", () => {
    // The builder explains a decision; it must not be able to change one.
    const result = runAnalysis(pullbackIntoSupport());
    const before = JSON.stringify(result);

    buildExplanations(result);

    expect(JSON.stringify(result)).toBe(before);
  });

  it("leaves the score untouched, whatever the explanations say", () => {
    const result = runAnalysis(extendedAboveSupport());
    const total = result.score!.total;
    const riskReward = result.score!.breakdown.riskReward.score;

    const list = buildExplanations(result);

    expect(list.some((e) => e.signal === "negative")).toBe(true);
    expect(result.score!.total).toBe(total);
    expect(result.score!.breakdown.riskReward.score).toBe(riskReward);
  });
});
