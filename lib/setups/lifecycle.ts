import type { AnalysisResult } from "@/lib/analysis";
import { classifyRegime } from "@/lib/regime";

import type {
  ConfirmationPayload,
  ExistingSetup,
  PlannedCreate,
  PlannedTransition,
  SetupEventType,
  SetupLifecycleStatus,
  SetupOrigin,
  SetupPlan,
  SetupSnapshot,
} from "./types";

/**
 * The setup lifecycle, as a pure function of the analysis and what is already
 * stored.
 *
 * No database access, no clock, no I/O — the same inputs always produce the
 * same plan. `services/setups.ts` executes the plan; everything decided here
 * can be tested without a database, which is the only way these rules get
 * covered properly.
 */

/** Terminal state: nothing transitions out of an invalidated setup. */
export const TERMINAL_STATUS: SetupLifecycleStatus = "INVALIDATED";

/**
 * Where the analysis puts a setup in its lifecycle.
 *
 * Every branch reads an existing engine output. Nothing here re-derives
 * strategy, and the order matters:
 *
 *  - No setup at all means the engine refused (AVOID, or no entry could be
 *    built). There is nothing to track, and any open setup gets invalidated by
 *    the caller.
 *  - CONTRADICTED outranks everything else: the market answered in the wrong
 *    direction, which is the definition of the premise failing.
 *  - POTENTIAL_SETUP is checked before CONFIRMATION_DETECTED because the status
 *    gate already requires confirmation to be PRESENT — reaching it means
 *    confirmation *and* every other rule passed.
 *  - CONFIRMATION_DETECTED is confirmation present while some other rule still
 *    holds the analysis back. That is a real and common state, and it is worth
 *    recording separately from "nothing has happened yet".
 *  - Price not yet in the entry zone is SETUP_FORMING: the level is identified
 *    but not in play.
 */
export function lifecycleStatusFor(result: AnalysisResult): SetupLifecycleStatus | null {
  if (!result.setup) return null;
  if (result.confirmation?.status === "CONTRADICTED") return "INVALIDATED";
  if (result.status === "POTENTIAL_SETUP") return "POTENTIAL_SETUP";
  if (result.confirmation?.status === "PRESENT") return "CONFIRMATION_DETECTED";
  if (!result.setup.entry.priceInZone) return "SETUP_FORMING";
  return "WAITING_CONFIRMATION";
}

/**
 * Whether two origins are the same level.
 *
 * Plain interval overlap, deliberately. Support zones are sized from ATR, so
 * their bounds move a little every candle; keying identity on exact bounds — or
 * on a rounded bucket, which just moves the problem to the bucket edge — would
 * mint a fresh setup on almost every run. Two zones that share any price at all
 * are the same level being re-drawn, which is exactly what identity should mean
 * here.
 *
 * The consequence, stated plainly: a zone that drifts far enough over many
 * candles stays one setup the whole way, because each step overlapped the last.
 * That is the right answer — it is one level slowly re-forming, not a series of
 * different ones — but it does mean identity is a chain, not a fixed box.
 */
export function isSameOrigin(a: SetupOrigin, b: SetupOrigin): boolean {
  return a.zoneLow <= b.zoneHigh && a.zoneHigh >= b.zoneLow;
}

/** The origin of the setup in this result, or null when there is no setup. */
export function originOf(result: AnalysisResult): SetupOrigin | null {
  const zone = result.setup?.entry.sourceZone;
  return zone ? { zoneLow: zone.low, zoneHigh: zone.high } : null;
}

/**
 * Decides what to do about one analysis run.
 *
 * `existing` must be the most recent *open* setup for this user, pair and
 * timeframe, or null. Passing an already-invalidated one is treated as none:
 * invalidation is terminal, and a level that comes back is a new setup with a
 * new id and its own history.
 */
export function reconcileSetup(input: {
  existing: ExistingSetup | null;
  result: AnalysisResult;
}): SetupPlan {
  const { result } = input;
  const existing =
    input.existing && input.existing.status !== TERMINAL_STATUS ? input.existing : null;

  const target = lifecycleStatusFor(result);
  const origin = originOf(result);
  const payload = confirmationPayload(result);

  // --- nothing to track ----------------------------------------------------
  if (target === null || origin === null) {
    if (!existing) {
      return { action: "NONE", reason: "The engine offered no setup, and none is being tracked." };
    }

    return {
      action: "TRANSITION",
      transition: invalidation(existing, result.statusReason, payload),
    };
  }

  // --- a level we have not seen before ------------------------------------
  if (!existing) {
    if (target === TERMINAL_STATUS) {
      return {
        action: "NONE",
        reason: "Confirmation is contradicted on a setup that was never tracked.",
      };
    }
    return { action: "CREATE", create: creation(target, origin, result, payload) };
  }

  // --- the entry has moved to a different level ---------------------------
  if (!isSameOrigin(existing.origin, origin)) {
    const invalidate = invalidation(
      existing,
      "The entry no longer rests on this level — the engine has anchored to a different support zone, so this setup's premise is gone.",
      payload,
    );

    if (target === TERMINAL_STATUS) {
      return { action: "TRANSITION", transition: invalidate };
    }

    return {
      action: "REPLACE",
      invalidate,
      create: creation(target, origin, result, payload),
    };
  }

  // --- same level, same state: write nothing at all ------------------------
  if (target === existing.status) {
    return {
      action: "NONE",
      reason: `Still ${target.toLowerCase().replace(/_/g, " ")}; nothing about the setup has changed.`,
    };
  }

  // --- same level, new state ----------------------------------------------
  if (target === TERMINAL_STATUS) {
    const reason =
      result.confirmation?.invalidationReason ??
      result.confirmation?.explanation ??
      result.statusReason;
    return { action: "TRANSITION", transition: invalidation(existing, reason, payload) };
  }

  return {
    action: "TRANSITION",
    transition: {
      setupId: existing.id,
      from: existing.status,
      to: target,
      event: {
        type: eventTypeFor(target),
        detail: transitionDetail(existing.status, target, result),
        payload,
      },
      marksConfirmed: marksConfirmed(target),
      invalidationReason: null,
    },
  };
}

