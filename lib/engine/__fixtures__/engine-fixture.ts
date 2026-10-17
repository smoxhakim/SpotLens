/**
 * The engine's real wiring — supervisor, child adapter, shutdown hooks, lock
 * reader — driving fixture children instead of the scanner and monitor. Used
 * by `orphans.process.test.ts` to prove, with real processes and real signals,
 * that the engine leaves nothing behind.
 *
 *   node --import tsx lib/engine/__fixtures__/engine-fixture.ts
 *   env: SPOTLENS_LOCK_DIR, FIXTURE_PID_DIR, FIXTURE_RECHECK_MS,
 *        FIXTURE_THROW_AFTER_MS (crash the engine with an uncaught error)
 */
import { spawn } from "node:child_process";

import {
  DEFAULT_RESTART_POLICY,
  adaptChildProcess,
  createSupervisor,
  installEngineShutdown,
  liveLockHolder,
  type ChildSpec,
} from "@/lib/engine";

const CHILD = "lib/engine/__fixtures__/child-fixture.ts";
const specs: ChildSpec[] = [
  { name: "scanner", script: CHILD, args: ["scanner"] },
  { name: "entry-zone", script: CHILD, args: ["entry-zone"] },
];
const log = (m: string) => console.log(`[engine fixture] ${m}`);

const supervisor = createSupervisor(specs, {
  spawn: (spec) =>
    adaptChildProcess(
      spawn(process.execPath, ["--import", "tsx", spec.script, ...spec.args], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
      }),
      (m) => log(`${spec.name}: ${m}`),
    ),
  log,
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  lockHolder: (name) => liveLockHolder(name),
  policy: {
    ...DEFAULT_RESTART_POLICY,
    lockRecheckMs: Number(process.env.FIXTURE_RECHECK_MS ?? 300),
    stopTimeoutMs: 10_000,
  },
});

installEngineShutdown({ proc: process, supervisor, log, now: Date.now });
supervisor.start();

const throwAfter = Number(process.env.FIXTURE_THROW_AFTER_MS ?? 0);
if (throwAfter > 0) {
  setTimeout(() => {
    throw new Error("fixture: an unexpected engine failure");
  }, throwAfter);
}

void supervisor.done.then((code) => {
  log(`done ${code}`);
  process.exitCode = code;
});
