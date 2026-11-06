// @vitest-environment node
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { hermeticEnv } from "@/lib/test-utils/hermetic-env";
import { registerCleanup, throwawayDir } from "@/lib/test-utils/throwaway-postgres";

/**
 * The real script as a real process with no database: it reaches nothing and exits 1.
 * In the normal suite: no Docker, no network. Every key a `.env` names is blank, so a
 * checkout's `.env` cannot be picked up by Prisma and reach the database it names.
 */
describe("scanner:once with no database configured", () => {
  it("says so and exits 1, without connecting anywhere", async () => {
    const lockDir = throwawayDir();
    try {
      const child = spawn(
        "node",
        [
          "--import",
          "./lib/test-utils/network-guard.mjs",
          "--import",
          "tsx",
          "scripts/scanner.ts",
          "--once",
        ],
        {
          env: hermeticEnv({
            BINANCE_API_BASE_URL: "http://127.0.0.1:9",
            SPOTLENS_LOCK_DIR: lockDir,
          }),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout.on("data", (d) => void (stdout += d));
      child.stderr.on("data", () => undefined);
      // A process that hangs is a failure, and never outlives the test.
      const unregister = registerCleanup(() => child.kill("SIGKILL"));
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 20_000);
      const code = await new Promise<number | null>((resolve) =>
        child.on("exit", (x) => resolve(x)),
      );
      clearTimeout(watchdog);
      unregister();
      expect(code).toBe(1);
      expect(stdout).toMatch(/No database is configured/);
      expect(stdout).not.toMatch(/Can't reach|retrying in/);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }, 30_000);
});
