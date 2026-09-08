import { describe, expect, it, vi } from "vitest";

import { HIGHER_TIMEFRAME, defaultHigherTimeframe, isValidTimeframePair } from "@/lib/analysis";

import { BinanceProvider } from "./binance";
import {
  NOISY_TIMEFRAMES,
  TIMEFRAMES,
  TIMEFRAME_LABELS,
  TIMEFRAME_MS,
  isLastCandleForming,
  isNoisyTimeframe,
} from "./provider";
import { timeframeSchema } from "./schema";

describe("timeframes", () => {
  it("is ordered shortest to longest", () => {
    const durations = TIMEFRAMES.map((tf) => TIMEFRAME_MS[tf]);
    expect(durations).toEqual([...durations].sort((a, b) => a - b));
  });

  it("gives every timeframe a label, a duration and a higher pair", () => {
    for (const tf of TIMEFRAMES) {
      expect(TIMEFRAME_LABELS[tf], tf).toBeTruthy();
      expect(TIMEFRAME_MS[tf], tf).toBeGreaterThan(0);
      expect(HIGHER_TIMEFRAME, tf).toHaveProperty(tf);
    }
  });

  it("includes the one-minute and five-minute timeframes", () => {
    expect(TIMEFRAMES).toContain("M1");
    expect(TIMEFRAMES).toContain("M5");
    expect(TIMEFRAME_MS.M1).toBe(60_000);
    expect(TIMEFRAME_MS.M5).toBe(5 * 60_000);
  });

  it("pairs each timeframe with the next one up", () => {
    expect(defaultHigherTimeframe("M1")).toBe("M5");
    expect(defaultHigherTimeframe("M5")).toBe("M15");
    expect(defaultHigherTimeframe("W1")).toBeNull();
  });

  it("only accepts a genuinely higher timeframe as the bias", () => {
    expect(isValidTimeframePair("M1", "H1")).toBe(true);
    expect(isValidTimeframePair("H1", "M1")).toBe(false);
    expect(isValidTimeframePair("M5", "M5")).toBe(false);
  });

  it("validates every timeframe through one shared schema", () => {
    // Routes derive their schema from TIMEFRAMES, so adding one cannot leave a
    // stale literal list behind in some handler.
    for (const tf of TIMEFRAMES) {
      expect(timeframeSchema.safeParse(tf).success, tf).toBe(true);
    }
    expect(timeframeSchema.safeParse("M2").success).toBe(false);
  });

  it("maps every timeframe to an exchange interval", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(new URL(url).searchParams.get("interval") ?? "");
        return new Response("[]", { status: 200 });
      }),
    );

    const provider = new BinanceProvider("https://api.test");
    for (const tf of TIMEFRAMES) await provider.getCandles("BTCUSDT", tf);

    expect(seen).toEqual(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]);
    vi.unstubAllGlobals();
  });

  it("marks the sub-15-minute timeframes as noisy", () => {
    expect(NOISY_TIMEFRAMES).toEqual(["M1", "M5"]);
    expect(isNoisyTimeframe("M1")).toBe(true);
    expect(isNoisyTimeframe("H4")).toBe(false);
  });
});

describe("isLastCandleForming", () => {
  const candle = (openTime: number, closeTime: number) => ({
    openTime,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    closeTime,
  });

  it("is true while the period is still running", () => {
    expect(isLastCandleForming([candle(0, 1000)], 500)).toBe(true);
  });

  it("is false once the period has closed", () => {
    expect(isLastCandleForming([candle(0, 1000)], 1000)).toBe(false);
    expect(isLastCandleForming([candle(0, 1000)], 5000)).toBe(false);
  });

  it("is false for an empty series", () => {
    expect(isLastCandleForming([], 500)).toBe(false);
  });
});
