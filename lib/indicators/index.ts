/**
 * Pure indicator math. No I/O, no framework imports — candles in, numbers out.
 * This layer is the foundation the analysis engine reasons over, so it is the
 * most heavily unit-tested code in the project.
 */
export { atr, latestAtr, trueRange } from "./atr";
export { ema, latestEma } from "./ema";
export { rsi, latestRsi } from "./rsi";
export { analyzeVolume, averageVolume } from "./volume";
export type { VolumeRead, VolumeTrend } from "./volume";
export { closes, highs, lows, volumes } from "./series";
