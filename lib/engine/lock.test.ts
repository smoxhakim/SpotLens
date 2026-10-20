// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ABANDONED_CLAIM_AFTER_MS,
  PROCESS_START_TOLERANCE_MS,
  acquireLock,
  liveLockHolder,
  linuxProcessIdentity,
  parseElapsed,
  parseProcStatStartTicks,
  processStartTime,
  type LinuxIdentity,
  type LockOptions,
} from "@/lib/engine/lock";

/**
 * Run locks: exactly one holder per role, a stale lock taken over by exactly
 * one process, and a reused PID not mistaken for the holder.
 *
 * Competing processes are simulated in one process, deterministically: the
 * liveness check is the moment a real process has read the lock and not yet
 * acted on it, so running a whole competing `acquireLock` inside it is the
 * worst interleaving there is. A real multi-process race is in
 * `lock.process.test.ts`.
 */

let dir = "";
const DEAD = 999_991;
const T0 = Date.UTC(2026, 9, 20, 9);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spotlens-lock-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lockFile = (role = "scanner") => join(dir, `${role}.lock`);
const holderOf = (role = "scanner") =>
  JSON.parse(readFileSync(lockFile(role), "utf8")) as Record<string, unknown>;

/** A process: its pid, its start time, and what it believes about others. */
function proc(
  pid: number,
  alive: (pid: number) => boolean,
  extra: Partial<LockOptions> = {},
): LockOptions {
  return {
    dir,
    pid,
    isAlive: alive,
    processStartedAt: T0 + pid, // distinct per process
    startTimeOf: (p) => T0 + p, // every live process is who its lock says
    now: () => T0 + 60 * 60_000,
    // The macOS check, whatever this runs on; Linux has its own tests below.
    platform: "darwin",
    identity: null,
    ...extra,
  };
}

function staleLock(role = "scanner") {
  writeFileSync(
    lockFile(role),
    JSON.stringify({ pid: DEAD, startedAt: "x", processStartedAt: T0, nonce: crypto.randomUUID() }),
  );
}

describe("one holder per role", () => {
  it("a second live process is refused; release frees it; nothing is left behind", () => {
    const alive = (p: number) => p !== DEAD;
    const a = acquireLock("scanner", proc(111, alive));
    expect(a.ok).toBe(true);
    expect(acquireLock("scanner", proc(222, alive))).toMatchObject({ ok: false, holderPid: 111 });

    if (a.ok) a.release();
    expect(acquireLock("scanner", proc(222, alive)).ok).toBe(true);
    expect(readdirSync(dir)).toEqual(["scanner.lock"]); // no temp or claim files
  });

  it("the lock records its holder's pid, process start and a nonce", () => {
    acquireLock(
      "scanner",
      proc(111, () => true),
    );
    expect(holderOf()).toMatchObject({ pid: 111, processStartedAt: T0 + 111 });
    expect(holderOf().nonce).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("stale lock recovery", () => {
  it("a lock left by a dead process is taken over", () => {
    staleLock();
    expect(
      acquireLock(
        "scanner",
        proc(111, (p) => p !== DEAD),
      ).ok,
    ).toBe(true);
    expect(holderOf().pid).toBe(111);
    expect(readdirSync(dir)).toEqual(["scanner.lock"]);
  });

  it("an older-format lock (no nonce, no start time) left by a dead process is taken over", () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: DEAD, startedAt: "x" }));
    expect(
      acquireLock(
        "scanner",
        proc(111, (p) => p !== DEAD),
      ).ok,
    ).toBe(true);
  });

  it("an unreadable lock is taken over", () => {
    writeFileSync(lockFile(), "not json");
    expect(
      acquireLock(
        "scanner",
        proc(111, () => true),
      ).ok,
    ).toBe(true);
  });

  it("release removes only the very lock it took — never a successor's", () => {
    const alive = (p: number) => p !== DEAD;
    const a = acquireLock("scanner", proc(111, alive));
    // 111 is declared dead by 222, which takes over.
    const b = acquireLock(
      "scanner",
      proc(222, (p) => p !== 111),
    );
    expect(b.ok).toBe(true);
    if (a.ok) a.release();
    expect(holderOf().pid).toBe(222);
  });
});

