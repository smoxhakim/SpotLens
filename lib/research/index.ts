/**
 * Research: descriptive statistics over history, never prediction.
 *
 * Reuses the backtester's metric definitions so expectancy, profit factor and
 * drawdown mean exactly what they mean elsewhere in the product.
 */
export {
  buildResearchReport,
  engineFunnel,
  humanDecisions,
  toMetricRow,
  type ResearchEntry,
  type ResearchSetup,
} from "./aggregate";
export type { EngineFunnel, HumanDecisions, ResearchFilters, ResearchReport } from "./types";
