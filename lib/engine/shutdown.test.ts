// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FORCE_INTERRUPT_AFTER_MS,
  SPAWN_FAILED,
  adaptChildProcess,
  installEngineShutdown,
  liveLockHolder,
  stopWhenEngineGone,
  type ChildProcessLike,
} from "@/lib/engine";

/**
 * The engine's shutdown wiring and the child adapter, against fakes.
 *
 * These are the pieces the M1 review found missing: SIGHUP, an exit hook that
 * leaves no child behind, child-process errors that must not crash the engine,
 * and children that stop when the engine is gone. Real processes are exercised
 * in `orphans.process.test.ts`; this file pins the rules deterministically.
 */

// --- fakes -------------------------------------------------------------------

class FakeStream extends EventEmitter {
  setEncoding() {
    return this;
  }
}

class FakeChildProcess extends EventEmitter implements ChildProcessLike {
  pid: number | undefined = 123;
  connected = true;
  stdout = new FakeStream();
  stderr = new FakeStream();
  sent: unknown[] = [];
  killed: string[] = [];
  sendBehaviour: "ok" | "callback-error" | "throw" = "ok";
  killThrows = false;

  send(message: unknown, callback: (err: Error | null) => void) {
    if (this.sendBehaviour === "throw") throw new Error("channel closed");
    this.sent.push(message);
    callback(this.sendBehaviour === "callback-error" ? new Error("EPIPE") : null);
    return true;
  }
  kill(signal: NodeJS.Signals) {
    if (this.killThrows) throw new Error("ESRCH");
    this.killed.push(signal);
    return true;
  }
}

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  channel: unknown = undefined;
}

function fakeSupervisor() {
  return {
    stop: vi.fn(async () => undefined),
    forceStop: vi.fn(),
    killSurvivors: vi.fn(() => 0),
  };
}

// --- child adapter ------------------------------------------------------------

describe("adaptChildProcess", () => {
  it("a spawn failure is reported once as an exit, so the restart policy applies", () => {
    const child = new FakeChildProcess();
    child.pid = undefined;
    const errors: string[] = [];
    const handle = adaptChildProcess(child, (m) => errors.push(m));
    const exits: [number | null, string | null][] = [];
    handle.onExit((code, signal) => exits.push([code, signal]));

    child.emit("error", new Error("spawn node ENOENT"));
    child.emit("exit", null, null); // Node may or may not follow with an exit

    expect(exits).toEqual([[null, SPAWN_FAILED]]);
    expect(errors).toEqual(["child process error: spawn node ENOENT"]);
  });

  it("an error after the child started is logged, not turned into an exit", () => {
    const child = new FakeChildProcess();
    const errors: string[] = [];
    const handle = adaptChildProcess(child, (m) => errors.push(m));
    const exits: unknown[] = [];
    handle.onExit((...a) => exits.push(a));

    child.emit("spawn");
    child.emit("error", new Error("kill ESRCH"));
    expect(exits).toEqual([]);
    expect(errors[0]).toMatch(/pid 123.*kill ESRCH/);

    child.emit("exit", 0, null);
    expect(exits).toEqual([[0, null]]);
  });

  it("an `error` with no other listener does not throw (it used to crash the engine)", () => {
    const child = new FakeChildProcess();
    adaptChildProcess(child, () => undefined);
    expect(() => child.emit("error", new Error("boom"))).not.toThrow();
  });

  it("only one exit is ever reported", () => {
    const child = new FakeChildProcess();
    const handle = adaptChildProcess(child, () => undefined);
    const exits: unknown[] = [];
    handle.onExit((...a) => exits.push(a));
    child.emit("spawn");
    child.emit("exit", 1, null);
    child.emit("exit", 1, null);
    expect(exits).toHaveLength(1);
  });

  it("sending to a closed channel neither throws nor emits", () => {
    const child = new FakeChildProcess();
    const errors: string[] = [];
    const handle = adaptChildProcess(child, (m) => errors.push(m));

    child.connected = false;
    expect(handle.send({ type: "x" })).toBe(false);

    child.connected = true;
    child.sendBehaviour = "callback-error";
    expect(() => handle.send({ type: "x" })).not.toThrow();
    child.sendBehaviour = "throw";
    expect(handle.send({ type: "x" })).toBe(false);
    expect(errors).toHaveLength(2);
  });

  it("kill on a process that is already gone is swallowed", () => {
    const child = new FakeChildProcess();
    child.killThrows = true;
    const handle = adaptChildProcess(child, () => undefined);
    expect(() => handle.kill("SIGKILL")).not.toThrow();
  });

  it("splits output into lines and flushes a partial line on exit", () => {
    const child = new FakeChildProcess();
    const handle = adaptChildProcess(child, () => undefined);
    const lines: string[] = [];
    handle.onLine((line, stream) => lines.push(`${stream}:${line}`));
    child.stdout.emit("data", "one\ntw");
    child.stderr.emit("data", "err-line\n");
    child.stdout.emit("data", "o");
    child.emit("spawn");
    child.emit("exit", 0, null);
    expect(lines).toEqual(["stdout:one", "stderr:err-line", "stdout:two"]);
  });
});

