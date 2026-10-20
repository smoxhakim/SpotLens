import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every Telegram outcome reaches its notification row.
 *
 * The row is written PENDING before sending — its unique index is the dedupe —
 * and anything that threw before the outcome was written left it PENDING for
 * ever: never sent, never marked failed, and never tried again because the
 * dedupe key was already taken.
 */

const update = vi.fn();
vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: { notification: { update: (a: unknown) => update(a) } },
}));
const warn = vi.fn();
vi.mock("@/lib/log", () => ({ warnOnce: (...a: unknown[]) => warn(...a) }));

const { sendAndRecord, deliveryOf, NOT_SENT_ERROR } = await import("./telegram-delivery");

const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

beforeEach(() => {
  update.mockReset().mockResolvedValue({});
  warn.mockReset();
  consoleWarn.mockClear();
});

const recorded = () => update.mock.calls.map(([a]) => (a as { data: unknown }).data);

describe("sendAndRecord", () => {
  it("a send that succeeded is SENT", async () => {
    const r = await sendAndRecord({
      notificationId: "n1",
      label: "test",
      send: async () => ({ ok: true, error: null, attempts: 1 }),
    });
    expect(r).toEqual({ ok: true, recorded: true, delivery: "SENT" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "n1" },
      data: expect.objectContaining({ status: "SENT", attempts: 1, error: null }),
    });
  });

  it("a send that threw before Telegram (a database error looking up the chat) is FAILED, not PENDING", async () => {
    const r = await sendAndRecord({
      notificationId: "n1",
      label: "test",
      send: async () => {
        throw new Error("Can't reach database server at `db.example:5432`");
      },
    });
    expect(r).toEqual({ ok: false, recorded: true, delivery: "NOT_SENT" });
    expect(recorded()).toEqual([
      { status: "FAILED", sentAt: null, attempts: 0, error: NOT_SENT_ERROR },
    ]);
    // The raw error goes to the log, never to the row.
    expect(JSON.stringify(recorded())).not.toContain("db.example");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a send whose delivery is unknown is FAILED, with the provider's message", async () => {
    const error = "Telegram did not answer in time. It may have been delivered; not sent again.";
    await sendAndRecord({
      notificationId: "n1",
      label: "test",
      send: async () => ({ ok: false, error, attempts: 1 }),
    });
    expect(recorded()).toEqual([{ status: "FAILED", sentAt: null, attempts: 1, error }]);
  });

  it("the database refusing the outcome once: tried again, and recorded", async () => {
    update.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce({});
    const r = await sendAndRecord({
      notificationId: "n1",
      label: "test",
      send: async () => ({ ok: true, error: null, attempts: 1 }),
    });
    expect(r).toEqual({ ok: true, recorded: true, delivery: "SENT" });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("the database refusing it twice: reported and logged, never thrown — the row stays PENDING", async () => {
    update.mockRejectedValue(new Error("connection closed"));
    const r = await sendAndRecord({
      notificationId: "n1",
      label: "test",
      send: async () => ({ ok: true, error: null, attempts: 1 }),
    });
    expect(r).toEqual({ ok: true, recorded: false, delivery: "SENT" });
    expect(update).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "test:record",
      expect.stringMatching(/stays PENDING/),
      expect.any(Error),
    );
  });
});

describe("the log says which of the three it was, every time", () => {
  const cases = [
    [
      "NOT_SENT",
      { ok: false, error: "The confirmation bot is not connected.", attempts: 0 },
      /Telegram: not sent/,
    ],
    [
      "FAILED",
      { ok: false, error: "Telegram 400: Bad Request", attempts: 1 },
      /Telegram: failed after 1 attempt/,
    ],
    [
      "MAY_HAVE_BEEN_DELIVERED",
      { ok: false, error: "Telegram did not answer in time.", attempts: 1, deliveryUnknown: true },
      /Telegram: may have been delivered \(no answer in time\); not sent again/,
    ],
  ] as const;

  it.each(cases)("%s", async (delivery, outcome, line) => {
    const r = await sendAndRecord({
      notificationId: "n7",
      label: "test",
      send: async () => outcome,
    });
    expect(r.delivery).toBe(delivery);
    expect(deliveryOf(outcome)).toBe(delivery);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(String(consoleWarn.mock.calls[0][0])).toMatch(line);
    expect(String(consoleWarn.mock.calls[0][0])).toContain("notification n7");
    // All three are FAILED rows; the error text keeps them apart there too.
    expect(recorded()[0]).toMatchObject({ status: "FAILED", error: outcome.error });
  });

  it("a send that threw is logged as not sent on every occurrence, not only the first", async () => {
    const boom = async () => {
      throw new Error("lookup failed");
    };
    await sendAndRecord({ notificationId: "a", label: "test", send: boom });
    await sendAndRecord({ notificationId: "b", label: "test", send: boom });
    expect(consoleWarn.mock.calls.map(([m]) => String(m))).toEqual([
      expect.stringMatching(/Telegram: not sent — notification a/),
      expect.stringMatching(/Telegram: not sent — notification b/),
    ]);
  });

  it("a message that went out logs nothing", async () => {
    await sendAndRecord({
      notificationId: "n1",
      label: "test",
      send: async () => ({ ok: true, error: null, attempts: 1 }),
    });
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});
