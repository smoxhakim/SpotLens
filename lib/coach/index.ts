/**
 * The Coach: an educational reading of an analysis SpotLens already made.
 *
 * SpotLens owns every number. The Coach owns only the reading of them, and the
 * two never swap places — a review discusses an entry and can never become the
 * source of one. Nothing here executes anything, and there is no code path that
 * could: a provider receives a finished context and returns prose.
 *
 * Pure parts (context, review, rules) live here; `services/coach.ts` performs
 * the owner-scoped reads that feed them.
 */
export {
  contextFromScannerCandidate,
  contextFromTrackedSetup,
  type ScannerCandidateFacts,
  type TrackedSetupFacts,
} from "./context";

export { buildDeterministicReview, verdictFor } from "./review";

export { FORBIDDEN_PHRASES, forbiddenPhrasesIn, isSafeReview } from "./rules";

export {
  CoachProviderError,
  deterministicProvider,
  reviewWith,
  type CoachProvider,
} from "./provider";

export { DEFAULT_COACH_MODEL, resolveCoachProvider, type CoachProviderChoice } from "./config";

export { CoachProviderFailure, buildRequestBody, createOpenAiCoach } from "./openai";

export {
  COACH_JSON_SCHEMA,
  COACH_SYSTEM_PROMPT,
  coachResponseSchema,
  serialiseContext,
  type CoachModelResponse,
} from "./prompt";

export { cacheKeyFor, clearCoachCache, coachCacheSize } from "./cache";

export {
  VERDICT_LABELS,
  type CoachContext,
  type CoachEvidence,
  type CoachFact,
  type CoachLevels,
  type CoachResult,
  type CoachReview,
  type CoachSection,
  type CoachVerdict,
} from "./types";
