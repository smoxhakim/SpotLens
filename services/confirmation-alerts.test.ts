import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfirmationObservation, ObservedSignal } from "@/lib/confirmation-watch";
import { DEFAULT_PREFERENCES } from "@/lib/notifications";

/**
 * Confirmation delivery: which bot, how many times, and what happens when the
 * channel is broken.
 *
 * The database is stubbed so these are about the delivery rules rather than
 * about Prisma — but the one rule that cannot be stubbed away is the unique
 * index, so `P2002` is simulated explicitly wherever idempotency is the claim.
 */

const db = {
  notification: { create: vi.fn(), update: vi.fn() },
  notificationPreference: { findUnique: vi.fn() },
  setupConfirmationWatch: { findFirst: vi.fn(), upsert: vi.fn() },
  telegramConnection: { findUnique: vi.fn() },
  trackedSetup: { findFirst: vi.fn() },
};

vi.mock("@/lib/db/prisma", () => ({ isDatabaseConfigured: true, prisma: db }));

const sendTelegramMessage = vi.fn();
vi.mock("@/lib/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notifications")>("@/lib/notifications");
  return { ...actual, sendTelegramMessage: (i: unknown) => sendTelegramMessage(i) };
});

const { deliverConfirmationAlerts } = await import("./confirmation-alerts");

const SETUP_ROW = {
  entryLow: 0.05382,
  entryHigh: 0.05476,
  stopLoss: 0.05121,
  score: 90,
  riskReward: 3.3,
  riskRewardIsSynthetic: false,
};

function positive(type: ObservedSignal["type"]): ObservedSignal {
  return { type, signal: "positive", title: `${type} title`, detail: "…" };
}

function observation(overrides: Partial<ConfirmationObservation> = {}): ConfirmationObservation {
  return {
    trackedSetupId: "setup-a",
    userId: "user-1",
    symbol: "PYTHUSDT",
    timeframe: "H4",
    lifecycleStatus: "WAITING_CONFIRMATION",
    status: "NOT_PRESENT",
    signals: [positive("HIGHER_LOW")],
    evaluatedAt: Date.UTC(2026, 8, 15, 12),
    ...overrides,
  };
}

/** A stored watch row, as the service reads it back. */
function watched(announcedEvidence: string, reachedAnnounced = false) {
  return { announcedEvidence, reachedAnnounced };
}

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

let created = 0;

beforeEach(() => {
  vi.clearAllMocks();
  created = 0;

  db.notificationPreference.findUnique.mockResolvedValue({
    ...DEFAULT_PREFERENCES,
    userId: "user-1",
  });
  db.notification.create.mockImplementation(async () => ({ id: `n${(created += 1)}` }));
  db.notification.update.mockResolvedValue({});
  db.setupConfirmationWatch.findFirst.mockResolvedValue(null);
  db.setupConfirmationWatch.upsert.mockResolvedValue({});
  db.telegramConnection.findUnique.mockResolvedValue({ chatId: "42" });
  db.trackedSetup.findFirst.mockResolvedValue(SETUP_ROW);
  sendTelegramMessage.mockResolvedValue({ ok: true, error: null, retryable: false, attempts: 1 });
});

/** Notification rows written to the confirmation bot's channel. */
function telegramRows() {
  return db.notification.create.mock.calls
    .map(([arg]) => arg.data)
    .filter((d) => d.channel === "TELEGRAM_CONFIRMATION");
}

describe("the baseline", () => {
  it("records the first sight of a setup and sends nothing", async () => {
    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [observation({ signals: [positive("HIGHER_LOW"), positive("RECLAIM")] })],
    });

    expect(outcome.baselined).toBe(1);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(db.notification.create).not.toHaveBeenCalled();

    // What was already true is written down, so it is never announced later.
    expect(db.setupConfirmationWatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ announcedEvidence: "HIGHER_LOW+RECLAIM" }),
      }),
    );
  });

  it("baselines every open setup at once without a burst of messages", async () => {
    const observations = ["a", "b", "c", "d", "e"].map((id) =>
      observation({ trackedSetupId: `setup-${id}`, signals: [positive("HIGHER_LOW")] }),
    );

    const outcome = await deliverConfirmationAlerts({ userId: "user-1", observations });

    expect(outcome.baselined).toBe(5);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});

