// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RESTART_POLICY,
  EXIT_ALREADY_RUNNING,
  acquireLock,
  createLineSplitter,
  createSupervisor,
  FORCE_INTERRUPT_AFTER_MS,
  isCatchUpDue,
  isForceInterrupt,
  isScannerRunCompleted,
  latestDueScanWindow,
  prefixLine,
  restartDecision,
  scannerRunCompleted,
  type ChildHandle,
  type ChildName,
  type ChildSpec,
  type RestartPolicy,
} from "@/lib/engine";

/**
 * The engine's rules, without a process in sight.
 *
 * Children are fakes that record what the engine did to them and exit when a
 * test says so; time is a manual clock. So "the monitor keeps running when the
 * scanner crashes" is asserted against the supervisor's actual decisions, not
 * against how quickly a real process happened to die.
 */

// --- fakes -------------------------------------------------------------------

class FakeClock {
  t = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private next = 1;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimer = (id: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };
  advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }
  pending() {
    return this.timers.length;
  }
}

class FakeChild implements ChildHandle {
  static nextPid = 1000;
  readonly pid = FakeChild.nextPid++;
  signals: string[] = [];
  sent: unknown[] = [];
  private lineL: ((line: string, stream: "stdout" | "stderr") => void)[] = [];
  private msgL: ((m: unknown) => void)[] = [];
  private exitL: ((code: number | null, signal: string | null) => void)[] = [];
  exited = false;

  constructor(readonly name: ChildName) {}

  onLine(l: (line: string, stream: "stdout" | "stderr") => void) {
    this.lineL.push(l);
  }
  onMessage(l: (m: unknown) => void) {
    this.msgL.push(l);
  }
  onExit(l: (code: number | null, signal: string | null) => void) {
    this.exitL.push(l);
  }
  send(m: unknown) {
    this.sent.push(m);
    return true;
  }
  kill(signal: "SIGINT" | "SIGTERM" | "SIGKILL") {
    this.signals.push(signal);
  }

  // test controls
  print(line: string, stream: "stdout" | "stderr" = "stdout") {
    this.lineL.forEach((l) => l(line, stream));
  }
  message(m: unknown) {
    this.msgL.forEach((l) => l(m));
  }
  exit(code: number | null, signal: string | null = null) {
    this.exited = true;
    this.exitL.forEach((l) => l(code, signal));
  }
}

const SPECS: ChildSpec[] = [
  { name: "scanner", script: "scripts/scanner.ts", args: ["--catch-up"] },
  { name: "entry-zone", script: "scripts/entry-zone-monitor.ts", args: [] },
];

const POLICY: RestartPolicy = {
  maxRestarts: 3,
  windowMs: 15 * 60_000,
  backoffMs: [5_000, 30_000, 120_000],
  stopTimeoutMs: 60_000,
  lockRecheckMs: 30_000,
};

function harness(
  policy: RestartPolicy = POLICY,
  options: { withLockHolder?: boolean } = { withLockHolder: true },
) {
  const clock = new FakeClock();
  const spawned: FakeChild[] = [];
  const logs: string[] = [];
  /** Who holds each role's lock outside this engine; null = free. */
  const held = new Map<ChildName, number | null>();
  const supervisor = createSupervisor(SPECS, {
    ...(options.withLockHolder ? { lockHolder: (name: ChildName) => held.get(name) ?? null } : {}),
    spawn: (spec) => {
      const child = new FakeChild(spec.name);
      spawned.push(child);
      return child;
    },
    log: (line) => logs.push(line),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    policy,
  });
  let exitCode: number | null = null;
  void supervisor.done.then((code) => (exitCode = code));

  const latest = (name: ChildName) => [...spawned].reverse().find((c) => c.name === name)!;
  const all = (name: ChildName) => spawned.filter((c) => c.name === name);
  const settled = async () => {
    await Promise.resolve();
    await Promise.resolve();
    return exitCode;
  };

  return { clock, spawned, logs, supervisor, latest, all, settled, held };
}

