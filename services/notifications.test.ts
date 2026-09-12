import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationEvent } from "@/lib/notifications";

/**
 * Delivery behaviour: who gets told, once, and what happens when the channel
 * is broken. The database is stubbed so these are about the routing rules
 * rather than about Prisma.
 */

const db = {
  notification: {
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  },
  notificationPreference: { findUnique: vi.fn(), upsert: vi.fn() },
  telegramConnection: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
};

vi.mock("@/lib/db/prisma", () => ({ isDatabaseConfigured: true, prisma: db }));

const sendTelegramMessage = vi.fn();
vi.mock("@/lib/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notifications")>("@/lib/notifications");
  return { ...actual, sendTelegramMessage: (i: unknown) => sendTelegramMessage(i) };
});

const { deliverEvents, markRead, markAllRead } = await import("./notifications");

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    type: "CONFIRMATION_DETECTED",
    userId: "user-1",
    priority: "HIGH",
    asset: "BTCUSDT",
    timeframe: "H1",
    timestamp: Date.UTC(2026, 0, 2),
    dedupeKey: "setup-event:e1",
    setup: {
      setupId: "setup-1",
      lifecycleStatus: "CONFIRMATION_DETECTED",
      previousStatus: "WAITING_CONFIRMATION",
      entryLow: 100,
      entryHigh: 104,
      stopLoss: 96,
      takeProfit1: 118,
      takeProfit2: null,
      riskReward: 2.1,
      riskRewardIsSynthetic: false,
      score: 79,
      scoreGrade: "STRONG",
      analysisStatus: "WAIT_FOR_CONFIRMATION",
      trend: "BULLISH",
      mtfAgreement: null,
      supportLow: 100,
      supportHigh: 104,
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
    },
    summary: null,
    systemError: null,
    ...overrides,
  };
}

const PREFS = {
  inAppEnabled: true,
  telegramEnabled: true,
  setupDetected: true,
  confirmationDetected: true,
  setupInvalidated: true,
  structureChanged: true,
  dailySummary: true,
  systemError: true,
};

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.notificationPreference.findUnique.mockResolvedValue(PREFS);
  db.telegramConnection.findUnique.mockResolvedValue({ chatId: "42" });
  db.notification.create.mockResolvedValue({ id: "n1" });
  db.notification.update.mockResolvedValue({});
  sendTelegramMessage.mockResolvedValue({ ok: true, error: null, retryable: false, attempts: 1 });
});

