import { beforeEach, describe, expect, it } from "vitest";

import { RATE_LIMITS, checkRateLimit, rateLimitIdentifier, resetRateLimits } from "./rate-limit";

const rule = { name: "test", limit: 3, windowMs: 1000 };

beforeEach(() => {
  resetRateLimits();
});

describe("checkRateLimit", () => {
  it("allows requests up to the limit and then refuses", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await checkRateLimit("a", rule)).ok, `request ${i + 1}`).toBe(true);
    }
    expect((await checkRateLimit("a", rule)).ok).toBe(false);
  });

  it("counts each caller separately", async () => {
    for (let i = 0; i < 3; i += 1) await checkRateLimit("a", rule);

    expect((await checkRateLimit("a", rule)).ok).toBe(false);
    expect((await checkRateLimit("b", rule)).ok).toBe(true);
  });

  it("keeps separate buckets per rule name", async () => {
    for (let i = 0; i < 3; i += 1) await checkRateLimit("a", rule);

    expect((await checkRateLimit("a", { ...rule, name: "other" })).ok).toBe(true);
  });

  it("reports how many requests remain", async () => {
    expect((await checkRateLimit("a", rule)).remaining).toBe(2);
    expect((await checkRateLimit("a", rule)).remaining).toBe(1);
    expect((await checkRateLimit("a", rule)).remaining).toBe(0);
  });

  it("frees the allowance once the window passes", async () => {
    const short = { name: "short", limit: 1, windowMs: 30 };

    expect((await checkRateLimit("a", short)).ok).toBe(true);
    expect((await checkRateLimit("a", short)).ok).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 45));
    expect((await checkRateLimit("a", short)).ok).toBe(true);
  });
});

describe("rateLimitIdentifier", () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://example.test", { headers });

  it("prefers the signed-in user over the address", () => {
    expect(rateLimitIdentifier(request({ "x-forwarded-for": "1.2.3.4" }), "u1")).toBe("user:u1");
  });

  it("uses the first address in x-forwarded-for", () => {
    expect(rateLimitIdentifier(request({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe(
      "ip:1.2.3.4",
    );
  });

  it("falls back to a shared bucket rather than an empty key", () => {
    // An empty identifier would give every anonymous caller its own unlimited
    // allowance, which is worse than sharing one.
    expect(rateLimitIdentifier(request({}))).toBe("ip:unknown");
  });
});

describe("configured limits", () => {
  it("is strictest on the most expensive route", () => {
    expect(RATE_LIMITS.backtest.limit).toBeLessThan(RATE_LIMITS.analysis.limit);
    expect(RATE_LIMITS.analysis.limit).toBeLessThan(RATE_LIMITS.marketData.limit);
  });

  it("limits account creation over a long window", () => {
    expect(RATE_LIMITS.register.windowMs).toBeGreaterThanOrEqual(60 * 60_000);
  });

  /**
   * Settings polls the claim route every three seconds while a connection code
   * is on screen. Sharing the issue-a-code bucket meant the poll exhausted it
   * in half a minute and the connection flow died silently on a 429.
   */
  it("allows the connection poll to run for a full minute", () => {
    const pollsPerMinute = 60_000 / 3_000;

    expect(RATE_LIMITS.telegramClaim.name).not.toBe(RATE_LIMITS.telegramConnect.name);
    expect(RATE_LIMITS.telegramClaim.limit).toBeGreaterThan(pollsPerMinute);
  });

  it("keeps issuing codes tighter than polling for one", () => {
    expect(RATE_LIMITS.telegramConnect.limit).toBeLessThan(RATE_LIMITS.telegramClaim.limit);
  });
});