// --- supervisor --------------------------------------------------------------

describe("engine start", () => {
  it("starts both children, each once", () => {
    const h = harness();
    h.supervisor.start();

    expect(h.spawned.map((c) => c.name)).toEqual(["scanner", "entry-zone"]);
    expect(h.supervisor.state()).toEqual({ scanner: "running", "entry-zone": "running" });
  });

  it("labels child output that is not already labelled", () => {
    const h = harness();
    h.supervisor.start();
    h.latest("scanner").print("[scanner 2026-10-04T10:00:00.000Z] Scanning 1h…");
    h.latest("entry-zone").print("prisma:warn something", "stderr");

    expect(h.logs).toContain("[scanner 2026-10-04T10:00:00.000Z] Scanning 1h…");
    expect(h.logs).toContain("[entry-zone] prisma:warn something");
  });
});

describe("scanner → monitor handoff", () => {
  it("relays a completed scan to the monitor, and nothing else", () => {
    const h = harness();
    h.supervisor.start();

    h.latest("scanner").message(scannerRunCompleted("run-1"));
    h.latest("scanner").message({ type: "something-else" });
    h.latest("entry-zone").message(scannerRunCompleted("run-x")); // wrong direction

    expect(h.latest("entry-zone").sent).toEqual([
      { type: "scanner-run-completed", runId: "run-1" },
    ]);
    expect(h.latest("scanner").sent).toEqual([]);
  });

  it("does not relay to a monitor that is down", () => {
    const h = harness();
    h.supervisor.start();
    const monitor = h.latest("entry-zone");
    monitor.exit(1);

    h.latest("scanner").message(scannerRunCompleted("run-1"));
    expect(monitor.sent).toEqual([]);
  });
});

