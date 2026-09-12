import type { NotificationEvent } from "./types";

/**
 * The short form shown in the app's own list.
 *
 * Separate from the Telegram formatter because the constraints differ: this is
 * read next to the chart it describes, so it can be brief, and it needs no
 * escaping because React renders it as text rather than markup.
 *
 * This is also the channel that keeps everything. Telegram routing drops the
 * quiet events — replacements, high-risk confirmations, structure signals — and
 * they all still arrive here, because "not worth a push" and "not worth
 * recording" are different judgements.
 */
export function renderInApp(event: NotificationEvent): { title: string; body: string } {
  const where = [event.asset, event.timeframe].filter(Boolean).join(" ");

  switch (event.type) {
    case "SETUP_DETECTED": {
      const setup = event.setup!;
      return {
        title: `🟢 Potential setup — ${where}`,
        body: `Quality ${setup.score}/100. ${
          setup.riskRewardIsSynthetic
            ? "Reward is not measurable against structure."
            : `Risk/reward 1:${setup.riskReward.toFixed(1)}.`
        } Review the chart before deciding.`,
      };
    }

    case "CONFIRMATION_DETECTED": {
      const setup = event.setup!;
      const positives = setup.confirmationSignals.filter((s) => s.signal === "positive");
      return {
        // "Evidence", not "detected". Reaching this state means the evidence
        // was found *and* the analysis was not promoted — announcing only the
        // first half reads as an approval the engine never gave.
        title: `🔵 Confirmation evidence — ${where}`,
        body:
          (positives.length > 0
            ? `${positives.map((s) => s.title).join("; ")}. `
            : "The confirmation layer found the evidence it requires. ") +
          "The analysis has not been promoted — review the chart before deciding.",
      };
    }

    case "SETUP_INVALIDATED": {
      const setup = event.setup!;

      // A replacement is bookkeeping: the engine re-anchored and created a new
      // setup in the same pass. Calling that "invalidated" tells the reader a
      // level failed when none did.
      if (setup.isReplacement) {
        const newZone =
          setup.replacementZoneLow !== null && setup.replacementZoneHigh !== null
            ? ` The new zone is ${setup.replacementZoneLow} – ${setup.replacementZoneHigh}.`
            : "";

        return {
          title: `🔄 Setup re-anchored — ${where}`,
          body:
            "The engine anchored to a different support zone, so this setup was replaced rather " +
            `than invalidated by the market.${newZone}`,
        };
      }

      return {
        title: `🔴 Setup invalidated — ${where}`,
        body: setup.invalidationReason ?? setup.statusReason,
      };
    }

    case "STRUCTURE_CHANGED": {
      const setup = event.setup!;
      const structural = setup.confirmationSignals.filter(
        (s) => s.type === "STRUCTURE_BREAK" || s.type === "RECLAIM",
      );
      return {
        // "Signal", not "changed": this fires on setups being seen for the
        // first time, where nothing changed at all.
        title: `🟠 Structure signal — ${where}`,
        body: structural.map((s) => s.title).join("; ") || setup.statusReason,
      };
    }

    case "DAILY_SUMMARY": {
      const s = event.summary!;
      return {
        title: `📊 Daily summary — ${s.date}`,
        body:
          `${s.marketsScanned} markets scanned. ${s.potentialSetups} potential, ${s.waiting} waiting, ` +
          `${s.highRisk} high risk, ${s.avoided} avoid. ${s.setupsCreated} setups created, ` +
          `${s.confirmations} confirmed, ${s.invalidations} invalidated.`,
      };
    }

    case "SYSTEM_ERROR": {
      const e = event.systemError!;
      // The category is a scanner enum. It names the failure usefully, but not
      // in the shape a person reads, and a row is user-facing text.
      const category = e.category.toLowerCase().replace(/_/g, " ");

      return {
        title: `⚠️ Scanner error — ${category}`,
        body: e.symbol ? `${e.symbol} ${e.timeframe ?? ""}: ${e.message}` : e.message,
      };
    }
  }
}
