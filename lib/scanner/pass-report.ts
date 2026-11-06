import { databaseFailureOf } from "@/lib/db/failure";

import { classifyFailure } from "./failures";
import type { PassOutcome } from "./retry";

/**
 * What an operator needs after a pass that did not succeed: which markets on which
 * timeframes, what kind of failure, whether it can pass by itself, how many markets
 * succeeded, and what the schedule will do about it.
 *
 * Pure. Every code goes through `safeCode` and no failure message is ever read, so
 * a host, a path or a credential has no way to reach these lines.
 */

export type PassNext =
  | { kind: "RETRY"; inMs: number; attempt: number; of: number }
  | { kind: "NEXT_WINDOW"; at: number }
  | { kind: "MOVED_ON"; at: number }
  | { kind: "EXIT" };

export interface ReportedResult {
  symbol: string;
  timeframe: string;
  ok: boolean;
  failure?: {
    category: string;
    code?: string;
    retryable: boolean;
    database?: "TRANSIENT" | "PERMANENT";
  } | null;
}

export interface ReportedPass {
  analysed: number;
  succeeded: number;
  failed: number;
  results: readonly ReportedResult[];
  saveFailure?: { code: string; class: "TRANSIENT" | "PERMANENT" } | null;
  emptyUniverse?: boolean;
}

const LABEL: Partial<Record<PassOutcome, string>> = {
  FAILED_BLOCKED: "BLOCKED",
  FAILED_TRANSIENT: "FAILED, TRANSIENT",
  FAILED_PERMANENT: "FAILED, PERMANENT",
};

const SCHEMA_CODES = new Set(["P2021", "P2022", "42P01", "42703"]);
const ACCESS_CODES = new Set(["P1000", "P1003", "INIT_REFUSED"]);
const CODELESS = "PrismaClientUnknownRequestError";

/** A token, or UNKNOWN. Nothing that could be free text is ever printed. */
export function safeCode(code: string | undefined | null): string {
  return code && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "UNKNOWN";
}

function actionFor(input: {
  codes: readonly string[];
  transient: boolean;
  emptyUniverse: boolean;
  database: boolean;
  beforeAnyMarket: boolean;
}): string {
  if (input.emptyUniverse) return "Check the seed has run and that assets and pairs are active.";
  if (input.database) {
    if (input.transient)
      return "Check the database or network. Nothing to do if it clears by itself.";
    if (input.codes.some((c) => ACCESS_CODES.has(c))) {
      return "Check DATABASE_URL and the database credentials.";
    }
    if (input.codes.some((c) => SCHEMA_CODES.has(c))) {
      return "The schema does not match the code: check for a pending migration.";
    }
    if (input.codes.includes(CODELESS)) {
      return (
        "Prisma gave no error code, so this could be a refused write or a lock conflict with a " +
        "writer outside the scanner. Check the markets above and the database log."
      );
    }
    return "A write was refused. Check the rows and constraints for the markets above.";
  }
  if (input.beforeAnyMarket) {
    return input.transient
      ? "Check the network and the exchange. Nothing to do if it clears by itself."
      : "An unexpected error stopped this pass before it read any market. The line before this summary says what it was.";
  }
  return input.transient
    ? "Check the network and the exchange. Nothing to do if it clears by itself."
    : "The exchange refused these markets, or their analysis failed. Check the symbols above.";
}

function nextLine(next: PassNext, timeframes: string): string {
  const iso = (at: number) => new Date(at).toISOString();
  switch (next.kind) {
    case "RETRY":
      return (
        `Next: ${timeframes} will retry in ${Math.round(next.inMs / 60_000)} min ` +
        `(retry ${next.attempt} of ${next.of}).`
      );
    case "NEXT_WINDOW":
      return (
        `Next: ${timeframes} will not retry. They stay uncovered and wait for the next ` +
        `scheduled window at ${iso(next.at)}.`
      );
    case "MOVED_ON":
      return `Next: ${timeframes} will not retry and count as covered. The schedule moves on to ${iso(next.at)}.`;
    case "EXIT":
      return `Next: this was a single pass, so ${timeframes} will not retry. Exiting with code 1.`;
  }
}

