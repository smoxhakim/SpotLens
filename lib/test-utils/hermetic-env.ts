import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Importing `@prisma/client` can load the checkout's `.env` by itself, for every key the
 * environment does not already hold, including DATABASE_URL and a Telegram token. No
 * `new PrismaClient`, no query: the import is enough. It happens when a `.env` existed at
 * `prisma generate`, because the lookup is built into the generated client, and that is
 * the main checkout. A fresh worktree's client has no lookup, which hides all of this.
 * So an unset key is not a safe key. A real scanner process started with no DATABASE_URL,
 * with such a client, connected to the database that file named (measured, with a fake
 * `.env`).
 *
 * A key that is present but blank is left alone. So a test process starts with every
 * key the checkout's `.env` names set blank, and only then the values it means to use.
 *
 * In a test that imports Prisma, the blanking has to happen first:
 *
 *   await vi.hoisted(async () => {
 *     const { applyHermeticEnv } = await import("@/lib/test-utils/hermetic-env");
 *     applyHermeticEnv({});
 *   });
 *
 * No Prisma import here, and none may be added: that would defeat the point.
 */

/** Blanked whether or not a `.env` names them. */
const ALWAYS_BLANK = [
  "DATABASE_URL",
  "DIRECT_URL",
  "SHADOW_DATABASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CONFIRMATION_BOT_TOKEN",
  "OPENAI_API_KEY",
  "SCANNER_USER_EMAIL",
];

/** The names of the keys in a `.env` file. Values are never read into anything. */
export function envFileKeys(cwd: string = process.cwd()): string[] {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return [];
  const keys: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

function blanks(cwd: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...ALWAYS_BLANK, ...envFileKeys(cwd)]) env[key] = "";
  return env;
}

/** For a child process: nothing inherited but PATH and HOME. */
export function hermeticEnv(
  explicit: Record<string, string>,
  cwd: string = process.cwd(),
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    ...blanks(cwd),
    ...explicit,
  } as NodeJS.ProcessEnv;
}

/** For this process. Call before anything imports the Prisma client or the app's services. */
export function applyHermeticEnv(
  explicit: Record<string, string>,
  cwd: string = process.cwd(),
): void {
  Object.assign(process.env, blanks(cwd), explicit);
}

/** Throws if a key that could reach something real holds a value in this process. */
export function assertEnvNeutralised(cwd: string = process.cwd()): void {
  const live = Object.keys(blanks(cwd)).filter((key) => process.env[key]);
  if (live.length > 0) {
    throw new Error(
      `Refusing to start: ${live.join(", ")} still set. Call applyHermeticEnv in vi.hoisted, before any import that reaches Prisma.`,
    );
  }
}