describe("competing for one stale lock: exactly one wins", () => {
  it("B takes over while A is between reading the stale lock and acting on it", () => {
    staleLock();
    let b: ReturnType<typeof acquireLock> | null = null;

    const a = acquireLock(
      "scanner",
      proc(111, (p) => {
        if (p === DEAD && !b)
          b = acquireLock(
            "scanner",
            proc(222, (q) => q !== DEAD),
          );
        return p !== DEAD; // A sees 222, once it has the lock, as alive
      }),
    );

    expect(b!.ok).toBe(true);
    expect(a).toMatchObject({ ok: false, holderPid: 222 }); // used to be true: two holders
    expect(holderOf().pid).toBe(222);
    expect(readdirSync(dir)).toEqual(["scanner.lock"]);
  });

  it("five processes, each interrupted by the next at the worst moment: one holder", () => {
    staleLock();
    const results: { pid: number; ok: boolean }[] = [];

    function contender(pid: number, next: number | null) {
      let interrupted = false;
      const r = acquireLock(
        "scanner",
        proc(pid, (p) => {
          if (p === DEAD && next !== null && !interrupted) {
            interrupted = true;
            contender(next, next < 105 ? next + 1 : null);
          }
          return p !== DEAD;
        }),
      );
      results.push({ pid, ok: r.ok });
    }
    contender(101, 102);

    expect(results).toHaveLength(5);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(holderOf().pid).toBe(results.find((r) => r.ok)!.pid);
  });

  it("a claim held by another process blocks the takeover", () => {
    staleLock();
    const stale = holderOf();
    writeFileSync(
      `${lockFile()}.claim-${stale.nonce}`,
      JSON.stringify({ pid: 222, processStartedAt: T0 + 222, at: T0 + 60 * 60_000 }),
    );
    expect(
      acquireLock(
        "scanner",
        proc(111, (p) => p !== DEAD),
      ).ok,
    ).toBe(false);
    expect(holderOf().pid).toBe(DEAD); // untouched
  });

  it("a claim abandoned by a process that died mid-takeover is cleared once it is old", () => {
    staleLock();
    const stale = holderOf();
    const claim = `${lockFile()}.claim-${stale.nonce}`;
    const now = T0 + 60 * 60_000;
    const alive = (p: number) => p !== DEAD && p !== 333;

    writeFileSync(claim, JSON.stringify({ pid: 333, processStartedAt: T0, at: now - 1_000 }));
    expect(acquireLock("scanner", proc(111, alive)).ok).toBe(false); // too recent to call abandoned

    writeFileSync(
      claim,
      JSON.stringify({ pid: 333, processStartedAt: T0, at: now - ABANDONED_CLAIM_AFTER_MS - 1 }),
    );
    expect(acquireLock("scanner", proc(111, alive)).ok).toBe(true);
    expect(readdirSync(dir)).toEqual(["scanner.lock"]);
  });
});

describe("PID reuse (macOS: the ps start time)", () => {
  const LIVE = 4242;

  function lockedBy(processStartedAt: number | undefined) {
    writeFileSync(
      lockFile(),
      JSON.stringify({ pid: LIVE, startedAt: "x", processStartedAt, nonce: crypto.randomUUID() }),
    );
  }

  it("a live PID whose process started at another time is not the holder: taken over", () => {
    lockedBy(T0);
    const opts = proc(111, () => true, { startTimeOf: () => T0 + 60 * 60_000 }); // PID reused an hour later
    expect(liveLockHolder("scanner", opts)).toBeNull();
    expect(acquireLock("scanner", opts).ok).toBe(true);
    expect(holderOf().pid).toBe(111);
  });

  it("the same process, within the tolerance, is the holder: refused", () => {
    lockedBy(T0);
    const opts = proc(111, () => true, {
      startTimeOf: () => T0 + PROCESS_START_TOLERANCE_MS - 1,
    });
    expect(liveLockHolder("scanner", opts)).toBe(LIVE);
    expect(acquireLock("scanner", opts)).toMatchObject({ ok: false, holderPid: LIVE });
  });

  it("when the start time cannot be told, the live PID is obeyed — refusing is the safe mistake", () => {
    lockedBy(T0);
    const opts = proc(111, () => true, { startTimeOf: () => null });
    expect(acquireLock("scanner", opts).ok).toBe(false);
    expect(liveLockHolder("scanner", opts)).toBe(LIVE);
  });

  it("an older-format lock without a start time is obeyed while its PID lives", () => {
    lockedBy(undefined);
    expect(
      acquireLock(
        "scanner",
        proc(111, () => true),
      ).ok,
    ).toBe(false);
  });
});

