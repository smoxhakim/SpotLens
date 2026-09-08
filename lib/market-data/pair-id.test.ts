import { describe, expect, it } from "vitest";

import { deterministicPairId } from "./pair-id";

describe("deterministicPairId", () => {
  it("produces a valid v5 uuid", () => {
    expect(deterministicPairId("BTCUSDT")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is stable across calls and case-insensitive", () => {
    expect(deterministicPairId("BTCUSDT")).toBe(deterministicPairId("btcusdt"));
  });

  it("gives different pairs different ids", () => {
    expect(deterministicPairId("BTCUSDT")).not.toBe(deterministicPairId("ETHUSDT"));
  });
});
