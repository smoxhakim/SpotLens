import { Target } from "lucide-react";
import { z } from "zod";

import { OpportunitiesView } from "@/features/opportunities/components/OpportunitiesView";

export const metadata = { title: "Top Opportunities — SpotLens" };

/**
 * A server component so the reference is validated before anything renders,
 * and a bad value becomes null rather than failing the page — the same
 * treatment `/coach` and `/decision` give their parameters.
 *
 * `?runId=` addresses one particular scanner pass. The API has always taken it
 * ("omitted means the most recent pass"); this is the UI finally offering it,
 * so a pass can be linked to and read later instead of being reachable only
 * while it happens to be the newest.
 */
const uuidSchema = z.string().uuid();

function parseRunId(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const result = uuidSchema.safeParse(value);
  return result.success ? result.data : null;
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Next 15+: dynamic params arrive as a Promise.
  const runId = parseRunId((await searchParams).runId);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Target className="h-5 w-5" />
          Top opportunities to review
        </h1>
        <p className="text-sm text-muted-foreground">
          {/* The wording follows the parameter. Saying "the latest scan" over a
              pass that is not the latest would be the page describing itself
              wrongly, which is the one thing a page about provenance cannot do. */}
          {runId
            ? "Deterministically ranked from one particular scan. The scanner covers every curated market on both timeframes; this is the short list of what met the review threshold on that pass, in the order the scanner put them in."
            : "Deterministically ranked from the latest broad market scan. The scanner covers every curated market on both timeframes; this is the short list of what met the review threshold, in the order the scanner put them in."}
        </p>
      </header>

      <OpportunitiesView runId={runId} />
    </div>
  );
}
