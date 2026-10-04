import { describe, expect, it } from "vitest";

import {
  STALE_PRICE_MS,
  entryZoneEvent,
  groupBySymbol,
  initialMemory,
  mergeMemory,
  planEntryZoneWatch,
  zonePosition,
  type WatchMemory,
  type WatchedSetup,
} from "@/lib/entry-zone";
import type { SetupFacts } from "@/lib/notifications";

/**
 * The entry-zone rules, with no database and no clock.
 *
 * Every scenario here drives `planEntryZoneWatch` the way the monitor does —
 * one observation at a time, carrying memory forward only from what the
 * previous decision returned — so a sequence of prices is a sequence of real
 * decisions rather than a set of isolated assertions.
 */

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

function setup(overrides: Partial<WatchedSetup> = {}): WatchedSetup {
  return {
    setupId: "setup-btc-h1",
    userId: "user-1",
    symbol: "BTCUSDT",
    timeframe: "H1",
    entryLow: 100,
    entryHigh: 105,
    createdOutside: false,
    ...overrides,
  };
}

function quote(price: number, overrides: { symbol?: string; receivedAt?: number } = {}) {
  return { symbol: overrides.symbol ?? "BTCUSDT", price, receivedAt: overrides.receivedAt ?? NOW };
}

const FRESH: WatchMemory = { armed: false, reached: false };

/**
 * Feeds prices through the planner in order, threading memory exactly as the
 * monitor does, and returns which observations alerted.
 */
function run(prices: number[], s: WatchedSetup = setup(), start: WatchMemory = FRESH) {
  let memory = start;
  const alerts: number[] = [];
  const arms: number[] = [];

  prices.forEach((price, i) => {
    const decision = planEntryZoneWatch({ setup: s, memory, observation: quote(price), now: NOW });
    if (decision.kind !== "OBSERVED") throw new Error(`skipped at ${price}: ${decision.reason}`);
    if (decision.alert) alerts.push(i);
    if (decision.arm) arms.push(i);
    memory = decision.next;
  });

  return { alerts, arms, memory };
}

describe("zonePosition — boundaries are inside", () => {
  it.each([
    [99, "BELOW"],
    [99.99, "BELOW"],
    [100, "INSIDE"],
    [102, "INSIDE"],
    [105, "INSIDE"],
    [105.01, "ABOVE"],
    [106, "ABOVE"],
  ] as const)("price %s is %s zone 100–105", (price, expected) => {
    expect(zonePosition(price, 100, 105)).toBe(expected);
  });

  it("agrees with the boundary as stored to eight decimals", () => {
    // The snapshot is Decimal(24,8) and Binance quotes to eight decimals; both
    // parse to the same double, so a price exactly on a stored edge is inside.
    expect(zonePosition(Number("81183.28000000"), Number("81183.28"), 81423.03)).toBe("INSIDE");
    expect(zonePosition(Number("81423.03000000"), 81183.28, Number("81423.03"))).toBe("INSIDE");
    expect(zonePosition(81183.27999999, 81183.28, 81423.03)).toBe("BELOW");
  });
});

describe("transitions", () => {
  it("F. outside → inside raises ENTRY_ZONE_REACHED", () => {
    expect(run([99, 101]).alerts).toEqual([1]);
  });

  it("G. already inside → still inside raises nothing", () => {
    // Unarmed and first seen inside: it may have been there all along.
    expect(run([101, 102]).alerts).toEqual([]);
  });

  it("does not spam while price stays inside", () => {
    expect(run([99, 100.1, 100.2, 101, 102, 103]).alerts).toEqual([1]);
  });

  it("H. leaving the zone raises nothing", () => {
    expect(run([102, 106]).alerts).toEqual([]);
    expect(run([99, 102, 106]).alerts).toEqual([1]);
  });

  it("I. re-entry after the alert is silent — one alert per setup", () => {
    const { alerts, memory } = run([99, 101, 106, 103]);
    expect(alerts).toEqual([1]);
    expect(memory.reached).toBe(true);
  });

  it("I. a setup first seen inside alerts once it has left and come back", () => {
    expect(run([101, 106, 103, 99, 102]).alerts).toEqual([2]);
  });

  it("entering from below is still entering", () => {
    expect(run([99, 100]).alerts).toEqual([1]);
  });

  it("gap-through: above then below, never seen inside, raises nothing", () => {
    const { alerts, memory } = run([106, 99]);
    expect(alerts).toEqual([]);
    // Still armed: a later reading inside the zone is a real arrival.
    expect(memory.armed).toBe(true);
    expect(run([106, 99, 101]).alerts).toEqual([2]);
  });

  it("arms exactly once, on the first reading outside", () => {
    expect(run([101, 106, 99, 107]).arms).toEqual([1]);
    expect(run([106, 99]).arms).toEqual([0]);
  });

  it("a setup created outside is armed before the monitor has seen it", () => {
    const s = setup({ createdOutside: true });
    // First reading the monitor ever takes is inside: it began outside, so this
    // is an arrival — the case of the monitor starting after price moved in.
    expect(run([102], s, initialMemory(s, null)).alerts).toEqual([0]);
    // And it does not need to write anything to be armed.
    expect(run([106], s, initialMemory(s, null)).arms).toEqual([]);
  });
});

