import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { MarketDataError } from "@/lib/market-data/provider";
import type { ApiErrorResponse } from "@/types/market";

export function apiError(code: string, message: string, status: number) {
  return NextResponse.json<ApiErrorResponse>({ error: { code, message } }, { status });
}

export function validationError(err: ZodError) {
  const first = err.errors[0];
  const where = first?.path.join(".");
  return apiError(
    "INVALID_REQUEST",
    first ? `${where ? `${where}: ` : ""}${first.message}` : "Invalid request.",
    400,
  );
}

/** Maps thrown errors to a safe response — never leaks internals to the client. */
export function handleRouteError(err: unknown, context: string) {
  if (err instanceof ZodError) return validationError(err);

  if (err instanceof MarketDataError) {
    console.error(`[${context}] ${err.code}: ${err.message}`);
    return apiError(err.code, marketErrorMessage(err), err.httpStatus);
  }

  console.error(`[${context}] unexpected error`, err);
  return apiError("INTERNAL_ERROR", "Something went wrong. Please try again.", 500);
}

function marketErrorMessage(err: MarketDataError): string {
  switch (err.code) {
    case "UNKNOWN_SYMBOL":
      return "This market is not listed on the data provider.";
    case "RATE_LIMITED":
      return "The market data provider is rate limiting us. Try again in a moment.";
    case "TIMEOUT":
      return "The market data provider took too long to respond.";
    default:
      return "Market data is temporarily unavailable.";
  }
}
