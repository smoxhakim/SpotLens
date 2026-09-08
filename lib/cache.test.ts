import { describe, expect, it, vi } from "vitest";

import { memoizeAsync } from "./cache";

describe("memoizeAsync", () => {
  it("loads once and reuses the value within the ttl", async () => {
    const load = vi.fn().mockResolvedValue("value");
    const memo = memoizeAsync(load, 1000);

    expect(await memo()).toBe("value");
    expect(await memo()).toBe("value");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads after the ttl expires", async () => {
    const load = vi.fn().mockResolvedValue("value");
    const memo = memoizeAsync(load, 20);

    await memo();
    await new Promise((r) => setTimeout(r, 35));
    await memo();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one load between concurrent callers", async () => {
    // A cold cache under parallel requests must not fan out into several
    // identical queries.
    const load = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve("value"), 20)));
    const memo = memoizeAsync(load, 1000);

    const results = await Promise.all([memo(), memo(), memo()]);

    expect(results).toEqual(["value", "value", "value"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("can be invalidated", async () => {
    const load = vi.fn().mockResolvedValue("value");
    const memo = memoizeAsync(load, 10_000);

    await memo();
    memo.invalidate();
    await memo();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a rejection", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("value");
    const memo = memoizeAsync(load, 10_000);

    await expect(memo()).rejects.toThrow("boom");
    // A failed load must not poison the cache for the next caller.
    await expect(memo()).resolves.toBe("value");
  });
});