/** One line per timeframe, category, code and class, naming every market in it. */
function failureLines(results: readonly ReportedResult[]) {
  const groups = new Map<
    string,
    { timeframe: string; category: string; code: string; cls: string; symbols: string[] }
  >();

  for (const r of results) {
    if (r.ok || !r.failure) continue;
    const code = safeCode(r.failure.code);
    const cls = r.failure.database
      ? r.failure.database.toLowerCase()
      : r.failure.retryable
        ? "transient"
        : "permanent";
    const key = `${r.timeframe}|${r.failure.category}|${code}|${cls}`;
    const group = groups.get(key) ?? {
      timeframe: r.timeframe,
      category: r.failure.category,
      code,
      cls,
      symbols: [],
    };
    group.symbols.push(r.symbol);
    groups.set(key, group);
  }

  const sorted = [...groups.values()].sort(
    (a, b) => a.timeframe.localeCompare(b.timeframe) || a.code.localeCompare(b.code),
  );
  return {
    lines: sorted.map(
      (g) => `   ${g.timeframe} ${g.category} ${g.code} ${g.cls}: ${g.symbols.sort().join(", ")}`,
    ),
    codes: sorted.map((g) => g.code),
    database: sorted.some((g) => g.category === "DATABASE_ERROR"),
  };
}

/** Empty for a pass that succeeded or was stopped on purpose. */
export function describeFailedPass(input: {
  outcome: PassOutcome;
  timeframes: readonly string[];
  summary: ReportedPass | null;
  thrown: unknown;
  next: PassNext;
}): string[] {
  const label = LABEL[input.outcome];
  if (!label) return [];

  const { summary } = input;
  const timeframes = input.timeframes.join(", ");
  const transient = input.outcome === "FAILED_TRANSIENT";
  const lines: string[] = [];
  let codes: string[] = [];
  let database = false;

  if (summary) {
    lines.push(
      summary.emptyUniverse
        ? `PASS ${label}: ${timeframes}: no active markets to scan. Stored as FAILED.`
        : `PASS ${label}: ${timeframes}: ${summary.succeeded} succeeded, ${summary.failed} failed, of ${summary.analysed}.`,
    );
    const failures = failureLines(summary.results);
    lines.push(...failures.lines);
    codes = failures.codes;
    database = failures.database;

    if (summary.saveFailure) {
      const code = safeCode(summary.saveFailure.code);
      codes.push(code);
      database = true;
      lines.push(
        `   results not saved: DATABASE_ERROR ${code} ${summary.saveFailure.class.toLowerCase()}: ` +
          "every market in this pass. Lifecycle writes already committed stand.",
      );
    }
    if (summary.emptyUniverse) lines.push("   no markets: NO_MARKETS permanent");
  } else {
    const db = databaseFailureOf(input.thrown);
    const failure = classifyFailure(input.thrown);
    const name = input.thrown instanceof Error ? input.thrown.name : undefined;
    const code = safeCode(db?.code ?? failure.code ?? name);
    codes = [code];
    database = db !== null;
    lines.push(
      `PASS ${label}: ${timeframes}: stopped before any market result. 0 succeeded, 0 failed.`,
    );
    lines.push(
      `   before any market: ${failure.category} ${code} ${transient ? "transient" : "permanent"}`,
    );
  }

  lines.push(`   ${nextLine(input.next, timeframes)}`);
  lines.push(
    `   Action: ${actionFor({
      codes,
      transient,
      emptyUniverse: summary?.emptyUniverse === true,
      database,
      beforeAnyMarket: summary === null,
    })}`,
  );
  return lines;
}
