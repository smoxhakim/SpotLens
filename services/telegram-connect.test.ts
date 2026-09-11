import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The connection flow is the one place a mistake would let somebody attach
 * their own Telegram chat to another person's account, so it gets its own file.
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
vi.mock("@/lib/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notifications")>("@/lib/notifications");
  return { ...actual, getTelegramUpdates: (i: unknown) => getTelegramUpdates(i) };
});

const {
  beginTelegramConnection,
  claimTelegramConnection,
  MAX_CLAIM_ATTEMPTS,
  CONNECTION_CODE_TTL_MS,
} = await import("./notifications");

const { createHash } = await import("node:crypto");
const hash = (v: string) => createHash("sha256").update(v).digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  db.telegramConnection.upsert.mockResolvedValue({});
  db.telegramConnection.update.mockResolvedValue({});
  db.notificationPreference.upsert.mockResolvedValue({
    inAppEnabled: true,
    telegramEnabled: true,
    setupDetected: false,
    confirmationDetected: true,
    setupInvalidated: true,
    structureChanged: false,
    dailySummary: false,
    systemError: true,
  });
});

describe("issuing a connection code", () => {
  it("stores only the hash, never the code", async () => {
    const { code } = await beginTelegramConnection("user-1");

    const stored = JSON.stringify(db.telegramConnection.upsert.mock.calls[0][0]);
    expect(stored).not.toContain(code);
    expect(stored).toContain(hash(code));
  });

  it("issues an unpredictable code from an unambiguous alphabet", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i += 1) codes.add((await beginTelegramConnection("user-1")).code);

    expect(codes.size).toBe(50);
    for (const code of codes) {
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
      // No characters that get misread when retyped from a screen to a phone.
      expect(code).not.toMatch(/[O0I1]/);
    }
  });

  it("gives the code an expiry and resets the attempt counter", async () => {
    await beginTelegramConnection("user-1");
    const data = db.telegramConnection.upsert.mock.calls[0][0].create;

    expect(data.claimAttempts).toBe(0);
    expect(data.pendingExpires.getTime()).toBeGreaterThan(Date.now());
    expect(data.pendingExpires.getTime()).toBeLessThanOrEqual(Date.now() + CONNECTION_CODE_TTL_MS);
  });
});

