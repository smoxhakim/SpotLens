import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Candle } from "@/lib/market-data/provider";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";

/**
 * The manual analysis routes never create or move a setup from data that is
 * stale, or without the higher timeframe the analysis needs.
 *
 * `getCandles` answers from the cache, flagged `stale: true`, when the exchange
 * fails. And a timeframe with a higher one (H1 → H4) needs that higher read
 * before it can be a potential setup: the counter-trend veto lives there. In
 * either case the analysis is still returned — marked `incomplete` when the
 * higher timeframe is the problem — but never as POTENTIAL_SETUP, and the
 * lifecycle is not touched. Every dependency is a stub; no database, no network.
 */

const PAIR = "11111111-1111-4111-8111-111111111111";

/** The textbook potential setup, moved so its last candle closed a moment ago. */
function recent(candles: Candle[]): Candle[] {
  const shift = Date.now() - 60_000 - candles.at(-1)!.closeTime;
  return candles.map((c) => ({
    ...c,
    openTime: c.openTime + shift,
    closeTime: c.closeTime + shift,
  }));
}
const FRESH = recent(pullbackIntoSupport());
/** The same series as it was a day ago: the newest candles are missing. */
const BEHIND = FRESH.slice(0, -30);

const getCandles = vi.fn();
vi.mock("@/services/candles", () => ({ getCandles: (q: unknown) => getCandles(q) }));

const trackSetup = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
  action: "NONE",
  setupId: null,
  status: null,
}));
vi.mock("@/services/setups", () => ({ trackSetup: (i: unknown) => trackSetup(i) }));

vi.mock("@/services/snapshots", () => ({ saveAnalysisSnapshot: async () => "snapshot-1" }));
vi.mock("@/services/markets", () => ({
  findMarketByPairId: async () => ({ pairId: PAIR, exchangeSymbol: "BTCUSDT", label: "BTC/USDT" }),
}));
vi.mock("@/lib/auth", () => ({ currentUserId: async () => "user-1" }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMITS: { analysis: {} },
  enforceRateLimit: async () => null,
}));

const run = await import("./run/route");
const mtf = await import("./mtf/route");

