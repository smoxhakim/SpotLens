import { DEFAULT_RISK_FEE_RATE } from "@/lib/risk";

/**
 * The demo trial: SpotLens reads the market, a person places every order by
 * hand on Binance Demo Trading, and the journal records what they decided and
 * what the trade did.
 *
 * Its terms are stated once, here, and printed on every report — a result is
 * uninterpretable without them, the same rule a backtest follows. Nothing in
 * this module sizes a position or places an order: `lib/risk` stays the only
 * sizing formula, and SpotLens still has no order path.
 */
export const DEMO_TRIAL = {
  venue: "Binance Demo Trading — simulated funds and a simulated order book",
  capitalUsdt: 100,
  /** Planned loss at the stop, estimated fees included. */
  maxRiskUsdt: 1,
  /**
   * An estimate, not a measured fee: the risk calculator's assumed fee per
   * side, so the report estimates as the calculator does. Binance Demo's own
   * fee was not verified; the fees actually charged are only the ones recorded
   * in the journal, and only the net result uses those.
   */
  estimatedFeeRate: DEFAULT_RISK_FEE_RATE,
  /**
   * How far a take-profit may sit from the primary target and still be it.
   * Covers rounding to the tick: the coarsest tick on the curated list is about
   * 0.1% of price (ALGOUSDT, 0.0001 at 0.095).
   */
  primaryTargetTolerancePct: 0.25,
  execution: "Manual. Every order was placed by hand; SpotLens has no order path.",
  rules: [
    "Trade only Potential setups that are still open and fresh.",
    "Wait for confirmation is not an entry signal, and an Opportunities listing or an entry-zone alert alone is not enough.",
    "Maximum planned risk is 1 USDT including estimated fees.",
    "Size in the risk calculator with a balance of 100 USDT, whatever the Demo balance is, and round the quantity down to the step size.",
    "One primary take-profit: the target the setup's risk/reward was measured to.",
    "Skip the trade when exchange filters, the minimum order or fees make the risk limit impossible to keep.",
    "Record Taken only after the Demo entry has actually filled, with the fill time as the entry time.",
    "Setup invalidation is not a stop-loss and does not by itself require closing a trade: the position's own stop and take-profit decide the exit.",
  ],
} as const;

/** How the fee estimate is named wherever a planned loss is shown. */
export const FEE_ESTIMATE = `estimated fees (${(DEMO_TRIAL.estimatedFeeRate * 100).toFixed(1)}% a side — the risk calculator's assumption, not a verified Binance Demo fee)`;
