import { describe, expect, it } from "vitest";

import {
  detectZones,
  isInZone,
  runAnalysis,
  runMarketRead,
  EXTENDED_ATR_MULTIPLE,
  MIN_CANDLES_FOR_READ,
  RECENT_SWING_MAX_AGE_BARS,
  REJECTION_MIN_CLOSE_POSITION,
  REJECTION_MIN_WICK_RATIO,
  type PriceZone,
} from "@/lib/analysis";
import type { Candle } from "@/lib/market-data/provider";
import { lifecycleStatusFor } from "@/lib/setups";

import {
  RETEST_ATR_WINDOW,
  RETEST_CLOSES,
  RETEST_ZONE,
  zoneRetest,
  zoneRetestRejection,
} from "./fixtures";
import { branchOf, decisionOf, goldenFile, line, zoneOf, type Branch } from "./project";

/**
 * Golden master for zone location (Phase 5, commit 0; audit findings D1, D2).
 *
 * Pins today's behaviour at the boundaries the audits identified, so the
 * diagnostics release provably leaves it alone and any later fix shows up as a
 * deliberate, reviewable diff:
 *
 *   - D1: a zone's side is decided by its midpoint against the last close. A
 *     support zone retested from above, closing in its lower half, is treated
 *     as resistance — High Risk, with the entry anchored to the zone below.
 *   - D2: a candle that wicks through the zone and closes above it carries
 *     confirmation evidence, but the verdict says price has not reached the
 *     zone.
 *
 * These pin what the engine *does*, not what it should do. Every expectation
 * below was derived by hand from the source for the `zoneRetest` fixture; if
 * the first run disagrees, the derivation or the fixture is wrong — fix the
 * test, never the engine.
 */

const isRetestZone = (zone: PriceZone) =>
  zone.low === RETEST_ZONE.low && zone.high === RETEST_ZONE.high;

const LOWER_HALF = RETEST_CLOSES.filter((close) => close <= RETEST_ZONE.mid);
const UPPER_HALF = RETEST_CLOSES.filter(
  (close) => close > RETEST_ZONE.mid && close <= RETEST_ZONE.high,
);
const ABOVE = RETEST_CLOSES.filter((close) => close > RETEST_ZONE.high);

/**
 * Everything the expectations below assume about a retest series, checked on
 * the series itself. Each assertion names the rule it keeps from answering
 * first, so a failure here says which part of the hand derivation was wrong.
 */
function expectRetestGeometry(candles: Candle[]) {
  const read = runMarketRead(candles);
  const structure = read.trend.structure;
  const atr = read.indicators.atr14;
  const last = candles[candles.length - 1];

  // Enough history that the insufficient-history rule cannot answer.
  expect(read.candleCount).toBeGreaterThanOrEqual(MIN_CANDLES_FOR_READ);
  expect(read.insufficientData).toBe(false);

  // ATR inside the window where 100 and 105 cluster into one zone, 88 stays
  // apart, and the zone is not widened.
  expect(atr).not.toBeNull();
  expect(atr!).toBeGreaterThanOrEqual(RETEST_ATR_WINDOW.min);
  expect(atr!).toBeLessThanOrEqual(RETEST_ATR_WINDOW.max);

  // Higher highs and higher lows, from exactly the swings the fixture places.
  expect(structure.structure).toBe("UPTREND");
  expect(structure.labels).toEqual({ high: "HH", low: "HL" });
  expect([structure.previousLow?.price, structure.lastLow?.price]).toEqual([100, 105]);
  expect([structure.previousHigh?.price, structure.lastHigh?.price]).toEqual([130, 140]);

  // The last swing low, at 105, is recent enough to count as confirmation
  // evidence — both the higher low and the structure break read it.
  const lastLowAge = candles.length - 1 - structure.lastLow!.index;
  expect(lastLowAge).toBe(8);
  expect(lastLowAge).toBeLessThanOrEqual(RECENT_SWING_MAX_AGE_BARS);

  // Bullish with no structure/EMA conflict, so neither the bearish rule nor the
  // sideways rule can answer first.
  expect(read.trend.trend).toBe("BULLISH");
  expect(read.trend.conflict).toBe(false);

  // Volume exactly average: neither the thin-volume rule nor a volume
  // confirmation signal can fire.
  expect(read.volume.read?.relative).toBe(1);

  // The zone itself: one 100 – 105 zone from two swing lows, never flipped.
  const zones = [...read.support, ...read.resistance];
  const retest = zones.filter(isRetestZone);
  expect(retest).toHaveLength(1);
  expect(retest[0].mid).toBe(RETEST_ZONE.mid);
  expect(retest[0].touches).toBe(2);
  expect(retest[0].flipped).toBe(false);

  // A one-swing support zone around 88 below it — where the entry re-anchors
  // when the retest zone is called resistance.
  const below = read.support.find((zone) => isInZone(88, zone));
  expect(below).toBeDefined();
  expect(below!.touches).toBe(1);
  expect(below!.high).toBeLessThan(RETEST_ZONE.low);

  // Nothing above the retest zone starts within the final candle's range, so
  // the resistance rule can only ever be answered by the retest zone itself.
  const above = zones.filter((zone) => zone.low > RETEST_ZONE.high);
  expect(above.length).toBeGreaterThan(0);
  expect(Math.min(...above.map((zone) => zone.low))).toBeGreaterThan(last.high);

  // The final candle reaches into the zone, and closes no further above it than
  // the chasing limit, so the extended rule cannot answer first.
  expect(last.low).toBeLessThanOrEqual(RETEST_ZONE.high);
  expect((last.close - RETEST_ZONE.high) / atr!).toBeLessThanOrEqual(EXTENDED_ATR_MULTIPLE);
}