describe("idempotency", () => {
  it("sends once for new evidence and stays silent on an unchanged repeat", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched("HIGHER_LOW"));

    const first = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [
        observation({ signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")] }),
      ],
    });

    expect(first.sent).toBe(1);

    // The state now includes what was just announced, as the upsert wrote it.
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched("BULLISH_REJECTION+HIGHER_LOW"));
    sendTelegramMessage.mockClear();

    const second = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [
        observation({ signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")] }),
      ],
    });

    expect(second.sent).toBe(0);
    expect(second.quiet).toBe(1);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("sends nothing when the unique index rejects the row, whatever the state says", async () => {
    // The crash window: the row was written on an earlier pass and the state
    // update never landed, so the watcher believes this is new. The index is
    // the second guarantee, and it is the one that actually stops the message.
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched("HIGHER_LOW"));
    db.notification.create.mockRejectedValue(uniqueViolation());

    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [
        observation({ signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")] }),
      ],
    });

    expect(outcome.duplicates).toBeGreaterThan(0);
    expect(outcome.sent).toBe(0);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("advances the state even when the row was a duplicate, so the retry stops", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched("HIGHER_LOW"));
    db.notification.create.mockRejectedValue(uniqueViolation());

    await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [
        observation({ signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")] }),
      ],
    });

    expect(db.setupConfirmationWatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ announcedEvidence: "BULLISH_REJECTION+HIGHER_LOW" }),
      }),
    );
  });

  it("writes the state only after the row exists, never before", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched("HIGHER_LOW"));

    const order: string[] = [];
    db.notification.create.mockImplementation(async () => {
      order.push("row");
      return { id: "n1" };
    });
    db.setupConfirmationWatch.upsert.mockImplementation(async () => {
      order.push("state");
      return {};
    });

    await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [
        observation({ signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")] }),
      ],
    });

    // Updating the state first and crashing would lose the alert for good; this
    // order can only ever re-derive it, which the index then rejects.
    expect(order.indexOf("row")).toBeLessThan(order.indexOf("state"));
  });

  it("produces one row per channel for one alert, and no more", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));

    await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [observation({ signals: [positive("HIGHER_LOW")] })],
    });

    const channels = db.notification.create.mock.calls.map(([a]) => a.data.channel);
    expect(channels.sort()).toEqual(["IN_APP", "TELEGRAM_CONFIRMATION"]);
  });
});

describe("confirmation reached", () => {
  it("sends one message keyed on the setup", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched("HIGHER_LOW"));

    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [
        observation({
          status: "PRESENT",
          lifecycleStatus: "CONFIRMATION_DETECTED",
          signals: [positive("HIGHER_LOW"), positive("RECLAIM")],
        }),
      ],
    });

    expect(outcome.sent).toBe(1);
    expect(telegramRows()[0]).toMatchObject({
      type: "CONFIRMATION_REACHED",
      dedupeKey: "confirmation-reached:setup-a",
    });
  });

  it("sends nothing on the scans that follow", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched("HIGHER_LOW+RECLAIM", true));

    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [
        observation({
          status: "PRESENT",
          lifecycleStatus: "CONFIRMATION_DETECTED",
          signals: [positive("HIGHER_LOW"), positive("RECLAIM"), positive("VOLUME_CONFIRMATION")],
        }),
      ],
    });

    expect(outcome.sent).toBe(0);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});

