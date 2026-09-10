import { RISK_DISCLAIMER } from "@/lib/constants/disclaimers";

import {
  COSTS_SIGNIFICANT_RATIO,
  DEFAULT_RISK_FEE_RATE,
  DEFAULT_RISK_SLIPPAGE_RATE,
  HIGH_RISK_PERCENT,
  TIGHT_STOP_PERCENT,
  type RiskCalculation,
  type RiskError,
  type RiskInput,
  type RiskResult,
  type RiskWarning,
} from "./types";

/**
 * Position size from the stop distance.
 *
 * Pure, and exact until the moment of display: nothing is rounded on the way
 * through, because rounding a quantity mid-calculation and then multiplying it
 * back out produces a risk figure that is quietly wrong.
 *
 * ## The formula
 *
 *   riskAmount   = balance × riskPercent / 100
 *   stopDistance = entry − stopLoss
 *   quantity     = riskAmount / stopDistance
 *   positionQuote = quantity × entry
 *
 * With 100 balance, 1% risk, entry 100 and stop 95: risk 1, distance 5,
 * quantity 0.2, position 20. The user is not investing 100, and not 1.
 *
 * ## Spot cannot exceed the balance
 *
 * A tighter stop implies a larger position for the same risk, and past some
 * point that position costs more than the account holds. On spot there is no
 * borrowing, so it is capped — and the capped position then risks *less* than
 * intended, which is reported rather than glossed over.
 */
export function calculateRisk(input: RiskInput): RiskResult {
  const errors = validate(input);
  if (errors.length > 0) return { ok: false, errors };

  const feeRate = input.feeRate ?? DEFAULT_RISK_FEE_RATE;
  const slippageRate = input.slippageRate ?? DEFAULT_RISK_SLIPPAGE_RATE;

  const intendedRiskAmount = input.balance * (input.riskPercent / 100);
  const stopDistance = input.entry - input.stopLoss;
  const stopDistancePercent = (stopDistance / input.entry) * 100;

  const uncappedQuantity = intendedRiskAmount / stopDistance;
  const uncappedPositionQuote = uncappedQuantity * input.entry;

  // Spot: never more than the balance. A tighter exposure limit narrows it
  // further, but nothing can widen it — a tight stop must not become an
  // argument for borrowing.
  const exposureCap =
    input.maxExposurePercent === undefined
      ? input.balance
      : Math.min(input.balance, input.balance * (input.maxExposurePercent / 100));

  const wasCapped = uncappedPositionQuote > exposureCap;
  const positionQuote = wasCapped ? exposureCap : uncappedPositionQuote;
  const quantity = positionQuote / input.entry;

  // The number that matters when a cap applies. A smaller position loses less
  // at the same stop, so the trade no longer risks what was asked for.
  const actualRiskAmount = quantity * stopDistance;

  // Costs on both legs, in the backtester's convention: fees on notional in
  // and out, slippage always against the trade.
  const costRate = feeRate + slippageRate;
  const estimatedCosts = quantity * (input.entry + input.stopLoss) * costRate;
  const estimatedNetLoss = actualRiskAmount + estimatedCosts;

  const takeProfit = input.takeProfit ?? null;
  const potentialGrossProfit = takeProfit === null ? null : quantity * (takeProfit - input.entry);
  const potentialNetProfit =
    takeProfit === null || potentialGrossProfit === null
      ? null
      : potentialGrossProfit - quantity * (input.entry + takeProfit) * costRate;

  // Reward to risk per unit — the same definition the setup engine uses, so a
  // number carried over from a setup and one typed by hand agree.
  const riskReward = takeProfit === null ? null : (takeProfit - input.entry) / stopDistance;

  return {
    ok: true,
    calculation: {
      balance: input.balance,
      riskPercent: input.riskPercent,
      entry: input.entry,
      stopLoss: input.stopLoss,
      takeProfit,

      intendedRiskAmount,
      stopDistance,
      stopDistancePercent,

      uncappedPositionQuote,
      uncappedQuantity,
      exposureCap,
      positionQuote,
      quantity,
      positionPercentOfBalance: (positionQuote / input.balance) * 100,
      wasCapped,
      actualRiskAmount,

      estimatedCosts,
      estimatedNetLoss,
      potentialGrossProfit,
      potentialNetProfit,
      riskReward,
      riskRewardIsSynthetic: Boolean(input.takeProfitIsSynthetic),

      warnings: warningsFor({
        input,
        stopDistancePercent,
        wasCapped,
        intendedRiskAmount,
        actualRiskAmount,
        estimatedCosts,
      }),
      disclaimer: RISK_DISCLAIMER,
    },
  };
}

/**
 * Structured errors rather than a bare null.
 *
 * Every invalid input names itself, because "the calculator returned nothing"
 * is indistinguishable from "the calculator thinks the answer is zero", and a
 * risk tool must never be ambiguous about which.
 */
