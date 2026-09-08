import { describe, expect, it } from "vitest";

import { TIMEFRAME_MS } from "@/lib/market-data/provider";

import { currentBucketOpenTime } from "./candles";

describe("currentBucketOpenTime", () => {
  it("floors to the start of the current interval", () => {
    // 2024-01-01T00:07:30Z -> the 00:00 fifteen-minute bucket.
    const now = Date.UTC(2024, 0, 1, 0, 7, 30);
    expect(currentBucketOpenTime("M15", now)).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
  });

  it("floors hourly and four-hourly buckets", () => {
    const now = Date.UTC(2024, 0, 1, 9, 45, 0);
    expect(currentBucketOpenTime("H1", now)).toBe(Date.UTC(2024, 0, 1, 9, 0, 0));
    expect(currentBucketOpenTime("H4", now)).toBe(Date.UTC(2024, 0, 1, 8, 0, 0));
  });

  it("floors daily buckets to UTC midnight", () => {
    const now = Date.UTC(2024, 0, 1, 23, 59, 59);
    expect(currentBucketOpenTime("D1", now)).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
  });

  it("opens weekly buckets on Monday 00:00 UTC", () => {
    // 2024-01-03 is a Wednesday; its week opened Monday 2024-01-01.
    const now = Date.UTC(2024, 0, 3, 12, 0, 0);
    const open = currentBucketOpenTime("W1", now);
    expect(open).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
    expect(new Date(open).getUTCDay()).toBe(1);
  });

  it("never returns a bucket in the future", () => {
    const now = Date.now();
    for (const tf of ["M15", "H1", "H4", "D1", "W1"] as const) {
      const open = currentBucketOpenTime(tf, now);
      expect(open).toBeLessThanOrEqual(now);
      expect(now - open).toBeLessThan(TIMEFRAME_MS[tf]);
    }
  });
});