// --- engine shutdown ------------------------------------------------------------

describe("installEngineShutdown", () => {
  function install() {
    const proc = new FakeProcess();
    const supervisor = fakeSupervisor();
    let t = 1_000;
    const logs: string[] = [];
    installEngineShutdown({ proc, supervisor, log: (m) => logs.push(m), now: () => t });
    return { proc, supervisor, logs, advance: (ms: number) => (t += ms) };
  }

  it("SIGHUP — a closed terminal — takes the same graceful path as SIGTERM", () => {
    const { proc, supervisor } = install();
    proc.emit("SIGHUP");
    expect(supervisor.stop).toHaveBeenCalledWith("terminal closed (SIGHUP)");
    expect(supervisor.forceStop).not.toHaveBeenCalled();
  });

  it.each([
    ["SIGINT", "Ctrl-C"],
    ["SIGTERM", "SIGTERM"],
  ])("%s starts a graceful stop", (signal, reason) => {
    const { proc, supervisor } = install();
    proc.emit(signal);
    expect(supervisor.stop).toHaveBeenCalledWith(reason);
  });

  it("a duplicate delivery of the same interrupt is ignored; a deliberate second one forces", () => {
    const { proc, supervisor, advance } = install();
    proc.emit("SIGHUP");
    advance(30);
    proc.emit("SIGINT"); // relayed by a wrapper
    expect(supervisor.forceStop).not.toHaveBeenCalled();
    advance(FORCE_INTERRUPT_AFTER_MS);
    proc.emit("SIGINT");
    expect(supervisor.forceStop).toHaveBeenCalledTimes(1);
    expect(supervisor.stop).toHaveBeenCalledTimes(1);
  });

  it("the engine's exit kills surviving children — and does nothing else", () => {
    const { proc, supervisor } = install();
    proc.emit("exit", 1);
    expect(supervisor.killSurvivors).toHaveBeenCalledTimes(1);
    expect(supervisor.stop).not.toHaveBeenCalled();
  });

  it("output errors after the terminal hung up do not crash the engine mid-shutdown", () => {
    const { proc } = install();
    expect(() =>
      proc.stdout.emit("error", Object.assign(new Error("EIO"), { code: "EIO" })),
    ).not.toThrow();
    expect(() => proc.stderr.emit("error", new Error("EPIPE"))).not.toThrow();
  });
});

// --- children ----------------------------------------------------------------------

describe("stopWhenEngineGone", () => {
  it("under the engine, the channel closing stops the child, once", () => {
    const proc = new FakeProcess();
    proc.channel = {};
    const onGone = vi.fn();
    expect(stopWhenEngineGone(proc, onGone)).toBe(true);
    proc.emit("disconnect");
    proc.emit("disconnect");
    expect(onGone).toHaveBeenCalledTimes(1);
    // The engine's end of the pipes is gone too: writing must not crash the stop.
    expect(() => proc.stdout.emit("error", new Error("EPIPE"))).not.toThrow();
  });

  it("run standalone (no channel), it does nothing", () => {
    const proc = new FakeProcess();
    const onGone = vi.fn();
    expect(stopWhenEngineGone(proc, onGone)).toBe(false);
    proc.emit("disconnect");
    expect(onGone).not.toHaveBeenCalled();
  });
});

// --- lock reader ---------------------------------------------------------------------

describe("liveLockHolder", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("names a live holder, and reads a free or stale lock as free — without touching it", () => {
    dir = mkdtempSync(join(tmpdir(), "spotlens-holder-"));
    expect(liveLockHolder("entry-zone", { dir })).toBeNull();

    writeFileSync(join(dir, "entry-zone.lock"), JSON.stringify({ pid: 77, startedAt: "x" }));
    expect(liveLockHolder("entry-zone", { dir, isAlive: () => true })).toBe(77);
    expect(liveLockHolder("entry-zone", { dir, isAlive: () => false })).toBeNull();

    writeFileSync(join(dir, "entry-zone.lock"), "garbage");
    expect(liveLockHolder("entry-zone", { dir, isAlive: () => true })).toBeNull();
  });
});