describe("graceful shutdown", () => {
  it("asks each child to stop once, and finishes cleanly when both have", async () => {
    const h = harness();
    h.supervisor.start();

    const stopping = h.supervisor.stop("Ctrl-C");
    expect(h.latest("scanner").signals).toEqual(["SIGINT"]);
    expect(h.latest("entry-zone").signals).toEqual(["SIGINT"]);

    h.latest("entry-zone").exit(0);
    expect(await h.settled()).toBeNull(); // the scanner is still finishing its pass
    h.latest("scanner").exit(0);

    await stopping;
    expect(await h.settled()).toBe(0);
    expect(h.supervisor.state()).toEqual({ scanner: "stopped", "entry-zone": "stopped" });
    // A stop is not a crash: nothing is restarted.
    expect(h.spawned).toHaveLength(2);
    expect(h.clock.pending()).toBe(0);
  });

  it("kills a child that does not stop in time", async () => {
    const h = harness();
    h.supervisor.start();
    void h.supervisor.stop("Ctrl-C");
    h.latest("entry-zone").exit(0);

    h.clock.advance(POLICY.stopTimeoutMs);
    expect(h.latest("scanner").signals).toEqual(["SIGINT", "SIGKILL"]);
    h.latest("scanner").exit(null, "SIGKILL");
    expect(await h.settled()).toBe(0);
  });

  it("a stop during a restart wait cancels the restart", async () => {
    const h = harness();
    h.supervisor.start();
    h.latest("scanner").exit(1); // crash → restart scheduled
    expect(h.supervisor.state().scanner).toBe("restarting");

    void h.supervisor.stop("Ctrl-C");
    h.latest("entry-zone").exit(0);
    h.clock.advance(10 * 60_000);

    expect(h.all("scanner")).toHaveLength(1);
    expect(await h.settled()).toBe(0);
  });

  it("a second interrupt kills both at once", () => {
    const h = harness();
    h.supervisor.start();
    void h.supervisor.stop("Ctrl-C");
    h.supervisor.forceStop();
    expect(h.latest("scanner").signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(h.latest("entry-zone").signals).toEqual(["SIGINT", "SIGKILL"]);
  });
});

describe("one child failing", () => {
  it("a scanner crash leaves the monitor running, untouched, and restarts the scanner", () => {
    const h = harness();
    h.supervisor.start();
    const monitor = h.latest("entry-zone");

    h.latest("scanner").exit(1);

    expect(monitor.signals).toEqual([]);
    expect(h.supervisor.state()).toEqual({ scanner: "restarting", "entry-zone": "running" });
    expect(
      h.logs.some((l) =>
        /scanner EXITED UNEXPECTEDLY \(code 1\); still running: entry-zone/.test(l),
      ),
    ).toBe(true);

    h.clock.advance(5_000);
    expect(h.all("scanner")).toHaveLength(2);
    expect(h.supervisor.state().scanner).toBe("running");
    expect(h.all("entry-zone")).toEqual([monitor]);
  });

  it("a monitor crash is reported clearly and the scanner keeps running", () => {
    const h = harness();
    h.supervisor.start();
    const scanner = h.latest("scanner");

    h.latest("entry-zone").exit(null, "SIGSEGV");

    expect(
      h.logs.some((l) =>
        /entry-zone EXITED UNEXPECTEDLY \(signal SIGSEGV\); still running: scanner/.test(l),
      ),
    ).toBe(true);
    expect(scanner.signals).toEqual([]);
    expect(h.supervisor.state().scanner).toBe("running");
  });

  it("does not restart endlessly: gives up after the bound, and the other child carries on", async () => {
    const h = harness();
    h.supervisor.start();

    for (const wait of [5_000, 30_000, 120_000]) {
      h.latest("entry-zone").exit(1);
      h.clock.advance(wait);
    }
    h.latest("entry-zone").exit(1); // fourth failure inside the window

    expect(h.all("entry-zone")).toHaveLength(4); // the original + three restarts
    expect(h.supervisor.state()).toEqual({ scanner: "running", "entry-zone": "gave-up" });
    expect(
      h.logs.some((l) => /entry-zone failed 3 times in 15 minutes; giving up on it/.test(l)),
    ).toBe(true);
    h.clock.advance(60 * 60_000);
    expect(h.all("entry-zone")).toHaveLength(4);
    expect(await h.settled()).toBeNull(); // the scanner is still running, so the engine is too
  });

  it("restarts again once old failures have left the window", () => {
    const h = harness();
    h.supervisor.start();
    for (const wait of [5_000, 30_000, 120_000]) {
      h.latest("scanner").exit(1);
      h.clock.advance(wait);
    }
    h.clock.advance(POLICY.windowMs); // a quiet quarter-hour
    h.latest("scanner").exit(1);
    expect(h.supervisor.state().scanner).toBe("restarting");
  });

  it("exits non-zero when neither child is left", async () => {
    const h = harness();
    h.supervisor.start();
    for (const name of ["scanner", "entry-zone"] as const) {
      for (const wait of [5_000, 30_000, 120_000]) {
        h.latest(name).exit(1);
        h.clock.advance(wait);
      }
      h.latest(name).exit(1);
    }
    expect(h.supervisor.state()).toEqual({ scanner: "gave-up", "entry-zone": "gave-up" });
    expect(await h.settled()).toBe(1);
  });

  it("ignores a late exit from a child that has already been replaced", () => {
    const h = harness();
    h.supervisor.start();
    const first = h.latest("scanner");
    first.exit(1);
    h.clock.advance(5_000);
    const second = h.latest("scanner");

    first.exit(1); // stale event
    expect(h.supervisor.state().scanner).toBe("running");
    expect(h.latest("scanner")).toBe(second);
  });
});

describe("a role held by another process (M1 recovery)", () => {
  it("waits instead of giving up, and spawns nothing while the role is held", async () => {
    const h = harness();
    h.supervisor.start();
    h.held.set("entry-zone", 4242); // e.g. a monitor orphaned by an engine that died
    h.latest("entry-zone").exit(EXIT_ALREADY_RUNNING);

    expect(h.supervisor.state()["entry-zone"]).toBe("waiting");
    h.clock.advance(10 * 60_000); // twenty re-checks
    expect(h.all("entry-zone")).toHaveLength(1);
    expect(
      h.logs.filter((l) => /entry-zone is already running elsewhere \(pid 4242\)/.test(l)),
    ).toHaveLength(1);
    // Not a crash, and not reported as one.
    expect(h.logs.some((l) => /entry-zone EXITED UNEXPECTEDLY/.test(l))).toBe(false);
    // Waiting keeps the engine running.
    expect(await h.settled()).toBeNull();
  });

  it("starts its own child as soon as the role is free again", () => {
    const h = harness();
    h.supervisor.start();
    h.held.set("entry-zone", 4242);
    h.latest("entry-zone").exit(EXIT_ALREADY_RUNNING);
    h.clock.advance(60_000);
    expect(h.all("entry-zone")).toHaveLength(1);

    h.held.set("entry-zone", null); // the orphan finally died
    h.clock.advance(30_000);

    expect(h.all("entry-zone")).toHaveLength(2);
    expect(h.supervisor.state()["entry-zone"]).toBe("running");
    expect(h.logs.some((l) => /entry-zone's role is free again; starting it/.test(l))).toBe(true);
  });

  it("re-checks at a bounded rate: one look per lockRecheckMs", () => {
    const h = harness();
    h.supervisor.start();
    h.held.set("scanner", 7);
    h.latest("scanner").exit(EXIT_ALREADY_RUNNING);
    expect(h.clock.pending()).toBe(1); // exactly one timer for the wait
    h.clock.advance(29_999);
    h.held.set("scanner", null);
    expect(h.all("scanner")).toHaveLength(1); // not yet
    h.clock.advance(1);
    expect(h.all("scanner")).toHaveLength(2);
  });

  it("without a lock reader, retries by relaunching on the same schedule, announcing the wait once", () => {
    const h = harness(POLICY, { withLockHolder: false });
    h.supervisor.start();
    for (let i = 0; i < 4; i += 1) {
      h.latest("entry-zone").exit(EXIT_ALREADY_RUNNING);
      h.clock.advance(30_000);
    }
    expect(h.all("entry-zone")).toHaveLength(5);
    expect(h.logs.filter((l) => /entry-zone is already running elsewhere/.test(l))).toHaveLength(1);
  });

  it("a wait after the child really ran is announced again", () => {
    const h = harness();
    h.supervisor.start();
    h.held.set("scanner", 9);
    h.latest("scanner").exit(EXIT_ALREADY_RUNNING);
    h.held.set("scanner", null);
    h.clock.advance(30_000);
    h.latest("scanner").exit(1); // ran, then crashed
    h.clock.advance(5_000); // restarted
    h.held.set("scanner", 10);
    h.latest("scanner").exit(EXIT_ALREADY_RUNNING);
    expect(h.logs.filter((l) => /scanner is already running elsewhere/.test(l))).toHaveLength(2);
  });

  it("a stop during the wait cancels it and the engine finishes cleanly", async () => {
    const h = harness();
    h.supervisor.start();
    h.held.set("entry-zone", 4242);
    h.latest("entry-zone").exit(EXIT_ALREADY_RUNNING);

    void h.supervisor.stop("SIGHUP");
    h.latest("scanner").exit(0);
    h.held.set("entry-zone", null);
    h.clock.advance(10 * 60_000);

    expect(h.all("entry-zone")).toHaveLength(1);
    expect(await h.settled()).toBe(0);
  });
});

describe("killSurvivors (the engine's exit hook)", () => {
  it("SIGKILLs every child still alive, and only those", () => {
    const h = harness();
    h.supervisor.start();
    h.latest("scanner").exit(1); // down, waiting to restart

    expect(h.supervisor.killSurvivors()).toBe(1);
    expect(h.latest("entry-zone").signals).toEqual(["SIGKILL"]);
    expect(h.latest("scanner").signals).toEqual([]);
  });

  it("is synchronous and side-effect free beyond the signal: no log, no timer", () => {
    const h = harness();
    h.supervisor.start();
    const logsBefore = h.logs.length;
    const timersBefore = h.clock.pending();
    h.supervisor.killSurvivors();
    expect(h.logs.length).toBe(logsBefore);
    expect(h.clock.pending()).toBe(timersBefore);
  });

  it("after a clean stop there is nothing to kill", async () => {
    const h = harness();
    h.supervisor.start();
    void h.supervisor.stop("Ctrl-C");
    h.latest("scanner").exit(0);
    h.latest("entry-zone").exit(0);
    expect(await h.settled()).toBe(0);
    expect(h.supervisor.killSurvivors()).toBe(0);
  });
});

describe("interrupts", () => {
  it("the first interrupt is never a force quit", () => {
    expect(isForceInterrupt(null, 1_000)).toBe(false);
  });

  it("one keypress relayed twice by a wrapper is still one clean stop", () => {
    // Observed live: npm/tsx re-delivered the terminal's SIGINT 32 ms later.
    expect(isForceInterrupt(1_000, 1_032)).toBe(false);
  });

  it("pressing Ctrl-C again, deliberately, forces it", () => {
    expect(isForceInterrupt(1_000, 1_000 + FORCE_INTERRUPT_AFTER_MS)).toBe(true);
    expect(isForceInterrupt(1_000, 4_000)).toBe(true);
  });
});

describe("restartDecision", () => {
  it("backs off, then stops", () => {
    const at = (n: number) =>
      restartDecision({ exitCode: 1, recentRestarts: Array(n).fill(0), now: 1, policy: POLICY });
    expect(at(0)).toEqual({ restart: true, delayMs: 5_000 });
    expect(at(1)).toEqual({ restart: true, delayMs: 30_000 });
    expect(at(2)).toEqual({ restart: true, delayMs: 120_000 });
    expect(at(3)).toEqual({ restart: false, reason: "too-many-restarts" });
  });

  it("uses a sensible default policy", () => {
    expect(DEFAULT_RESTART_POLICY.maxRestarts).toBeGreaterThan(0);
    expect(DEFAULT_RESTART_POLICY.maxRestarts).toBeLessThan(10);
  });
});

describe("output", () => {
  it("prefixLine leaves an already-labelled line alone", () => {
    expect(prefixLine("scanner", "[scanner 2026-…] x")).toBe("[scanner 2026-…] x");
    expect(prefixLine("entry-zone", "Error: boom")).toBe("[entry-zone] Error: boom");
  });

  it("splits a stream into whole lines across chunk boundaries", () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.push("one\ntw");
    s.push("o\r\nthree");
    expect(lines).toEqual(["one", "two"]);
    s.flush();
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("recognises only the completion message", () => {
    expect(isScannerRunCompleted(scannerRunCompleted(null))).toBe(true);
    expect(isScannerRunCompleted({ type: "scanner-run-completed" })).toBe(true);
    expect(isScannerRunCompleted("scanner-run-completed")).toBe(false);
    expect(isScannerRunCompleted(null)).toBe(false);
  });
});

// --- locks -------------------------------------------------------------------

describe("run locks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spotlens-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("one holder per role; a second live process is refused", () => {
    // Made-up PIDs: never look a real process up by them (/proc on Linux, ps on
    // macOS). A real PID 111 on the machine would otherwise read as a different
    // process, and the lock would be taken over.
    const FAKE = { identity: null, startTimeOf: () => null } as const;

    const first = acquireLock("scanner", { dir, pid: 111, isAlive: () => true, ...FAKE });
    expect(first.ok).toBe(true);

    const second = acquireLock("scanner", { dir, pid: 222, isAlive: () => true, ...FAKE });
    expect(second).toMatchObject({ ok: false, holderPid: 111 });

    // A different role is a different lock.
    expect(acquireLock("entry-zone", { dir, pid: 222, isAlive: () => true, ...FAKE }).ok).toBe(
      true,
    );
  });

  it("takes over a lock left by a process that is no longer running", () => {
    acquireLock("entry-zone", { dir, pid: 111, isAlive: () => true });
    const taken = acquireLock("entry-zone", { dir, pid: 222, isAlive: (pid) => pid !== 111 });
    expect(taken.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "entry-zone.lock"), "utf8")).pid).toBe(222);
  });

  it("takes over an unreadable lock file", () => {
    writeFileSync(join(dir, "engine.lock"), "not json");
    expect(acquireLock("engine", { dir, pid: 5, isAlive: () => true }).ok).toBe(true);
  });

  it("release removes only the holder's own lock", () => {
    const mine = acquireLock("scanner", { dir, pid: 111, isAlive: () => true });
    if (!mine.ok) throw new Error("expected the lock");
    // Someone took it over (we were presumed dead); our release must not remove theirs.
    writeFileSync(join(dir, "scanner.lock"), JSON.stringify({ pid: 333, startedAt: "x" }));
    mine.release();
    expect(JSON.parse(readFileSync(join(dir, "scanner.lock"), "utf8")).pid).toBe(333);
  });

  it("is free again after release", () => {
    const a = acquireLock("engine", { dir, pid: 1, isAlive: () => true });
    if (!a.ok) throw new Error("expected the lock");
    a.release();
    expect(acquireLock("engine", { dir, pid: 2, isAlive: () => true }).ok).toBe(true);
  });

  it("uses the real liveness check by default", () => {
    // This process is alive, so a lock naming it is respected.
    writeFileSync(join(dir, "scanner.lock"), JSON.stringify({ pid: process.pid, startedAt: "x" }));
    expect(acquireLock("scanner", { dir, pid: process.pid + 1 })).toMatchObject({
      ok: false,
      holderPid: process.pid,
    });
  });
});

