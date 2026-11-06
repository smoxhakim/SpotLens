import { describe, expect, it } from "vitest";

import { describeFailedPass, safeCode, type ReportedPass } from "./pass-report";

const AT = Date.UTC(2026, 10, 6, 14, 1, 30);
const ok = (symbol: string, timeframe = "H1") => ({ symbol, timeframe, ok: true, failure: null });
const db = (symbol: string, timeframe: string, code: string, cls: "TRANSIENT" | "PERMANENT") => ({
  symbol,
  timeframe,
  ok: false,
  failure: { category: "DATABASE_ERROR", code, retryable: cls === "TRANSIENT", database: cls },
});
const pass = (
  results: ReportedPass["results"],
  extra: Partial<ReportedPass> = {},
): ReportedPass => ({
  analysed: results.length,
  succeeded: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
  ...extra,
});
const NEXT = { kind: "NEXT_WINDOW", at: AT } as const;

describe("the five things every blocked pass says", () => {
  const lines = describeFailedPass({
    outcome: "FAILED_BLOCKED",
    timeframes: ["H1", "H4"],
    summary: pass([
      ok("ADAUSDT"),
      ok("BTCUSDT", "H4"),
      db("ETHUSDT", "H1", "P2003", "PERMANENT"),
      db("XRPUSDT", "H4", "P2003", "PERMANENT"),
    ]),
    thrown: null,
    next: NEXT,
  });
  const text = lines.join("\n");
  it("affected market and timeframe", () => {
    expect(text).toContain("H1 DATABASE_ERROR P2003 permanent: ETHUSDT");
    expect(text).toContain("H4 DATABASE_ERROR P2003 permanent: XRPUSDT");
  });
  it("category and safe code", () => expect(text).toMatch(/DATABASE_ERROR P2003/));
  it("markets succeeded and failed", () => expect(text).toContain("2 succeeded, 2 failed, of 4."));
  it("transient or permanent", () => expect(text).toContain(" permanent: "));
  it("retry or wait", () =>
    expect(text).toContain(
      "will not retry. They stay uncovered and wait for the next scheduled window at 2026-11-06T14:01:30.000Z.",
    ));
});

describe("grouping", () => {
  it("one line per timeframe, category, code and class; no market is dropped", () => {
    const many = Array.from({ length: 45 }, (_, i) => db(`M${i}USDT`, "H1", "P1017", "TRANSIENT"));
    const lines = describeFailedPass({
      outcome: "FAILED_TRANSIENT",
      timeframes: ["H1"],
      summary: pass(many),
      thrown: null,
      next: { kind: "RETRY", inMs: 60_000, attempt: 1, of: 4 },
    });
    const line = lines.find((l) => l.includes("P1017"))!;
    for (const m of many) expect(line).toContain(m.symbol);
    expect(lines.filter((l) => l.includes("P1017"))).toHaveLength(1);
  });
  it("a mixed pass shows both classes and the exchange failure beside them", () => {
    const text = describeFailedPass({
      outcome: "FAILED_BLOCKED",
      timeframes: ["H1"],
      summary: pass([
        db("A", "H1", "P1017", "TRANSIENT"),
        db("B", "H1", "P2003", "PERMANENT"),
        {
          symbol: "C",
          timeframe: "H1",
          ok: false,
          failure: { category: "MARKET_DATA_ERROR", code: "UPSTREAM_ERROR", retryable: true },
        },
      ]),
      thrown: null,
      next: NEXT,
    }).join("\n");
    expect(text).toContain("DATABASE_ERROR P1017 transient: A");
    expect(text).toContain("DATABASE_ERROR P2003 permanent: B");
    expect(text).toContain("MARKET_DATA_ERROR UPSTREAM_ERROR transient: C");
  });
});

describe("every kind of blocked pass has a summary", () => {
  it("results not saved", () => {
    const text = describeFailedPass({
      outcome: "FAILED_BLOCKED",
      timeframes: ["H1"],
      summary: pass([ok("A")], { saveFailure: { code: "P2022", class: "PERMANENT" } }),
      thrown: null,
      next: NEXT,
    }).join("\n");
    expect(text).toContain(
      "results not saved: DATABASE_ERROR P2022 permanent: every market in this pass.",
    );
    expect(text).toContain("pending migration");
  });
  it("zero markets", () => {
    const text = describeFailedPass({
      outcome: "FAILED_BLOCKED",
      timeframes: ["H1"],
      summary: pass([], { emptyUniverse: true }),
      thrown: null,
      next: NEXT,
    }).join("\n");
    expect(text).toContain("no active markets");
    expect(text).toContain("NO_MARKETS permanent");
    expect(text).toContain("Check the seed");
  });
  it("thrown before any market, with a hostile message", () => {
    const thrown = Object.assign(
      new Error("postgresql://user:hunter2@db.internal:5432/x at /Users/me/app"),
      { name: "PrismaClientInitializationError" },
    );
    const text = describeFailedPass({
      outcome: "FAILED_BLOCKED",
      timeframes: ["H1"],
      summary: null,
      thrown,
      next: NEXT,
    }).join("\n");
    expect(text).toContain("DATABASE_ERROR INIT_REFUSED permanent");
    expect(text).toContain("Check DATABASE_URL");
    for (const leak of ["hunter2", "db.internal", "/Users/me", "postgresql://", "5432"])
      expect(text).not.toContain(leak);
  });
  it("--once says it exits", () => {
    expect(
      describeFailedPass({
        outcome: "FAILED_BLOCKED",
        timeframes: ["H1"],
        summary: pass([db("A", "H1", "P2003", "PERMANENT")]),
        thrown: null,
        next: { kind: "EXIT" },
      }).join("\n"),
    ).toContain("single pass");
  });
});

