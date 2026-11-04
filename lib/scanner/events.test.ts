import { describe, expect, it } from "vitest";

import { eventsForOutcome, failureEvent } from "./events";

/**
 * Scanner events carry the exact `SetupEvent` ids the lifecycle wrote, so a
 * notification names its event instead of looking for "the newest one".
 */
describe("scanner events name the lifecycle's own events", () => {
  const context = { symbol: "BTCUSDT", timeframe: "H1", detail: "because" };

  it("a creation carries its CREATED event", () => {
    const [event] = eventsForOutcome({
      ...context,
      outcome: {
        action: "CREATE",
        setupId: "s1",
        status: "WAITING_CONFIRMATION",
        replacedSetupId: null,
        events: [{ setupId: "s1", eventId: "e1" }],
      },
    });

    expect(event).toMatchObject({
      type: "SETUP_CREATED",
      setupId: "s1",
      eventId: "e1",
      closedSetupId: null,
    });
  });

  it("a transition carries its own event", () => {
    const [event] = eventsForOutcome({
      ...context,
      outcome: {
        action: "TRANSITION",
        setupId: "s1",
        status: "INVALIDATED",
        events: [{ setupId: "s1", eventId: "e2" }],
      },
    });

    expect(event).toMatchObject({ type: "SETUP_INVALIDATED", setupId: "s1", eventId: "e2" });
  });

  it("a replacement keeps the null-setupId signal and names both halves exactly", () => {
    const [closing, opening] = eventsForOutcome({
      ...context,
      outcome: {
        action: "REPLACE",
        setupId: "s-new",
        status: "WAITING_CONFIRMATION",
        replacedSetupId: "s-old",
        events: [
          { setupId: "s-old", eventId: "e-invalidated" },
          { setupId: "s-new", eventId: "e-created" },
        ],
      },
    });

    // The closing half: still no setupId — that is how a replacement is told
    // apart — but now with the setup it closed and the event that closed it.
    expect(closing).toMatchObject({
      type: "SETUP_INVALIDATED",
      setupId: null,
      lifecycleStatus: "INVALIDATED",
      closedSetupId: "s-old",
      eventId: "e-invalidated",
    });
    expect(opening).toMatchObject({
      type: "SETUP_CREATED",
      setupId: "s-new",
      closedSetupId: null,
      eventId: "e-created",
    });
  });

  it("names no event when the outcome named none, rather than guessing one", () => {
    const [event] = eventsForOutcome({
      ...context,
      outcome: { action: "CREATE", setupId: "s1", status: "SETUP_FORMING" },
    });

    expect(event.eventId).toBeNull();
  });

  it("a failure names no setup and no event", () => {
    expect(
      failureEvent({ symbol: "BTCUSDT", timeframe: "H1", category: "UNKNOWN", message: "x" }),
    ).toMatchObject({ setupId: null, eventId: null, closedSetupId: null });
  });
});
