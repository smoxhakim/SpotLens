/**
 * Which rules produced a result, and in what shape its diagnostics were
 * reported.
 *
 * Strings, following `REGIME_VERSION`. They travel beside a record so a reader
 * can tell two rule sets apart; nothing compares them to decide anything.
 */

/**
 * The decision rules: the gates, their order, their thresholds and the levels
 * they build. Bump when the same candles could produce a different status,
 * level, score or confirmation.
 */
export const ANALYSIS_RULES_VERSION = "1";

/** The shape of `AnalysisDiagnostics`. Bump when a field is added, removed or redefined. */
export const DIAGNOSTICS_VERSION = "1";
