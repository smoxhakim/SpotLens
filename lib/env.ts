import { z } from "zod";

/**
 * Environment validation.
 *
 * Checked once at boot so a missing secret fails immediately and loudly,
 * rather than surfacing as a confusing runtime error on whichever request
 * happens to touch it first.
 *
 * Requirements differ by environment on purpose: development is meant to run
 * with nothing configured (the chart works with no database at all), while
 * production must not start without the secrets that keep sessions safe.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().optional(),
  DIRECT_URL: z.string().url().optional(),
  BINANCE_API_BASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_BINANCE_WS_BASE_URL: z.string().optional(),
  AUTH_SECRET: z.string().min(1).optional(),
  NEXTAUTH_SECRET: z.string().min(1).optional(),
  NEXTAUTH_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export interface EnvReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * An empty value in a `.env` file means "not configured" — it is how a
 * commented-out or placeholder line is usually left behind. Zod would instead
 * see a present-but-invalid string and fail the whole boot, so
 * `UPSTASH_REDIS_REST_URL=` alone was enough to stop production starting.
 * Dropping blanks makes every `.optional()` above mean what it says.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

export function validateEnv(source: NodeJS.ProcessEnv = process.env): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = schema.safeParse(withoutBlanks(source));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join(".")}: ${issue.message}`);
    }
    return { ok: false, errors, warnings };
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === "production";
  const hasAuthSecret = Boolean(env.AUTH_SECRET || env.NEXTAUTH_SECRET);

  if (isProduction) {
    // Without a secret, Auth.js cannot sign sessions safely.
    if (!hasAuthSecret) {
      errors.push("AUTH_SECRET (or NEXTAUTH_SECRET) is required in production.");
    }
    if (!env.DATABASE_URL) {
      errors.push("DATABASE_URL is required in production — accounts and history depend on it.");
    }
    if (env.DATABASE_URL?.includes("localhost")) {
      errors.push("DATABASE_URL points at localhost in production.");
    }
    if (!env.UPSTASH_REDIS_REST_URL) {
      warnings.push(
        "No Upstash configured: rate limits are per-instance and reset on restart. Fine for a single instance, not for several.",
      );
    }
  } else {
    if (!hasAuthSecret) {
      warnings.push(
        "No AUTH_SECRET set — sign-in will not work. Generate one: openssl rand -base64 32",
      );
    }
    if (!env.DATABASE_URL) {
      warnings.push(
        "No DATABASE_URL: charts and analysis work, but accounts, watchlist and backtests do not.",
      );
    }
  }

  if (env.DATABASE_URL?.includes("-pooler") && !env.DIRECT_URL) {
    warnings.push(
      "DATABASE_URL uses a connection pooler but DIRECT_URL is unset. Migrations need a direct connection.",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Throws in production, warns in development. Called once from instrumentation. */
export function assertEnv(source: NodeJS.ProcessEnv = process.env): void {
  const report = validateEnv(source);

  for (const warning of report.warnings) console.warn(`[env] ${warning}`);

  if (!report.ok) {
    const message = `Invalid environment:\n  - ${report.errors.join("\n  - ")}`;
    if (source.NODE_ENV === "production") throw new Error(message);
    console.error(`[env] ${message}`);
  }
}
