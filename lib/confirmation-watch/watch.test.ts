import { describe, expect, it } from "vitest";

import type { ConfirmationSignalType } from "@/lib/analysis/confirmation";
import type { SetupLifecycleStatus } from "@/lib/setups";

import {
  dedupeKeyForEvidence,
  dedupeKeyForReached,
  decodeEvidence,
  encodeEvidence,
  planConfirmationWatch,
} from "./watch";
import type { ConfirmationObservation, ObservedSignal, WatchState } from "./types";

/**
 * The watcher's rules, as pure functions.
 *
 * No database and no clock anywhere in this file — every case is (stored state,
 * observation) in, plan out. The idempotency these tests describe is the first
 * of two guarantees; the second is the unique index, covered in
 * `services/confirmation-alerts.test.ts`.
 */

const TITLES: Record<ConfirmationSignalType, string> = {
  BULLISH_REJECTION: "Bullish rejection at the zone",
  HIGHER_LOW: "A higher low has formed",
  STRUCTURE_BREAK: "Local structure broken upward",
  RECLAIM: "The zone has been reclaimed",
  VOLUME_CONFIRMATION: "Volume backs the move",
};

function positive(type: ConfirmationSignalType): ObservedSignal {
  return { type, signal: "positive", title: TITLES[type], detail: "…" };
}

function negative(type: ConfirmationSignalType): ObservedSignal {
  return { type, signal: "negative", title: `${TITLES[type]} (against)`, detail: "…" };
}

function observe(overrides: Partial<ConfirmationObservation> = {}): ConfirmationObservation {
  return {
    trackedSetupId: "setup-a",
    userId: "user-1",
    symbol: "PYTHUSDT",
    timeframe: "H4",
    lifecycleStatus: "WAITING_CONFIRMATION" as SetupLifecycleStatus,
    status: "NOT_PRESENT",
    signals: [],
    evaluatedAt: Date.UTC(2026, 8, 15, 12),
    ...overrides,
  };
}

function state(announcedEvidence: ConfirmationSignalType[], reachedAnnounced = false): WatchState {
  return { announcedEvidence, reachedAnnounced };
}

/** Runs a sequence of observations through the planner, threading the state. */
function replay(observations: ConfirmationObservation[], initial: WatchState | null = null) {
  let current = initial;
  const plans = [];

  for (const observation of observations) {
    const plan = planConfirmationWatch({ observation, existing: current });
    plans.push(plan);
    if (plan.action !== "NONE") current = plan.state;
  }

  return {
    plans,
    state: current,
    alerts: plans.flatMap((p) => (p.action === "ANNOUNCE" ? p.alerts : [])),
  };
}

describe("the baseline — arming the watcher must not announce a backlog", () => {
  it("says nothing the first time it sees a setup that already has evidence", () => {
    const plan = planConfirmationWatch({
      observation: observe({ signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")] }),
      existing: null,
    });

    expect(plan.action).toBe("BASELINE");
    if (plan.action !== "BASELINE") return;
    // Recorded as already known, so it is never announced later either.
    expect(plan.state.announcedEvidence).toEqual(["BULLISH_REJECTION", "HIGHER_LOW"]);
  });

  it("records a setup that already satisfies confirmation as reached, silently", () => {
    const plan = planConfirmationWatch({
      observation: observe({
        status: "PRESENT",
        lifecycleStatus: "CONFIRMATION_DETECTED",
        signals: [positive("HIGHER_LOW"), positive("RECLAIM")],
      }),
      existing: null,
    });

    expect(plan.action).toBe("BASELINE");
    if (plan.action !== "BASELINE") return;
    expect(plan.state.reachedAnnounced).toBe(true);
  });

  it("baselines a setup with nothing at the level, and then speaks when something appears", () => {
    // The case that makes a dedicated state table necessary. Notification rows
    // alone cannot tell "never watched" from "watched, nothing to say" — both
    // have written nothing — so without this record the watcher would either
    // re-baseline forever or announce every open setup's backlog.
    const { plans, alerts } = replay([
      observe({ lifecycleStatus: "SETUP_FORMING", signals: [] }),
      observe({ signals: [positive("HIGHER_LOW")] }),
    ]);

    expect(plans[0].action).toBe("BASELINE");
    expect(plans[1].action).toBe("ANNOUNCE");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].newEvidence.map((s) => s.type)).toEqual(["HIGHER_LOW"]);
  });
});