describe("bot isolation", () => {
  it("only ever asks for the confirmation bot's chat", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));

    await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [observation()],
    });

    expect(db.telegramConnection.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_bot: { userId: "user-1", bot: "CONFIRMATION" } },
      }),
    );
  });

  it("only ever sends through the confirmation bot", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));

    await deliverConfirmationAlerts({ userId: "user-1", observations: [observation()] });

    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ bot: "CONFIRMATION" }),
    );
  });

  it("writes no row on the main Telegram channel", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));

    await deliverConfirmationAlerts({ userId: "user-1", observations: [observation()] });

    const channels = db.notification.create.mock.calls.map(([a]) => a.data.channel);
    expect(channels).not.toContain("TELEGRAM");
  });

  it("uses only the two confirmation event types", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));

    await deliverConfirmationAlerts({ userId: "user-1", observations: [observation()] });

    for (const [arg] of db.notification.create.mock.calls) {
      expect(["CONFIRMATION_EVIDENCE", "CONFIRMATION_REACHED"]).toContain(arg.data.type);
    }
  });
});

describe("failure isolation", () => {
  it("records a Telegram failure without throwing", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));
    sendTelegramMessage.mockResolvedValue({
      ok: false,
      error: "Telegram 500: internal",
      retryable: true,
      attempts: 3,
    });

    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [observation()],
    });

    expect(outcome.failed).toBe(1);
    expect(db.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", error: "Telegram 500: internal" }),
      }),
    );
  });

  it("marks the row failed and names the right bot when the confirmation bot is not connected", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));
    db.telegramConnection.findUnique.mockResolvedValue(null);

    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [observation()],
    });

    expect(outcome.failed).toBe(1);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    // "Telegram is not connected" would send the reader to the main bot's
    // connection, which is working fine.
    expect(db.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: expect.stringContaining("confirmation bot") }),
      }),
    );
  });

  it("keeps the in-app record when the bot is unreachable", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));
    db.telegramConnection.findUnique.mockResolvedValue(null);

    await deliverConfirmationAlerts({ userId: "user-1", observations: [observation()] });

    const channels = db.notification.create.mock.calls.map(([a]) => a.data.channel);
    expect(channels).toContain("IN_APP");
  });

  it("never throws, whatever goes wrong underneath", async () => {
    db.setupConfirmationWatch.findFirst.mockRejectedValue(new Error("connection lost"));

    await expect(
      deliverConfirmationAlerts({ userId: "user-1", observations: [observation()] }),
    ).resolves.toBeDefined();
  });

  it("keeps going through a batch when one observation fails", async () => {
    db.setupConfirmationWatch.findFirst
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue(watched(""));

    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [
        observation({ trackedSetupId: "setup-a" }),
        observation({ trackedSetupId: "setup-b" }),
      ],
    });

    expect(outcome.observed).toBe(2);
    expect(outcome.sent).toBe(1);
  });

  it("does nothing at all when preferences cannot be read", async () => {
    db.notificationPreference.findUnique.mockRejectedValue(new Error("connection lost"));

    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [observation()],
    });

    expect(outcome).toMatchObject({ observed: 0, sent: 0 });
    expect(db.notification.create).not.toHaveBeenCalled();
  });
});

describe("preferences", () => {
  it("suppresses delivery when the switch is off", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));
    db.notificationPreference.findUnique.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      confirmationAlerts: false,
      userId: "user-1",
    });

    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [observation()],
    });

    expect(outcome.suppressed).toBe(1);
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("still advances the state while the switch is off, so turning it on is not a burst", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));
    db.notificationPreference.findUnique.mockResolvedValue({
      ...DEFAULT_PREFERENCES,
      confirmationAlerts: false,
      userId: "user-1",
    });

    await deliverConfirmationAlerts({ userId: "user-1", observations: [observation()] });

    expect(db.setupConfirmationWatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ announcedEvidence: "HIGHER_LOW" }),
      }),
    );
  });
});