describe("preferences decide what is delivered", () => {
  it("delivers on both channels when both are enabled", async () => {
    const outcome = await deliverEvents([event()]);

    expect(outcome.created).toBe(2);
    expect(outcome.sent).toBe(2);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("sends nothing to Telegram when the channel is off", async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ ...PREFS, telegramEnabled: false });

    const outcome = await deliverEvents([event()]);

    expect(outcome.created).toBe(1);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("suppresses an event type the user turned off, on every channel at once", async () => {
    db.notificationPreference.findUnique.mockResolvedValue({
      ...PREFS,
      confirmationDetected: false,
    });

    const outcome = await deliverEvents([event()]);

    expect(outcome.suppressed).toBe(1);
    expect(outcome.created).toBe(0);
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("suppresses everything when both channels are off", async () => {
    db.notificationPreference.findUnique.mockResolvedValue({
      ...PREFS,
      inAppEnabled: false,
      telegramEnabled: false,
    });

    expect((await deliverEvents([event()])).suppressed).toBe(1);
  });

  it("falls back to the defaults for a user with no row", async () => {
    db.notificationPreference.findUnique.mockResolvedValue(null);

    // In-app is on and Telegram is off until a chat is bound, so a potential
    // setup is recorded on exactly one channel.
    const outcome = await deliverEvents([event({ type: "SETUP_DETECTED" })]);

    expect(outcome.suppressed).toBe(0);
    expect(db.notification.create).toHaveBeenCalledTimes(1);
    expect(db.notification.create.mock.calls[0][0].data.channel).toBe("IN_APP");
  });

  it("still suppresses an event the defaults leave off", async () => {
    db.notificationPreference.findUnique.mockResolvedValue(null);

    const outcome = await deliverEvents([event({ type: "STRUCTURE_CHANGED" })]);

    expect(outcome.suppressed).toBe(1);
    expect(db.notification.create).not.toHaveBeenCalled();
  });
});

describe("deduplication", () => {
  it("writes the same event only once, whatever the caller does", async () => {
    // The unique index is the guard, not a check-then-write: two scans racing
    // cannot both decide the row is absent.
    db.notification.create
      .mockResolvedValueOnce({ id: "n1" })
      .mockResolvedValueOnce({ id: "n2" })
      .mockRejectedValue(uniqueViolation());

    await deliverEvents([event()]);
    const second = await deliverEvents([event()]);

    expect(second.created).toBe(0);
    expect(second.duplicates).toBe(2);
  });

  it("does not treat a genuinely new transition as a duplicate", async () => {
    await deliverEvents([event({ dedupeKey: "setup-event:e1" })]);
    const next = await deliverEvents([event({ dedupeKey: "setup-event:e2" })]);

    expect(next.created).toBe(2);
  });

  it("re-raises a database failure that is not the unique index", async () => {
    db.notification.create.mockRejectedValue(new Error("connection lost"));

    // Swallowed at the top level so the scanner survives, but nothing is
    // recorded as delivered.
    const outcome = await deliverEvents([event()]);

    expect(outcome.created).toBe(0);
    expect(outcome.sent).toBe(0);
  });
});

describe("failure isolation", () => {
  it("records a Telegram failure without throwing", async () => {
    sendTelegramMessage.mockResolvedValue({
      ok: false,
      error: "Telegram 500: server error",
      retryable: true,
      attempts: 3,
    });

    const outcome = await deliverEvents([event()]);

    expect(outcome.failed).toBe(1);
    // The in-app copy still landed: channels fail independently.
    expect(outcome.sent).toBe(1);

    const update = db.notification.update.mock.calls[0][0];
    expect(update.data.status).toBe("FAILED");
    expect(update.data.attempts).toBe(3);
  });

  it("marks the row FAILED when Telegram is not connected", async () => {
    db.telegramConnection.findUnique.mockResolvedValue(null);

    const outcome = await deliverEvents([event()]);

    expect(outcome.failed).toBe(1);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("never throws, whatever goes wrong underneath", async () => {
    db.notificationPreference.findUnique.mockRejectedValue(new Error("database on fire"));

    // The scanner calls this. A notification layer that can abort a scan is
    // worse than no notification layer.
    await expect(deliverEvents([event()])).resolves.toBeDefined();
  });

  it("keeps going through a batch when one event fails", async () => {
    db.notification.create
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue({ id: "n2" });

    const outcome = await deliverEvents([event({ dedupeKey: "a" }), event({ dedupeKey: "b" })]);

    expect(outcome.created).toBeGreaterThan(0);
  });
});

describe("in-app ownership", () => {
  it("scopes marking read to the owner in the query itself", async () => {
    db.notification.updateMany.mockResolvedValue({ count: 1 });

    await markRead("user-1", "n1");

    const where = db.notification.updateMany.mock.calls[0][0].where;
    expect(where.userId).toBe("user-1");
    expect(where.id).toBe("n1");
  });

  it("reports failure rather than throwing for someone else's notification", async () => {
    db.notification.updateMany.mockResolvedValue({ count: 0 });

    // The route turns this into a 404, so the endpoint cannot be used to probe
    // which ids exist on other accounts.
    expect(await markRead("user-2", "n1")).toBe(false);
  });

  it("marks all read only for the caller", async () => {
    db.notification.updateMany.mockResolvedValue({ count: 4 });

    expect(await markAllRead("user-1")).toBe(4);
    expect(db.notification.updateMany.mock.calls[0][0].where.userId).toBe("user-1");
  });
});

describe("what gets stored", () => {
  it("never stores a bot token or a raw error", async () => {
    sendTelegramMessage.mockResolvedValue({
      ok: false,
      error: "Telegram 401: Unauthorized for bot[redacted]",
      retryable: false,
      attempts: 1,
    });

    await deliverEvents([event()]);

    const stored = JSON.stringify(db.notification.update.mock.calls[0][0]);
    expect(stored).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}/);
  });

  it("records the in-app copy as sent immediately", async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ ...PREFS, telegramEnabled: false });

    await deliverEvents([event()]);

    const created = db.notification.create.mock.calls[0][0].data;
    expect(created.channel).toBe("IN_APP");
    expect(created.status).toBe("SENT");
    expect(created.priority).toBe("HIGH");
  });
});

