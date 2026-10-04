import {
  EVENT_PRIORITY,
  dedupeKeyForEntryZone,
  type NotificationEvent,
  type SetupFacts,
} from "@/lib/notifications";

import type { PriceObservation, WatchedSetup } from "./types";

/**
 * The ENTRY_ZONE_REACHED event for one setup.
 *
 * Owner, market and timeframe come from the watched setup; every level, score
 * and label from the stored facts the rest of the notification layer reads.
 * The only new number is the observed price, and it is a reading, not a level.
 *
 * The timestamp is the price's receipt time, so the message says when price
 * was seen in the zone rather than when the row happened to be written.
 */
export function entryZoneEvent(input: {
  setup: WatchedSetup;
  facts: SetupFacts;
  observation: PriceObservation;
}): NotificationEvent {
  const { setup, facts, observation } = input;

  return {
    type: "ENTRY_ZONE_REACHED",
    userId: setup.userId,
    priority: EVENT_PRIORITY.ENTRY_ZONE_REACHED,
    asset: setup.symbol,
    timeframe: setup.timeframe,
    timestamp: observation.receivedAt,
    dedupeKey: dedupeKeyForEntryZone(setup.setupId),
    setup: facts,
    summary: null,
    systemError: null,
    entryZone: { observedPrice: observation.price, observedAt: observation.receivedAt },
  };
}
