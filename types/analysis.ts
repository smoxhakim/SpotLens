import type { AnalysisResult } from "@/lib/analysis";
import type { Timeframe } from "@/lib/market-data/provider";

export interface AnalysisRunResponse {
  pairId: string;
  symbol: string;
  label: string;
  timeframe: Timeframe;
  /** Epoch ms of the last candle the analysis saw. */
  asOf: number;
  result: AnalysisResult;
}
