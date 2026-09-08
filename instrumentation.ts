/**
 * Runs once when the server starts. Next.js calls this before handling any
 * request, which is the right place to fail fast on a broken environment.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnv } = await import("@/lib/env");
    assertEnv();
  }
}
