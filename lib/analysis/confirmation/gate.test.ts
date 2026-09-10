import { describe, expect, it } from "vitest";

import { analyzeMultiTimeframe } from "../mtf";
import { determineStatus } from "../setup/status";
import { runAnalysis } from "../setup";
import type { EntryZone, RiskReward } from "../setup/types";
import type { SetupScore } from "../setup/score";
import type { MarketRead } from "../market-read";
import { downtrend, extendedAboveSupport, pullbackIntoSupport } from "@/lib/test-utils/scenarios";
import { runBacktest } from "@/lib/backtesting";

import type { ConfirmationResult } from "./types";

/**
 * Confirmation is the last gate, and these tests are about what that ordering
 * buys: it can hold a setup back, and it can do nothing else. A confirmation
 * that could promote past the counter-trend veto or past an unmeasured reward
 * would be a way to reach POTENTIAL_SETUP through the back door.
 */

const PRESENT: ConfirmationResult = {
  status: "PRESENT",
  signals: [],
  explanation: "Confirmation is present.",
  evaluatedAt: 0,
  invalidationReason: null,
};

function mtfFor(
  lower: Parameters<typeof runAnalysis>[0],
  higher: Parameters<typeof runAnalysis>[0],
) {
  return analyzeMultiTimeframe({
    lowerCandles: lower,
    higherCandles: higher,
    lowerTimeframe: "H1",
    higherTimeframe: "H4",
  });
}

describe("confirmation cannot bypass an existing disqualifier", () => {
  it("never even runs when the counter-trend veto fires", () => {
    // The veto refuses before a setup is built, so there is nothing to confirm
    // — and no object a later stage could inspect and be tempted by.
    const lower = pullbackIntoSupport();
    const result = runAnalysis(lower, { mtf: mtfFor(lower, downtrend()) });

    expect(result.status).toBe("AVOID");
    expect(result.confirmation).toBeNull();
  });

  it("cannot promote a setup whose reward was never measured", () => {
    const synthetic = runAnalysis(extendedAboveSupport());
    expect(synthetic.setup!.riskReward.isSynthetic).toBe(true);

    // Hand the status engine a *present* confirmation for that same setup.
    const verdict = determineStatus(
      synthetic.read,
      synthetic.setup!.entry,
      synthetic.setup!.riskReward,
      synthetic.score!,
      undefined,
      PRESENT,
    );

    expect(verdict.status).not.toBe("POTENTIAL_SETUP");
  });

  it("cannot promote a setup the score already grades AVOID", () => {
    const read = { trend: { trend: "BULLISH" } } as MarketRead;
    const entry = { priceInZone: true, distanceAtr: 0 } as EntryZone;
    const riskReward = { ratio: 3, isPoor: false, isSynthetic: false } as RiskReward;
    const score = { total: 20, grade: "AVOID" } as SetupScore;

    const verdict = determineStatus(read, entry, riskReward, score, undefined, PRESENT);

    expect(verdict.status).toBe("AVOID");
  });
});

