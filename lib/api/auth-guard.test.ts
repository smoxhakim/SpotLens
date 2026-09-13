import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gate, and the case it was added for.
 *
 * Sessions are JWTs rather than database rows, so a correctly signed cookie
 * outlives the account it names. Before this check, such a session passed the
 * guard and failed later on a foreign key — `P2003` surfaced as a 500 and
 * "Please try again", which could never work. These pin the four outcomes the
 * guard is responsible for, and in particular that a session naming a user who
 * is gone is refused *here*, as a 401, rather than reaching a query.
 */

const currentUserId = vi.fn();
vi.mock("@/lib/auth", () => ({ currentUserId: () => currentUserId() }));

const userFindUnique = vi.fn();
const dbState = { configured: true };

vi.mock("@/lib/db/prisma", () => ({
  get isDatabaseConfigured() {
    return dbState.configured;
  },
  prisma: { user: { findUnique: (a: unknown) => userFindUnique(a) } },
}));

const { requireUser, isDenied } = await import("./auth-guard");

const USER = "11111111-1111-4111-8111-111111111111";

/** The status and code an error result carries, without unwrapping a Response. */
async function denial(result: Awaited<ReturnType<typeof requireUser>>) {
  if (!isDenied(result)) throw new Error("expected a denial");
  const body = (await result.response.json()) as { error: { code: string; message: string } };
  return { status: result.response.status, ...body.error };
}

beforeEach(() => {
  currentUserId.mockReset();
  userFindUnique.mockReset();
  dbState.configured = true;
});

describe("requireUser", () => {
  it("admits a valid session whose user still exists", async () => {
    currentUserId.mockResolvedValue(USER);
    userFindUnique.mockResolvedValue({ id: USER });

    const result = await requireUser();

    expect(isDenied(result)).toBe(false);
    expect(result).toEqual({ userId: USER });
  });

  it("refuses a request with no session", async () => {
    currentUserId.mockResolvedValue(null);

    const result = await requireUser();

    expect(await denial(result)).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    // Nothing is looked up: there is no id to look up.
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("refuses a validly signed session whose user no longer exists", async () => {
    // The regression. The token is genuine and `currentUserId` returns an id —
    // the account behind it is simply gone, as after a database rebuild.
    currentUserId.mockResolvedValue(USER);
    userFindUnique.mockResolvedValue(null);

    const result = await requireUser();

    expect(await denial(result)).toMatchObject({ status: 401, code: "SESSION_INVALID" });
  });

  it("tells that caller to sign in again rather than to retry", async () => {
    // "Please try again" was the old answer and it could never work: retrying
    // cannot bring a deleted user back.
    currentUserId.mockResolvedValue(USER);
    userFindUnique.mockResolvedValue(null);

    const { message } = await denial(await requireUser());

    expect(message).toMatch(/sign in again/i);
    expect(message).not.toMatch(/try again/i);
  });

  it("checks the id against the primary key, selecting nothing else", async () => {
    // An indexed lookup that loads no columns — the cost of the guarantee is
    // one key probe, not a row.
    currentUserId.mockResolvedValue(USER);
    userFindUnique.mockResolvedValue({ id: USER });

    await requireUser();

    expect(userFindUnique).toHaveBeenCalledWith({ where: { id: USER }, select: { id: true } });
  });

  it("does not turn a missing database into a signed-out session", async () => {
    // Routes that need a database answer 503 themselves. Refusing here would
    // report "signed out", which is a different and wrong answer.
    dbState.configured = false;
    currentUserId.mockResolvedValue(USER);

    const result = await requireUser();

    expect(result).toEqual({ userId: USER });
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("returns the caller's own id, never one from the request", async () => {
    // Ownership is enforced downstream against this id, so the guard handing
    // back anything else would defeat every scoped query at once.
    currentUserId.mockResolvedValue(USER);
    userFindUnique.mockResolvedValue({ id: USER });

    const result = await requireUser();

    expect(isDenied(result)).toBe(false);
    if (isDenied(result)) return;
    expect(result.userId).toBe(USER);
  });
});