describe("ownership", () => {
  it("scopes the watch lookup to the owner in the query itself", async () => {
    await deliverConfirmationAlerts({ userId: "user-1", observations: [observation()] });

    expect(db.setupConfirmationWatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { trackedSetupId: "setup-a", userId: "user-1" },
      }),
    );
  });

  it("scopes the setup's levels to the owner in the query itself", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));

    await deliverConfirmationAlerts({ userId: "user-1", observations: [observation()] });

    expect(db.trackedSetup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "setup-a", userId: "user-1" } }),
    );
  });

  it("drops an observation belonging to another account rather than delivering it", async () => {
    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [observation({ userId: "user-2" })],
    });

    expect(outcome.observed).toBe(0);
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});

describe("what is stored", () => {
  it("stores no token and no raw error", async () => {
    process.env.TELEGRAM_CONFIRMATION_BOT_TOKEN = "123456:SECRET-CONFIRMATION-TOKEN";
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));

    await deliverConfirmationAlerts({ userId: "user-1", observations: [observation()] });

    const written = JSON.stringify(db.notification.create.mock.calls);
    expect(written).not.toContain("SECRET-CONFIRMATION-TOKEN");
    expect(JSON.stringify(db.notification.update.mock.calls)).not.toContain(
      "SECRET-CONFIRMATION-TOKEN",
    );

    delete process.env.TELEGRAM_CONFIRMATION_BOT_TOKEN;
  });

  it("links the row to the setup, so the app can open the right one", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));

    await deliverConfirmationAlerts({ userId: "user-1", observations: [observation()] });

    expect(telegramRows()[0]).toMatchObject({
      trackedSetupId: "setup-a",
      asset: "PYTHUSDT",
      timeframe: "H4",
    });
  });

  it("reads the levels from the immutable snapshot rather than any live analysis", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));

    await deliverConfirmationAlerts({ userId: "user-1", observations: [observation()] });

    expect(db.trackedSetup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ entryLow: true, riskRewardIsSynthetic: true }),
      }),
    );
  });

  it("records the closed candle it was judged on", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));
    const evaluatedAt = Date.UTC(2026, 8, 15, 12);

    await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [observation({ evaluatedAt })],
    });

    expect(db.setupConfirmationWatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ lastEvaluatedAt: BigInt(evaluatedAt) }),
      }),
    );
  });
});

describe("setups the watcher refuses", () => {
  it("writes nothing at all for an invalidated setup", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched("HIGHER_LOW"));

    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [
        observation({
          lifecycleStatus: "INVALIDATED",
          status: "PRESENT",
          signals: [positive("HIGHER_LOW"), positive("RECLAIM")],
        }),
      ],
    });

    expect(outcome.sent).toBe(0);
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(db.setupConfirmationWatch.upsert).not.toHaveBeenCalled();
  });

  it("writes nothing for a contradicted reading", async () => {
    db.setupConfirmationWatch.findFirst.mockResolvedValue(watched(""));

    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [observation({ status: "CONTRADICTED" })],
    });

    expect(outcome.sent).toBe(0);
    expect(db.notification.create).not.toHaveBeenCalled();
  });
});

describe("a replacement setup", () => {
  it("has its own state and can speak for itself", async () => {
    // Setup A is long-established and quiet; setup B replaced it on the same
    // market and has never been seen.
    db.setupConfirmationWatch.findFirst.mockImplementation(async ({ where }) =>
      where.trackedSetupId === "setup-a" ? watched("HIGHER_LOW+BULLISH_REJECTION") : null,
    );

    const outcome = await deliverConfirmationAlerts({
      userId: "user-1",
      observations: [
        observation({
          trackedSetupId: "setup-a",
          signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")],
        }),
        observation({ trackedSetupId: "setup-b", signals: [positive("HIGHER_LOW")] }),
      ],
    });

    // A says nothing (everything already announced); B is baselined, not
    // silenced by A's history.
    expect(outcome.quiet).toBe(1);
    expect(outcome.baselined).toBe(1);

    const baselined = db.setupConfirmationWatch.upsert.mock.calls.map(
      ([a]) => a.where.trackedSetupId,
    );
    expect(baselined).toContain("setup-b");
  });
});
