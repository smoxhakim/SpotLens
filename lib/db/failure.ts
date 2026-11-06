/**
 * What kind of database failure an error is, from its structure.
 *
 * A pass must not count as successful unless what it wrote is stored, and what
 * happens next depends on whether the failure can pass by itself: a transient one
 * is retried, a permanent one blocks the window. So this answers one question, on
 * the properties Prisma actually sets, and says nothing about the message text.
 *
 *  - `code` on PrismaClientKnownRequestError: P2034, P1008, P1017 and the rest.
 *  - `meta.code` on P2010 (a raw query): Postgres's own SQLSTATE.
 *  - `code` on LifecycleConflictError: LIFECYCLE_CONFLICT.
 *
 * A model-query deadlock or lock timeout has no such property. Prisma throws
 * PrismaClientUnknownRequestError with no `code` and no `meta`, and the SQLSTATE
 * exists only in the message, which is deliberately not read: a later Prisma can
 * reword it, and a wrong guess here would retry something that will not change. So
 * it is permanent. The consequence is bounded and accepted: that pass is blocked
 * for one window, is never called a success, and the next window tries again. It
 * takes a writer outside the lifecycle lock holding a row to reach it.
 * `failure.db.test.ts` pins these shapes against a real client.
 *
 * Pure, and no Prisma import: shapes only, so `lib/scanner` can use it.
 */

export type DatabaseFailureClass = "TRANSIENT" | "PERMANENT";

export interface DatabaseFailure {
  /** A stable token, never free text: a Prisma code, a SQLSTATE, or one of ours. */
  code: string;
  class: DatabaseFailureClass;
}

/** Connection-level or conflict-level: the same statement can work next time. */
const TRANSIENT = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2028",
  "P2034",
  "55P03",
  "40001",
  "40P01",
  "LIFECYCLE_CONFLICT",
]);

const CODELESS = new Set(["PrismaClientUnknownRequestError", "PrismaClientRustPanicError"]);

/** Null when the error is not a database error at all. */
export function databaseFailureOf(err: unknown): DatabaseFailure | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    name?: unknown;
    code?: unknown;
    errorCode?: unknown;
    meta?: { code?: unknown };
    message?: unknown;
  };

  if (e.name === "PrismaClientInitializationError") return initializationFailure(e);

  if (typeof e.name === "string" && CODELESS.has(e.name)) {
    return { code: e.name, class: "PERMANENT" };
  }

  const code =
    typeof e.code === "string" ? e.code : typeof e.errorCode === "string" ? e.errorCode : null;
  if (code === null) return null;

  if (code === "P2010") return rawQueryFailure(e.meta?.code);

  // A code that merely looks like one (ECONNRESET, an exchange's own) is not ours.
  if (!/^P\d{4}$/.test(code) && code !== "LIFECYCLE_CONFLICT") return null;
  return classOf(code);
}

/**
 * A failure to connect for the first time. Real ones carry no code at all, so this
 * is the one place a message is read, and only the phrase `classifyPassError` has
 * always read: it is what lets startup keep waiting through an outage. Any other
 * wording is permanent, so a reworded message blocks a window and is never a success.
 */
function initializationFailure(e: { errorCode?: unknown; message?: unknown }): DatabaseFailure {
  if (typeof e.errorCode === "string" && e.errorCode !== "") return classOf(e.errorCode);

  const message = typeof e.message === "string" ? e.message : "";
  return /can't reach database server/i.test(message)
    ? { code: "INIT_UNREACHABLE", class: "TRANSIENT" }
    : { code: "INIT_REFUSED", class: "PERMANENT" };
}

/**
 * A raw query that failed. With a SQLSTATE, Postgres refused it and said why. With
 * none (`meta.code` is "N/A") Postgres refused nothing: reproduced with a socket
 * timeout before any answer came. Transient by that structure, not by any wording,
 * so the worst a rarer cause can cost is a few pointless retries before the next
 * window. It can never become a success.
 */
function rawQueryFailure(sqlstate: unknown): DatabaseFailure {
  if (typeof sqlstate === "string" && /^[0-9A-Z]{5}$/.test(sqlstate)) return classOf(sqlstate);
  return { code: "P2010_NO_SQLSTATE", class: "TRANSIENT" };
}

function classOf(code: string): DatabaseFailure {
  return { code, class: TRANSIENT.has(code) ? "TRANSIENT" : "PERMANENT" };
}
