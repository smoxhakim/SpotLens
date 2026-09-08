import { z } from "zod";

import { TIMEFRAMES, type Timeframe } from "./provider";

/**
 * One schema for every route that accepts a timeframe.
 *
 * Previously each route inlined its own `z.enum([...])`, so adding a timeframe
 * meant editing five literal lists and hoping none were missed. Deriving it
 * from TIMEFRAMES makes that impossible.
 */
export const timeframeSchema = z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]);
