/**
 * The demo trial's paper-trading report.
 *
 *   npm run demo:report -- --from 2026-10-30T15:00:00Z [--to <ISO time>] [--out <file.md>]
 *
 * Read-only. Reads the scanner owner's journal, setups, scanner runs and
 * notifications for the window and prints a Markdown report: whether the data
 * stayed fresh, what the engine produced, what was decided, each trade against
 * its plan, the results in R, and where Demo's fills differed from SpotLens's
 * plan. Writes nothing to the database, and calls no exchange and no model.
 *
 * The owner is resolved exactly as the scanner resolves it, so the report
 * reads the same account the setups were tracked for.
 */
import { writeFile } from "node:fs/promises";

import { prisma } from "@/lib/db/prisma";
import { buildTrialReport } from "@/services/demo-trial";
import { describeScannerUserFailure, resolveScannerUser } from "@/services/scanner";

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function time(name: string, value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} is not a time: ${value}`);
  return parsed;
}

async function main() {
  const from = time("from", option("from"));
  if (from === null) throw new Error("--from is required, e.g. --from 2026-10-30T15:00:00Z");
  const to = time("to", option("to")) ?? Date.now();
  if (to <= from) throw new Error("--to must be after --from.");

  const owner = await resolveScannerUser(process.env.SCANNER_USER_EMAIL);
  if (!owner.ok) throw new Error(describeScannerUserFailure(owner.failure));

  const report = await buildTrialReport({
    userId: owner.userId,
    from,
    to,
    generatedAt: Date.now(),
  });

  const out = option("out");
  if (out) {
    await writeFile(out, report, "utf8");
    console.log(`Report written to ${out}`);
  } else {
    console.log(report);
  }
}

main()
  .catch((err: unknown) => {
    console.error(`Report failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
