// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TIMEFRAME_MS, type Candle, type Timeframe } from "@/lib/market-data/provider";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";

/**
 * POST /api/analysis/run on a candle still forming.
 *
 * This route is single-timeframe, so every timeframe with a higher one is
 * incomplete and never tracked. The one with no higher timeframe is complete,
 * and it is the case that matters here: the analysis is shown and recorded
 * whatever the clock says, but it may not create or move a tracked setup until
 * its last candle has closed — the rule `/api/analysis/mtf` already keeps. No
 * database, network or exchange is reached; every service is a stub.
 */

const PAIR_ID = "00000000-0000-4000-8000-000000000001";
const SCENARIO = pullbackIntoSupport();

/** The same price path on any timeframe, opening on a Monday as Binance's weeks do. */
function series(timeframe: Timeframe): Candle[] {
  const size = TIMEFRAME_MS[timeframe];
  const start = Date.UTC(2024, 0, 1);
  return SCENARIO.map((candle, i) => ({
    ...candle,
    openTime: start + i * size,
    closeTime: start + (i + 1) * size - 1,
  }));
}

const services = vi.hoisted(() => ({
  trackSetup: vi.fn(async () => ({ action: "NONE", setupId: null, status: null })),
  saveAnalysisSnapshot: vi.fn(async () => "snapshot-1"),
  candles: [] as Candle[],
}));

vi.mock("@/lib/auth", () => ({ currentUserId: async () => "user-1" }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMITS: { analysis: {} },
  enforceRateLimit: async () => null,
}));
vi.mock("@/services/markets", () => ({
  findMarketByPairId: async () => ({
    pairId: PAIR_ID,
    exchangeSymbol: "BTCUSDT",
    label: "BTC/USDT",
  }),
}));
vi.mock("@/services/candles", () => ({
  getCandles: async () => ({ candles: services.candles, stale: false }),
}));
vi.mock("@/services/setups", () => ({ trackSetup: services.trackSetup }));
vi.mock("@/services/snapshots", () => ({ saveAnalysisSnapshot: services.saveAnalysisSnapshot }));

const { POST } = await import("./route");

async function run(timeframe: Timeframe, now: number) {
  vi.setSystemTime(now);
  const response = await POST(
    new Request("http://t/api/analysis/run", {
      method: "POST",
      body: JSON.stringify({ tradingPairId: PAIR_ID, timeframe }),
    }) as never,
  );
  return { status: response.status, body: await response.json() };
}

const W1 = series("W1");
const LAST_W1 = W1.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  services.trackSetup.mockClear();
  services.saveAnalysisSnapshot.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("tracking from a manual single-timeframe analysis", () => {
  it("creates or moves no tracked setup while the weekly candle is still forming", async () => {
    services.candles = W1;
    // Mid-week: the newest weekly candle closes a day from now.
    const { status, body } = await run("W1", LAST_W1.closeTime - 24 * 60 * 60_000);

    expect(status).toBe(200);
    expect(body.result.incomplete).toBeNull();
    expect(services.trackSetup).not.toHaveBeenCalled();
    // The analysis itself is still shown and recorded, exactly as before.
    expect(services.saveAnalysisSnapshot).toHaveBeenCalledTimes(1);
    expect(body.snapshotId).toBe("snapshot-1");
  });

  it("tracks the same result it returns once the weekly candle has closed", async () => {
    services.candles = W1;
    const { status, body } = await run("W1", LAST_W1.closeTime + 1);

    expect(status).toBe(200);
    expect(services.trackSetup).toHaveBeenCalledTimes(1);
    const [input] = services.trackSetup.mock.calls[0] as unknown as [
      { result: { status: string }; timeframe: string; analysisSnapshotId: string },
    ];
    expect(input.timeframe).toBe("W1");
    expect(input.analysisSnapshotId).toBe("snapshot-1");
    expect(input.result.status).toBe(body.result.status);
  });

  it("still never tracks a timeframe whose higher one this route does not check", async () => {
    services.candles = series("H4");
    const { status, body } = await run("H4", series("H4").at(-1)!.closeTime + 1);

    expect(status).toBe(200);
    expect(body.result.incomplete).not.toBeNull();
    expect(services.trackSetup).not.toHaveBeenCalled();
  });
});
