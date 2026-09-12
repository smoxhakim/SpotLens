import {
  COACH_JSON_SCHEMA,
  COACH_SYSTEM_PROMPT,
  coachResponseSchema,
  serialiseContext,
  type CoachModelResponse,
} from "./prompt";
import type { CoachProvider } from "./provider";
import type { CoachContext, CoachReview } from "./types";

/**
 * The ChatGPT Coach.
 *
 * Plain `fetch` rather than the OpenAI SDK, matching the Telegram provider: an
 * injectable `fetchImpl`, an abort-based timeout, and errors sanitised before
 * they leave the module. The alternative is a dependency and its tree for one
 * POST, and a client whose error objects quote the request — which is the one
 * place a key could surface.
 *
 * The model is handed facts and returns prose. It is given no tools, so there
 * is nothing for it to call even if it tried; and it is never asked for a
 * number, because `CoachReview` has nowhere to put one. Every figure the reader
 * sees is rendered from `CoachContext` by the page.
 */

const API_URL = "https://api.openai.com/v1/responses";

/** Long enough for a considered answer, short enough that a hung request ends. */
const REQUEST_TIMEOUT_MS = 45_000;

export interface OpenAiCoachOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CoachProviderFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoachProviderFailure";
  }
}

/**
 * Removes anything that could carry the key out of an error.
 *
 * The key is a request header rather than part of the URL, so it is less
 * exposed here than Telegram's is — but a client, a proxy or a future change
 * could echo a header, and an error that has already been stripped cannot
 * regret it. Bounded too: a provider's message is not a log format.
 */
function sanitise(message: string, apiKey: string): string {
  return message
    .split(apiKey)
    .join("[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * The generated text, from whichever shape the response takes.
 *
 * The Responses API returns an `output` array of items; the text lives on a
 * `message` item's `output_text` content. A `refusal` item is a different
 * outcome and is treated as a failure rather than parsed as prose — a refusal
 * is not a review, and rendering one as though it were would put the model's
 * apology where an analysis should be.
 */
function extractText(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    throw new CoachProviderFailure("The provider returned no usable response.");
  }

  const response = body as { output_text?: unknown; output?: unknown };

  // Some responses carry a flattened convenience field. Preferred when present
  // because it needs no walking, but never depended on.
  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    throw new CoachProviderFailure("The provider returned no usable response.");
  }

  for (const item of response.output) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as { type?: unknown; content?: unknown; refusal?: unknown };

    if (entry.type === "refusal" || typeof entry.refusal === "string") {
      throw new CoachProviderFailure("The provider declined to answer.");
    }

    if (!Array.isArray(entry.content)) continue;

    for (const part of entry.content) {
      if (typeof part !== "object" || part === null) continue;
      const chunk = part as { type?: unknown; text?: unknown; refusal?: unknown };

      if (chunk.type === "refusal" || typeof chunk.refusal === "string") {
        throw new CoachProviderFailure("The provider declined to answer.");
      }
      if (chunk.type === "output_text" && typeof chunk.text === "string") return chunk.text;
    }
  }

  throw new CoachProviderFailure("The provider returned no usable response.");
}

/** The request body, exported so a test can assert what is actually sent. */
export function buildRequestBody(context: CoachContext, model: string) {
  return {
    model,
    // No `tools` key at all, rather than an empty array: the model is given
    // nothing to call, and a later edit that added one would be visible here.
    input: [
      { role: "system" as const, content: COACH_SYSTEM_PROMPT },
      { role: "user" as const, content: serialiseContext(context) },
    ],
    text: {
      format: {
        type: "json_schema" as const,
        name: "coach_review",
        strict: true,
        schema: COACH_JSON_SCHEMA,
      },
    },
  };
}

/** The model's prose, mapped onto the review the application already renders. */
function toReview(parsed: CoachModelResponse, providerId: string): CoachReview {
  return {
    verdict: parsed.verdict,
    summary: parsed.summary,
    strengths: { title: "What looks good", points: parsed.strengths },
    concerns: { title: "What concerns me", points: parsed.concerns },
    confirmationReview: { title: "Confirmation", points: parsed.confirmationReview },
    riskRewardReview: { title: "Risk and reward", points: parsed.riskRewardReview },
    invalidationReview: { title: "What would invalidate it", points: parsed.invalidationReview },
    chartChecks: {
      title: "What I would verify on the chart",
      // The educational notes ride with the chart checks rather than adding a
      // section the page does not render — a section nobody shows is a section
      // nobody reads.
      points: [...parsed.chartChecks, ...parsed.educationalNotes],
    },
    providerId,
  };
}

export function createOpenAiCoach(options: OpenAiCoachOptions): CoachProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return {
    id: `openai:${options.model}`,

    async review(context: CoachContext): Promise<CoachReview> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await doFetch(API_URL, {
          method: "POST",
          headers: {
            // Server-side only. This module is imported by a service and a
            // route handler, never by a client component, so the key has no
            // path into a bundle.
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(buildRequestBody(context, options.model)),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new CoachProviderFailure(
            sanitise(`Provider responded ${response.status}: ${detail}`, options.apiKey),
          );
        }

        const body: unknown = await response.json().catch(() => null);
        const text = extractText(body);

        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new CoachProviderFailure(
            "The provider returned text that was not the agreed shape.",
          );
        }

        // Validated rather than trusted. Strict structured output makes a
        // mismatch unlikely; a model is still the one part of this system that
        // can answer with anything at all, so nothing reaches the page until
        // it has been through the schema.
        const parsed = coachResponseSchema.safeParse(json);
        if (!parsed.success) {
          throw new CoachProviderFailure(
            "The provider returned text that was not the agreed shape.",
          );
        }

        return toReview(parsed.data, `openai:${options.model}`);
      } catch (error) {
        if (error instanceof CoachProviderFailure) throw error;

        const aborted = error instanceof Error && error.name === "AbortError";
        throw new CoachProviderFailure(
          sanitise(
            aborted
              ? "The provider took too long to answer."
              : error instanceof Error
                ? error.message
                : "The provider could not be reached.",
            options.apiKey,
          ),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
