/**
 * One contender in the real multi-process lock race (`lock.process.test.ts`).
 *
 * Says it is ready, waits at a barrier until the test opens it — so every
 * contender reads the stale lock at the same moment — tries to take the
 * scanner lock with the real liveness checks, reports the result, and holds a
 * won lock for a moment before releasing it. No database, no network.
 *
 *   node --import tsx lib/engine/__fixtures__/lock-fixture.ts <work-dir> <id>
 *   env: SPOTLENS_LOCK_DIR
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireLock } from "@/lib/engine/lock";

const [work, id] = process.argv.slice(2);
writeFileSync(join(work, `ready-${id}`), "");

const pause = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(join(work, "go"))) Atomics.wait(pause, 0, 0, 1);

const lock = acquireLock("scanner");
writeFileSync(join(work, `result-${id}`), JSON.stringify({ pid: process.pid, ok: lock.ok }));
setTimeout(() => {
  if (lock.ok) lock.release();
}, 1_500);