describe("claiming a connection", () => {
  const future = () => new Date(Date.now() + 60_000);

  it("binds the chat when the code arrives", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: future(),
      claimAttempts: 0,
      lastUpdateId: null,
    });
    getTelegramUpdates.mockResolvedValue({
      ok: true,
      error: null,
      updates: [{ updateId: 9, chatId: "42", chatLabel: "@someone", text: "/start ABCD2345" }],
    });

    const result = await claimTelegramConnection("user-1");

    expect(result).toEqual({ status: "CONNECTED", chatLabel: "@someone" });

    const bind = db.telegramConnection.update.mock.calls.at(-1)![0].data;
    expect(bind.chatId).toBe("42");
    // The code is burned in the same write, so it cannot be replayed.
    expect(bind.pendingCodeHash).toBeNull();
    expect(bind.pendingExpires).toBeNull();
  });

  it("refuses a code that has expired", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: new Date(Date.now() - 1),
      claimAttempts: 0,
      lastUpdateId: null,
    });

    expect(await claimTelegramConnection("user-1")).toEqual({ status: "EXPIRED" });
    expect(getTelegramUpdates).not.toHaveBeenCalled();
  });

  it("refuses to reuse a code that has already been claimed", async () => {
    // After a successful bind the hash is null, so a replay finds nothing.
    db.telegramConnection.findUnique.mockResolvedValue({
      pendingCodeHash: null,
      pendingExpires: null,
      claimAttempts: 0,
      lastUpdateId: 9n,
      chatId: "42",
    });

    expect(await claimTelegramConnection("user-1")).toEqual({ status: "NO_CODE" });
  });

  it("burns the code after too many attempts, so it cannot be guessed", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: future(),
      claimAttempts: MAX_CLAIM_ATTEMPTS,
      lastUpdateId: null,
    });

    expect(await claimTelegramConnection("user-1")).toEqual({ status: "TOO_MANY_ATTEMPTS" });

    const cleared = db.telegramConnection.update.mock.calls[0][0].data;
    expect(cleared.pendingCodeHash).toBeNull();
  });

  it("does not bind on a message carrying the wrong code", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: future(),
      claimAttempts: 0,
      lastUpdateId: null,
    });
    getTelegramUpdates.mockResolvedValue({
      ok: true,
      error: null,
      updates: [{ updateId: 9, chatId: "99", chatLabel: null, text: "/start ZZZZ9999" }],
    });

    const result = await claimTelegramConnection("user-1");

    expect(result).toEqual({ status: "PENDING" });
    const writes = db.telegramConnection.update.mock.calls.map((c) => c[0].data);
    expect(writes.some((w) => "chatId" in w)).toBe(false);
  });

  /**
   * The regression that made the connection flow unusable.
   *
   * Settings polls this every three seconds while the code is on screen. When
   * every poll counted as an attempt, the ten-attempt allowance ran out thirty
   * seconds into a ten-minute window — before a user could realistically
   * switch to Telegram and send the code — and the panel reported the fresh
   * code as invalid.
   */
  it("does not spend an attempt on a poll that found nothing", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: future(),
      claimAttempts: 0,
      lastUpdateId: null,
    });
    getTelegramUpdates.mockResolvedValue({ ok: true, error: null, updates: [] });

    for (let poll = 0; poll < MAX_CLAIM_ATTEMPTS * 3; poll += 1) {
      expect((await claimTelegramConnection("user-1")).status).toBe("PENDING");
    }

    const writes = db.telegramConnection.update.mock.calls.map((c) => c[0].data);
    expect(writes.some((w) => "claimAttempts" in w)).toBe(false);
    expect(writes.some((w) => w.pendingCodeHash === null)).toBe(false);
  });

  it("spends an attempt on a message that carried a wrong code", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: future(),
      claimAttempts: 0,
      lastUpdateId: null,
    });
    getTelegramUpdates.mockResolvedValue({
      ok: true,
      error: null,
      updates: [
        { updateId: 1, chatId: "99", chatLabel: null, text: "ZZZZ9999" },
        { updateId: 2, chatId: "99", chatLabel: null, text: "/start YYYY8888" },
      ],
    });

    expect((await claimTelegramConnection("user-1")).status).toBe("PENDING");

    const write = db.telegramConnection.update.mock.calls.at(-1)![0].data;
    expect(write.claimAttempts).toEqual({ increment: 2 });
  });

  it("ignores chat that could not be a code at all", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: future(),
      claimAttempts: 0,
      lastUpdateId: null,
    });
    getTelegramUpdates.mockResolvedValue({
      ok: true,
      error: null,
      updates: [{ updateId: 1, chatId: "99", chatLabel: null, text: "/start" }],
    });

    await claimTelegramConnection("user-1");

    const writes = db.telegramConnection.update.mock.calls.map((c) => c[0].data);
    expect(writes.some((w) => "claimAttempts" in w)).toBe(false);
  });

  it("burns the code on the guess that reaches the ceiling", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: future(),
      claimAttempts: MAX_CLAIM_ATTEMPTS - 1,
      lastUpdateId: null,
    });
    getTelegramUpdates.mockResolvedValue({
      ok: true,
      error: null,
      updates: [{ updateId: 1, chatId: "99", chatLabel: null, text: "ZZZZ9999" }],
    });

    expect(await claimTelegramConnection("user-1")).toEqual({ status: "TOO_MANY_ATTEMPTS" });

    const writes = db.telegramConnection.update.mock.calls.map((c) => c[0].data);
    expect(writes.some((w) => w.pendingCodeHash === null)).toBe(true);
  });

  it("advances the update cursor so an old message cannot be re-read", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: future(),
      claimAttempts: 0,
      lastUpdateId: 5n,
    });
    getTelegramUpdates.mockResolvedValue({ ok: true, error: null, updates: [] });

    await claimTelegramConnection("user-1");

    expect(getTelegramUpdates).toHaveBeenCalledWith({ offset: 6 });
  });

  it("reports Telegram being unavailable without binding anything", async () => {
    db.telegramConnection.findUnique.mockResolvedValue({
      pendingCodeHash: hash("ABCD2345"),
      pendingExpires: future(),
      claimAttempts: 0,
      lastUpdateId: null,
    });
    getTelegramUpdates.mockResolvedValue({ ok: false, updates: [], error: "Telegram 500" });

    const result = await claimTelegramConnection("user-1");

    expect(result.status).toBe("UNAVAILABLE");
  });

  it("finds the code however the user sent it", async () => {
    for (const text of ["ABCD2345", "/start ABCD2345", "  abcd2345  ", "code: ABCD2345!"]) {
      vi.clearAllMocks();
      db.telegramConnection.update.mockResolvedValue({});
      db.notificationPreference.upsert.mockResolvedValue({});
      db.telegramConnection.findUnique.mockResolvedValue({
        pendingCodeHash: hash("ABCD2345"),
        pendingExpires: future(),
        claimAttempts: 0,
        lastUpdateId: null,
      });
      getTelegramUpdates.mockResolvedValue({
        ok: true,
        error: null,
        updates: [{ updateId: 1, chatId: "42", chatLabel: null, text }],
      });

      expect((await claimTelegramConnection("user-1")).status, text).toBe("CONNECTED");
    }
  });
});