function post(body: unknown) {
  return new NextRequest("http://localhost/api/analysis", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

type Served = { candles: Candle[]; stale?: boolean } | "THROW";

/** What the cache answers for each timeframe. */
function serve(byTimeframe: Record<string, Served>) {
  getCandles.mockImplementation(async (q: { timeframe: string }) => {
    const served = byTimeframe[q.timeframe];
    if (served === "THROW") throw new Error("fetch failed");
    return {
      candles: served.candles,
      stale: served.stale ?? false,
      source: served.stale ? "cache-stale" : "provider",
    };
  });
}

async function analyse(route: typeof run | typeof mtf, body: unknown) {
  const res = await route.POST(post(body));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result: {
      status: string;
      incomplete: { scope: string; gap: string; timeframe: string } | null;
    };
  };
}

beforeEach(() => {
  getCandles.mockReset();
  trackSetup.mockClear();
});

describe("POST /api/analysis/mtf — the full analysis", () => {
  const body = { tradingPairId: PAIR, lowerTimeframe: "H1", higherTimeframe: "H4" };

  it("fresh H1 and H4: complete, a potential setup, and tracked", async () => {
    serve({ H1: { candles: FRESH }, H4: { candles: FRESH } });
    const { result } = await analyse(mtf, body);

    expect(result.incomplete).toBeNull();
    expect(result.status).toBe("POTENTIAL_SETUP");
    expect(trackSetup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stale (served from cache)", { candles: FRESH, stale: true } as Served, "STALE"],
    ["stale (newest candles missing)", { candles: BEHIND } as Served, "STALE"],
    ["unavailable (fetch failed)", "THROW" as Served, "UNAVAILABLE"],
    ["insufficient", { candles: FRESH.slice(-20) } as Served, "INSUFFICIENT"],
    ["invalid (out of order)", { candles: [...FRESH].reverse() } as Served, "INVALID"],
  ])("H4 %s: incomplete, held at wait, not tracked", async (_name, h4, gap) => {
    serve({ H1: { candles: FRESH }, H4: h4 });
    const { result } = await analyse(mtf, body);

    expect(result.incomplete).toMatchObject({ scope: "HIGHER", timeframe: "H4", gap });
    expect(result.status).not.toBe("POTENTIAL_SETUP");
    expect(trackSetup).not.toHaveBeenCalled();
  });

  it("recovers when valid H4 data returns", async () => {
    serve({ H1: { candles: FRESH }, H4: { candles: FRESH, stale: true } });
    expect((await analyse(mtf, body)).result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(trackSetup).not.toHaveBeenCalled();

    serve({ H1: { candles: FRESH }, H4: { candles: FRESH } });
    const { result } = await analyse(mtf, body);
    expect(result).toMatchObject({ status: "POTENTIAL_SETUP", incomplete: null });
    expect(trackSetup).toHaveBeenCalledTimes(1);
  });

  it("stale H1 (entry) candles: incomplete on H1, never potential, not tracked", async () => {
    // Fresh, valid H4 — and the H1 series alone would be a potential setup.
    serve({ H1: { candles: FRESH, stale: true }, H4: { candles: FRESH } });
    const { result } = await analyse(mtf, body);

    expect(result.incomplete).toMatchObject({ scope: "ENTRY", timeframe: "H1", gap: "STALE" });
    expect(result.status).not.toBe("POTENTIAL_SETUP");
    expect(trackSetup).not.toHaveBeenCalled();
  });

  it("stale entry candles take precedence over an unusable H4", async () => {
    serve({ H1: { candles: FRESH, stale: true }, H4: "THROW" });
    const { result } = await analyse(mtf, body);
    expect(result.incomplete).toMatchObject({ scope: "ENTRY", timeframe: "H1" });
  });

  it("a higher-timeframe shortfall is scoped to the higher timeframe", async () => {
    serve({ H1: { candles: FRESH }, H4: "THROW" });
    const { result } = await analyse(mtf, body);
    expect(result.incomplete).toMatchObject({ scope: "HIGHER", timeframe: "H4" });
  });
});

describe("POST /api/analysis/run — single-timeframe by design", () => {
  it("H1: the H4 trend was not checked, so informational only — never potential, never tracked", async () => {
    serve({ H1: { candles: FRESH } });
    const { result } = await analyse(run, { tradingPairId: PAIR, timeframe: "H1" });

    expect(result.incomplete).toMatchObject({
      scope: "HIGHER",
      timeframe: "H4",
      gap: "NOT_CHECKED",
    });
    expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(trackSetup).not.toHaveBeenCalled();
  });

  it("W1, which has no higher timeframe: complete and tracked as before", async () => {
    serve({ W1: { candles: FRESH } });
    const { result } = await analyse(run, { tradingPairId: PAIR, timeframe: "W1" });

    expect(result.incomplete).toBeNull();
    expect(trackSetup).toHaveBeenCalledTimes(1);
  });

  it("stale W1 candles: incomplete on W1, never potential, not tracked", async () => {
    serve({ W1: { candles: FRESH, stale: true } });
    const { result } = await analyse(run, { tradingPairId: PAIR, timeframe: "W1" });

    expect(result.incomplete).toMatchObject({ scope: "ENTRY", timeframe: "W1", gap: "STALE" });
    expect(result.status).not.toBe("POTENTIAL_SETUP");
    expect(trackSetup).not.toHaveBeenCalled();
  });

  it("stale H1 candles: reported as stale entry data, ahead of the unchecked H4", async () => {
    serve({ H1: { candles: FRESH, stale: true } });
    const { result } = await analyse(run, { tradingPairId: PAIR, timeframe: "H1" });

    expect(result.incomplete).toMatchObject({ scope: "ENTRY", timeframe: "H1", gap: "STALE" });
    expect(result.status).not.toBe("POTENTIAL_SETUP");
    expect(trackSetup).not.toHaveBeenCalled();
  });
});
