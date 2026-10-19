import type { ChildHandle } from "./supervisor";
import { createLineSplitter } from "./supervisor";

/**
 * Adapts a spawned child process to the supervisor's `ChildHandle`.
 *
 * Kept out of `scripts/spotlens.ts` so the failure handling below is tested
 * against real and fake processes rather than trusted.
 *
 * ## Errors are handled, never left to crash the engine
 *
 * A `ChildProcess` emits `error` when it cannot be spawned, cannot be killed, or
 * cannot be sent a message. An `error` event with no listener throws — in the
 * engine, which would then die and leave the other child running unsupervised.
 * So every handle listens:
 *
 *  - A failure **before** the child started (`spawn` never fired) is reported to
 *    the supervisor as an exit, so the ordinary bounded restart policy applies;
 *    Node may or may not follow it with an `exit` event, and only one exit is
 *    ever reported.
 *  - A failure **after** it started is logged and nothing more: the process is
 *    still there, and its real `exit` will come.
 *  - `send` passes a callback, so a message to a child whose channel just closed
 *    becomes a logged error instead of an emitted one.
 */

/** The parts of `ChildProcess` the adapter uses — a fake can provide them in tests. */
export interface ChildProcessLike {
  readonly pid?: number;
  readonly connected: boolean;
  readonly stdout?: StreamLike | null;
  readonly stderr?: StreamLike | null;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  send(message: unknown, callback: (err: Error | null) => void): boolean;
  kill(signal: NodeJS.Signals): boolean;
}

export interface StreamLike {
  setEncoding(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
}

/** Reported as the exit "signal" when a child never started. */
export const SPAWN_FAILED = "SPAWN_FAILED";

export function adaptChildProcess(
  child: ChildProcessLike,
  onError: (message: string) => void,
): ChildHandle {
  let spawned = false;
  let exitReported = false;
  const exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  const lineListeners: ((line: string, stream: "stdout" | "stderr") => void)[] = [];

  const out = createLineSplitter((line) => lineListeners.forEach((l) => l(line, "stdout")));
  const err = createLineSplitter((line) => lineListeners.forEach((l) => l(line, "stderr")));
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => out.push(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => err.push(chunk));

  function reportExit(code: number | null, signal: string | null) {
    if (exitReported) return;
    exitReported = true;
    out.flush();
    err.flush();
    for (const listener of exitListeners) listener(code, signal);
  }

  child.on("spawn", () => {
    spawned = true;
  });

  child.on("error", (error) => {
    onError(`child process error${child.pid ? ` (pid ${child.pid})` : ""}: ${error.message}`);
    if (!spawned) reportExit(null, SPAWN_FAILED);
  });

  child.on("exit", (code, signal) => reportExit(code, signal));

  return {
    get pid() {
      return child.pid;
    },
    onLine: (listener) => {
      lineListeners.push(listener);
    },
    onMessage: (listener) => {
      child.on("message", listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    send: (message) => {
      if (!child.connected) return false;
      try {
        return child.send(message, (error) => {
          if (error) onError(`could not relay a message to the child: ${error.message}`);
        });
      } catch (error) {
        onError(
          `could not relay a message to the child: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        return false;
      }
    },
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    },
  };
}