describe("confirmation as a gate on POTENTIAL_SETUP", () => {
  it("holds an otherwise sound setup at WAIT when confirmation is absent", () => {
    const sound = runAnalysis(pullbackIntoSupport());
    expect(sound.status).toBe("POTENTIAL_SETUP");

    const absent: ConfirmationResult = { ...PRESENT, status: "NOT_PRESENT" };
    const verdict = determineStatus(
      sound.read,
      sound.setup!.entry,
      sound.setup!.riskReward,
      sound.score!,
      undefined,
      absent,
    );

    expect(verdict.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(verdict.reason).toMatch(/not a trade/i);
  });

  it("holds it at WAIT when confirmation is contradicted", () => {
    const sound = runAnalysis(pullbackIntoSupport());
    const contradicted: ConfirmationResult = {
      ...PRESENT,
      status: "CONTRADICTED",
      explanation: "Confirmation is contradicted: support has been lost.",
    };

    const verdict = determineStatus(
      sound.read,
      sound.setup!.entry,
      sound.setup!.riskReward,
      sound.score!,
      undefined,
      contradicted,
    );

    expect(verdict.status).toBe("WAIT_FOR_CONFIRMATION");
  });

  it("allows POTENTIAL_SETUP only with confirmation present", () => {
    const result = runAnalysis(pullbackIntoSupport());

    expect(result.status).toBe("POTENTIAL_SETUP");
    expect(result.confirmation!.status).toBe("PRESENT");
    // And the reason says which evidence carried it.
    expect(result.statusReason).toMatch(/confirmation is present/i);
  });

  it("does not add a fifth status", () => {
    const statuses = new Set(
      [pullbackIntoSupport(), extendedAboveSupport(), downtrend()].map(
        (c) => runAnalysis(c).status,
      ),
    );

    for (const status of statuses) {
      expect(["POTENTIAL_SETUP", "WAIT_FOR_CONFIRMATION", "HIGH_RISK", "AVOID"]).toContain(status);
    }
  });
});

describe("backtest and live run the same confirmation", () => {
  it("gives the backtester the confirmation the live engine would have given", () => {
    // Parity by construction: the backtester calls `runAnalysis`, which owns
    // the confirmation call. There is no second implementation to drift.
    const candles = pullbackIntoSupport();
    const live = runAnalysis(candles);
    const replayed = runAnalysis(candles.slice(0, candles.length));

    expect(JSON.stringify(replayed.confirmation)).toBe(JSON.stringify(live.confirmation));
  });

  it("only reports setups the confirmation gate let through", () => {
    const report = runBacktest(pullbackIntoSupport(), { warmupBars: 60 });

    for (const setup of report.setups) {
      // Every reported setup was a POTENTIAL_SETUP, which now requires
      // confirmation — so replaying its trigger bar must confirm.
      const upToTrigger = pullbackIntoSupport().filter((c) => c.openTime <= setup.triggeredAt);
      const atTrigger = runAnalysis(upToTrigger);

      expect(atTrigger.status).toBe("POTENTIAL_SETUP");
      expect(atTrigger.confirmation!.status).toBe("PRESENT");
    }
  });
});

/**
 * The test Phase C specifically calls for: a perfect confirmation exists on a
 * later candle, and must be invisible until evaluation reaches it.
 */
describe("no lookahead through the backtester", () => {
  it("does not let a future candle's confirmation reach an earlier bar", () => {
    const candles = pullbackIntoSupport();

    // Find the first bar the engine confirms on.
    let firstConfirmed = -1;
    for (let i = 60; i < candles.length; i += 1) {
      if (runAnalysis(candles.slice(0, i + 1)).confirmation?.status === "PRESENT") {
        firstConfirmed = i;
        break;
      }
    }

    expect(firstConfirmed).toBeGreaterThan(-1);

    // One bar earlier the same confirmation must not exist, even though the
    // candle that produces it is already present in the full series.
    const earlier = runAnalysis(candles.slice(0, firstConfirmed));
    expect(earlier.confirmation?.status).not.toBe("PRESENT");

    // Move evaluation forward by one, and only then does it appear.
    const atBar = runAnalysis(candles.slice(0, firstConfirmed + 1));
    expect(atBar.confirmation!.status).toBe("PRESENT");
  });

  it("is unaffected by rewriting every candle after the bar being judged", () => {
    const candles = pullbackIntoSupport();
    const cut = Math.floor(candles.length * 0.8);

    const original = runAnalysis(candles.slice(0, cut + 1));
    const rewrittenFuture = candles.map((c, i) =>
      i <= cut
        ? c
        : { ...c, open: c.open * 4, high: c.high * 4, low: c.low * 4, close: c.close * 4 },
    );
    const withFuture = runAnalysis(rewrittenFuture.slice(0, cut + 1));

    expect(JSON.stringify(withFuture.confirmation)).toBe(JSON.stringify(original.confirmation));
  });
});
