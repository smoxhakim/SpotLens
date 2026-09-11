import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { apiError } from "./api/response";
import { warnOnce } from "./log";

export interface RateLimitRule {
  /** Namespace, so two routes never share a bucket. */
  name: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Rate limiting, backed by Upstash when it is configured and by an in-process
 * window when it is not.
 *
 * The in-process fallback is honest about what it is: counters live in one
 * server's memory, so several instances each get their own allowance and a
 * restart clears them. That is fine for a single-instance deployment and
 * useless as an abuse defence across many — which is why the Upstash path
 * exists and takes over automatically once the environment variables are set.
 *
 * Even single-instance, this earns its place: it is what stops a runaway
 * client loop from hammering the exchange API and getting the whole app
 * rate-limited upstream.
 */
const memory = new Map<string, number[]>();

let upstash: Ratelimit | null | undefined;

function upstashLimiter(rule: RateLimitRule): Ratelimit | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }

  try {
    upstash ??= new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(rule.limit, `${Math.ceil(rule.windowMs / 1000)} s`),
      prefix: "spotlens",
    });
    return upstash;
  } catch (err) {
    warnOnce(
      "ratelimit:upstash",
      "[rate-limit] Upstash unavailable — using in-process limits.",
      err,
    );
    return null;
  }
}

export async function checkRateLimit(
  identifier: string,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  const key = `${rule.name}:${identifier}`;

  const limiter = upstashLimiter(rule);
  if (limiter) {
    const result = await limiter.limit(key);
    return { ok: result.success, remaining: result.remaining, resetAt: result.reset };
  }

  const now = Date.now();
  const cutoff = now - rule.windowMs;
  const hits = (memory.get(key) ?? []).filter((t) => t > cutoff);

  if (hits.length >= rule.limit) {
    return { ok: false, remaining: 0, resetAt: hits[0] + rule.windowMs };
  }

  hits.push(now);
  memory.set(key, hits);

  // Opportunistic sweep so the map cannot grow without bound.
  if (memory.size > 5_000) {
    for (const [k, v] of memory) {
      if (v.every((t) => t <= cutoff)) memory.delete(k);
    }
  }

  return { ok: true, remaining: rule.limit - hits.length, resetAt: now + rule.windowMs };
}

/** Test seam. */
export function resetRateLimits() {
  memory.clear();
  upstash = undefined;
}

/**
 * Caller identity for limiting: the signed-in user where there is one, else
 * the client address. Falls back to a shared bucket rather than an empty key,
 * so a missing header cannot hand someone an unlimited allowance.
 */
export function rateLimitIdentifier(req: Request, userId?: string | null): string {
  if (userId) return `user:${userId}`;

  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip");

  return ip ? `ip:${ip}` : "ip:unknown";
}

/** Returns a 429 response when the caller is over the limit, else null. */
export async function enforceRateLimit(req: Request, rule: RateLimitRule, userId?: string | null) {
  const result = await checkRateLimit(rateLimitIdentifier(req, userId), rule);
  if (result.ok) return null;

  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  const response = apiError(
    "RATE_LIMITED",
    `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
    429,
  );
  response.headers.set("retry-after", String(retryAfter));
  return response;
}

/** Limits per route, tuned to what each one actually costs. */
export const RATE_LIMITS = {
  /** Runs the engine and may hit the exchange. */
  analysis: { name: "analysis", limit: 30, windowMs: 60_000 },
  /** Replays up to 1000 bars synchronously — by far the most expensive route. */
  backtest: { name: "backtest", limit: 5, windowMs: 60_000 },
  /** Account creation, the classic abuse target. */
  register: { name: "register", limit: 5, windowMs: 60 * 60_000 },
  /** Reads that fall through to the exchange on a cache miss. */
  marketData: { name: "market-data", limit: 120, windowMs: 60_000 },
  /**
   * Telegram connection attempts. Tight on purpose: each one issues or claims a
   * one-time code, and a generous limit here would turn a short code into
   * something worth guessing.
   */
  telegramConnect: { name: "telegram-connect", limit: 10, windowMs: 60_000 },
  /**
   * Polling for the code the user sent the bot. Separate from issuing one, and
   * deliberately roomier: Settings polls every three seconds for as long as the
   * code is on screen, so a limit sized for issuing codes would cut the
   * connection flow off half a minute into its ten-minute window. Guessing is
   * bounded where it actually happens — `MAX_CLAIM_ATTEMPTS`, counted against
   * messages sent to the bot — not here.
   */
  telegramClaim: { name: "telegram-claim", limit: 40, windowMs: 60_000 },
  /** Outbound test messages, so the button cannot be used to spam a chat. */
  telegramTest: { name: "telegram-test", limit: 5, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;