describe("a setup replaced by one on a different level", () => {
  it("still reports the invalidation", async () => {
    // The scanner reports a replacement's invalidation with no id, because the
    // lifecycle hands back the new setup's. Dropping it would lose the single
    // most important thing this layer says: the level you were waiting on is
    // gone.
    const invalidation = event({
      type: "SETUP_INVALIDATED",
      dedupeKey: "setup-event:old-1",
      setup: {
        ...event().setup!,
        setupId: "old-setup",
        lifecycleStatus: "INVALIDATED",
        invalidationReason: "The entry no longer rests on this level.",
      },
    });

    const outcome = await deliverEvents([invalidation]);

    expect(outcome.created).toBe(2);
    const created = db.notification.create.mock.calls[0][0].data;
    expect(created.type).toBe("SETUP_INVALIDATED");
    expect(created.dedupeKey).toBe("setup-event:old-1");
  });
});

/**
 * Phase K: Telegram receives a subset, the record receives everything.
 *
 * The distinction these tests exist to protect: withholding a push is not
 * suppressing an event. A user who turns a switch on gets the row, the in-app
 * copy and the history regardless of what the routing rules decide about their
 * phone.
 */
describe("channel routing", () => {
  const quiet = [
    [
      "a re-anchored setup",
      event({
        type: "SETUP_INVALIDATED",
        setup: { ...event().setup!, isReplacement: true },
      }),
    ],
    [
      "a confirmation on a high-risk setup",
      event({
        type: "CONFIRMATION_DETECTED",
        setup: { ...event().setup!, analysisStatus: "HIGH_RISK" },
      }),
    ],
    [
      "a confirmation whose reward was never measurable",
      event({
        type: "CONFIRMATION_DETECTED",
        setup: { ...event().setup!, riskRewardIsSynthetic: true },
      }),
    ],
    ["a structure signal", event({ type: "STRUCTURE_CHANGED" })],
  ] as const;

  it.each(quiet)("records %s in-app and withholds the push", async (_name, e) => {
    const outcome = await deliverEvents([e]);

    expect(db.notification.create).toHaveBeenCalledTimes(1);
    expect(db.notification.create.mock.calls[0][0].data.channel).toBe("IN_APP");
    expect(sendTelegramMessage).not.toHaveBeenCalled();

    // Nothing was suppressed — the event exists and the user can read it.
    expect(outcome.suppressed).toBe(0);
    expect(outcome.created).toBe(1);
    expect(outcome.telegramWithheld).toBe(1);
  });

  const loud = [
    ["a potential setup", event({ type: "SETUP_DETECTED" })],
    ["a measured confirmation", event()],
    [
      "a genuine invalidation of a level that had confirmed",
      event({
        type: "SETUP_INVALIDATED",
        setup: { ...event().setup!, everConfirmed: true },
      }),
    ],
  ] as const;

  it.each(loud)("pushes %s to both channels", async (_name, e) => {
    const outcome = await deliverEvents([e]);

    expect(db.notification.create).toHaveBeenCalledTimes(2);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(outcome.telegramWithheld).toBe(0);
    expect(outcome.created).toBe(2);
  });

  it("keeps the in-app copy when Telegram is not connected at all", async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ ...PREFS, telegramEnabled: false });

    const outcome = await deliverEvents([event({ type: "STRUCTURE_CHANGED" })]);

    expect(outcome.created).toBe(1);
    // Nothing was withheld: there was no push to withhold.
    expect(outcome.telegramWithheld).toBe(0);
  });

  it("still honours the per-event switch ahead of the routing rules", async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ ...PREFS, structureChanged: false });

    const outcome = await deliverEvents([event({ type: "STRUCTURE_CHANGED" })]);

    expect(outcome.suppressed).toBe(1);
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("writes the Telegram row only for what it actually sends", async () => {
    await deliverEvents([
      event({ type: "SETUP_DETECTED", dedupeKey: "a" }),
      event({ type: "STRUCTURE_CHANGED", dedupeKey: "b" }),
    ]);

    const channels = db.notification.create.mock.calls.map(
      (call) => (call[0] as { data: { channel: string } }).data.channel,
    );

    expect(channels).toEqual(["IN_APP", "TELEGRAM", "IN_APP"]);
  });
});