describe("process start time, from ps", () => {
  it("parses every elapsed-time form ps prints", () => {
    expect(parseElapsed("00:07")).toBe(7_000);
    expect(parseElapsed("  12:34\n")).toBe((12 * 60 + 34) * 1000);
    expect(parseElapsed("1:02:03")).toBe(3_723_000);
    expect(parseElapsed("3-04:05:06")).toBe(((3 * 24 + 4) * 3600 + 5 * 60 + 6) * 1000);
    expect(parseElapsed("")).toBeNull();
    expect(parseElapsed("Mon Oct 19")).toBeNull();
  });

  it("this process: ps agrees with Node about when it started", () => {
    const own = Date.now() - process.uptime() * 1000;
    const viaPs = processStartTime(process.pid);
    expect(viaPs).not.toBeNull();
    expect(Math.abs(viaPs! - own)).toBeLessThan(PROCESS_START_TOLERANCE_MS);
  });

  it("a PID that is not running has no start time", () => {
    expect(processStartTime(DEAD)).toBeNull();
    expect(processStartTime(-1)).toBeNull();
  });
});

// --- Linux ---------------------------------------------------------------------

const BOOT = "0f2c6f4e-7a1b-4c3d-9e8f-102938475610";
const OTHER_BOOT = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const id = (startTicks: string, bootId = BOOT): LinuxIdentity => ({ bootId, startTicks });

