import { EXIT_ALREADY_RUNNING } from "./lock";
import { isScannerRunCompleted } from "./messages";

/**
 * The engine: one process that runs the scanner and the entry-zone monitor.
 *
 * It supervises and relays, and does nothing else. It analyses no market,
 * reads no price and writes nothing to the database. Each child is the same
 * script a person can run on its own; the engine only starts them, prefixes
 * their output, passes the scanner's "pass completed" message to the monitor,
 * restarts a crashed child a bounded number of times, and stops both cleanly.
 *
 * The two children are independent on purpose. A scanner that crashes leaves
 * the monitor watching the setups already in the database; a monitor that
 * crashes leaves the scanner on its schedule. The engine exits on its own only
 * when neither child is left running.
 *
 * Everything with a side effect — spawning, timers, the clock, logging — is
 * injected, so the restart and shutdown rules are tested without a process.
 */

export type ChildName = "scanner" | "entry-zone";

export interface ChildSpec {
  name: ChildName;
  script: string;
  args: string[];
}

/** What the engine needs from a running child. `scripts/spotlens.ts` adapts `child_process`. */
export interface ChildHandle {
  readonly pid: number | undefined;
  onLine(listener: (line: string, stream: "stdout" | "stderr") => void): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  send(message: unknown): boolean;
  kill(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void;
}

export interface RestartPolicy {
  /** Restarts allowed inside `windowMs` before the engine gives up on a child. */
  maxRestarts: number;
  windowMs: number;
  /** Wait before restart n (0-based); the last value repeats. */
  backoffMs: number[];
  /** How long a child gets to stop after SIGINT before it is killed. */
  stopTimeoutMs: number;
  /**
   * How often to look again at a role another process holds. Reading a lock file
   * costs nothing, so waiting has no bound on duration — only on rate.
   */
  lockRecheckMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxRestarts: 3,
  windowMs: 15 * 60_000,
  backoffMs: [5_000, 30_000, 120_000],
  // A scan pass in flight is allowed to unwind; the scanner aborts its
  // remaining markets on SIGINT, so this is a ceiling rather than a wait.
  stopTimeoutMs: 60_000,
  lockRecheckMs: 30_000,
};

export interface SupervisorDeps {
  spawn(spec: ChildSpec): ChildHandle;
  log(line: string): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /**
   * The PID of a live process holding this role's lock, or null when it is
   * free. Lets the engine wait for a role held elsewhere without spawning a
   * process just to be refused. Without it, the engine re-tries by starting the
   * child on the same schedule.
   */
  lockHolder?(name: ChildName): number | null;
  policy?: RestartPolicy;
}

/**
 * `waiting`: another process holds this role's lock — typically a scanner or
 * monitor left running by an engine that died. The engine looks again every
 * `lockRecheckMs` and starts its own as soon as the role is free, so a role is
 * never abandoned just because someone else had it for a while.
 */
export type ChildState = "starting" | "running" | "restarting" | "waiting" | "stopped" | "gave-up";

export interface Supervisor {
  start(): void;
  /** Graceful stop: SIGINT to each child, SIGKILL after the policy's timeout. */
  stop(reason: string): Promise<void>;
  /** Immediate SIGKILL to every child. For a second Ctrl-C. */
  forceStop(): void;
  /**
   * Synchronous last resort for the engine's own `exit`: SIGKILL to any child
   * still running, and nothing else — no logging, no timers, no promises, since
   * none of those run after `exit`. Returns how many were signalled.
   */
  killSurvivors(): number;
  state(): Record<ChildName, ChildState>;
  /** Resolves with the engine's exit code once nothing is left running. */
  readonly done: Promise<number>;
}

/**
 * A child line, labelled with which child wrote it.
 *
 * The scripts already prefix their own log lines (`[scanner 2026-…]`), and
 * labelling those twice would only add noise. Everything else a child prints —
 * a Prisma warning, a stack trace — arrives unlabelled, and gets the label.
 */
export function prefixLine(name: ChildName, line: string): string {
  return line.startsWith(`[${name} `) || line.startsWith(`[${name}]`) ? line : `[${name}] ${line}`;
}

/**
 * Whether a child that has exited unexpectedly should be started again.
 *
 * Pure, so the bound is tested directly: restarts are counted inside a sliding
 * window, a child that keeps failing is given up on rather than restarted
 * forever, and "already running" is not a restart at all — the supervisor waits
 * for that role's lock to be released instead (see `ChildState`).
 */
export function restartDecision(input: {
  exitCode: number | null;
  recentRestarts: number[];
  now: number;
  policy: RestartPolicy;
}):
  | { restart: true; delayMs: number }
  | { restart: false; reason: "already-running" | "too-many-restarts" } {
  if (input.exitCode === EXIT_ALREADY_RUNNING) return { restart: false, reason: "already-running" };

  const inWindow = input.recentRestarts.filter((at) => input.now - at < input.policy.windowMs);
  if (inWindow.length >= input.policy.maxRestarts) {
    return { restart: false, reason: "too-many-restarts" };
  }

  const backoff = input.policy.backoffMs;
  return { restart: true, delayMs: backoff[Math.min(inWindow.length, backoff.length - 1)] ?? 0 };
}

interface ChildEntry {
  spec: ChildSpec;
  handle: ChildHandle | null;
  state: ChildState;
  restarts: number[];
  timer: unknown;
  /** The "already running elsewhere" line has been logged for the current wait. */
  announcedWait: boolean;
}

export function createSupervisor(specs: ChildSpec[], deps: SupervisorDeps): Supervisor {
  const policy = deps.policy ?? DEFAULT_RESTART_POLICY;
  const children = new Map<ChildName, ChildEntry>(
    specs.map((spec) => [
      spec.name,
      { spec, handle: null, state: "starting", restarts: [], timer: null, announcedWait: false },
    ]),
  );

  let stopping = false;
  let stopTimer: unknown = null;
  let resolveDone: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => (resolveDone = resolve));
  let finished = false;

