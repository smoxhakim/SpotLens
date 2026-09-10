import { describe, expect, it } from "vitest";
import { z } from "zod";

import { timeframeSchema } from "@/lib/market-data/schema";

/**
 * The query contract for GET /api/setups.
 *
 * Kept in step with the route by construction: both build the schema from the
 * same shared `timeframeSchema`, so adding a timeframe cannot leave a stale
 * copy behind here.
 */
const LIFECYCLE_STATUSES = [
  "SETUP_FORMING",
  "WAITING_CONFIRMATION",
  "CONFIRMATION_DETECTED",
  "POTENTIAL_SETUP",
  "INVALIDATED",
] as const;

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(LIFECYCLE_STATUSES).optional(),
  tradingPairId: z.string().uuid().optional(),
  timeframe: timeframeSchema.optional(),
});

describe("GET /api/setups query validation", () => {
  it("defaults to a bounded page size", () => {
    expect(querySchema.parse({}).limit).toBe(25);
  });

  it("refuses a page size that would let one request read everything", () => {
    expect(querySchema.safeParse({ limit: "1000" }).success).toBe(false);
    expect(querySchema.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("refuses a lifecycle status the state machine does not define", () => {
    expect(querySchema.safeParse({ status: "CONFIRMED" }).success).toBe(false);
    expect(querySchema.safeParse({ status: "WAITING_CONFIRMATION" }).success).toBe(true);
  });

  it("refuses a trading pair id that is not a uuid", () => {
    expect(querySchema.safeParse({ tradingPairId: "'; drop table" }).success).toBe(false);
  });

  it("accepts every timeframe the app defines, and nothing else", () => {
    expect(querySchema.safeParse({ timeframe: "H4" }).success).toBe(true);
    expect(querySchema.safeParse({ timeframe: "H3" }).success).toBe(false);
  });
});

describe("GET /api/setups/:id param validation", () => {
  const paramsSchema = z.object({ id: z.string().uuid() });

  it("requires a uuid", () => {
    expect(paramsSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
    expect(paramsSchema.safeParse({ id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }).success).toBe(
      true,
    );
  });
});
