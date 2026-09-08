import { describe, expect, it } from "vitest";

import { makeCandles } from "@/lib/test-utils/candles";

import { analyzeVolume, averageVolume } from "./volume";

const flat = (volumes: number[]) => makeCandles(volumes.map((volume) => ({ close: 100, volume })));

describe("averageVolume", () => {
  it("averages the last `period` candles", () => {
    expect(averageVolume(flat([10, 20, 30, 40]), 4)).toBe(25);
    expect(averageVolume(flat([10, 20, 30, 40]), 2)).toBe(35);
  });

  it("returns null when there is not enough history", () => {
    expect(averageVolume(flat([10, 20]), 5)).toBeNull();
  });
});

describe("analyzeVolume", () => {
  it("excludes the latest candle from its own average", () => {
    // Ten candles at 100, then a 1000 spike. Including the spike in the average
    // would dilute exactly the thing we are trying to detect.
    const read = analyzeVolume(flat([...new Array(10).fill(100), 1000]), 10)!;

    expect(read.average).toBe(100);
    expect(read.latest).toBe(1000);
    expect(read.relative).toBe(10);
    expect(read.isAboveAverage).toBe(true);
  });

  it("does not flag a candle sitting at its average", () => {
    const read = analyzeVolume(flat(new Array(11).fill(100)), 10)!;

    expect(read.relative).toBe(1);
    expect(read.isAboveAverage).toBe(false);
    expect(read.trend).toBe("STABLE");
  });

  it("detects rising volume", () => {
    const read = analyzeVolume(
      flat([...new Array(5).fill(50), ...new Array(5).fill(150), 150]),
      10,
    )!;
    expect(read.trend).toBe("INCREASING");
  });

  it("detects falling volume", () => {
    const read = analyzeVolume(
      flat([...new Array(5).fill(150), ...new Array(5).fill(50), 50]),
      10,
    )!;
    expect(read.trend).toBe("DECREASING");
  });

  it("treats small fluctuations as stable rather than a trend", () => {
    const read = analyzeVolume(
      flat([...new Array(5).fill(100), ...new Array(5).fill(105), 100]),
      10,
    )!;
    expect(read.trend).toBe("STABLE");
  });

  it("returns null without enough history to compare against", () => {
    expect(analyzeVolume(flat(new Array(10).fill(100)), 10)).toBeNull();
    expect(analyzeVolume(flat(new Array(11).fill(100)), 10)).not.toBeNull();
  });

  it("does not divide by zero on a dead market", () => {
    const read = analyzeVolume(flat(new Array(11).fill(0)), 10)!;
    expect(read.relative).toBe(0);
    expect(read.isAboveAverage).toBe(false);
  });
});