  const log = (message: string) => deps.log(message);

  function launch(entry: ChildEntry) {
    const handle = deps.spawn(entry.spec);
    entry.handle = handle;
    entry.state = "running";
    log(`${entry.spec.name} started (pid ${handle.pid ?? "?"})`);

    handle.onLine((line) => log(prefixLine(entry.spec.name, line)));

    handle.onMessage((message) => {
      // The only relay: a completed scan tells the monitor to reload now.
      if (entry.spec.name === "scanner" && isScannerRunCompleted(message)) {
        // A monitor that is down or waiting to restart has no handle; it will
        // reload on startup anyway, so the message is simply not needed.
        children.get("entry-zone")?.handle?.send(message);
      }
    });

    handle.onExit((code, signal) => onChildExit(entry, handle, code, signal));
  }

  function onChildExit(
    entry: ChildEntry,
    handle: ChildHandle,
    code: number | null,
    signal: string | null,
  ) {
    // A late exit from a handle that has already been replaced says nothing
    // about the current one.
    if (entry.handle !== handle) return;
    entry.handle = null;

    const how = signal ? `signal ${signal}` : `code ${code}`;

    if (stopping) {
      entry.state = "stopped";
      log(`${entry.spec.name} stopped (${how})`);
      settleIfIdle();
      return;
    }

    // Not a crash: the role is held by another process. Wait for it rather than
    // reporting a failure — and, on a refused re-check, rather than reporting
    // the same "failure" every time.
    if (code === EXIT_ALREADY_RUNNING) {
      waitForLock(entry);
      return;
    }

    const others = [...children.values()].filter((c) => c !== entry && c.handle);
    const stillRunning = others.map((c) => c.spec.name).join(", ") || "nothing";
    log(`${entry.spec.name} EXITED UNEXPECTEDLY (${how}); still running: ${stillRunning}`);

    const decision = restartDecision({
      exitCode: code,
      recentRestarts: entry.restarts,
      now: deps.now(),
      policy,
    });

    // The child really ran, so a later wait is a new one worth announcing.
    entry.announcedWait = false;

    if (!decision.restart) {
      entry.state = "gave-up";
      log(
        `${entry.spec.name} failed ${policy.maxRestarts} times in ${Math.round(policy.windowMs / 60_000)} minutes; ` +
          "giving up on it. Fix the cause and restart the engine.",
      );
      settleIfIdle();
      return;
    }

    entry.state = "restarting";
    entry.restarts = [
      ...entry.restarts.filter((at) => deps.now() - at < policy.windowMs),
      deps.now(),
    ];
    log(
      `restarting ${entry.spec.name} in ${Math.round(decision.delayMs / 1000)}s ` +
        `(restart ${entry.restarts.length} of ${policy.maxRestarts} allowed in ${Math.round(policy.windowMs / 60_000)} minutes)`,
    );
    entry.timer = deps.setTimer(() => {
      entry.timer = null;
      if (!stopping) launch(entry);
    }, decision.delayMs);
  }