describe("restart", () => {
  it("N. reached is durable: a new process seeing price inside stays silent", () => {
    const s = setup({ createdOutside: true });
    const afterRestart = initialMemory(s, { armedAt: null, reachedAt: NOW - 60_000 });
    expect(run([102, 103], s, afterRestart).alerts).toEqual([]);
  });

  it("an armed setup interrupted before entering still alerts after a restart", () => {
    const s = setup();
    const afterRestart = initialMemory(s, { armedAt: NOW - 60_000, reachedAt: null });
    expect(afterRestart).toEqual({ armed: true, reached: false });
    expect(run([102], s, afterRestart).alerts).toEqual([0]);
  });

  it("an unarmed setup inside across a restart stays silent", () => {
    const s = setup();
    expect(run([102], s, initialMemory(s, null)).alerts).toEqual([]);
  });

  it("a reload never un-arms or un-reaches", () => {
    const inMemory: WatchMemory = { armed: true, reached: true };
    expect(mergeMemory(inMemory, { armed: false, reached: false })).toEqual(inMemory);
    // Another monitor alerted in the meantime: the reload brings that in.
    expect(mergeMemory({ armed: true, reached: false }, { armed: true, reached: true })).toEqual({
      armed: true,
      reached: true,
    });
    expect(mergeMemory(undefined, { armed: true, reached: false })).toEqual({
      armed: true,
      reached: false,
    });
  });
});

describe("isolation", () => {
  it("J. same symbol, H1 and H4: each its own zone and its own memory", () => {
    const h1 = setup({ setupId: "h1", timeframe: "H1", entryLow: 100, entryHigh: 105 });
    const h4 = setup({ setupId: "h4", timeframe: "H4", entryLow: 90, entryHigh: 95 });

    // 99 → 101: H1's zone entered from below; H4 was above its zone throughout.
    expect(run([99, 101], h1).alerts).toEqual([1]);
    expect(run([99, 101], h4).alerts).toEqual([]);
    // 96 → 94: H4's zone entered from above; H1 below its zone throughout.
    expect(run([96, 94], h4).alerts).toEqual([1]);
    expect(run([96, 94], h1).alerts).toEqual([]);

    const groups = groupBySymbol([h1, h4]);
    expect(groups.get("BTCUSDT")?.map((s) => s.setupId)).toEqual(["h1", "h4"]);
  });

  it("K. a price for one symbol is never applied to another", () => {
    const eth = setup({ setupId: "eth", symbol: "ETHUSDT" });
    const decision = planEntryZoneWatch({
      setup: eth,
      memory: { armed: true, reached: false },
      observation: quote(102, { symbol: "BTCUSDT" }),
      now: NOW,
    });
    expect(decision).toEqual({ kind: "SKIPPED", reason: "WRONG_SYMBOL" });

    const groups = groupBySymbol([setup(), eth]);
    expect([...groups.keys()]).toEqual(["BTCUSDT", "ETHUSDT"]);
  });
});

describe("freshness", () => {
  const armed: WatchMemory = { armed: true, reached: false };

  it("P. a stale price raises nothing and changes no memory", () => {
    const decision = planEntryZoneWatch({
      setup: setup(),
      memory: armed,
      observation: quote(102, { receivedAt: NOW - STALE_PRICE_MS - 1 }),
      now: NOW,
    });
    expect(decision).toEqual({ kind: "SKIPPED", reason: "STALE" });
  });

  it("a price exactly at the freshness limit is still usable", () => {
    const decision = planEntryZoneWatch({
      setup: setup(),
      memory: armed,
      observation: quote(102, { receivedAt: NOW - STALE_PRICE_MS }),
      now: NOW,
    });
    expect(decision.kind === "OBSERVED" && decision.alert).toBe(true);
  });

  it("a price from the future is not a reading of now", () => {
    const decision = planEntryZoneWatch({
      setup: setup(),
      memory: armed,
      observation: quote(102, { receivedAt: NOW + 5_000 }),
      now: NOW,
    });
    expect(decision).toEqual({ kind: "SKIPPED", reason: "STALE" });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("price %s is never a price", (price) => {
    const decision = planEntryZoneWatch({
      setup: setup(),
      memory: armed,
      observation: quote(price),
      now: NOW,
    });
    expect(decision).toEqual({ kind: "SKIPPED", reason: "INVALID_PRICE" });
  });

  it("honours a caller's tighter freshness limit", () => {
    const decision = planEntryZoneWatch({
      setup: setup(),
      memory: armed,
      observation: quote(102, { receivedAt: NOW - 2_000 }),
      now: NOW,
      staleAfterMs: 1_000,
    });
    expect(decision).toEqual({ kind: "SKIPPED", reason: "STALE" });
  });
});

describe("entryZoneEvent", () => {
  const facts = { setupId: "setup-btc-h1", entryLow: 100, entryHigh: 105 } as SetupFacts;

  it("is addressed to the setup's owner and keyed on the setup alone", () => {
    const event = entryZoneEvent({
      setup: setup({ userId: "owner-7" }),
      facts,
      observation: quote(101.5),
    });

    expect(event).toMatchObject({
      type: "ENTRY_ZONE_REACHED",
      userId: "owner-7",
      asset: "BTCUSDT",
      timeframe: "H1",
      timestamp: NOW,
      dedupeKey: "entry-zone:setup-btc-h1",
      entryZone: { observedPrice: 101.5, observedAt: NOW },
    });
    // The levels are the stored facts, passed through untouched.
    expect(event.setup).toBe(facts);
  });

  it("the key does not depend on price or time, so a repeat cannot be new", () => {
    const a = entryZoneEvent({ setup: setup(), facts, observation: quote(101) });
    const b = entryZoneEvent({
      setup: setup(),
      facts,
      observation: quote(104, { receivedAt: NOW + 3_600_000 }),
    });
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(
      entryZoneEvent({ setup: setup({ setupId: "replacement" }), facts, observation: quote(101) })
        .dedupeKey,
    ).not.toBe(a.dedupeKey);
  });
});
