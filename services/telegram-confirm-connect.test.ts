import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two bots, two bindings, and nothing shared between them.
 *
 * A confirmation binding that silently reused the main bot's chat would look
 * connected in Settings and answer 403 on every send — Telegram will not let a
 * bot message somebody who has never started a chat with *that* bot. This file
 * asserts the separation at every point it could leak: the row, the update
 * cursor, the pending code, the preference switch and the disconnect.
 */

const db = {
  telegramConnection: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  notificationPreference: { upsert: vi.fn(), findUnique: vi.fn() },
  notification: { create: vi.fn(), update: vi.fn() },
};

vi.mock("@/lib/db/prisma", () => ({ isDatabaseConfigured: true, prisma: db }));

const getTelegramUpdates = vi.fn();
const sendTelegramMessage = vi.fn();
vi.mock("@/lib/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notifications")>("@/lib/notifications");
  return {
    ...actual,
    getTelegramUpdates: (i: unknown) => getTelegramUpdates(i),
    sendTelegramMessage: (i: unknown) => sendTelegramMessage(i),
  };
});

const {
  beginTelegramConnection,
  claimTelegramConnection,
  disconnectTelegram,
  getTelegramStatus,
  sendTelegramTest,
} = await import("./notifications");

const { createHash } = await import("node:crypto");
const hash = (v: string) => createHash("sha256").update(v).digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  db.telegramConnection.upsert.mockResolvedValue({});
  db.telegramConnection.update.mockResolvedValue({});
  db.telegramConnection.deleteMany.mockResolvedValue({ count: 1 });
  db.notificationPreference.upsert.mockResolvedValue({
    inAppEnabled: true,
    telegramEnabled: true,
    setupDetected: true,
    confirmationDetected: true,
    setupInvalidated: true,
    structureChanged: false,
    dailySummary: false,
    systemError: true,
    confirmationAlerts: true,
  });
  getTelegramUpdates.mockResolvedValue({ ok: true, updates: [], error: null });
  sendTelegramMessage.mockResolvedValue({ ok: true, error: null, retryable: false, attempts: 1 });
});

describe("the bindings are separate rows", () => {
  it("issues a confirmation code against the confirmation binding only", async () => {
    await beginTelegramConnection("user-1", "CONFIRMATION");

    expect(db.telegramConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_bot: { userId: "user-1", bot: "CONFIRMATION" } },
        create: expect.objectContaining({ bot: "CONFIRMATION" }),
      }),
    );
  });

  it("still defaults to the main bot, so every existing caller is unchanged", async () => {
    await beginTelegramConnection("user-1");

    expect(db.telegramConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_bot: { userId: "user-1", bot: "MAIN" } },
      }),
    );
  });

  it("reads status for the bot it was asked about", async () => {
    db.telegramConnection.findUnique.mockResolvedValue(null);

    const status = await getTelegramStatus("user-1", "CONFIRMATION");

    expect(db.telegramConnection.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_bot: { userId: "user-1", bot: "CONFIRMATION" } },
      }),
    );
    expect(status.bot).toBe("CONFIRMATION");
    // Names the variable to set rather than assuming which bot is missing.
    expect(status.tokenVariable).toBe("TELEGRAM_CONFIRMATION_BOT_TOKEN");
  });
});

describe("the update cursor is per bot", () => {
  it("polls the confirmation bot with the confirmation binding's own offset", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      userId: "user-1",
      bot: "CONFIRMATION",
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: new Date(Date.now() + 60_000),
      claimAttempts: 0,
      lastUpdateId: BigInt(11),
    });

    await claimTelegramConnection("user-1", "CONFIRMATION");

    // Sharing a cursor would let one bot's poll swallow the message the other
    // was waiting for — the user would send the code and nothing would happen.
    expect(getTelegramUpdates).toHaveBeenCalledWith({ offset: 12, bot: "CONFIRMATION" });
  });
});

describe("connecting one bot does not touch the other", () => {
  it("turns on confirmation alerts, not the main Telegram channel", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      userId: "user-1",
      bot: "CONFIRMATION",
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: new Date(Date.now() + 60_000),
      claimAttempts: 0,
      lastUpdateId: null,
    });
    getTelegramUpdates.mockResolvedValue({
      ok: true,
      updates: [{ updateId: 5, chatId: "99", chatLabel: "@me", text: "/start ABCD2345" }],
      error: null,
    });

    const result = await claimTelegramConnection("user-1", "CONFIRMATION");

    expect(result.status).toBe("CONNECTED");
    // The main channel may have been left off deliberately; binding a second
    // bot must not decide that for the user.
    expect(db.notificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { confirmationAlerts: true } }),
    );
    expect(db.telegramConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_bot: { userId: "user-1", bot: "CONFIRMATION" } },
      }),
    );
  });

  it("still turns on the main channel when the main bot is bound", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      userId: "user-1",
      bot: "MAIN",
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: new Date(Date.now() + 60_000),
      claimAttempts: 0,
      lastUpdateId: null,
    });
    getTelegramUpdates.mockResolvedValue({
      ok: true,
      updates: [{ updateId: 5, chatId: "99", chatLabel: "@me", text: "ABCD2345" }],
      error: null,
    });

    await claimTelegramConnection("user-1");

    expect(db.notificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { telegramEnabled: true } }),
    );
  });
});

describe("disconnecting is scoped to one bot", () => {
  it("leaves the main binding alone when confirmation is disconnected", async () => {
    await disconnectTelegram("user-1", "CONFIRMATION");

    expect(db.telegramConnection.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", bot: "CONFIRMATION" },
    });
    expect(db.notificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { confirmationAlerts: false } }),
    );
  });

  it("leaves confirmation alone when the main bot is disconnected", async () => {
    await disconnectTelegram("user-1");

    expect(db.telegramConnection.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", bot: "MAIN" },
    });
    expect(db.notificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { telegramEnabled: false } }),
    );
  });
});

describe("the test message", () => {
  it("sends the confirmation bot its own wording through its own bot", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({ chatId: "99" });

    const result = await sendTelegramTest("user-1", "CONFIRMATION");

    expect(result.ok).toBe(true);
    const [sent] = sendTelegramMessage.mock.calls[0];
    expect(sent.bot).toBe("CONFIRMATION");
    expect(sent.text).toContain("confirmation alerts connected");
  });

  it("says which bot is missing rather than pointing at the wrong connection", async () => {
    db.telegramConnection.findUnique.mockResolvedValue(null);

    const result = await sendTelegramTest("user-1", "CONFIRMATION");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("confirmation bot");
  });

  it("still sends the main bot its own wording", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({ chatId: "42" });

    await sendTelegramTest("user-1");

    const [sent] = sendTelegramMessage.mock.calls[0];
    expect(sent.bot).toBe("MAIN");
    expect(sent.text).toContain("SpotLens Telegram connection test successful");
  });
});
