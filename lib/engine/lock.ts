import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One process per role, on this machine.
 *
 * Two scanners running at once is not merely wasteful: both reconcile the same
 * markets against the same open setups, and the setup lifecycle has no unique
 * constraint that would stop them each creating a setup for the same level.
 * Two monitors are safe for notifications — the unique index makes the second
 * alert a no-op — but they double the exchange traffic for nothing. So each
 * role takes a lock file before it does anything, and refuses to start if a
 * live process already holds it.
 *
 * A lock left behind by a process that died (a crash, `kill -9`) names a PID
 * that is no longer running, and is taken over rather than obeyed — otherwise
 * one bad exit would block the engine until someone found and deleted a file.
 *
 * Local only, deliberately: SpotLens is a local application, and this guards
 * against the mistake that actually happens here — `npm run monitor` in one
 * terminal while `npm run spotlens` runs in another. It does not coordinate
 * across machines; the notification unique index is what keeps a second
 * machine's alerts from duplicating.
 */

export type LockRole = "engine" | "scanner" | "entry-zone";

/**
 * Exit code a child uses when its role is already running. Not a crash, so
 * never counted as a restart: the engine waits for the role's lock to be free
 * (re-reading it with `liveLockHolder`) and only then starts the child again.
 */
export const EXIT_ALREADY_RUNNING = 3;

export type LockResult =
  { ok: true; release: () => void } | { ok: false; holderPid: number; startedAt: string | null };

export interface LockOptions {
  dir?: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export function defaultLockDir(): string {
  return process.env.SPOTLENS_LOCK_DIR || join(process.cwd(), ".spotlens", "locks");
}

/** Whether a PID names a running process. EPERM means it exists but is not ours. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(role: LockRole, options: LockOptions = {}): LockResult {
  const dir = options.dir ?? defaultLockDir();
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const now = options.now ?? Date.now;
  const file = join(dir, `${role}.lock`);

  mkdirSync(dir, { recursive: true });

  // Two attempts: the second only after removing a lock whose holder is dead.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify({ pid, startedAt: new Date(now()).toISOString() }), {
        flag: "wx",
      });
      return { ok: true, release: () => releaseLock(file, pid) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const holder = readHolder(file);

    if (holder && holder.pid !== pid && isAlive(holder.pid)) {
      return { ok: false, holderPid: holder.pid, startedAt: holder.startedAt };
    }

    // Stale, unreadable, or our own: clear it and try once more.
    try {
      unlinkSync(file);
    } catch {
      // Another process cleared it first; the next attempt settles who wins.
    }
  }

  const holder = readHolder(file);
  return { ok: false, holderPid: holder?.pid ?? -1, startedAt: holder?.startedAt ?? null };
}

function readHolder(file: string): { pid: number; startedAt: string | null } | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; startedAt?: unknown };
    if (typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * The PID of a live process holding `role`'s lock, or null when the lock is
 * free — absent, unreadable, or left by a process that is no longer running.
 * Read-only: it never takes or clears a lock, so the engine can poll it while
 * it waits for another process to let go of a role.
 */
export function liveLockHolder(
  role: LockRole,
  options: Pick<LockOptions, "dir" | "isAlive"> = {},
): number | null {
  const holder = readHolder(join(options.dir ?? defaultLockDir(), `${role}.lock`));
  if (!holder) return null;
  return (options.isAlive ?? processIsAlive)(holder.pid) ? holder.pid : null;
}

/** Removes the lock only if this process still holds it. */
function releaseLock(file: string, pid: number) {
  if (readHolder(file)?.pid !== pid) return;
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/**
 * Takes the role's lock for the life of this process, or exits.
 *
 * The shared entry point for the scanner and monitor scripts. Exits with
 * `EXIT_ALREADY_RUNNING` so the engine can tell "already running" apart from a
 * crash, and waits for the lock instead of restarting into one it cannot get.
 */
export function holdLockOrExit(role: LockRole, log: (message: string) => void): void {
  const lock = acquireLock(role);

  if (!lock.ok) {
    log(
      `Another ${role} process is already running (pid ${lock.holderPid}` +
        `${lock.startedAt ? `, since ${lock.startedAt}` : ""}). Not starting a second one.`,
    );
    process.exit(EXIT_ALREADY_RUNNING);
  }

  process.on("exit", lock.release);
}
