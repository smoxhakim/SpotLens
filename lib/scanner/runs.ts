/**
 * Which scanner runs count as a pass that actually happened.
 *
 * A run is finished when it has a `completedAt`, but finishing is not the same
 * as succeeding: a pass in which every market failed (the exchange unreachable
 * when a laptop wakes, say) is written as FAILED with a `completedAt`, and it
 * produced nothing. Counting it as "a pass happened" let the startup catch-up
 * skip the pass that was needed, and moved the monitor's reload cursor onto a
 * run with no results. COMPLETED and PARTIAL qualify — PARTIAL's failures were
 * other markets, and its successful results are as real as a full pass's.
 *
 * One definition, used by every query that asks the question: the startup
 * catch-up, the monitor's newer-run check, and the setup-freshness provenance.
 */
export const SUCCESSFUL_RUN_STATUSES = ["COMPLETED", "PARTIAL"] as const;

export type SuccessfulRunStatus = (typeof SUCCESSFUL_RUN_STATUSES)[number];

/** The Prisma `where` for a finished, successful pass. A fresh object per call. */
export function successfulPassWhere() {
  return {
    completedAt: { not: null },
    status: { in: [...SUCCESSFUL_RUN_STATUSES] as SuccessfulRunStatus[] },
  };
}
