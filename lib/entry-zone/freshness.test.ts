import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_SETUP_AGE_CANDLES,
  MAX_SETUP_AGE_CANDLES_CEILING,
  SETUP_AGE_GRACE_MS,
  maxSetupAgeMs,
  parseMaxSetupAgeCandles,
  setupFreshness,
} from "@/lib/entry-zone";

/**
 * The freshness rule on its own: no clock, no database.
 *
 * "Verified" is the completion time of the last completed scan that re-confirmed
 * the setup; the service decides what counts as one. This file decides only how
 * old that may be.
 */

const H = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 17, 15, 0);

describe("setupFreshness", () => {
  it("a setup re-confirmed by the latest pass is fresh", () => {
    const v = setupFreshness({ verifiedAt: NOW - 20 * 60_000, timeframe: "H1", now: NOW });
    expect(v).toMatchObject({ fresh: true, ageMs: 20 * 60_000 });
  });

  it("the default allows one candle of the setup's timeframe plus the grace", () => {
    expect(DEFAULT_MAX_SETUP_AGE_CANDLES).toBe(1);
    expect(maxSetupAgeMs("H1", 1)).toBe(H + SETUP_AGE_GRACE_MS);
    expect(maxSetupAgeMs("H4", 1)).toBe(4 * H + SETUP_AGE_GRACE_MS);
  });

  it("exactly at the limit is still fresh; one millisecond past it is stale", () => {
    const limit = H + SETUP_AGE_GRACE_MS;
    expect(setupFreshness({ verifiedAt: NOW - limit, timeframe: "H1", now: NOW }).fresh).toBe(true);
    expect(
      setupFreshness({ verifiedAt: NOW - limit - 1, timeframe: "H1", now: NOW }),
    ).toMatchObject({ fresh: false, reason: "STALE" });
  });

  it("scales with the timeframe: two hours old is stale on H1 and fresh on H4", () => {
    const verifiedAt = NOW - 2 * H;
    expect(setupFreshness({ verifiedAt, timeframe: "H1", now: NOW }).fresh).toBe(false);
    expect(setupFreshness({ verifiedAt, timeframe: "H4", now: NOW }).fresh).toBe(true);
  });

  it("the two-week-old setup from the audit is stale", () => {
    const v = setupFreshness({ verifiedAt: NOW - 14 * 24 * H, timeframe: "H4", now: NOW });
    expect(v).toMatchObject({ fresh: false, reason: "STALE" });
  });

  it("the configured multiplier widens the limit", () => {
    const verifiedAt = NOW - 2 * H;
    expect(setupFreshness({ verifiedAt, timeframe: "H1", now: NOW, maxAgeCandles: 2 }).fresh).toBe(
      true,
    );
  });

  describe("fails closed", () => {
    it("never verified", () => {
      expect(setupFreshness({ verifiedAt: null, timeframe: "H1", now: NOW })).toMatchObject({
        fresh: false,
        reason: "NO_VERIFIED_SCAN",
      });
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -5])("verifiedAt %s is not a time", (t) => {
      expect(setupFreshness({ verifiedAt: t, timeframe: "H1", now: NOW })).toMatchObject({
        fresh: false,
        reason: "INVALID_TIMESTAMP",
      });
    });

    it("a verification from the future is a fault, not freshness", () => {
      expect(
        setupFreshness({ verifiedAt: NOW + 5 * 60_000, timeframe: "H1", now: NOW }),
      ).toMatchObject({ fresh: false, reason: "INVALID_TIMESTAMP" });
      // A few seconds of clock skew is tolerated.
      expect(setupFreshness({ verifiedAt: NOW + 5_000, timeframe: "H1", now: NOW }).fresh).toBe(
        true,
      );
    });

    it("an unknown timeframe cannot be judged", () => {
      expect(setupFreshness({ verifiedAt: NOW, timeframe: "X9" as never, now: NOW })).toMatchObject(
        { fresh: false, reason: "INVALID_TIMESTAMP" },
      );
    });

    it("an invalid multiplier cannot be judged", () => {
      for (const m of [0, -1, Number.NaN]) {
        expect(
          setupFreshness({ verifiedAt: NOW, timeframe: "H1", now: NOW, maxAgeCandles: m }),
        ).toMatchObject({ fresh: false, reason: "INVALID_TIMESTAMP" });
      }
    });
  });
});

describe("parseMaxSetupAgeCandles", () => {
  it("unset or blank means the default, silently", () => {
    expect(parseMaxSetupAgeCandles(undefined)).toEqual({ value: 1, warning: null });
    expect(parseMaxSetupAgeCandles("  ")).toEqual({ value: 1, warning: null });
  });

  it("accepts a positive number, including a fraction", () => {
    expect(parseMaxSetupAgeCandles("2")).toEqual({ value: 2, warning: null });
    expect(parseMaxSetupAgeCandles("1.5")).toEqual({ value: 1.5, warning: null });
  });

  it("a bad value falls back to the default — never to no limit", () => {
    for (const raw of ["abc", "0", "-3", "Infinity"]) {
      const parsed = parseMaxSetupAgeCandles(raw);
      expect(parsed.value).toBe(DEFAULT_MAX_SETUP_AGE_CANDLES);
      expect(parsed.warning).toMatch(/not a positive number/);
    }
  });

  it("a huge value is clamped so a typo cannot disable the guard", () => {
    const parsed = parseMaxSetupAgeCandles("10000");
    expect(parsed.value).toBe(MAX_SETUP_AGE_CANDLES_CEILING);
    expect(parsed.warning).toMatch(/above/);
  });
});
