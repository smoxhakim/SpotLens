import type { VolumeRead } from "@/lib/indicators";

/**
 * Volume commentary. Deliberately never a signal on its own — it qualifies a
 * move that price action has already established.
 */
export function explainVolume(read: VolumeRead | null): string {
  if (!read) {
    return "There is not enough history on this timeframe to compare volume against its average.";
  }

  const relative = read.relative;
  const trendPhrase =
    read.trend === "INCREASING"
      ? "Volume has been building over recent candles."
      : read.trend === "DECREASING"
        ? "Volume has been fading over recent candles."
        : "Volume has been steady over recent candles.";

  if (relative >= 2) {
    return `The latest candle traded on ${relative.toFixed(1)}× its average volume — a strong conviction move. ${trendPhrase}`;
  }
  if (read.isAboveAverage) {
    return `The latest candle traded on ${relative.toFixed(1)}× its average volume, which supports the move. ${trendPhrase}`;
  }
  if (relative <= 0.6) {
    return `The latest candle traded on only ${relative.toFixed(1)}× its average volume. A breakout on volume this thin is weakly confirmed. ${trendPhrase}`;
  }
  return `The latest candle traded near its average volume (${relative.toFixed(1)}×), so volume neither confirms nor contradicts the move. ${trendPhrase}`;
}
