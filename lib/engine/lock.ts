import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
 * So is one whose PID now belongs to a different process: every lock records
 * when its holder started, and a live PID whose process started at another time
 * is not the holder. Exactly one process can take a stale lock over; see
 * `acquireLock`.
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
  /** When this process started, epoch ms. Recorded in the lock; see `processStartTime`. */
  processStartedAt?: number;
  /** When a running PID's process started, epoch ms, or null if that cannot be told. */
  startTimeOf?: (pid: number) => number | null;
}

/**
 * How far apart a lock's recorded process start and the live process's own may
 * be and still be the same process. `ps` reports whole seconds; the recorded
 * time is computed from `process.uptime()`. Two different processes reusing one
 * PID start minutes or days apart, not seconds.
 */
export const PROCESS_START_TOLERANCE_MS = 5_000;

/**
 * A takeover claim older than this, whose claimant is gone, was abandoned by a
 * process that died in the few milliseconds a takeover takes.
 */
export const ABANDONED_CLAIM_AFTER_MS = 30_000;

/** When this process started — recorded in every lock it takes. */
const OWN_PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

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

/**
 * When a running process started, epoch ms, from `ps` — or null when it cannot
 * be told (no such process, no `ps`, unparseable output). Seconds precision.
 *
 * This is what tells a lock's holder apart from an unrelated process that was
 * later given the same PID — after a reboot, or on a machine that has cycled
 * through its PID space. A PID alone was obeyed: an unrelated live process
 * could keep a role from starting indefinitely.
 *
 * From the elapsed time (`etime`), not the start timestamp (`lstart`): the
 * timestamp is local wall-clock time, and `ps` and Node can disagree about the
 * local offset — observed an hour apart — which made a live holder look like a
 * different process. Elapsed time has no zone.
 */
export function processStartTime(pid: number, now: () => number = Date.now): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    const elapsed = parseElapsed(out);
    return elapsed === null ? null : now() - elapsed;
  } catch {
    return null;
  }
}

/** `ps` elapsed time — `[[dd-]hh:]mm:ss` — in ms, or null. */
export function parseElapsed(text: string): number | null {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(text);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 +
      Number(seconds)) *
    1000
  );
}

interface Holder {
  pid: number;
  startedAt: string | null;
  /** Absent from locks written before it was recorded; such a lock is obeyed. */
  processStartedAt: number | null;
  nonce: string | null;
}

/**
 * Takes `role`'s lock, or reports the live process that holds it.
 *
 * ## How a stale lock is taken over, by exactly one process
 *
 * A lock file is always written whole: to a temporary file first, then
 * hard-linked into place, which fails if a lock is already there — so a reader
 * never sees half of one, and two creators cannot both succeed.
 *
 * A lock left by a dead process — or by a process whose PID now belongs to
 * someone else — used to be deleted and re-created. Two processes that found
 * the same stale lock could both do that: the second deleted the first's fresh
 * lock, and both believed they held the role (two scanners, duplicate setups).
 * Nothing deletes a lock on a stale read now. Each lock carries a random
 * `nonce`; to take one over, a process must first create the claim file for
 * that nonce — exclusively, so only one process can hold it — then re-read the
 * lock under the claim and, only if it is still the same lock, replace it
 * atomically (rename). A process that lost the claim, or found the lock
 * changed, starts again and sees the winner as a live holder.
 *
 * The one residual case: a process that dies inside the few milliseconds it
 * holds a claim leaves the claim behind. After `ABANDONED_CLAIM_AFTER_MS` it is
 * removed — and two processes removing the same abandoned claim at the same
 * instant could still both proceed. That needs a crash inside the takeover and
 * two racers after it; nothing short of an OS file lock closes it.
 */
export function acquireLock(role: LockRole, options: LockOptions = {}): LockResult {
  const dir = options.dir ?? defaultLockDir();
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const live = liveness(options);
  const file = join(dir, `${role}.lock`);

  mkdirSync(dir, { recursive: true });

  const self: Holder = {
    pid,
    startedAt: new Date(now()).toISOString(),
    processStartedAt: options.processStartedAt ?? OWN_PROCESS_STARTED_AT,
    nonce: randomUUID(),
  };
  const content = JSON.stringify(self);
  const held = (): LockResult => ({ ok: true, release: () => releaseLock(file, self.nonce!) });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (createExclusive(file, content)) return held();

    const seen = readLock(file);
    if (!seen) continue; // released in the meantime; try to create it again

    if (seen.holder && seen.holder.pid !== pid && live(seen.holder)) {
      return { ok: false, holderPid: seen.holder.pid, startedAt: seen.holder.startedAt };
    }

    // Stale: dead holder, reused PID, a previous life of this PID, or unreadable.
    if (takeOver(file, seen.key, content, { pid, now, live })) return held();
  }

  const last = readLock(file)?.holder;
  return { ok: false, holderPid: last?.pid ?? -1, startedAt: last?.startedAt ?? null };
}

