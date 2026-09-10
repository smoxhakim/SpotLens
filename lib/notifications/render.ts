import type { NotificationEvent } from "./types";

/**
 * The short form shown in the app's own list.
 *
 * Separate from the Telegram formatter because the constraints differ: this is
 * read next to the chart it describes, so it can be brief, and it needs no
 * escaping because React renders it as text rather than markup.
 */
export function renderInApp(event: NotificationEvent): { title: string; body: string } {
  const where = [event.asset, event.timeframe].filter(Boolean).join(" ");

  switch (event.type) {
    case "SETUP_DETECTED": {
      const setup = event.setup!;
      return {
        title: `Potential setup — ${where}`,
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
        title: `Confirmation detected — ${where}`,
        body:
          positives.length > 0
            ? `${positives.map((s) => s.title).join("; ")}. Review the chart before deciding.`
            : "The confirmation layer found the evidence it requires. Review the chart before deciding.",
      };
    }

    case "SETUP_INVALIDATED": {
      const setup = event.setup!;
      return {
        title: `Setup invalidated — ${where}`,
        body: setup.invalidationReason ?? setup.statusReason,
      };
    }

    case "STRUCTURE_CHANGED": {
      const setup = event.setup!;
      const structural = setup.confirmationSignals.filter(
        (s) => s.type === "STRUCTURE_BREAK" || s.type === "RECLAIM",
      );
      return {
        title: `Structure changed — ${where}`,
        body: structural.map((s) => s.title).join("; ") || setup.statusReason,
      };
    }

    case "DAILY_SUMMARY": {
      const s = event.summary!;
      return {
        title: `Daily summary — ${s.date}`,
        body:
          `${s.marketsScanned} markets scanned. ${s.potentialSetups} potential, ${s.waiting} waiting, ` +
          `${s.highRisk} high risk, ${s.avoided} avoid. ${s.setupsCreated} setups created, ` +
          `${s.confirmations} confirmed, ${s.invalidations} invalidated.`,
      };
    }

    case "SYSTEM_ERROR": {
      const e = event.systemError!;
      return {
        title: `Scanner error — ${e.category}`,
        body: e.symbol ? `${e.symbol} ${e.timeframe ?? ""}: ${e.message}` : e.message,
      };
    }
  }
}
