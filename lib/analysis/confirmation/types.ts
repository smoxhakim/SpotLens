/**
 * Deterministic confirmation.
 *
 * A setup describes a level worth caring about. Confirmation asks a separate
 * question: has the market actually *done* anything there yet? Buying a support
 * zone because it is a support zone is how a falling market takes money from
 * people who were technically right about the level.
 *
 * Everything here is derived from closed candles and existing engine output.
 * No clock, no randomness, no network, no model.
 */

/**
 * The five signals, exactly as specified.
 *
 * Each type is a *question*, not a verdict, which is why `signal` is tri-state:
 * `HIGHER_LOW` answers positive on a higher low and negative on a lower low.
 * Splitting those into separate types would double the vocabulary and let a
 * reader think a missing negative type meant the question was never asked.
 */
export type ConfirmationSignalType =
  "BULLISH_REJECTION" | "HIGHER_LOW" | "STRUCTURE_BREAK" | "VOLUME_CONFIRMATION" | "RECLAIM";

export type ConfirmationSignalDirection = "positive" | "negative" | "neutral";

export interface ConfirmationSignal {
  type: ConfirmationSignalType;
  signal: ConfirmationSignalDirection;
  title: string;
  detail: string;
}

/**
 * `CONTRADICTED` is not "not present with extra steps".
 *
 * NOT_PRESENT means the market has not answered yet — the level is untested,
 * or what evidence exists is too thin to act on. CONTRADICTED means it answered
 * in the wrong direction: support broke, structure gave way, the zone was
 * rejected downward.
 *
 * The line between them is *opposing evidence* versus *missing evidence*, and
 * only a primary signal can supply the former. Quiet volume is an absence —
 * nobody showed up — and an absence cannot contradict a rejection wick and a
 * higher low that visibly did happen. It can only leave them uncorroborated,
 * which is what NOT_PRESENT already says.
 *
 * Both statuses hold the setup at WAIT. The difference matters because only one
 * of them says the premise is actively failing, which is what Phase D will need
 * to invalidate on.
 */
export type ConfirmationStatus = "NOT_PRESENT" | "PRESENT" | "CONTRADICTED";

export interface ConfirmationResult {
  status: ConfirmationStatus;
  signals: ConfirmationSignal[];
  explanation: string;
  /**
   * Close time of the candle this was judged on — always a closed one.
   *
   * A timestamp rather than a clock reading, deliberately: the engine is pure,
   * and a backtest replaying this bar in a year must produce the identical
   * result. It is also the honest answer to "as of when?", since a forming
   * candle's wick and close can still change completely.
   */
  evaluatedAt: number;
  /**
   * Set only when a hard negative fired — the support zone the entry rests on
   * has been closed through. Phase D persists this; here it is result-level
   * only, so the reason the premise failed is not lost between phases.
   */
  invalidationReason: string | null;
}

/**
 * Signals that can carry a setup, and the one that can only corroborate.
 *
 * Volume is deliberately not a primary signal. Heavy volume says a lot of
 * people traded, not that they bought — a support zone breaking down does it
 * on heavy volume too. It confirms a move that price action has already
 * established, which is the same role it plays in the scoring engine.
 *
 * This one distinction governs the rule in **both** directions, which is the
 * point of stating it as a property of the signal rather than as two separate
 * lists. A supporting signal cannot confirm on its own, and it cannot
 * contradict on its own either: the same reason disqualifies it from both.
 * Thin volume means nobody showed up, and nobody showing up is not evidence
 * that the level failed — it is the absence of evidence that it held.
 */
export const PRIMARY_SIGNALS: ConfirmationSignalType[] = [
  "BULLISH_REJECTION",
  "HIGHER_LOW",
  "STRUCTURE_BREAK",
  "RECLAIM",
];

/** True when a signal of this type is strong enough to carry, or to refute. */
export function isPrimarySignal(type: ConfirmationSignalType): boolean {
  return PRIMARY_SIGNALS.includes(type);
}

/**
 * The rule, stated once so it cannot drift between the code and the docs:
 *
 *   CONTRADICTED  — any negative signal of a PRIMARY type, whatever else is
 *                   present. A supporting signal cannot contradict.
 *   PRESENT       — at least one positive PRIMARY signal, and at least
 *                   MIN_POSITIVE_SIGNALS positive signals in total.
 *   NOT_PRESENT   — anything else, including a lone primary signal and any
 *                   amount of volume on its own.
 *
 * Two signals rather than one, because every single signal here has a common
 * failure mode: a rejection wick that the next candle erases, a higher low that
 * becomes a lower high, a break that closes back inside the range. Requiring a
 * second independent signal does not make any of those impossible, it makes
 * them less likely to co-occur — and the cost of waiting is one candle, while
 * the cost of being wrong is the stop.
 */
export const MIN_POSITIVE_SIGNALS = 2;

/**
 * Lower wick as a fraction of the candle's whole range before it counts as a
 * rejection. At 0.4 the wick is longer than the body and both other wicks
 * combined can be, which is what makes it visible as a rejection rather than
 * ordinary noise on a candle that happened to dip.
 */
export const REJECTION_MIN_WICK_RATIO = 0.4;

/**
 * Where the candle must close within its own range. At 0.6 the close sits in
 * the top 40%, so price ended the period near the high after having been
 * pushed to the low — the sequence that makes a rejection mean something.
 */
export const REJECTION_MIN_CLOSE_POSITION = 0.6;

/**
 * How recent a confirmed swing must be to count as confirmation.
 *
 * A higher low twelve candles ago is market structure, and the trend read
 * already accounts for it. Confirmation is asking what happened *at this
 * level, now*, so a stale swing is not an answer to it.
 */
export const RECENT_SWING_MAX_AGE_BARS = 10;

/**
 * Window in which a level must have been lost for taking it back to count as a
 * reclaim. Beyond this the "reclaim" is just price being above a level it left
 * long ago, which is not evidence of anything.
 */
export const RECLAIM_LOOKBACK_BARS = 5;

/**
 * Volume at or below this fraction of average contradicts rather than merely
 * fails to confirm. Same threshold the scoring engine and the volume prose
 * already treat as "weakly confirmed".
 */
export const THIN_VOLUME_RELATIVE = 0.6;
