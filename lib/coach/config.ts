import { createOpenAiCoach } from "./openai";
import { deterministicProvider, type CoachProvider } from "./provider";

/**
 * Which Coach answers, decided once, on the server.
 *
 * Configuration rather than a code change: with no key the deterministic
 * reviewer answers, exactly as it did before this existed, and the feature
 * degrades to something complete rather than to an error. That is also what
 * keeps the test suite free and offline — nothing needs a key to run.
 *
 * Never import this from a client component. The key is read here and travels
 * only into a request header.
 */

/**
 * The default model.
 *
 * `gpt-5.6-terra` balances cost against the quality of a piece of writing a
 * person actually reads; `gpt-5.6-luna` is cheaper and `gpt-6-astra` more
 * capable, and either is one environment variable away. Configurable because a
 * model id is the part of this that dates fastest.
 */
export const DEFAULT_COACH_MODEL = "gpt-5.6-terra";

export interface CoachProviderChoice {
  provider: CoachProvider;
  /** Whether a model is answering, for the page to say so honestly. */
  isModelBacked: boolean;
  model: string | null;
}

export function resolveCoachProvider(env: NodeJS.ProcessEnv = process.env): CoachProviderChoice {
  const apiKey = env.OPENAI_API_KEY?.trim();

  // A blank value in a `.env` file means "not configured" — the same rule
  // `lib/env.ts` applies, and the reason a stray `OPENAI_API_KEY=` line does
  // not put the Coach into a mode that cannot work.
  if (!apiKey) {
    return { provider: deterministicProvider, isModelBacked: false, model: null };
  }

  const model = env.OPENAI_COACH_MODEL?.trim() || DEFAULT_COACH_MODEL;

  return {
    provider: createOpenAiCoach({ apiKey, model }),
    isModelBacked: true,
    model,
  };
}
