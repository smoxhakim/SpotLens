import { $Enums } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { FORBIDDEN_PHRASES } from "@/lib/coach/rules";
import { ANALYSIS_DISCLAIMER, SPOT_ONLY_NOTE } from "@/lib/constants/disclaimers";
import {
  DEFAULT_PREFERENCES,
  EVENT_PRIORITY,
  PREFERENCE_FOR_EVENT,
  TELEGRAM_TITLES,
  dedupeKeyForEntryZone,
  escape,
  formatForTelegram,
  isTelegramWorthy,
  notificationEventTypeSchema,
  renderInApp,
  telegramPriorityFor,
  toneForNotification,
  type NotificationEvent,
  type SetupFacts,
} from "@/lib/notifications";

/**
 * ENTRY_ZONE_REACHED through the notification layer: who it reaches, what it
 * says, and that every per-type table knows it exists.
 */

function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    setupId: "setup-btc-h1",
    lifecycleStatus: "WAITING_CONFIRMATION",
    previousStatus: "SETUP_FORMING",
    entryLow: 81183.28,
    entryHigh: 81423.03,
    stopLoss: 80500.5,
    takeProfit1: 84000,
    takeProfit2: null,
    riskReward: 3.3,
    riskRewardIsSynthetic: false,
    score: 87,
    scoreGrade: "STRONG",
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    trend: "BULLISH",
    mtfAgreement: null,
    supportLow: 81183.28,
    supportHigh: 81423.03,
    entryReason: "r",
    statusReason: "r",
    confirmationSignals: [],
    confirmationExplanation: null,
    invalidationReason: null,
    regime: null,
    isReplacement: false,
    replacementZoneLow: null,
    replacementZoneHigh: null,
    everConfirmed: false,
    ...overrides,
  };
}

function event(setup: Partial<SetupFacts> = {}): NotificationEvent {
  return {
    type: "ENTRY_ZONE_REACHED",
    userId: "user-1",
    priority: EVENT_PRIORITY.ENTRY_ZONE_REACHED,
    asset: "BTCUSDT",
    timeframe: "H1",
    timestamp: Date.UTC(2026, 9, 3, 12, 5),
    dedupeKey: dedupeKeyForEntryZone("setup-btc-h1"),
    setup: facts(setup),
    summary: null,
    systemError: null,
    entryZone: { observedPrice: 81400, observedAt: Date.UTC(2026, 9, 3, 12, 5) },
  };
}

describe("Telegram routing", () => {
  it("pushes a potential setup", () => {
    const e = event({ analysisStatus: "POTENTIAL_SETUP" });
    expect(telegramPriorityFor(e)).toBe("HIGH");
    expect(isTelegramWorthy(e)).toBe(true);
  });

  it("pushes a waiting setup whose reward was measured", () => {
    const e = event({ analysisStatus: "WAIT_FOR_CONFIRMATION", riskRewardIsSynthetic: false });
    expect(telegramPriorityFor(e)).toBe("MEDIUM");
    expect(isTelegramWorthy(e)).toBe(true);
  });

  it("keeps a waiting setup with a synthetic reward in-app", () => {
    expect(
      isTelegramWorthy(
        event({ analysisStatus: "WAIT_FOR_CONFIRMATION", riskRewardIsSynthetic: true }),
      ),
    ).toBe(false);
  });

  it("keeps a high-risk setup in-app, measured reward or not", () => {
    expect(
      isTelegramWorthy(event({ analysisStatus: "HIGH_RISK", riskRewardIsSynthetic: false })),
    ).toBe(false);
    expect(
      isTelegramWorthy(event({ analysisStatus: "HIGH_RISK", riskRewardIsSynthetic: true })),
    ).toBe(false);
  });

  it("keeps an event with no setup facts in-app", () => {
    expect(telegramPriorityFor({ type: "ENTRY_ZONE_REACHED", setup: null })).toBe("LOW");
  });

  it("routing reads the creation verdict, not where the lifecycle has since moved", () => {
    // A HIGH_RISK setup whose lifecycle later reached confirmation evidence is
    // still a setup the engine called high risk.
    expect(
      isTelegramWorthy(
        event({ analysisStatus: "HIGH_RISK", lifecycleStatus: "CONFIRMATION_DETECTED" }),
      ),
    ).toBe(false);
  });
});