describe("the action fits the failure", () => {
  const exchange = (retryable: boolean) => [
    {
      symbol: "A",
      timeframe: "H1",
      ok: false,
      failure: {
        category: retryable ? "MARKET_DATA_ERROR" : "INVALID_DATA",
        code: retryable ? "UPSTREAM_ERROR" : "UNKNOWN_SYMBOL",
        retryable,
      },
    },
  ];
  it("exchange failures never send the reader to the database", () => {
    const refused = describeFailedPass({
      outcome: "FAILED_PERMANENT",
      timeframes: ["H1"],
      summary: pass(exchange(false)),
      thrown: null,
      next: { kind: "MOVED_ON", at: AT },
    }).join("\n");
    expect(refused).toContain("The exchange refused");
    expect(refused).not.toContain("A write was refused");
    const down = describeFailedPass({
      outcome: "FAILED_TRANSIENT",
      timeframes: ["H1"],
      summary: pass(exchange(true)),
      thrown: null,
      next: { kind: "RETRY", inMs: 60_000, attempt: 1, of: 4 },
    }).join("\n");
    expect(down).toContain("network and the exchange");
    expect(down).not.toContain("database");
  });
});

describe("the action names what can actually be known", () => {
  const blocked = (code: string) =>
    describeFailedPass({
      outcome: "FAILED_BLOCKED",
      timeframes: ["H1"],
      summary: pass([db("A", "H1", code, "PERMANENT")]),
      thrown: null,
      next: NEXT,
    }).join("\n");

  it("a code-less failure says the cause cannot be told from here", () => {
    const text = blocked("PrismaClientUnknownRequestError");
    expect(text).toContain("Prisma gave no error code");
    expect(text).toContain("a refused write or a lock conflict");
    expect(text).not.toContain("A write was refused.");
  });
  it("a refused write says so", () => expect(blocked("P2003")).toContain("A write was refused."));
  it("a schema mismatch points at migrations", () =>
    expect(blocked("P2022")).toContain("pending migration"));
  it("a thrown error that is not the database does not blame the exchange or a symbol", () => {
    const text = describeFailedPass({
      outcome: "FAILED_BLOCKED",
      timeframes: ["H1"],
      summary: null,
      thrown: new TypeError("Cannot read properties of undefined"),
      next: NEXT,
    }).join("\n");
    expect(text).toContain("before any market: ANALYSIS_ERROR TypeError permanent");
    expect(text).toContain("before it read any market");
    expect(text).not.toContain("exchange");
    expect(text).not.toContain("Cannot read properties");
  });
});

describe("sanitising", () => {
  it("a code that is not a plain token never reaches the log", () => {
    for (const hostile of [
      "postgresql://u:p@h/d",
      "a b",
      "../../etc",
      "x".repeat(65),
      "",
      null,
      undefined,
    ])
      expect(safeCode(hostile)).toBe("UNKNOWN");
    for (const fine of ["P2003", "55P03", "PrismaClientUnknownRequestError", "P2010_NO_SQLSTATE"])
      expect(safeCode(fine)).toBe(fine);
  });
  it("no free text from a failure is printed, only the token", () => {
    const text = describeFailedPass({
      outcome: "FAILED_BLOCKED",
      timeframes: ["H1"],
      summary: pass([
        {
          symbol: "A",
          timeframe: "H1",
          ok: false,
          failure: {
            category: "DATABASE_ERROR",
            code: "postgresql://u:hunter2@h/d",
            retryable: false,
            database: "PERMANENT",
          },
        },
      ]),
      thrown: null,
      next: NEXT,
    }).join("\n");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("UNKNOWN");
  });
});

describe("what gets no summary", () => {
  it("success and interruption", () => {
    for (const outcome of ["SUCCEEDED", "INTERRUPTED"] as const) {
      expect(
        describeFailedPass({
          outcome,
          timeframes: ["H1"],
          summary: pass([ok("A")]),
          thrown: null,
          next: NEXT,
        }),
      ).toEqual([]);
    }
  });
});
