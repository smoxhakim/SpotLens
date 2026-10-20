// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The stale-lock race with real processes: several contenders, released from a
 * barrier at once, all find the same lock left by a dead process. Exactly one
 * may take it over. The interleaving is up to the OS; the outcome must not be.
 *
 * What this proves is that the real file operations — exclusive link, atomic
 * rename, claim files — hold up under real concurrency and leave nothing
 * behind. It is not the regression test for the old race: that window is
 * microseconds wide and real processes rarely land in it (run against the old
 * delete-and-recreate takeover, this passed). `lock.test.ts` forces the worst
 * interleaving deterministically, and fails against the old code.
 */

const FIXTURE = "lib/engine/__fixtures__/lock-fixture.ts";
const CONTENDERS = 6;
const procs: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const p of procs.splice(0)) if (p.exitCode === null) p.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean, what: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function race() {
  const work = mkdtempSync(join(tmpdir(), "spotlens-lock-race-"));
  dirs.push(work);
  const locks = join(work, "locks");
  mkdirSync(locks);
  writeFileSync(
    join(locks, "scanner.lock"),
    JSON.stringify({
      pid: 999_991,
      startedAt: "x",
      processStartedAt: 0,
      nonce: crypto.randomUUID(),
    }),
  );

  const exited: Promise<void>[] = [];
  for (let i = 0; i < CONTENDERS; i += 1) {
    const p = spawn(process.execPath, ["--import", "tsx", FIXTURE, work, String(i)], {
      env: { ...process.env, SPOTLENS_LOCK_DIR: locks },
      stdio: "ignore",
    });
    procs.push(p);
    exited.push(new Promise((r) => p.once("exit", () => r())));
  }

  const ready = () => readdirSync(work).filter((f) => f.startsWith("ready-")).length;
  await waitFor(() => ready() === CONTENDERS, "every contender to reach the barrier");
  writeFileSync(join(work, "go"), "");

  const result = (i: number) => join(work, `result-${i}`);
  await waitFor(
    () => Array.from({ length: CONTENDERS }, (_, i) => existsSync(result(i))).every(Boolean),
    "every contender to report",
  );
  const results = Array.from(
    { length: CONTENDERS },
    (_, i) => JSON.parse(readFileSync(result(i), "utf8")) as { pid: number; ok: boolean },
  );
  const holder = JSON.parse(readFileSync(join(locks, "scanner.lock"), "utf8")) as { pid: number };

  await Promise.all(exited);
  return { results, holder, leftover: readdirSync(locks) };
}

describe("a stale scanner lock, contended by real processes", () => {
  it("three rounds of six contenders: exactly one takes it over each time", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { results, holder, leftover } = await race();
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      expect(holder.pid).toBe(winners[0].pid);
      // The winner released on exit; no temp or claim file was left behind.
      expect(leftover).toEqual([]);
    }
  }, 120_000);
});