  /**
   * Another process holds this role. Not a failure and not a restart: look at
   * the lock every `lockRecheckMs` and start our own child once it is free.
   * Logged once on entering the wait and once on leaving it — a monitor that
   * stays held for hours must not fill the log.
   */
  function waitForLock(entry: ChildEntry) {
    const holder = deps.lockHolder?.(entry.spec.name) ?? null;
    entry.state = "waiting";
    if (!entry.announcedWait) {
      entry.announcedWait = true;
      log(
        `${entry.spec.name} is already running elsewhere${holder ? ` (pid ${holder})` : ""}; ` +
          `the engine will start its own as soon as that one stops ` +
          `(checking every ${Math.round(policy.lockRecheckMs / 1000)}s).`,
      );
    }

    entry.timer = deps.setTimer(() => {
      entry.timer = null;
      if (stopping) return;
      if (deps.lockHolder && deps.lockHolder(entry.spec.name) !== null) {
        waitForLock(entry);
        return;
      }
      log(`${entry.spec.name}'s role is free again; starting it.`);
      launch(entry);
    }, policy.lockRecheckMs);
  }

  /** Ends the engine once no child is running and none is waiting to start. */
  function settleIfIdle() {
    if (finished) return;
    const active = [...children.values()].some(
      (c) => c.handle !== null || c.state === "restarting" || c.state === "waiting",
    );
    if (active) return;

    finished = true;
    if (stopTimer) deps.clearTimer(stopTimer);

    const gaveUp = [...children.values()].some((c) => c.state === "gave-up");
    if (!stopping) log("no child is running any more; the engine is stopping.");
    resolveDone(stopping && !gaveUp ? 0 : 1);
  }

  return {
    start() {
      log(`starting ${specs.map((s) => s.name).join(" + ")}`);
      for (const entry of children.values()) launch(entry);
    },

    stop(reason) {
      if (stopping) return done.then(() => undefined);
      stopping = true;
      log(`stopping (${reason}); each child finishes what it is doing first.`);

      for (const entry of children.values()) {
        if (entry.timer) {
          deps.clearTimer(entry.timer);
          entry.timer = null;
          entry.state = "stopped";
        }
        entry.handle?.kill("SIGINT");
      }

      stopTimer = deps.setTimer(() => {
        for (const entry of children.values()) {
          if (entry.handle) {
            log(
              `${entry.spec.name} did not stop within ${policy.stopTimeoutMs / 1000}s; killing it.`,
            );
            entry.handle.kill("SIGKILL");
          }
        }
      }, policy.stopTimeoutMs);

      settleIfIdle();
      return done.then(() => undefined);
    },

    forceStop() {
      stopping = true;
      for (const entry of children.values()) entry.handle?.kill("SIGKILL");
    },

    killSurvivors() {
      let signalled = 0;
      for (const entry of children.values()) {
        if (!entry.handle) continue;
        entry.handle.kill("SIGKILL");
        signalled += 1;
      }
      return signalled;
    },

    state() {
      return Object.fromEntries(
        [...children.values()].map((c) => [c.spec.name, c.state]),
      ) as Record<ChildName, ChildState>;
    },

    done,
  };
}

/**
 * How long after the first interrupt a second one means "force quit".
 *
 * Ctrl-C in a terminal signals the whole foreground process group — npm, the
 * tsx wrapper and the engine — and a wrapper may then relay the same interrupt
 * to the engine again. Observed: two SIGINTs 32 ms apart from one keypress.
 * Read as "pressed twice", that killed a child that was already shutting down
 * cleanly. A person pressing Ctrl-C again to force it takes far longer than a
 * relay does, so only an interrupt this long after the first counts as one.
 */
export const FORCE_INTERRUPT_AFTER_MS = 1_500;

/** Whether this interrupt asks for an immediate kill rather than a clean stop. */
export function isForceInterrupt(firstInterruptAt: number | null, now: number): boolean {
  return firstInterruptAt !== null && now - firstInterruptAt >= FORCE_INTERRUPT_AFTER_MS;
}

/** Splits a byte stream into whole lines, holding a partial line until it completes. */
export function createLineSplitter(onLine: (line: string) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.length > 0) onLine(line);
    },
    flush() {
      if (buffer.length > 0) onLine(buffer);
      buffer = "";
    },
  };
}