// --- catch-up ----------------------------------------------------------------

describe("catch-up on startup", () => {
  const H = 60 * 60_000;
  const DELAY = 90_000;
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 4, h, m);

  it("the most recent window is the last close plus the settle delay", () => {
    expect(latestDueScanWindow(["H1", "H4"], at(10, 5), DELAY)).toBe(at(10) + DELAY);
  });

  it("inside the settle period, the previous window is the one that counts", () => {
    expect(latestDueScanWindow(["H1"], at(10, 1), DELAY)).toBe(at(9) + DELAY);
  });

  it("scans after an overnight gap", () => {
    expect(
      isCatchUpDue({
        lastCompletedRunStartedAt: at(19, 45) - 24 * H,
        timeframes: ["H1", "H4"],
        now: at(8, 20),
        delayMs: DELAY,
      }),
    ).toBe(true);
  });

  it("does not scan when a pass already covered the latest window", () => {
    expect(
      isCatchUpDue({
        lastCompletedRunStartedAt: at(10) + DELAY,
        timeframes: ["H1", "H4"],
        now: at(10, 40),
        delayMs: DELAY,
      }),
    ).toBe(false);
  });

  it("scans when no pass has ever completed", () => {
    expect(
      isCatchUpDue({
        lastCompletedRunStartedAt: null,
        timeframes: ["H1"],
        now: at(10, 40),
        delayMs: DELAY,
      }),
    ).toBe(true);
  });

  it("leaves the window that is about to arrive to the schedule", () => {
    // 10:00:30 — the 10:00 close settles at 10:01:30 and the schedule takes it.
    // The 09:00 window was covered, so there is nothing to catch up.
    expect(
      isCatchUpDue({
        lastCompletedRunStartedAt: at(9) + DELAY,
        timeframes: ["H1"],
        now: at(10) + 30_000,
        delayMs: DELAY,
      }),
    ).toBe(false);
  });
});
