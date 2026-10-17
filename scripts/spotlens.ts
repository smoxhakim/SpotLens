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
 * Ctrl-C, SIGTERM or a closed terminal (SIGHUP) asks both to finish what they
 * are doing and stop. However the engine ends, it leaves no child behind: its
 * own exit kills any survivor, and each child stops by itself when the engine's
 * IPC channel closes. One engine per machine; each child also refuses to run
 * twice, and a role held by another process is waited for, not abandoned.
 *
 * Public market data only. Nothing in SpotLens holds exchange credentials or
 * can place an order — the user reviews, decides, and trades by hand.
 */
import { spawn } from "node:child_process";

import {
  adaptChildProcess,
  createSupervisor,
  holdLockOrExit,
  installEngineShutdown,
  liveLockHolder,
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
 *
 * Errors from the process — failing to spawn, to be signalled, to receive a
 * message — are handled in `adaptChildProcess`, never left to crash the engine.
 */
function spawnChild(spec: ChildSpec): ChildHandle {
  const child = spawn(process.execPath, ["--import", "tsx", spec.script, ...spec.args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  });
  return adaptChildProcess(child, (message) => log(`${spec.name}: ${message}`));
}

async function main() {
  holdLockOrExit("engine", log);

  const supervisor = createSupervisor(CHILDREN, {
    spawn: spawnChild,
    log,
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    lockHolder: (name) => liveLockHolder(name),
  });

  installEngineShutdown({ proc: process, supervisor, log, now: Date.now });

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