function validate(input: RiskInput): RiskError[] {
  const errors: RiskError[] = [];
  const finite = (value: number) => Number.isFinite(value);

  if (!finite(input.balance) || input.balance <= 0) {
    errors.push({
      code: "INVALID_BALANCE",
      field: "balance",
      message: "Account balance must be a positive number.",
    });
  }

  if (!finite(input.riskPercent) || input.riskPercent <= 0 || input.riskPercent > 100) {
    errors.push({
      code: "INVALID_RISK_PERCENT",
      field: "riskPercent",
      message: "Risk must be greater than 0 and no more than 100 percent.",
    });
  }

  if (!finite(input.entry) || input.entry <= 0) {
    errors.push({
      code: "INVALID_ENTRY",
      field: "entry",
      message: "Entry price must be a positive number.",
    });
  }

  if (!finite(input.stopLoss) || input.stopLoss <= 0) {
    errors.push({
      code: "INVALID_STOP",
      field: "stopLoss",
      message: "Stop loss must be a positive number.",
    });
  }

  // Checked only once both prices are individually sane, so the message is
  // about the relationship rather than about a NaN.
  if (
    finite(input.entry) &&
    finite(input.stopLoss) &&
    input.entry > 0 &&
    input.stopLoss > 0 &&
    input.stopLoss >= input.entry
  ) {
    errors.push({
      code: "STOP_NOT_BELOW_ENTRY",
      field: "stopLoss",
      message:
        input.stopLoss === input.entry
          ? "The stop loss cannot equal the entry: there would be no distance to size from."
          : "The stop loss must be below the entry. SpotLens covers spot longs only and has no short sizing.",
    });
  }

  if (input.takeProfit !== undefined) {
    if (!finite(input.takeProfit) || input.takeProfit <= 0) {
      errors.push({
        code: "INVALID_TAKE_PROFIT",
        field: "takeProfit",
        message: "Take profit must be a positive number.",
      });
    } else if (finite(input.entry) && input.takeProfit <= input.entry) {
      errors.push({
        code: "INVALID_TAKE_PROFIT",
        field: "takeProfit",
        message: "Take profit must be above the entry for a long.",
      });
    }
  }

  if (input.maxExposurePercent !== undefined) {
    if (
      !finite(input.maxExposurePercent) ||
      input.maxExposurePercent <= 0 ||
      input.maxExposurePercent > 100
    ) {
      errors.push({
        code: "INVALID_EXPOSURE_CAP",
        field: "maxExposurePercent",
        message: "Maximum exposure must be greater than 0 and no more than 100 percent.",
      });
    }
  }

  for (const [field, value] of [
    ["feeRate", input.feeRate],
    ["slippageRate", input.slippageRate],
  ] as const) {
    if (value === undefined) continue;
    if (!finite(value) || value < 0 || value > 0.1) {
      errors.push({
        code: "INVALID_COSTS",
        field,
        message: "Fee and slippage rates must be between 0 and 0.1 (10%).",
      });
    }
  }

  return errors;
}

function warningsFor(context: {
  input: RiskInput;
  stopDistancePercent: number;
  wasCapped: boolean;
  intendedRiskAmount: number;
  actualRiskAmount: number;
  estimatedCosts: number;
}): RiskWarning[] {
  const warnings: RiskWarning[] = [];
  const { input } = context;

  if (context.wasCapped) {
    const limit =
      input.maxExposurePercent === undefined
        ? "the account balance"
        : `the ${input.maxExposurePercent}% exposure limit`;

    warnings.push({
      code: "POSITION_CAPPED",
      message:
        `Risking ${input.riskPercent}% with this stop would need a position larger than ${limit}, ` +
        `so it has been capped. The capped position risks ${context.actualRiskAmount.toFixed(2)} ` +
        `rather than the ${context.intendedRiskAmount.toFixed(2)} intended — less, not more. ` +
        `Spot has no borrowing, so a tighter stop cannot buy a larger position than the account holds.`,
    });
  }

  if (context.stopDistancePercent < TIGHT_STOP_PERCENT) {
    warnings.push({
      code: "TIGHT_STOP",
      message:
        `The stop is ${context.stopDistancePercent.toFixed(2)}% from the entry. A stop that close ` +
        `implies a large position for the same risk, and ordinary market noise is more likely to reach it.`,
    });
  }

  if (input.riskPercent > HIGH_RISK_PERCENT) {
    warnings.push({
      code: "HIGH_RISK_PERCENT",
      message:
        `Risking ${input.riskPercent}% per trade is well above the 1–2% that most risk frameworks use. ` +
        `A short run of losses compounds quickly at this size.`,
    });
  }

  // Measured against what the trade *actually* risks, not what was intended.
  // When a cap applies those differ, and comparing to the intended figure
  // would understate the problem precisely in the case that provokes it: a
  // stop tight enough to cap the position is also the stop whose costs are
  // largest relative to its risk.
  if (context.estimatedCosts > context.actualRiskAmount * COSTS_SIGNIFICANT_RATIO) {
    warnings.push({
      code: "COSTS_LARGE_VS_RISK",
      message:
        `Estimated costs of ${context.estimatedCosts.toFixed(2)} are large next to the ` +
        `${context.actualRiskAmount.toFixed(2)} actually at risk. Fees are charged on the whole ` +
        `position, not on the risk, so a tight stop pays proportionally more to trade.`,
    });
  }

  if (input.takeProfitIsSynthetic) {
    warnings.push({
      code: "UNMEASURED_TARGET",
      message:
        "This target was not measured against structure — it is a multiple of the risk, so the ratio " +
        "restates that multiple rather than describing where sellers are waiting.",
    });
  }

  return warnings;
}
