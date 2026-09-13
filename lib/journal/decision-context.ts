/**
 * What the user was looking at when they decided.
 *
 * Recorded on the event rather than in new columns, for the same reason the
 * superseded outcome is: `JournalEvent.payload` is already the append-only
 * place for "what was true at this event", and `readAmendmentPayload` reads
 * only its own key and ignores every other, so a sibling key costs no
 * migration and cannot disturb what is already stored there.
 *
 * ## What this is not
 *
 * There is deliberately no `coachApproved`, and there never will be. The Coach
 * is a reader of the same analysis the user is reading; recording it as an
 * authority that signed something off would invert the whole arrangement, and
 * a field like that is the kind that later gets filtered on. What is recorded
 * is narrower and true: a review was read, by which provider, and what its own
 * verdict said. The user may have agreed with it, ignored it, or decided the
 * opposite — all three are ordinary, and none of them is stored as a judgement
 * on the decision.
 *
 * Pure: no clock and no I/O. The service supplies the moment, because a
 * timestamp a browser sent is a timestamp a browser chose.
 */

/** The Coach's own readings. Mirrors `CoachVerdict`, restated so the journal does not import the Coach. */
export const COACH_VERDICTS = [
  "STRONG_EVIDENCE",
  "PROMISING_NEEDS_CONFIRMATION",
  "MIXED_EVIDENCE",
  "CONTRADICTED",
  "INSUFFICIENT_DATA",
] as const;

export type CoachVerdictRecord = (typeof COACH_VERDICTS)[number];

export interface CoachReference {
  /** Which reading was on screen: a model's, or SpotLens's own deterministic one. */
  providerId: string;
  /** The Coach's reading of the evidence. Not a verdict on the user's decision. */
  verdict: CoachVerdictRecord;
  /** Server time when the decision carrying this reference was recorded, epoch ms. */
  recordedAt: number;
}

export interface DecisionContext {
  /** Which kind of record the decision was made against. */
  source: "TRACKED_SETUP" | "SCANNER_RESULT";
  /** The pass the reader was looking at, when the decision came through one. */
  runId: string | null;
  /**
   * A Coach review the user had read, when they had read one.
   *
   * Null covers both "no Coach was consulted" and "a Coach was opened but the
   * decision was made from somewhere else" — the journal records what was in
   * front of the user at the moment they decided, and it cannot know more than
   * that. A decision made without the Coach is an ordinary decision, not an
   * incomplete one.
   */
  coach: CoachReference | null;
}

/** The payload written onto a decision event. */
export interface DecisionContextPayload {
  decisionContext: DecisionContext;
}

export function buildDecisionContext(context: DecisionContext): DecisionContextPayload {
  return { decisionContext: context };
}

/**
 * Reads a decision context back out of an event payload.
 *
 * Returns null for anything that is not one — an outcome amendment, or any
 * event written before Phase O. Older rows stay valid; they simply do not say
 * what was on screen.
 */
export function readDecisionContext(payload: unknown): DecisionContext | null {
  if (payload === null || typeof payload !== "object") return null;

  const candidate = (payload as { decisionContext?: unknown }).decisionContext;
  if (candidate === null || typeof candidate !== "object") return null;

  const context = candidate as Partial<DecisionContext>;
  if (context.source !== "TRACKED_SETUP" && context.source !== "SCANNER_RESULT") return null;

  const coach = context.coach ?? null;
  const validCoach =
    coach !== null &&
    typeof coach === "object" &&
    typeof coach.providerId === "string" &&
    typeof coach.recordedAt === "number" &&
    (COACH_VERDICTS as readonly string[]).includes(coach.verdict as string);

  return {
    source: context.source,
    runId: typeof context.runId === "string" ? context.runId : null,
    coach: validCoach ? (coach as CoachReference) : null,
  };
}

/**
 * Whether a Coach review had been read by the time of any recorded decision.
 *
 * Any event, not the latest: reading a review before deciding to watch and then
 * changing to skipped a day later without reopening it does not un-read the
 * review. The question the journal answers is "was this decision informed by a
 * Coach review at some point", and the honest answer is yes.
 */
export function coachWasRead(payloads: readonly unknown[]): boolean {
  return payloads.some((payload) => readDecisionContext(payload)?.coach != null);
}