describe("the zoneRetest fixtures hold the geometry the expectations below depend on", () => {
  it.each(RETEST_CLOSES)("zoneRetest closing at %s", (close) => {
    expectRetestGeometry(zoneRetest(close));
  });

  it("zoneRetestRejection", () => {
    const candles = zoneRetestRejection();
    expectRetestGeometry(candles);

    // The final candle is a bullish rejection by the confirmation engine's own
    // thresholds: it swept the whole zone, closed green, near its high, with a
    // long lower wick — and closed above the zone, not inside it.
    const last = candles[candles.length - 1];
    const range = last.high - last.low;
    expect(last.low).toBeLessThanOrEqual(RETEST_ZONE.low);
    expect(last.close).toBeGreaterThan(last.open);
    expect((Math.min(last.open, last.close) - last.low) / range).toBeGreaterThanOrEqual(
      REJECTION_MIN_WICK_RATIO,
    );
    expect((last.close - last.low) / range).toBeGreaterThanOrEqual(REJECTION_MIN_CLOSE_POSITION);
    expect(last.close).toBeGreaterThan(RETEST_ZONE.high);

    // Above the midpoint, so the retest zone is the nearest support.
    const zones = detectZones(candles);
    expect(isRetestZone(zones.support[0])).toBe(true);
  });
});

describe("D1: a zone's side is decided by its midpoint", () => {
  it.each(LOWER_HALF)(
    "calls it resistance when the close is %s, at or below the midpoint",
    (close) => {
      const zones = detectZones(zoneRetest(close));

      expect(zones.resistance.find(isRetestZone)?.kind).toBe("RESISTANCE");
      expect(zones.support.some(isRetestZone)).toBe(false);
    },
  );

  it.each([...UPPER_HALF, ...ABOVE])(
    "calls it support when the close is %s, above the midpoint",
    (close) => {
      const zones = detectZones(zoneRetest(close));

      expect(zones.support[0]).toBeDefined();
      expect(isRetestZone(zones.support[0])).toBe(true);
      expect(zones.support[0].kind).toBe("SUPPORT");
    },
  );

  it.each(LOWER_HALF)(
    "rates a close at %s inside the support zone as high risk, anchored to the zone below",
    (close) => {
      const result = runAnalysis(zoneRetest(close));

      expect(result.status).toBe("HIGH_RISK");
      expect(branchOf(result)).toBe<Branch>("PRICE_IN_RESISTANCE");
      // The entry re-anchors below the zone price is sitting in.
      expect(result.setup!.entry.high).toBeLessThan(RETEST_ZONE.low);
      expect(result.setup!.entry.priceInZone).toBe(false);
      // And the zone price is inside becomes a target below the current price.
      expect(result.setup!.takeProfits[0].level).toBe(RETEST_ZONE.low);
      expect(result.setup!.takeProfits[0].level).toBeLessThanOrEqual(result.read.price);
    },
  );
});

