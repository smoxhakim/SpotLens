import { apiError } from "@/lib/api/response";

/**
 * POST /api/analysis/run — the deterministic trade setup engine (Phase 3).
 *
 * Deliberately returns 501 until the engine exists. SpotLens must never emit a
 * trade setup that was not calculated, so there is no placeholder result here.
 */
export function POST() {
  return apiError(
    "NOT_IMPLEMENTED",
    "The analysis engine is not available yet. SpotLens does not return trade setups it has not calculated.",
    501,
  );
}
