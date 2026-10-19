/**
 * A stand-in for the scanner or the monitor, for the real-process engine tests.
 *
 * It holds its role's lock, stops on SIGINT/SIGTERM and when the engine's IPC
 * channel closes — exactly the wiring the real scripts use — and is otherwise
 * silent, like the real scanner and monitor between events. That matters: a
 * child that wrote constantly would crash on the broken pipe the moment the
 * engine died and look as if it had stopped. On stopping it records *why* in
 * `<role>.stopped`, then writes a line, so a test can tell the mechanism that
 * stopped it and see that writing to a pipe with no reader does not crash it.
 * No database, no network, no market data.
 *
 *   node --import tsx lib/engine/__fixtures__/child-fixture.ts <role>
 *   env: SPOTLENS_LOCK_DIR, FIXTURE_PID_DIR
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { holdLockOrExit, stopWhenEngineGone, type LockRole } from "@/lib/engine";

const role = (process.argv[2] ?? "entry-zone") as LockRole;
const log = (m: string) => console.log(`[${role} fixture] ${m}`);

holdLockOrExit(role, log);
writeFileSync(join(process.env.FIXTURE_PID_DIR ?? ".", `${role}.pid`), String(process.pid));

// Like the real monitor: an un-ref'd channel must still report a disconnect.
if (role === "entry-zone") process.channel?.unref();

const pidDir = process.env.FIXTURE_PID_DIR ?? ".";
const idle = setInterval(() => undefined, 1_000); // alive, and quiet
let stopping = false;
const stop = (why: string) => {
  if (stopping) return;
  stopping = true;
  appendFileSync(join(pidDir, `${role}.stopped`), why);
  log(`stopping: ${why}`); // after the engine is gone: a write to a pipe with no reader
  clearInterval(idle);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(signal));
stopWhenEngineGone(process, () => stop("engine gone"));