describe("Linux process identity, from /proc", () => {
  const stat = (comm: string, ticks: string) =>
    `4242 (${comm}) S 1 4242 4242 0 -1 4194560 600 0 0 0 3 1 0 0 20 0 1 0 ${ticks} 12345678 900 18446744073709551615`;

  it("reads start ticks from field 22, counting from the last ')'", () => {
    expect(parseProcStatStartTicks(stat("node", "98765"))).toBe("98765");
    // A command name with spaces and parentheses cannot shift the fields.
    expect(parseProcStatStartTicks(stat("my (odd) proc) x", "98765"))).toBe("98765");
  });

  it.each([
    ["no closing parenthesis", "4242 node S 1 2 3"],
    ["too few fields", "4242 (node) S 1 2 3"],
    ["a non-numeric start", stat("node", "abc")],
    ["empty", ""],
  ])("malformed (%s) is unknown, never a value", (_, text) => {
    expect(parseProcStatStartTicks(text)).toBeNull();
  });

  it("combines the boot id and the start ticks", () => {
    const read = (path: string) => (path.endsWith("boot_id") ? `${BOOT}\n` : stat("node", "98765"));
    expect(linuxProcessIdentity(4242, read)).toEqual(id("98765"));
  });

  it.each([
    [
      "/proc missing",
      () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    ],
    [
      "permission denied",
      (path: string) => {
        if (path.endsWith("/stat")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return BOOT;
      },
    ],
    ["a malformed boot id", (path: string) => (path.endsWith("boot_id") ? "not-a-uuid" : "x")],
    ["a malformed stat", (path: string) => (path.endsWith("boot_id") ? BOOT : "garbage")],
  ])("unreadable (%s) is null — unknown, not different", (_, read) => {
    expect(linuxProcessIdentity(4242, read as (p: string) => string)).toBeNull();
  });

  it("an invalid pid is null without reading anything", () => {
    expect(
      linuxProcessIdentity(-1, () => {
        throw new Error("read");
      }),
    ).toBeNull();
  });
});

describe("Linux: who holds the lock", () => {
  const LIVE = 4242;

  /** A Linux process that sees `current` as LIVE's identity (null: cannot read it). */
  function linux(pid: number, current: LinuxIdentity | null, extra: Partial<LockOptions> = {}) {
    return proc(pid, (p) => p !== DEAD, {
      platform: "linux",
      identity: id(String(1000 + pid)),
      identityOf: (p) => (p === LIVE ? current : id(String(1000 + p))),
      // The wall-clock check must never be consulted on Linux: make it wrong.
      startTimeOf: () => T0 + 24 * 60 * 60_000,
      ...extra,
    });
  }

  function lockedBy(identity: unknown, pid = LIVE) {
    writeFileSync(
      lockFile(),
      JSON.stringify({
        pid,
        startedAt: "x",
        processStartedAt: T0,
        ...(identity === undefined ? {} : { identity }),
        nonce: crypto.randomUUID(),
      }),
    );
  }

  it("same PID, same boot, same start: the holder — even with the wall clock a day off", () => {
    lockedBy(id("555"));
    const opts = linux(111, id("555"));
    expect(liveLockHolder("scanner", opts)).toBe(LIVE);
    expect(acquireLock("scanner", opts)).toMatchObject({ ok: false, holderPid: LIVE });
  });

  it("same PID, a different start: a reused PID — taken over", () => {
    lockedBy(id("555"));
    const opts = linux(111, id("777"));
    expect(liveLockHolder("scanner", opts)).toBeNull();
    expect(acquireLock("scanner", opts).ok).toBe(true);
    expect(holderOf()).toMatchObject({ pid: 111, identity: id("1111") });
  });

  it("a different boot: the holder belonged to an earlier one — taken over", () => {
    lockedBy(id("555", OTHER_BOOT));
    const opts = linux(111, id("555"));
    expect(liveLockHolder("scanner", opts)).toBeNull();
    expect(acquireLock("scanner", opts).ok).toBe(true);
  });

  it("the live PID's identity cannot be read: never seized", () => {
    lockedBy(id("555"));
    const opts = linux(111, null);
    expect(liveLockHolder("scanner", opts)).toBe(LIVE);
    expect(acquireLock("scanner", opts)).toMatchObject({ ok: false, holderPid: LIVE });
  });

  it.each([
    ["an older lock with no identity", undefined],
    ["a malformed identity", { bootId: "nope", startTicks: "12" }],
    ["an identity with a non-numeric start", { bootId: BOOT, startTicks: "1e3" }],
  ])("%s, PID alive: obeyed — no wall-clock fallback on Linux", (_, identity) => {
    lockedBy(identity);
    const opts = linux(111, id("777"));
    expect(acquireLock("scanner", opts)).toMatchObject({ ok: false, holderPid: LIVE });
  });

  it("a dead holder is recovered as before", () => {
    lockedBy(id("555"), DEAD);
    expect(acquireLock("scanner", linux(111, null)).ok).toBe(true);
    expect(readdirSync(dir)).toEqual(["scanner.lock"]);
  });

  it("the lock records the holder's identity; macOS records none", () => {
    acquireLock("scanner", linux(111, null));
    expect(holderOf().identity).toEqual(id("1111"));
    rmSync(lockFile());
    acquireLock(
      "scanner",
      proc(222, () => true),
    );
    expect(holderOf().identity).toBeNull();
  });

  it("two contenders for one reused-PID lock: exactly one holder", () => {
    lockedBy(id("555"));
    let b: ReturnType<typeof acquireLock> | null = null;
    const a = acquireLock(
      "scanner",
      linux(111, id("777"), {
        identityOf: (p) => {
          if (p === LIVE && !b) b = acquireLock("scanner", linux(222, id("777")));
          return p === LIVE ? id("777") : id(String(1000 + p));
        },
      }),
    );
    expect(b!.ok).toBe(true);
    expect(a).toMatchObject({ ok: false, holderPid: 222 });
    expect(holderOf().pid).toBe(222);
    expect(readdirSync(dir)).toEqual(["scanner.lock"]);
  });

  it("an abandoned claim from an earlier boot is cleared once old", () => {
    lockedBy(id("555"), DEAD);
    const stale = holderOf();
    const claim = `${lockFile()}.claim-${stale.nonce}`;
    writeFileSync(
      claim,
      JSON.stringify({
        pid: LIVE,
        processStartedAt: T0,
        identity: id("555", OTHER_BOOT),
        at: T0 + 60 * 60_000 - ABANDONED_CLAIM_AFTER_MS - 1,
      }),
    );
    expect(acquireLock("scanner", linux(111, id("555"))).ok).toBe(true);
    expect(readdirSync(dir)).toEqual(["scanner.lock"]);
  });
});
