import { MessageCircleQuestion } from "lucide-react";
import { z } from "zod";

import { CoachReviewView } from "@/features/coach/components/CoachReviewView";
import { timeframeSchema } from "@/lib/market-data/schema";

export const metadata = { title: "Coach — SpotLens" };

/**
 * The Coach destination, ahead of the Coach itself.
 *
 * A real route rather than a disabled button, so the handoff from a candidate
 * to a review is a thing that exists and can be tested now. The body is a
 * placeholder and says so plainly: nothing here calls a model, and claiming a
 * review had happened would be the one failure this page must not have.
 *
 * A server component, so the parameters are validated before anything renders
 * rather than in the browser afterwards. Each one is parsed on its own and a
 * bad value becomes null instead of failing the page — a link with a mangled
 * setup id should still tell you which market it was about.
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

export default async function CoachPage({
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
          <MessageCircleQuestion className="h-5 w-5" />
          Coach
        </h1>
        <p className="text-sm text-muted-foreground">
          A second reading of an analysis SpotLens already made — what the setup rests on, what
          argues against it, and what would undo it. The numbers are SpotLens&apos;s; this explains
          them, and the decision stays yours.
        </p>
      </header>

      <CoachReviewView
        symbol={parse(symbolSchema, params.symbol)}
        timeframe={parse(timeframeSchema, params.tf)}
        setupId={parse(uuidSchema, params.setupId)}
        runId={parse(uuidSchema, params.runId)}
      />
    </div>
  );
}
