import { isForceInterrupt, type Supervisor } from "./supervisor";

/**
 * How the engine and its children stop, so that neither leaves the other
 * running unsupervised.
 *
 * The children are spawned detached — their own process group and session —
 * so a terminal's Ctrl-C reaches the engine once and the engine sends each
 * child exactly one SIGINT. The cost of detaching is that nothing the terminal
 * does reaches the children directly: closing the window sends SIGHUP to the
 * engine alone. Before this, the engine had no SIGHUP handler, died on the
 * default action, and left the scanner and monitor running as orphans — and a
 * new engine then found the monitor's role taken and gave up on it, so when the
 * orphan finally died there was no monitor at all. Three layers close that:
 *
 *  1. `installEngineShutdown`: SIGHUP takes the same graceful path as SIGTERM,
 *     and the engine's own `exit` kills any child still alive.
 *  2. `stopWhenEngineGone`, in each child: when the IPC channel to the engine
 *     closes — the engine is gone, however it went, `kill -9` included — the
 *     child stops as if it had been told to.
 *  3. The supervisor waits for a role held elsewhere instead of abandoning it.
 */

export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
export const SHUTDOWN_SIGNALS: ShutdownSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The parts of `process` this module touches — a fake can provide them in tests. */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  stdout?: { on(event: "error", listener: (err: unknown) => void): unknown } | null;
  stderr?: { on(event: "error", listener: (err: unknown) => void): unknown } | null;
}

const ignore = () => undefined;

/**
 * Writing to a terminal that has hung up fails with EIO (a pipe with no reader,
 * EPIPE). An unhandled stream error would kill the process in the middle of its
 * own shutdown, so those failures are ignored: a lost log line is the lesser
 * loss.
 */
export function ignoreOutputErrors(proc: ProcessLike): void {
  proc.stdout?.on("error", ignore);
  proc.stderr?.on("error", ignore);
}

export function installEngineShutdown(input: {
  proc: ProcessLike;
  supervisor: Pick<Supervisor, "stop" | "forceStop" | "killSurvivors">;
  log: (message: string) => void;
  now: () => number;
}): void {
  const { proc, supervisor, log, now } = input;
  ignoreOutputErrors(proc);

  let firstInterruptAt: number | null = null;

  for (const signal of SHUTDOWN_SIGNALS) {
    proc.on(signal, () => {
      const at = now();
      if (firstInterruptAt === null) {
        firstInterruptAt = at;
        const reason =
          signal === "SIGINT"
            ? "Ctrl-C"
            : signal === "SIGHUP"
              ? "terminal closed (SIGHUP)"
              : signal;
        void supervisor.stop(reason);
        return;
      }
      // The same keypress relayed a second time by a wrapper is not a request to
      // force anything — see FORCE_INTERRUPT_AFTER_MS.
      if (!isForceInterrupt(firstInterruptAt, at)) return;
      log("Second interrupt: killing both children now.");
      supervisor.forceStop();
    });
  }

  // The last line of defence, for every way out that skips the graceful path —
  // an uncaught exception, an unhandled rejection, `process.exit`. `exit`
  // listeners must be synchronous and must not exit again, so this only sends
  // SIGKILL to whatever is still alive and returns.
  proc.on("exit", () => {
    supervisor.killSurvivors();
  });
}

/**
 * For the scanner and the monitor: stop when the engine that started them is
 * gone.
 *
 * A child started by the engine has an IPC channel to it, and that channel
 * closes when the engine's process ends — even on `kill -9`, which no handler in
 * the engine can see. `onGone` is the child's own graceful stop, so a scan in
 * flight unwinds and the lock is released. Run standalone there is no channel,
 * and this does nothing.
 */
export function stopWhenEngineGone(
  proc: ProcessLike & { channel?: unknown; connected?: boolean },
  onGone: () => void,
): boolean {
  if (!proc.channel) return false;
  // Once the engine is gone, its end of the stdout/stderr pipes is too.
  ignoreOutputErrors(proc);
  let called = false;
  proc.on("disconnect", () => {
    if (called) return;
    called = true;
    onGone();
  });
  // A `disconnect` (or `message`) listener makes Node keep the IPC channel
  // referenced, which keeps the process alive after its work is done — the
  // child would then sit until the engine's stop timeout killed it. An explicit
  // unref sticks however many listeners are added later, and the channel still
  // delivers both messages and the disconnect.
  (proc.channel as { unref?: () => void }).unref?.();
  return true;
}
