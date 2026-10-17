// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { processIsAlive } from "@/lib/engine";

/**
 * M1, end to end: the engine leaves no scanner or monitor behind.
 *
 * Real processes and real signals. The engine fixture runs the production
 * supervisor, child adapter, shutdown hooks and lock reader; its children are
 * fixtures wired exactly like the real scripts (lock, signals, stop on engine
 * gone) but touching no database, network or market data. Each test gets its
 * own lock and pid directories, so nothing outside the temp dir is involved.
 *
 * Slower than the unit tests — every process starts through tsx — and so
 * generous timeouts, but deterministic in outcome: each assertion waits for a
 * condition rather than a fixed sleep.
 */

const ENGINE = "lib/engine/__fixtures__/engine-fixture.ts";
const CHILD = "lib/engine/__fixtures__/child-fixture.ts";

interface Run {
  dir: string;
  lockDir: string;
  pidDir: string;
  output: string[];
  proc: ChildProcess;
}

const started: Run[] = [];
const extraPids: number[] = [];

function startProcess(
  script: string,
  args: string[],
  env: Record<string, string>,
  dir?: string,
): Run {
  const base = dir ?? mkdtempSync(join(tmpdir(), "spotlens-orphans-"));
  const lockDir = join(base, "locks");
  const pidDir = base;
  const proc = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SPOTLENS_LOCK_DIR: lockDir,
      FIXTURE_PID_DIR: pidDir,
      // Nothing in the fixtures touches a database; make sure nothing could.
      DATABASE_URL: "postgresql://guard:guard@127.0.0.1:9/none",
      DIRECT_URL: "postgresql://guard:guard@127.0.0.1:9/none",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // its own group, so a signal reaches only it — like a terminal's
  });
  const output: string[] = [];
  proc.stdout?.on("data", (c) => output.push(String(c)));
  proc.stderr?.on("data", (c) => output.push(String(c)));
  const run = { dir: base, lockDir, pidDir, output, proc };
  started.push(run);
  return run;
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function childPid(run: Run, role: "scanner" | "entry-zone"): number | null {
  const file = join(run.pidDir, `${role}.pid`);
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
}

function stoppedBecause(run: Run, role: "scanner" | "entry-zone"): string | null {
  const file = join(run.pidDir, `${role}.stopped`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function exited(proc: ChildProcess): Promise<number | null> {
  return proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve(proc.exitCode)
    : new Promise((r) => proc.once("exit", (code) => r(code)));
}

async function startEngine(env: Record<string, string> = {}) {
  const run = startProcess(ENGINE, [], env);
  await waitFor(
    () => childPid(run, "scanner") !== null && childPid(run, "entry-zone") !== null,
    30_000,
    "both fixture children to start",
  );
  return { run, scanner: childPid(run, "scanner")!, monitor: childPid(run, "entry-zone")! };
}

afterEach(() => {
  for (const run of started.splice(0)) {
    for (const role of ["scanner", "entry-zone"] as const) {
      const pid = childPid(run, role);
      if (pid && processIsAlive(pid)) process.kill(pid, "SIGKILL");
    }
    if (run.proc.pid && processIsAlive(run.proc.pid)) process.kill(run.proc.pid, "SIGKILL");
    rmSync(run.dir, { recursive: true, force: true });
  }
  for (const pid of extraPids.splice(0)) if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
});

describe("the engine leaves no child behind (M1)", () => {
  it("SIGHUP — the terminal closing — stops both children and the engine cleanly", async () => {
    const { run, scanner, monitor } = await startEngine();

    process.kill(run.proc.pid!, "SIGHUP");
    const code = await exited(run.proc);

    await waitFor(
      () => !processIsAlive(scanner) && !processIsAlive(monitor),
      10_000,
      "children gone",
    );
    expect(code).toBe(0);
    expect(run.output.join("")).toMatch(/stopping \(terminal closed \(SIGHUP\)\)/);
    // Stopped by the engine's own graceful SIGINT, not by anything cruder.
    expect(stoppedBecause(run, "scanner")).toBe("SIGINT");
    expect(stoppedBecause(run, "entry-zone")).toBe("SIGINT");
    // A graceful stop: both children released their locks on the way out.
    expect(readdirSync(run.lockDir)).toEqual([]);
  }, 60_000);

  it("kill -9 of the engine — which no handler can see — still stops both children", async () => {
    const { run, scanner, monitor } = await startEngine();

    process.kill(run.proc.pid!, "SIGKILL");
    await exited(run.proc);

    // The children notice the IPC channel closing and stop themselves —
    // including the monitor fixture, whose channel is un-ref'd like the real one.
    await waitFor(
      () => !processIsAlive(scanner) && !processIsAlive(monitor),
      15_000,
      "children gone",
    );
    // …because they saw the engine go — not because a write to a dead pipe
    // happened to crash them. The "stopping" line each wrote afterwards went to a
    // pipe with no reader, and did not crash it either.
    expect(stoppedBecause(run, "scanner")).toBe("engine gone");
    expect(stoppedBecause(run, "entry-zone")).toBe("engine gone");
    // They stopped gracefully, so each released its own lock on the way out.
    expect(readdirSync(run.lockDir)).toEqual([]);
  }, 60_000);

  it("an uncaught error in the engine still takes both children with it", async () => {
    const { run, scanner, monitor } = await startEngine({ FIXTURE_THROW_AFTER_MS: "2500" });

    const code = await exited(run.proc);
    expect(code).not.toBe(0);
    await waitFor(
      () => !processIsAlive(scanner) && !processIsAlive(monitor),
      10_000,
      "children gone",
    );
  }, 60_000);

  it("a role held by an orphan is waited for, and taken back as soon as the orphan is gone", async () => {
    // An orphaned monitor from a previous engine: holds the entry-zone lock.
    const dir = mkdtempSync(join(tmpdir(), "spotlens-orphans-"));
    const orphan = startProcess(CHILD, ["entry-zone"], {}, dir);
    await waitFor(() => childPid(orphan, "entry-zone") !== null, 30_000, "orphan to start");
    const orphanPid = childPid(orphan, "entry-zone")!;
    extraPids.push(orphanPid);

    // A new engine in the same lock directory.
    const engine = startProcess(ENGINE, [], { FIXTURE_RECHECK_MS: "300" }, dir);
    await waitFor(
      () => /entry-zone is already running elsewhere \(pid \d+\)/.test(engine.output.join("")),
      30_000,
      "the engine to notice the held role",
    );
    expect(engine.proc.exitCode).toBeNull(); // still running, not given up

    process.kill(orphanPid, "SIGTERM");
    await waitFor(
      () => /entry-zone's role is free again; starting it/.test(engine.output.join("")),
      20_000,
      "the engine to take the role back",
    );
    await waitFor(
      () =>
        childPid(engine, "entry-zone") !== orphanPid &&
        processIsAlive(childPid(engine, "entry-zone")!),
      30_000,
      "the engine's own monitor to be running",
    );

    process.kill(engine.proc.pid!, "SIGTERM");
    expect(await exited(engine.proc)).toBe(0);
  }, 90_000);
});