/** Is this holder the live process that wrote the lock? */
function liveness(options: LockOptions) {
  const isAlive = options.isAlive ?? processIsAlive;
  const startTimeOf = options.startTimeOf ?? processStartTime;
  return (holder: Pick<Holder, "pid" | "processStartedAt">): boolean => {
    if (!isAlive(holder.pid)) return false;
    // Written before start times were recorded, or `ps` cannot say: obey it, as
    // before. Refusing a role is the safe way to be wrong.
    if (holder.processStartedAt === null) return true;
    const actual = startTimeOf(holder.pid);
    if (actual === null) return true;
    return Math.abs(actual - holder.processStartedAt) <= PROCESS_START_TOLERANCE_MS;
  };
}

/** Replaces the stale lock `key`, if this process wins its claim. */
function takeOver(
  file: string,
  key: string,
  content: string,
  ctx: {
    pid: number;
    now: () => number;
    live: (holder: Pick<Holder, "pid" | "processStartedAt">) => boolean;
  },
): boolean {
  const claim = `${file}.claim-${key}`;
  const claimContent = JSON.stringify({
    pid: ctx.pid,
    processStartedAt: OWN_PROCESS_STARTED_AT,
    at: ctx.now(),
  });

  if (!createExclusive(claim, claimContent)) {
    clearIfAbandoned(claim, ctx);
    return false;
  }
  try {
    // Under the claim: act only on the very lock that was judged stale.
    if (readLock(file)?.key !== key) return false;
    replaceAtomically(file, content);
    return true;
  } finally {
    removeQuietly(claim);
  }
}

/** Removes a claim whose claimant died mid-takeover, once it is old enough. */
function clearIfAbandoned(
  claim: string,
  ctx: {
    now: () => number;
    live: (holder: Pick<Holder, "pid" | "processStartedAt">) => boolean;
  },
) {
  try {
    const parsed = JSON.parse(readFileSync(claim, "utf8")) as {
      pid?: unknown;
      processStartedAt?: unknown;
      at?: unknown;
    };
    const at = typeof parsed.at === "number" ? parsed.at : 0;
    const claimant = {
      pid: typeof parsed.pid === "number" ? parsed.pid : -1,
      processStartedAt:
        typeof parsed.processStartedAt === "number" ? parsed.processStartedAt : null,
    };
    if (ctx.now() - at > ABANDONED_CLAIM_AFTER_MS && !ctx.live(claimant)) removeQuietly(claim);
  } catch {
    // Gone already, or unreadable for an instant while being written.
  }
}

/** The lock as it is now: its holder, if readable, and a key naming this very file. */
function readLock(file: string): { holder: Holder | null; key: string } | null {
  let raw: string;
  let identity: string;
  try {
    raw = readFileSync(file, "utf8");
    const st = statSync(file);
    identity = `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  const holder = parseHolder(raw);
  const key =
    holder?.nonce && /^[0-9a-f-]{36}$/.test(holder.nonce)
      ? holder.nonce
      : // A lock without a nonce (older format, or unreadable): name it by content
        // and identity, so a claim on it is a claim on this file and no other.
        createHash("sha256").update(`${identity}\n${raw}`).digest("hex").slice(0, 32);
  return { holder, key };
}

function parseHolder(raw: string): Holder | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      processStartedAt:
        typeof parsed.processStartedAt === "number" ? parsed.processStartedAt : null,
      nonce: typeof parsed.nonce === "string" ? parsed.nonce : null,
    };
  } catch {
    return null;
  }
}

/** Creates `target` whole, or returns false if it already exists. */
function createExclusive(target: string, content: string): boolean {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { flag: "wx" });
  try {
    linkSync(temp, target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    removeQuietly(temp);
  }
}

/** Replaces `target` in one step: readers see the old lock or the new one. */
function replaceAtomically(target: string, content: string) {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { flag: "wx" });
  try {
    renameSync(temp, target);
  } catch (err) {
    removeQuietly(temp);
    throw err;
  }
}

function removeQuietly(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/**
 * The PID of the live process holding `role`'s lock, or null when the lock is
 * free — absent, unreadable, left by a process that is no longer running, or
 * naming a PID that now belongs to a different process. Read-only: it never
 * takes or clears a lock, so the engine can poll it while it waits for another
 * process to let go of a role.
 */
export function liveLockHolder(
  role: LockRole,
  options: Pick<LockOptions, "dir" | "isAlive" | "startTimeOf"> = {},
): number | null {
  const holder = readLock(join(options.dir ?? defaultLockDir(), `${role}.lock`))?.holder;
  if (!holder) return null;
  return liveness(options)(holder) ? holder.pid : null;
}

/** Removes the lock only if it is still this very lock — same nonce. */
function releaseLock(file: string, nonce: string) {
  if (readLock(file)?.holder?.nonce !== nonce) return;
  removeQuietly(file);
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
