/**
 * The deterministic confirmation layer.
 *
 * Sits between a setup existing and a setup being worth acting on. Pure, closed
 * candles only, and applied as the last gate before POTENTIAL_SETUP so it can
 * only ever hold a setup back — never promote one past an existing rule.
 */
export { evaluateConfirmation } from "./engine";
export type { ConfirmationInput } from "./engine";
export {
  MIN_POSITIVE_SIGNALS,
  PRIMARY_SIGNALS,
  RECENT_SWING_MAX_AGE_BARS,
  RECLAIM_LOOKBACK_BARS,
  REJECTION_MIN_CLOSE_POSITION,
  REJECTION_MIN_WICK_RATIO,
  THIN_VOLUME_RELATIVE,
  type ConfirmationResult,
  type ConfirmationSignal,
  type ConfirmationSignalType,
  type ConfirmationSignalDirection,
  type ConfirmationStatus,
} from "./types";