function creation(
  status: SetupLifecycleStatus,
  origin: SetupOrigin,
  result: AnalysisResult,
  payload: ConfirmationPayload | null,
): PlannedCreate {
  return {
    status,
    origin,
    snapshot: snapshotOf(result),
    event: {
      type: "CREATED",
      detail: `Setup first seen at ${status.toLowerCase().replace(/_/g, " ")}. ${result.statusReason}`,
      payload,
    },
    marksConfirmed: marksConfirmed(status),
  };
}

function invalidation(
  existing: ExistingSetup,
  reason: string,
  payload: ConfirmationPayload | null,
): PlannedTransition {
  return {
    setupId: existing.id,
    from: existing.status,
    to: TERMINAL_STATUS,
    event: { type: "INVALIDATED", detail: reason, payload },
    marksConfirmed: false,
    invalidationReason: reason,
  };
}

/**
 * Confirmation has been seen once this state is reached.
 *
 * The service stamps `confirmedAt` only when it is still null, so a setup that
 * loses and regains confirmation keeps the timestamp of the first time — which
 * is the historical fact worth preserving.
 */
function marksConfirmed(status: SetupLifecycleStatus): boolean {
  return status === "CONFIRMATION_DETECTED" || status === "POTENTIAL_SETUP";
}

function eventTypeFor(status: SetupLifecycleStatus): SetupEventType {
  if (status === "INVALIDATED") return "INVALIDATED";
  if (status === "CONFIRMATION_DETECTED") return "CONFIRMATION_DETECTED";
  if (status === "POTENTIAL_SETUP") return "POTENTIAL_SETUP";
  return "STATUS_CHANGED";
}

function transitionDetail(
  from: SetupLifecycleStatus,
  to: SetupLifecycleStatus,
  result: AnalysisResult,
): string {
  const readable = (s: SetupLifecycleStatus) => s.toLowerCase().replace(/_/g, " ");

  if (to === "CONFIRMATION_DETECTED") {
    return `Confirmation detected. ${result.confirmation?.explanation ?? ""}`.trim();
  }
  if (to === "POTENTIAL_SETUP") {
    return `Every condition now holds. ${result.statusReason}`;
  }
  if (from === "CONFIRMATION_DETECTED" || from === "POTENTIAL_SETUP") {
    return `Fell back to ${readable(to)} — the confirmation that had been present no longer holds. ${result.statusReason}`;
  }
  return `Moved from ${readable(from)} to ${readable(to)}. ${result.statusReason}`;
}

function confirmationPayload(result: AnalysisResult): ConfirmationPayload | null {
  const confirmation = result.confirmation;
  if (!confirmation) return null;

  return {
    status: confirmation.status,
    explanation: confirmation.explanation,
    evaluatedAt: confirmation.evaluatedAt,
    signals: confirmation.signals.map((s) => ({
      type: s.type,
      signal: s.signal,
      title: s.title,
      detail: s.detail,
    })),
  };
}

/** The immutable half of the record, built once when a setup is created. */
export function snapshotOf(result: AnalysisResult): SetupSnapshot {
  const setup = result.setup!;
  const [tp1, tp2, tp3] = setup.takeProfits;

  return {
    entryLow: setup.entry.low,
    entryHigh: setup.entry.high,
    stopLoss: setup.stopLoss.price,
    takeProfit1: tp1?.level ?? null,
    takeProfit2: tp2?.level ?? null,
    takeProfit3: tp3?.level ?? null,
    riskReward: setup.riskReward.ratio,
    riskRewardIsSynthetic: setup.riskReward.isSynthetic,
    score: result.score?.total ?? 0,
    scoreGrade: result.score?.grade ?? "AVOID",
    analysisStatus: result.status,
    detail: {
      entryReason: setup.entry.reason,
      stopLossReason: setup.stopLoss.reason,
      riskRewardReason: setup.riskReward.reason,
      statusReason: result.statusReason,
      takeProfits: setup.takeProfits.map((t) => ({
        label: t.label,
        level: t.level,
        rr: t.rr,
        kind: t.kind,
        reason: t.reason,
      })),
      scoreBreakdown: Object.fromEntries(
        Object.entries(result.score?.breakdown ?? {}).map(([key, value]) => [
          key,
          { score: value.score, max: value.max, reason: value.reason },
        ]),
      ),
      trend: result.read.trend.trend,
      mtfAgreement: result.mtf?.agreement ?? null,
      createdFromCandleTime: result.read.lastCandleTime,
      // Classified from the read the engine already produced, so this costs
      // arithmetic and no data. It describes the environment; it did not help
      // decide anything.
      regime: regimeOf(result),
    },
  };
}

/** The environment, as context on the stored snapshot. Never a decision input. */
function regimeOf(result: AnalysisResult): {
  direction: string;
  volatility: string;
  evidence: number;
} | null {
  const regime = classifyRegime(result.read);
  return {
    direction: regime.direction,
    volatility: regime.volatility,
    evidence: regime.evidence,
  };
}