describe("the required sequence, exactly as specified", () => {
  it("announces growth, stays silent on repeats, and reaches once", () => {
    const hl = [positive("HIGHER_LOW")];
    const hlBr = [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")];
    const full = [positive("HIGHER_LOW"), positive("BULLISH_REJECTION"), positive("RECLAIM")];

    const { plans, alerts } = replay(
      [
        observe({ signals: hl }), // 1 — first evidence after baseline
        observe({ signals: hl }), // 2 — unchanged
        observe({ signals: hlBr }), // 3 — new evidence
        observe({ signals: hlBr }), // 4 — unchanged
        observe({ signals: full, status: "PRESENT" }), // 5 — reached
        observe({ signals: full, status: "PRESENT" }), // 6 — unchanged
      ],
      // Baselined earlier with nothing, which is what an open setup looks like
      // after its first quiet pass.
      state([]),
    );

    expect(plans.map((p) => p.action)).toEqual([
      "ANNOUNCE",
      "OBSERVE",
      "ANNOUNCE",
      "OBSERVE",
      "ANNOUNCE",
      "OBSERVE",
    ]);

    expect(alerts.map((a) => a.level)).toEqual(["DEVELOPING", "DEVELOPING", "REACHED"]);
    // Three messages across six passes, and every key distinct.
    expect(new Set(alerts.map((a) => a.dedupeKey)).size).toBe(3);
  });

  it("names only the evidence that is new, and carries the rest as context", () => {
    const { alerts } = replay(
      [observe({ signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")] })],
      state(["HIGHER_LOW"]),
    );

    expect(alerts[0].newEvidence.map((s) => s.type)).toEqual(["BULLISH_REJECTION"]);
    expect(alerts[0].knownEvidence.map((s) => s.type)).toEqual(["HIGHER_LOW"]);
    expect(alerts[0].missingEvidence).toContain("RECLAIM");
  });

  it("sends one message, not two, when the new evidence is also what completes the set", () => {
    const { alerts } = replay(
      [
        observe({
          status: "PRESENT",
          signals: [positive("HIGHER_LOW"), positive("RECLAIM")],
        }),
      ],
      state(["HIGHER_LOW"]),
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe("REACHED");
  });
});

describe("evidence that comes and goes", () => {
  it("says nothing when evidence shrinks", () => {
    const { plans } = replay(
      [observe({ signals: [positive("HIGHER_LOW")] })],
      state(["HIGHER_LOW", "BULLISH_REJECTION"]),
    );

    expect(plans[0].action).toBe("OBSERVE");
  });

  it("does not lower the high-water mark when evidence lapses", () => {
    const { state: after } = replay([observe({ signals: [] })], state(["HIGHER_LOW"]));
    expect(after?.announcedEvidence).toEqual(["HIGHER_LOW"]);
  });

  it("says nothing when evidence that lapsed comes back", () => {
    // The flapping case. A rejection wick erased by the next candle and printed
    // again two candles later is the same rejection, and announcing it twice is
    // precisely the spam this design exists to prevent.
    const { plans, alerts } = replay(
      [
        observe({ signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")] }),
        observe({ signals: [positive("HIGHER_LOW")] }),
        observe({ signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")] }),
        observe({ signals: [positive("HIGHER_LOW")] }),
        observe({ signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")] }),
      ],
      state(["HIGHER_LOW"]),
    );

    expect(plans.map((p) => p.action)).toEqual([
      "ANNOUNCE",
      "OBSERVE",
      "OBSERVE",
      "OBSERVE",
      "OBSERVE",
    ]);
    expect(alerts).toHaveLength(1);
  });

  it("still speaks for a genuinely different signal after a lapse", () => {
    const { plans, alerts } = replay(
      [observe({ signals: [] }), observe({ signals: [positive("STRUCTURE_BREAK")] })],
      state(["HIGHER_LOW"]),
    );

    expect(plans.map((p) => p.action)).toEqual(["OBSERVE", "ANNOUNCE"]);
    expect(alerts[0].newEvidence.map((s) => s.type)).toEqual(["STRUCTURE_BREAK"]);
  });
});

describe("after confirmation has been reached", () => {
  it("goes quiet on every later scan, however the evidence moves", () => {
    const { plans, alerts } = replay(
      [
        observe({ status: "PRESENT", signals: [positive("HIGHER_LOW"), positive("RECLAIM")] }),
        observe({
          status: "PRESENT",
          signals: [positive("HIGHER_LOW"), positive("RECLAIM"), positive("VOLUME_CONFIRMATION")],
        }),
        observe({ status: "NOT_PRESENT", signals: [positive("HIGHER_LOW")] }),
        observe({ status: "PRESENT", signals: [positive("HIGHER_LOW"), positive("RECLAIM")] }),
      ],
      state([]),
    );

    expect(alerts.map((a) => a.level)).toEqual(["REACHED"]);
    expect(plans.slice(1).every((p) => p.action === "OBSERVE")).toBe(true);
  });

  it("never announces reaching twice, even after confirmation lapses and returns", () => {
    const { alerts } = replay(
      [
        observe({ status: "NOT_PRESENT", signals: [positive("HIGHER_LOW")] }),
        observe({ status: "PRESENT", signals: [positive("HIGHER_LOW"), positive("RECLAIM")] }),
      ],
      state(["HIGHER_LOW", "RECLAIM"], true),
    );

    expect(alerts).toHaveLength(0);
  });
});

describe("refusals", () => {
  it("says nothing about an invalidated setup", () => {
    const plan = planConfirmationWatch({
      observation: observe({
        lifecycleStatus: "INVALIDATED",
        signals: [positive("HIGHER_LOW"), positive("RECLAIM")],
        status: "PRESENT",
      }),
      existing: state(["HIGHER_LOW"]),
    });

    expect(plan.action).toBe("NONE");
  });

  it("refuses an invalidated setup even on its first sight, so no baseline is written", () => {
    const plan = planConfirmationWatch({
      observation: observe({ lifecycleStatus: "INVALIDATED" }),
      existing: null,
    });

    expect(plan.action).toBe("NONE");
  });

  it("says nothing when confirmation is contradicted — that is the lifecycle's news", () => {
    const plan = planConfirmationWatch({
      observation: observe({
        status: "CONTRADICTED",
        signals: [positive("HIGHER_LOW"), negative("RECLAIM")],
      }),
      existing: state([]),
    });

    expect(plan.action).toBe("NONE");
  });

  it("says nothing when no setup is tracked", () => {
    const plan = planConfirmationWatch({
      observation: observe({ lifecycleStatus: null }),
      existing: null,
    });

    expect(plan.action).toBe("NONE");
  });

  it("carries a negative supporting signal as a caveat rather than refusing", () => {
    // Thin volume is missing corroboration, not opposing evidence. Treating it
    // as a contradiction is the mistake the engine's own types exist to prevent.
    const { alerts } = replay(
      [
        observe({
          signals: [positive("HIGHER_LOW"), negative("VOLUME_CONFIRMATION")],
        }),
      ],
      state([]),
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0].caveats.map((s) => s.type)).toEqual(["VOLUME_CONFIRMATION"]);
  });
});

describe("identity is the setup, never the market", () => {
  it("keeps two setups on the same symbol and timeframe completely apart", () => {
    const a = planConfirmationWatch({
      observation: observe({ trackedSetupId: "setup-a", signals: [positive("HIGHER_LOW")] }),
      existing: state([]),
    });

    // Setup B has the same market, the same timeframe and the same evidence,
    // and knows nothing about A.
    const b = planConfirmationWatch({
      observation: observe({ trackedSetupId: "setup-b", signals: [positive("HIGHER_LOW")] }),
      existing: state([]),
    });

    expect(a.action).toBe("ANNOUNCE");
    expect(b.action).toBe("ANNOUNCE");
    if (a.action !== "ANNOUNCE" || b.action !== "ANNOUNCE") return;

    expect(a.alerts[0].dedupeKey).not.toBe(b.alerts[0].dedupeKey);
    expect(a.alerts[0].dedupeKey).toContain("setup-a");
    expect(b.alerts[0].dedupeKey).toContain("setup-b");
  });

  it("does not let one setup's announced evidence silence another's", () => {
    // A replacement setup starts from no state at all, so its first pass is a
    // baseline rather than an inherited silence.
    const replacement = planConfirmationWatch({
      observation: observe({ trackedSetupId: "setup-b", signals: [positive("HIGHER_LOW")] }),
      existing: null,
    });

    expect(replacement.action).toBe("BASELINE");

    const later = planConfirmationWatch({
      observation: observe({
        trackedSetupId: "setup-b",
        signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")],
      }),
      existing: replacement.action === "BASELINE" ? replacement.state : null,
    });

    expect(later.action).toBe("ANNOUNCE");
  });

  it("keys reaching on the setup alone", () => {
    expect(dedupeKeyForReached("setup-a")).toBe("confirmation-reached:setup-a");
    expect(dedupeKeyForReached("setup-a")).not.toBe(dedupeKeyForReached("setup-b"));
  });
});

describe("no lookahead", () => {
  it("carries the engine's own evaluatedAt, which is a closed candle's close", () => {
    const closedAt = Date.UTC(2026, 8, 15, 12);
    const { alerts, state: after } = replay(
      [observe({ evaluatedAt: closedAt, signals: [positive("HIGHER_LOW")] })],
      state([]),
    );

    expect(alerts[0].evaluatedAt).toBe(closedAt);
    expect(after).not.toBeNull();
  });

  it("reads nothing but the observation it is given", () => {
    // Structural: the planner takes two arguments and has no access to candles,
    // a clock, or any later observation. Feeding it the same observation twice
    // with different "futures" is impossible, because there is no input for one.
    const observation = observe({ signals: [positive("HIGHER_LOW")] });
    const once = planConfirmationWatch({ observation, existing: state([]) });
    const twice = planConfirmationWatch({ observation, existing: state([]) });

    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

describe("evidence encoding", () => {
  it("is order-independent, so a key cannot depend on how the engine listed signals", () => {
    expect(encodeEvidence(["RECLAIM", "HIGHER_LOW"])).toBe(
      encodeEvidence(["HIGHER_LOW", "RECLAIM"]),
    );
  });

  it("round-trips", () => {
    const types: ConfirmationSignalType[] = ["HIGHER_LOW", "RECLAIM", "VOLUME_CONFIRMATION"];
    expect(decodeEvidence(encodeEvidence(types)).sort()).toEqual([...types].sort());
  });

  it("drops anything it does not recognise rather than trusting a stored string", () => {
    expect(decodeEvidence("HIGHER_LOW+NOT_A_SIGNAL")).toEqual(["HIGHER_LOW"]);
    expect(decodeEvidence("")).toEqual([]);
  });

  it("gives a distinct key for every distinct set", () => {
    const keys = [
      dedupeKeyForEvidence("s", ["HIGHER_LOW"]),
      dedupeKeyForEvidence("s", ["HIGHER_LOW", "BULLISH_REJECTION"]),
      dedupeKeyForEvidence("s", ["HIGHER_LOW", "BULLISH_REJECTION", "RECLAIM"]),
    ];

    expect(new Set(keys).size).toBe(3);
  });
});

describe("recovery after a restart", () => {
  it("re-derives the identical key from state read back out of the database", () => {
    // The scanner restarting mid-sequence must not re-announce. The state is a
    // string in a column, so this is the round trip that actually happens.
    const before = state(["HIGHER_LOW", "BULLISH_REJECTION"]);
    const encoded = encodeEvidence(before.announcedEvidence);

    const restored: WatchState = {
      announcedEvidence: decodeEvidence(encoded),
      reachedAnnounced: before.reachedAnnounced,
    };

    const observation = observe({
      signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")],
    });

    expect(planConfirmationWatch({ observation, existing: before }).action).toBe("OBSERVE");
    expect(planConfirmationWatch({ observation, existing: restored }).action).toBe("OBSERVE");
  });

  it("re-derives the identical alert key when the state write was lost", () => {
    // The crash window: the notification row was written and the state update
    // never landed. The next pass must produce the same key, so the unique
    // index rejects it rather than a second message going out.
    const observation = observe({
      signals: [positive("HIGHER_LOW"), positive("BULLISH_REJECTION")],
    });

    const first = planConfirmationWatch({ observation, existing: state(["HIGHER_LOW"]) });
    const retry = planConfirmationWatch({ observation, existing: state(["HIGHER_LOW"]) });

    expect(first.action).toBe("ANNOUNCE");
    expect(retry.action).toBe("ANNOUNCE");
    if (first.action !== "ANNOUNCE" || retry.action !== "ANNOUNCE") return;
    expect(retry.alerts[0].dedupeKey).toBe(first.alerts[0].dedupeKey);
  });
});