describe("preference", () => {
  it("is governed by its own switch, on by default", () => {
    expect(PREFERENCE_FOR_EVENT.ENTRY_ZONE_REACHED).toBe("entryZoneReached");
    expect(DEFAULT_PREFERENCES.entryZoneReached).toBe(true);
  });

  it("does not share a switch with any other event", () => {
    const sharing = Object.entries(PREFERENCE_FOR_EVENT).filter(
      ([type, key]) => key === "entryZoneReached" && type !== "ENTRY_ZONE_REACHED",
    );
    expect(sharing).toEqual([]);
  });
});

describe("exhaustiveness", () => {
  const types = notificationEventTypeSchema.options;

  it("the code's event list is exactly the database enum", () => {
    expect([...types].sort()).toEqual(Object.values($Enums.NotificationEventType).sort());
    expect(types).toContain("ENTRY_ZONE_REACHED");
  });

  it("every event type has a priority and a preference", () => {
    for (const type of types) {
      expect(EVENT_PRIORITY[type], type).toBeDefined();
      expect(PREFERENCE_FOR_EVENT[type], type).toBeDefined();
      expect(DEFAULT_PREFERENCES[PREFERENCE_FOR_EVENT[type]], type).toBeTypeOf("boolean");
    }
  });

  it("has a Telegram title, a renderer and an in-app tone", () => {
    expect(TELEGRAM_TITLES.ENTRY_ZONE_REACHED).toBe("🔔 Entry zone reached");
    expect(formatForTelegram(event())).toContain("Entry zone reached");
    const { title } = renderInApp(event());
    expect(toneForNotification({ type: "ENTRY_ZONE_REACHED", title })).toBe("INFO");
    // A row whose title predates the marker still reads as informational.
    expect(toneForNotification({ type: "ENTRY_ZONE_REACHED", title: "old" })).toBe("INFO");
  });

  it("is one canonical name — no synonyms crept in", () => {
    const synonyms = types.filter((t) => /ENTRY|ZONE|PRICE_REACHED/.test(t));
    expect(synonyms).toEqual(["ENTRY_ZONE_REACHED"]);
  });
});

describe("what it says", () => {
  const inApp = renderInApp(event());
  const telegram = formatForTelegram(event());

  it("in-app: the market, the observed price, the stored zone, and what it is not", () => {
    expect(inApp.title).toBe("🔔 Entry zone reached — BTCUSDT H1");
    expect(inApp.body).toContain("81,400.00");
    expect(inApp.body).toContain("81,183.28 – 81,423.03");
    expect(inApp.body).toContain("Last scan: waiting for confirmation");
    expect(inApp.body).toContain("not confirmation");
  });

  it("Telegram: every reserved character escaped, figures from the snapshot", () => {
    expect(telegram).toContain("*Price*: 81400");
    expect(telegram).toContain("81183\\.28 – 81423\\.03");
    expect(telegram).toContain("Waiting for confirmation \\(last scan\\)");
    expect(telegram).toContain("87/100");
    expect(telegram).toContain("1:3\\.3");
    expect(telegram).toContain("3 Oct, 12:05 UTC");
  });

  it("does not present an unmeasured reward as measured", () => {
    const text = formatForTelegram(event({ riskRewardIsSynthetic: true }));
    expect(text).toContain("not measurable");
    expect(text).not.toContain("1:3\\.3");
  });

  it.each([
    ["in-app", `${inApp.title}\n${inApp.body}`],
    ["telegram", telegram],
  ])("%s never instructs a trade", (_name, text) => {
    // Both disclaimers are denials — "no trade outcome is guaranteed", "no …
    // short selling" — and a word list would flag the very sentences that make
    // the message honest. Everything else is checked.
    let lower = text.toLowerCase();
    for (const denial of [ANALYSIS_DISCLAIMER, SPOT_ONLY_NOTE]) {
      lower = lower
        .split(escape(denial).toLowerCase())
        .join(" ")
        .split(denial.toLowerCase())
        .join(" ");
    }

    expect(lower).not.toMatch(/\bbuy\b/);
    expect(lower).not.toMatch(/\bsell\b/);
    for (const banned of [
      ...FORBIDDEN_PHRASES,
      "enter now",
      "open position",
      "open a position",
      "take the trade",
    ]) {
      expect(lower, `contained "${banned}"`).not.toContain(banned);
    }
  });

  it("tells the reader to review before deciding", () => {
    expect(inApp.body).toContain("review the setup before deciding");
    expect(telegram).toContain("Review the chart before deciding");
  });
});