describe("closes inside the upper half of the zone", () => {
  it.each(UPPER_HALF.filter((close) => close < RETEST_ZONE.high))(
    "holds a close at %s at wait, contradicted by the break of the swing low at 105",
    (close) => {
      const result = runAnalysis(zoneRetest(close));

      expect(result.setup!.entry.low).toBe(RETEST_ZONE.low);
      expect(result.setup!.entry.high).toBe(RETEST_ZONE.high);
      expect(result.setup!.entry.priceInZone).toBe(true);
      expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
      expect(branchOf(result)).toBe<Branch>("CONFIRMATION_CONTRADICTED");
      expect(result.confirmation!.signals.map((s) => `${s.type}:${s.signal}`)).toContain(
        "STRUCTURE_BREAK:negative",
      );
    },
  );

  it("holds a close exactly at the zone's ceiling at wait, with too little confirmation", () => {
    const result = runAnalysis(zoneRetest(RETEST_ZONE.high));

    expect(result.setup!.entry.priceInZone).toBe(true);
    expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(branchOf(result)).toBe<Branch>("CONFIRMATION_NOT_PRESENT");
  });
});

describe("D2: a close above the zone", () => {
  it.each(ABOVE)("says price has not reached the zone when the candle closed at %s", (close) => {
    const result = runAnalysis(zoneRetest(close));

    expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(branchOf(result)).toBe<Branch>("PRICE_NOT_IN_ZONE");
    expect(result.setup!.entry.priceInZone).toBe(false);
  });

  it("holds a bullish rejection through the zone at wait while recording confirmation", () => {
    const result = runAnalysis(zoneRetestRejection());

    expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(branchOf(result)).toBe<Branch>("PRICE_NOT_IN_ZONE");
    expect(result.statusReason).toMatch(/has not reached the entry zone/);
    expect(result.confirmation!.status).toBe("PRESENT");
    expect(result.confirmation!.signals.map((s) => `${s.type}:${s.signal}`)).toEqual(
      expect.arrayContaining(["BULLISH_REJECTION:positive", "HIGHER_LOW:positive"]),
    );
    expect(lifecycleStatusFor(result)).toBe("CONFIRMATION_DETECTED");
  });

  it("closes at 108, the top of its range, and still reads as not reached", () => {
    const result = runAnalysis(zoneRetest(108));

    expect(result.confirmation!.signals.map((s) => `${s.type}:${s.signal}`)).toContain(
      "BULLISH_REJECTION:positive",
    );
    expect(branchOf(result)).toBe<Branch>("PRICE_NOT_IN_ZONE");
  });
});

describe("golden file: zone location boundaries", () => {
  it("pins the zones and the verdict for every close", async () => {
    const cases: [string, ReturnType<typeof zoneRetest>][] = [
      ...RETEST_CLOSES.map((close): [string, ReturnType<typeof zoneRetest>] => [
        `zoneRetest@${close}`,
        zoneRetest(close),
      ]),
      ["zoneRetestRejection", zoneRetestRejection()],
    ];

    const lines = cases.map(([id, candles]) => {
      const zones = detectZones(candles);
      const result = runAnalysis(candles);
      return line(id, {
        zones: {
          support: zones.support.map(zoneOf),
          resistance: zones.resistance.map(zoneOf),
        },
        branch: branchOf(result),
        lifecycle: lifecycleStatusFor(result),
        decision: decisionOf(result),
      });
    });

    await expect(
      goldenFile("Zone location boundaries (audit D1/D2): zones, branch, decision", lines),
    ).toMatchFileSnapshot("./__golden__/zones.boundaries.golden.txt");
  });
});
