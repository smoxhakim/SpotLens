// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FaultProxy } from "./fault-proxy";

import { assertEnvNeutralised, envFileKeys, hermeticEnv } from "./hermetic-env";
import { assertThrowawayUrl, throwawayDir } from "./throwaway-postgres";

const dirs: string[] = [];
const dirWith = (content: string) => {
  const d = mkdtempSync(join(tmpdir(), "hermetic-"));
  dirs.push(d);
  writeFileSync(join(d, ".env"), content);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("a test process cannot pick up the checkout's .env", () => {
  const ENV =
    'DATABASE_URL="secret-a"\n# COMMENT=no\nexport TELEGRAM_BOT_TOKEN=secret-b\nSOME_NEW_KEY=secret-c\n';

  it("names every key and never holds a value", () => {
    expect(envFileKeys(dirWith(ENV))).toEqual([
      "DATABASE_URL",
      "TELEGRAM_BOT_TOKEN",
      "SOME_NEW_KEY",
    ]);
  });

  it("sets every key blank, so Prisma's own .env loading leaves it alone", () => {
    const env = hermeticEnv({}, dirWith(ENV));
    expect(env.DATABASE_URL).toBe("");
    expect(env.TELEGRAM_BOT_TOKEN).toBe("");
    expect(env.SOME_NEW_KEY).toBe("");
    expect(JSON.stringify(env)).not.toMatch(/secret-/);
  });

  it("blanks the dangerous keys even with no .env, and inherits nothing else", () => {
    process.env.G2_SHOULD_NOT_INHERIT = "x";
    const env = hermeticEnv({}, mkdtempSync(join(tmpdir(), "hermetic-none-")));
    delete process.env.G2_SHOULD_NOT_INHERIT;
    expect(env.DATABASE_URL).toBe("");
    expect(env.DIRECT_URL).toBe("");
    expect(env.TELEGRAM_BOT_TOKEN).toBe("");
    expect(env.G2_SHOULD_NOT_INHERIT).toBeUndefined();
  });

  it("the values a test means to use win", () => {
    expect(hermeticEnv({ DATABASE_URL: "mine" }, dirWith(ENV)).DATABASE_URL).toBe("mine");
  });

  it("refuses to start a throwaway server while a dangerous key still holds a value", () => {
    const before = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = "postgresql://live/spotlens";
      expect(() => assertEnvNeutralised(dirWith(""))).toThrow(/DATABASE_URL/);
      process.env.DATABASE_URL = "";
      expect(() => assertEnvNeutralised(dirWith("DATABASE_URL=x\n"))).not.toThrow();
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  });
});

describe("a temp directory a killed run left behind", () => {
  it("is swept by the next run once it is old, and a recent one is left alone", () => {
    const old = join(tmpdir(), `spotlens-throwaway-sweep-old-${process.pid}`);
    const recent = join(tmpdir(), `spotlens-throwaway-sweep-recent-${process.pid}`);
    mkdirSync(old);
    mkdirSync(recent);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);

    const created = throwawayDir();
    try {
      expect(existsSync(old)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      expect(existsSync(created)).toBe(true);
    } finally {
      rmSync(recent, { recursive: true, force: true });
      rmSync(old, { recursive: true, force: true });
      rmSync(created, { recursive: true, force: true });
    }
  });
});

describe("the fault proxy", () => {
  it("refuses to forward to the application's database port", () => {
    expect(() => new FaultProxy(5432)).toThrow(/Refusing/);
  });
});

describe("the throwaway server's own URL check", () => {
  const own = 55999;
  const good = `postgresql://throwaway:throwaway@127.0.0.1:${own}/x_test?sslmode=disable`;

  it("accepts its own server's _test database", () => {
    expect(() => assertThrowawayUrl(good, own)).not.toThrow();
  });

  it.each([
    ["the application's local port", good.replace(`:${own}/`, ":5432/")],
    ["another host", good.replace("127.0.0.1", "example.neon.tech")],
    ["localhost by name, which can resolve elsewhere", good.replace("127.0.0.1", "localhost")],
    ["another user", good.replace("throwaway:throwaway", "spotlens:spotlens")],
    ["a database not ending in _test", good.replace("x_test", "spotlens")],
  ])("refuses %s", (_label, url) => {
    expect(() => assertThrowawayUrl(url, own)).toThrow(/Refusing/);
  });

  it("refuses port 5432 even when it is claimed as the server's own", () => {
    expect(() => assertThrowawayUrl(good.replace(`:${own}/`, ":5432/"), 5432)).toThrow(/Refusing/);
  });
});
