/**
 * Single source of truth for every disclaimer in the product.
 *
 * Rendered identically everywhere, and version-stamped onto persisted analyses
 * and backtest reports so historical results always display the wording that
 * was current when they were generated.
 */

export const DISCLAIMER_VERSION = "2026-09-08";

export const ANALYSIS_DISCLAIMER =
  "This analysis is educational and informational only. Market conditions can change, and no trade outcome is guaranteed.";

export const BACKTEST_DISCLAIMER =
  "Historical performance does not guarantee future results. Backtests are an educational check on the method, not a forecast.";

export const ETHICAL_CHECKLIST_DISCLAIMER =
  "This checklist is for research purposes and is not a religious ruling (fatwa). Users should consult qualified scholars for religious decisions.";

export const RISK_DISCLAIMER = "Never risk money that you cannot afford to lose.";

export const SPOT_ONLY_NOTE =
  "SpotLens covers spot trading only — no futures, margin, leverage, or short selling — and never places trades for you.";
