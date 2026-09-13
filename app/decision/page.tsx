import { ClipboardCheck } from "lucide-react";
import { z } from "zod";

import { DecisionWorkflow } from "@/features/decision/components/DecisionWorkflow";
import { timeframeSchema } from "@/lib/market-data/schema";

export const metadata = { title: "Your decision — SpotLens" };

/**
 * Where the workflow ends and the record begins.
 *
 * A server component, so the references are validated before anything renders.
 * Each one is parsed on its own and a bad value becomes null rather than
 * failing the page — arriving with a mangled setup id should still tell you
 * which market it was about, and the view says plainly what it is missing.
 *
 * The same four-key contract the Coach uses, deliberately: the decision is
 * recorded against the analysis a particular pass produced, and a decision that
 * did not name the pass would be a decision about a moving target.
 */
const symbolSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{2,20}$/));

const uuidSchema = z.string().uuid();

function parse<T>(schema: z.ZodType<T>, value: string | string[] | undefined): T | null {
  if (typeof value !== "string") return null;
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export default async function DecisionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Next 15+: dynamic params arrive as a Promise.
  const params = await searchParams;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ClipboardCheck className="h-5 w-5" />
          Your decision
        </h1>
        <p className="text-sm text-muted-foreground">
          What SpotLens found, what you decided about it, and what the trade actually did are three
          different records. This is the second one. SpotLens never places an order — deciding to
          take a setup is a note to yourself, and the trade is yours to make or not.
        </p>
      </header>

      <DecisionWorkflow
        symbol={parse(symbolSchema, params.symbol)}
        timeframe={parse(timeframeSchema, params.tf)}
        setupId={parse(uuidSchema, params.setupId)}
        runId={parse(uuidSchema, params.runId)}
      />
    </div>
  );
}
