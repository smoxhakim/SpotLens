import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { databaseFailureOf } from "./failure";
import { classifyFailure } from "@/lib/scanner/failures";
import { classifyPassError } from "@/lib/scanner/retry";
import { LifecycleConflictError } from "@/lib/setups";

const clientVersion = Prisma.prismaVersion.client;
const known = (code: string, message = "anything", meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion, meta });

describe("the four codes, on the real classes, by the exact property", () => {
  // `.code` on PrismaClientKnownRequestError. Shapes captured from real runs where possible.
  const CASES: [string, Error][] = [
    [
      "P2034, as captured: real write conflict on a model query",
      known("P2034", "Transaction failed due to a write conflict or a deadlock.", {
        modelName: "User",
      }),
    ],
    [
      "P2034, as captured: real Serializable conflict",
      known("P2034", "Transaction failed due to a write conflict or a deadlock.", {}),
    ],
    [
      "P1008, as captured: real socket timeout",
      known("P1008", "Socket timeout", { modelName: "User", time: "1s" }),
    ],
    ["P1002, simulated: real class, code set by the test", known("P1002", "reached but timed out")],
    [
      "LIFECYCLE_CONFLICT: the class the writer throws",
      new LifecycleConflictError("setup", "OPEN"),
    ],
  ];
  for (const [name, err] of CASES) {
    const code = (err as unknown as { code: string }).code;
    it(`${name}: transient, by ${code}`, () => {
      expect(databaseFailureOf(err)).toEqual({ code, class: "TRANSIENT" });
    });
    it(`${name}: no message changes the answer`, () => {
      for (const message of [
        "",
        "Authentication failed",
        "does not exist",
        "can't reach",
        "too many connections",
        "timed out",
      ]) {
        Object.defineProperty(err, "message", { value: message, configurable: true });
        expect(databaseFailureOf(err)).toEqual({ code, class: "TRANSIENT" });
      }
    });
  }

  it("the property decides: the same message on another code is permanent", () => {
    const text = "Transaction failed due to a write conflict or a deadlock.";
    expect(databaseFailureOf(known("P2034", text))?.class).toBe("TRANSIENT");
    expect(databaseFailureOf(known("P2003", text))?.class).toBe("PERMANENT");
    expect(databaseFailureOf(known("P2022", "Socket timeout"))?.class).toBe("PERMANENT");
  });

  it("the message alone decides nothing: a plain error naming a code is not a database error", () => {
    for (const message of ["P2034", "P1002", "P1008", "LIFECYCLE_CONFLICT", "Socket timeout"]) {
      expect(databaseFailureOf(new Error(message))).toBeNull();
    }
  });

  it("a look-alike `.code` that is not a Prisma code is not a database error", () => {
    expect(databaseFailureOf(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeNull();
    expect(databaseFailureOf(Object.assign(new Error("x"), { code: "UPSTREAM_ERROR" }))).toBeNull();
  });
});

describe("raw queries: P2010 and meta.code", () => {
  const raw = (sqlstate: unknown) =>
    known("P2010", "Raw query failed.", { code: sqlstate, message: "x" });
  it("reads the SQLSTATE from meta.code", () => {
    expect(databaseFailureOf(raw("55P03"))).toEqual({ code: "55P03", class: "TRANSIENT" });
    expect(databaseFailureOf(raw("40P01"))).toEqual({ code: "40P01", class: "TRANSIENT" });
    expect(databaseFailureOf(raw("40001"))).toEqual({ code: "40001", class: "TRANSIENT" });
    expect(databaseFailureOf(raw("42P01"))).toEqual({ code: "42P01", class: "PERMANENT" });
  });
  it('meta.code "N/A", as captured from a real raw socket timeout, is transient under its own safe code', () => {
    expect(databaseFailureOf(raw("N/A"))).toEqual({
      code: "P2010_NO_SQLSTATE",
      class: "TRANSIENT",
    });
    expect(databaseFailureOf(raw(undefined))).toEqual({
      code: "P2010_NO_SQLSTATE",
      class: "TRANSIENT",
    });
  });
});

describe("documented limits", () => {
  it("a deadlock or lock timeout on a model query arrives with no code at all, so it is permanent: blocked, never success", () => {
    // PrismaClientUnknownRequestError, as captured: `.code` and `.meta` absent. The SQLSTATE
    // is only in the message, which is deliberately not read.
    const err = new Prisma.PrismaClientUnknownRequestError('PostgresError { code: "40P01" }', {
      clientVersion,
    });
    expect(databaseFailureOf(err)).toEqual({
      code: "PrismaClientUnknownRequestError",
      class: "PERMANENT",
    });
  });

  it("a first-connect error has no code: this one branch reads the message, and an unrecognised one fails safe", () => {
    const init = (message: string) =>
      new Prisma.PrismaClientInitializationError(message, clientVersion);
    expect(databaseFailureOf(init("Can't reach database server"))?.class).toBe("TRANSIENT");
    // Nothing beyond the phrase the merged code already reads.
    expect(databaseFailureOf(init("Too many database connections opened"))?.class).toBe(
      "PERMANENT",
    );
    expect(databaseFailureOf(init("Timed out fetching a new connection"))?.class).toBe("PERMANENT");
    expect(databaseFailureOf(init("Authentication failed"))?.class).toBe("PERMANENT");
    expect(databaseFailureOf(init("wording a later Prisma might use"))?.class).toBe("PERMANENT");
  });

  it("an engine code on a first-connect error wins over its message", () => {
    const err = new Prisma.PrismaClientInitializationError("can't reach", clientVersion, "P1000");
    expect(databaseFailureOf(err)?.code).toBe("P1000");
  });
});

describe("every shape, through what reads it", () => {
  const init = (message: string, code?: string) =>
    new Prisma.PrismaClientInitializationError(message, clientVersion, code);
  const raw = (sqlstate: string) => known("P2010", "raw", { code: sqlstate });

  it.each([
    ["P1001", known("P1001"), "P1001", "TRANSIENT"],
    ["P1002", known("P1002"), "P1002", "TRANSIENT"],
    ["P1008", known("P1008"), "P1008", "TRANSIENT"],
    ["P1017", known("P1017"), "P1017", "TRANSIENT"],
    ["P2024", known("P2024"), "P2024", "TRANSIENT"],
    ["P2028", known("P2028"), "P2028", "TRANSIENT"],
    ["P2034", known("P2034"), "P2034", "TRANSIENT"],
    ["a raw 55P03", raw("55P03"), "55P03", "TRANSIENT"],
    ["a raw 40001", raw("40001"), "40001", "TRANSIENT"],
    ["a raw 40P01", raw("40P01"), "40P01", "TRANSIENT"],
    ["a raw 42P01", raw("42P01"), "42P01", "PERMANENT"],
    [
      "LIFECYCLE_CONFLICT",
      new LifecycleConflictError("id", "OPEN"),
      "LIFECYCLE_CONFLICT",
      "TRANSIENT",
    ],
    [
      "first connect, unreachable",
      init("Can't reach database server at `x`"),
      "INIT_UNREACHABLE",
      "TRANSIENT",
    ],
    [
      "first connect, too many",
      init("Too many database connections opened"),
      "INIT_REFUSED",
      "PERMANENT",
    ],
    [
      "first connect, bad credentials",
      init("Authentication failed", "P1000"),
      "P1000",
      "PERMANENT",
    ],
    ["first connect, no database", init("Database does not exist", "P1003"), "P1003", "PERMANENT"],
    ["P2021", known("P2021"), "P2021", "PERMANENT"],
    ["P2022", known("P2022"), "P2022", "PERMANENT"],
    ["P2002", known("P2002"), "P2002", "PERMANENT"],
    ["P2003", known("P2003"), "P2003", "PERMANENT"],
    ["a code nothing here has heard of", known("P9999"), "P9999", "PERMANENT"],
    [
      "a code-less request error",
      new Prisma.PrismaClientUnknownRequestError("x", { clientVersion }),
      "PrismaClientUnknownRequestError",
      "PERMANENT",
    ],
  ] as const)("%s", (_name, err, code, cls) => {
    expect(databaseFailureOf(err)).toEqual({ code, class: cls });

    const market = classifyFailure(err);
    expect(market.category).toBe("DATABASE_ERROR");
    expect(market.code).toBe(code);
    expect(market.database).toBe(cls);
    // The market's own attempts are not repeated; the pass is what retries.
    expect(market.retryable).toBe(false);

    expect(classifyPassError(err, false)).toBe(
      cls === "TRANSIENT" ? "FAILED_TRANSIENT" : "FAILED_BLOCKED",
    );
    // A deliberate stop outranks all of them.
    expect(classifyPassError(err, true)).toBe("INTERRUPTED");
  });

  it("what is not a database error stays what it was", () => {
    expect(databaseFailureOf(new Error("fetch failed"))).toBeNull();
    expect(classifyPassError(new Error("fetch failed"), false)).toBe("FAILED_TRANSIENT");
    expect(databaseFailureOf(new TypeError("Cannot read properties"))).toBeNull();
    expect(classifyPassError(new TypeError("Cannot read properties"), false)).toBe(
      "FAILED_BLOCKED",
    );
  });
});
