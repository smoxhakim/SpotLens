import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who a headless scan writes against.
 *
 * This decides the owner of every `TrackedSetup`, every `SetupEvent` and every
 * `Notification` a pass produces, and it had no test at all — which is how the
 * defect it now guards against reached production and survived several audits.
 *
 * The old behaviour took the oldest account whenever `SCANNER_USER_EMAIL` was
 * unset. Correct for the single-user application this is, and silently wrong
 * the moment a second account appeared: the scanner tracked setups for one
 * account while Telegram was connected to another, so notifications went to a
 * chat nobody was watching and nothing reported it. It looked exactly like a
 * broken Telegram integration, and was diagnosed as one twice.
 */

const userFindUnique = vi.fn();
const userFindMany = vi.fn();
const userCount = vi.fn();
const dbState = { configured: true };

vi.mock("@/lib/db/prisma", () => ({
  get isDatabaseConfigured() {
    return dbState.configured;
  },
  prisma: {
    user: {
      findUnique: (a: unknown) => userFindUnique(a),
      findMany: (a: unknown) => userFindMany(a),
      count: () => userCount(),
    },
  },
}));

const { resolveScannerUser, describeScannerUserFailure } = await import("./scanner");

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  userFindUnique.mockReset();
  userFindMany.mockReset();
  userCount.mockReset();
  dbState.configured = true;
});

describe("an explicitly configured owner", () => {
  it("resolves exactly that account", async () => {
    userFindUnique.mockResolvedValue({ id: OWNER });

    const result = await resolveScannerUser("scanner@spotlens.local");

    expect(result).toEqual({ ok: true, userId: OWNER });
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { email: "scanner@spotlens.local" },
      select: { id: true },
    });
    // Named directly — never chosen from a list, however short.
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it("ignores surrounding whitespace, which a .env line collects easily", async () => {
    userFindUnique.mockResolvedValue({ id: OWNER });

    await resolveScannerUser("  scanner@spotlens.local  ");

    expect(userFindUnique.mock.calls[0][0].where.email).toBe("scanner@spotlens.local");
  });

  it("treats an empty value as unset rather than as an address", async () => {
    userFindMany.mockResolvedValue([{ id: OWNER }]);

    expect(await resolveScannerUser("   ")).toEqual({ ok: true, userId: OWNER });
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("fails when the configured address has no account", async () => {
    userFindUnique.mockResolvedValue(null);

    const result = await resolveScannerUser("typo@spotlens.local");

    expect(result).toEqual({
      ok: false,
      failure: { reason: "CONFIGURED_USER_MISSING", email: "typo@spotlens.local" },
    });
    // And does not quietly fall back to whoever happens to exist.
    expect(userFindMany).not.toHaveBeenCalled();
  });
});

describe("no configured owner", () => {
  it("uses the only account when there is exactly one", async () => {
    // The single-user case still needs no configuration. Requiring a variable
    // to name the only possible answer would be a setup step that prevents
    // nothing.
    userFindMany.mockResolvedValue([{ id: OWNER }]);

    expect(await resolveScannerUser(undefined)).toEqual({ ok: true, userId: OWNER });
  });

  it("fails closed once a second account exists", async () => {
    userFindMany.mockResolvedValue([{ id: OWNER }, { id: OTHER }]);
    userCount.mockResolvedValue(2);

    const result = await resolveScannerUser(undefined);

    expect(result).toEqual({ ok: false, failure: { reason: "AMBIGUOUS", count: 2 } });
  });

  it("never selects by account age", async () => {
    // The regression itself. Whatever order the rows arrive in, ambiguity is
    // refused rather than resolved by picking the oldest or the newest.
    userFindMany.mockResolvedValue([{ id: OWNER }, { id: OTHER }]);
    userCount.mockResolvedValue(2);

    const result = await resolveScannerUser(undefined);

    expect(result.ok).toBe(false);
    // No ordering is requested at all, so no ordering can be relied on.
    expect(JSON.stringify(userFindMany.mock.calls[0][0] ?? {})).not.toMatch(/orderBy|createdAt/);
  });

  it("reports the real number of accounts, not the two it stopped counting at", async () => {
    // Only two rows are read — enough to know the answer is ambiguous — and the
    // count for the message is asked for separately.
    userFindMany.mockResolvedValue([{ id: OWNER }, { id: OTHER }]);
    userCount.mockResolvedValue(7);

    const result = await resolveScannerUser(undefined);

    expect(result).toEqual({ ok: false, failure: { reason: "AMBIGUOUS", count: 7 } });
    expect(userFindMany.mock.calls[0][0].take).toBe(2);
  });

  it("keeps the existing answer when there are no accounts at all", async () => {
    userFindMany.mockResolvedValue([]);

    expect(await resolveScannerUser(undefined)).toEqual({
      ok: false,
      failure: { reason: "NO_USERS" },
    });
  });

  it("refuses when there is no database to ask", async () => {
    dbState.configured = false;

    expect(await resolveScannerUser(undefined)).toEqual({
      ok: false,
      failure: { reason: "NO_DATABASE" },
    });
    expect(userFindMany).not.toHaveBeenCalled();
  });
});

describe("the message the operator sees", () => {
  const failures = [
    { reason: "NO_DATABASE" as const },
    { reason: "NO_USERS" as const },
    { reason: "CONFIGURED_USER_MISSING" as const, email: "typo@spotlens.local" },
    { reason: "AMBIGUOUS" as const, count: 2 },
  ];

  it("tells the operator what to do in every case", async () => {
    for (const failure of failures) {
      const message = describeScannerUserFailure(failure);

      expect(message.length).toBeGreaterThan(30);
      // Each one names the thing to change: a variable, a page, or a setting.
      expect(message).toMatch(/SCANNER_USER_EMAIL|\/register|DATABASE_URL/);
    }
  });

  it("names the variable and the address when the address is wrong", async () => {
    const message = describeScannerUserFailure(failures[2]);

    expect(message).toContain("SCANNER_USER_EMAIL");
    expect(message).toContain("typo@spotlens.local");
  });

  it("explains why ambiguity is refused rather than guessed", async () => {
    const message = describeScannerUserFailure(failures[3]);

    expect(message).toContain("2 accounts");
    expect(message).toMatch(/notification/i);
    expect(message).toContain("SCANNER_USER_EMAIL");
  });

  it("never carries a secret", async () => {
    // An email is what the operator typed into their own configuration. A
    // connection string, a token or a password is not, and none is ever named.
    for (const failure of failures) {
      const message = describeScannerUserFailure(failure);

      expect(message).not.toMatch(/postgres(ql)?:\/\//);
      expect(message).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
      expect(message).not.toMatch(/DIRECT_URL|AUTH_SECRET|TELEGRAM_BOT_TOKEN|OPENAI_API_KEY/);
      expect(message).not.toMatch(/password/i);
    }
  });
});
