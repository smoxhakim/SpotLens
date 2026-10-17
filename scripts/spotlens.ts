/**
 * The SpotLens engine: `npm run spotlens`.
 *
 * Runs the scanner and the entry-zone monitor together, as two supervised
 * processes, so nothing has to be started by hand:
 *
 *   scanner     — catches up once if a scan window was missed, then scans H1/H4
 *                 after every candle close, exactly as `npm run scanner` does
 *   entry-zone  — watches open setups' entry zones against live public prices
 *
 * When a scan completes the scanner says so, and the engine passes that to the
 * monitor, which reloads open setups at once — a setup created by this pass is
 * watched within seconds, not at the next periodic reload.
 *
 * The engine itself analyses nothing, reads no price and writes nothing. It
 * starts the two scripts, labels their output, relays that one message,
 * restarts a crashed child a bounded number of times (never endlessly), and on
 * Ctrl-C asks both to finish what they are doing and stop. One engine per
 * machine; each child also refuses to run twice.
 *
 * Public market data only. Nothing in SpotLens holds exchange credentials or
 * can place an order — the user reviews, decides, and trades by hand.
 */
import { spawn } from "node:child_process";

import {
  createLineSplitter,
  createSupervisor,
  holdLockOrExit,
  isForceInterrupt,
  type ChildHandle,
  type ChildSpec,
} from "@/lib/engine";

const CHILDREN: ChildSpec[] = [
  { name: "scanner", script: "scripts/scanner.ts", args: ["--catch-up"] },
  { name: "entry-zone", script: "scripts/entry-zone-monitor.ts", args: [] },
];

function log(message: string) {
  // Child lines arrive already labelled; only the engine's own get a timestamp.
  console.log(
    message.startsWith("[") ? message : `[engine ${new Date().toISOString()}] ${message}`,
  );
}

/**
 * One child, as a plain Node process running the script through tsx's loader.
 *
 * Not `npx tsx …`: that is a wrapper process around the real one, and a signal
 * sent to the wrapper is not reliably the signal the script receives. Detached
 * into its own process group so the terminal's Ctrl-C reaches the engine only,
 * and the engine sends each child exactly one SIGINT — a second one is the
 * child's "force quit". The environment, `.env` included, is inherited.
 */
function spawnChild(spec: ChildSpec): ChildHandle {
  const child = spawn(process.execPath, ["--import", "tsx", spec.script, ...spec.args], {
    cwd: process.cwd(),
    env: { ...process.env, SPOTLENS_ENGINE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  });

  const lineListeners: ((line: string, stream: "stdout" | "stderr") => void)[] = [];
  const out = createLineSplitter((line) => lineListeners.forEach((l) => l(line, "stdout")));
  const err = createLineSplitter((line) => lineListeners.forEach((l) => l(line, "stderr")));
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => out.push(chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => err.push(chunk));

  return {
    pid: child.pid,
    onLine: (listener) => lineListeners.push(listener),
    onMessage: (listener) => child.on("message", listener),
    onExit: (listener) =>
      child.on("exit", (code, signal) => {
        out.flush();
        err.flush();
        listener(code, signal);
      }),
    send: (message) => (child.connected ? child.send(message as object) : false),
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    },
  };
}

async function main() {
  holdLockOrExit("engine", log);

  const supervisor = createSupervisor(CHILDREN, {
    spawn: spawnChild,
    log,
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  });

  let firstInterruptAt: number | null = null;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      const now = Date.now();
      if (firstInterruptAt === null) {
        firstInterruptAt = now;
        void supervisor.stop(signal === "SIGINT" ? "Ctrl-C" : "SIGTERM");
        return;
      }
      // The same keypress relayed a second time by a wrapper is not a request
      // to force anything; see FORCE_INTERRUPT_AFTER_MS.
      if (!isForceInterrupt(firstInterruptAt, now)) return;
      log("Second interrupt: killing both children now.");
      supervisor.forceStop();
    });
  }

  log(
    "SpotLens engine — scanner + entry-zone monitor. Analysis and alerts only: " +
      "SpotLens never places a trade. Ctrl-C to stop.",
  );
  supervisor.start();

  const code = await supervisor.done;
  log(code === 0 ? "Stopped." : "Stopped with a child that could not be kept running.");
  process.exitCode = code;
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exitCode = 1;
});
