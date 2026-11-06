import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { assertEnvNeutralised, hermeticEnv } from "./hermetic-env";

const run = promisify(execFile);

/**
 * A PostgreSQL that exists only for one test file, and that no setting can replace.
 *
 * The opt-in fault tests inject failures: they cut connections, add constraints and
 * rename columns. So they take no database URL at all, and nothing here reads one.
 * Each test file starts its own server, on a port the OS picks, in memory, migrates
 * it, and removes it when done. A URL that is not this server's own is refused.
 *
 * Opt in with SPOTLENS_FAULT_TESTS=1. Needs Docker running and a local
 * postgres:16-alpine; it never pulls an image.
 *
 * What cleans up after a run:
 *  - the test's own afterAll, on success or failure;
 *  - `registerCleanup`, on exit, on SIGINT, SIGTERM or SIGHUP, and when the test runner
 *    above a worker goes away;
 *  - for a runner killed outright, which can run nothing: the container ends itself
 *    after 30 minutes, a child scanner exits when its parent goes (network-guard.mjs),
 *    and old temp directories are swept by the next run.
 */

export const FAULT_TESTS_ENABLED = process.env.SPOTLENS_FAULT_TESTS === "1";

const IMAGE = "postgres:16-alpine";
const USER = "throwaway";
const LIFETIME_S = 1800;
const NAME_PREFIX = "spotlens-throwaway-";
const TEMP_PREFIX = "spotlens-throwaway-";
const STALE_TEMP_MS = 60 * 60_000;
/** The application's own local database. Never a target, whatever else matches. */
const APPLICATION_PORT = 5432;

// --- cleanup ----------------------------------------------------------------

const cleanups = new Set<() => void>();
let handlersInstalled = false;

function runCleanups() {
  for (const cleanup of [...cleanups]) {
    cleanups.delete(cleanup);
    try {
      cleanup();
    } catch {
      // The next one still has to run.
    }
  }
}

/**
 * Runs `cleanup` if this process ends before it is unregistered. Synchronous only:
 * on exit, nothing asynchronous gets to finish. Returns the way to unregister it.
 */
export function registerCleanup(cleanup: () => void): () => void {
  if (!handlersInstalled) {
    handlersInstalled = true;
    process.once("exit", runCleanups);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        runCleanups();
        process.kill(process.pid, signal);
      });
    }
    // A test worker whose runner has gone. It would otherwise carry on by itself.
    if (process.connected) {
      process.once("disconnect", () => {
        runCleanups();
        process.exit();
      });
    }
  }
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

/** A temp directory removed with the rest. Sweeps what a killed run left behind. */
export function throwawayDir(): string {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const path = join(tmpdir(), name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_TEMP_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Another run's, or already gone.
    }
  }
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- the server -------------------------------------------------------------

/** Throws unless the URL is this server's own, on this machine, in a _test database. */
export function assertThrowawayUrl(raw: string, ownPort: number): void {
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, "");
  if (
    url.hostname !== "127.0.0.1" ||
    Number(url.port) !== ownPort ||
    ownPort === APPLICATION_PORT ||
    url.username !== USER ||
    !database.endsWith("_test")
  ) {
    throw new Error("Refusing a database URL that is not this test's own throwaway server.");
  }
}

/** Throws unless the name is one this file generated. */
function assertOwnContainer(name: string): void {
  if (!name.startsWith(NAME_PREFIX)) throw new Error("Refusing to touch another container.");
}

function removeContainerSync(name: string): void {
  assertOwnContainer(name);
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}

/**
 * What the fault tests install in a database of their own. Lives only there, and
 * never in the application's schema.
 *
 * The clock: a real database's `now()` knows nothing of a test's fake clock, and a
 * lifecycle rule reads when an event was written, so the rows are stamped from a table
 * the test sets. The poison: a function the proxy can redirect the lifecycle's lock
 * call to, for a real refusal with a real SQLSTATE, and a switch that makes saving a
 * pass's results fail the same way.
 */
const FAULT_FIXTURES = [
  `CREATE TABLE test_clock (at timestamp(3) NOT NULL)`,
  `INSERT INTO test_clock VALUES (now())`,
  `CREATE FUNCTION test_stamp() RETURNS trigger AS $$ BEGIN NEW."createdAt" := (SELECT at FROM test_clock LIMIT 1); RETURN NEW; END $$ LANGUAGE plpgsql`,
  `CREATE TRIGGER test_stamp_event BEFORE INSERT ON "SetupEvent" FOR EACH ROW EXECUTE FUNCTION test_stamp()`,
  `CREATE TRIGGER test_stamp_setup BEFORE INSERT ON "TrackedSetup" FOR EACH ROW EXECUTE FUNCTION test_stamp()`,
  `CREATE FUNCTION test_stamp_started() RETURNS trigger AS $$ BEGIN NEW."startedAt" := (SELECT at FROM test_clock LIMIT 1); RETURN NEW; END $$ LANGUAGE plpgsql`,
  `CREATE TRIGGER test_stamp_run BEFORE INSERT ON "ScannerRun" FOR EACH ROW EXECUTE FUNCTION test_stamp_started()`,
  `CREATE FUNCTION test_poison_lock(bigint) RETURNS void AS $$ BEGIN RAISE EXCEPTION 'poison' USING ERRCODE = '42P01'; END $$ LANGUAGE plpgsql`,
  `CREATE TABLE test_flags (poison_results boolean NOT NULL DEFAULT false)`,
  `INSERT INTO test_flags VALUES (false)`,
  `CREATE FUNCTION test_refuse_results() RETURNS trigger AS $$ BEGIN IF (SELECT poison_results FROM test_flags LIMIT 1) THEN RAISE EXCEPTION 'refused' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
  `CREATE TRIGGER test_refuse BEFORE INSERT ON "ScannerResult" FOR EACH ROW EXECUTE FUNCTION test_refuse_results()`,
];

export interface ThrowawayPostgres {
  name: string;
  port: number;
  /** A direct URL for a database on this server. Refuses anything else. */
  url(database: string, params?: string): string;
  /** The same database through a proxy that forwards only to this server. */
  urlVia(proxy: { port: number; targetPort: number }, database: string, params?: string): string;
  /** Creates an empty, migrated database. With `faultFixtures`, the clock and the poison. */
  createDatabase(database: string, options?: { faultFixtures?: boolean }): Promise<string>;
  stop(): Promise<void>;
}

export async function startThrowawayPostgres(): Promise<ThrowawayPostgres> {
  assertEnvNeutralised();

  const name = `${NAME_PREFIX}${randomUUID().slice(0, 8)}`;
  assertOwnContainer(name);
  const unregister = registerCleanup(() => removeContainerSync(name));

  await run("docker", [
    "run",
    "-d",
    "--rm",
    "--pull",
    "never",
    "--name",
    name,
    "--label",
    "spotlens.throwaway=true",
    "-e",
    `POSTGRES_USER=${USER}`,
    "-e",
    `POSTGRES_PASSWORD=${USER}`,
    "-e",
    "POSTGRES_DB=admin_test",
    "-p",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--entrypoint",
    "sh",
    IMAGE,
    "-c",
    `exec timeout ${LIFETIME_S} docker-entrypoint.sh postgres`,
  ]);

  const stop = async () => {
    unregister();
    await run("docker", ["rm", "-f", name]).catch(() => undefined);
  };

  try {
    const { stdout } = await run("docker", ["port", name, "5432/tcp"]);
    const port = Number(/:(\d+)\s*$/m.exec(stdout)?.[1]);
    if (!Number.isInteger(port) || port === 0 || port === APPLICATION_PORT) {
      throw new Error("The throwaway server did not get a port of its own.");
    }

    const url = (database: string, params = "sslmode=disable") => {
      const value = `postgresql://${USER}:${USER}@127.0.0.1:${port}/${database}?${params}`;
      assertThrowawayUrl(value, port);
      return value;
    };

    // Asked over TCP: the image's temporary init server listens only on a socket, so
    // this cannot be answered by the server that is about to be restarted.
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("The throwaway server did not start in time.");
      const ready = await run("docker", [
        "exec",
        "-e",
        `PGPASSWORD=${USER}`,
        name,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        USER,
        "-d",
        "admin_test",
        "-qAtc",
        "select 1",
      ]).then(
        () => true,
        () => false,
      );
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Imported here, after the check above: importing it is what loads a `.env`.
    const { PrismaClient } = await import("@prisma/client");

    const admin = new PrismaClient({ datasourceUrl: url("admin_test"), log: [] });
    await admin.$executeRawUnsafe("CREATE DATABASE template_test");
    await admin.$disconnect();

    const template = url("template_test");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("node_modules/.bin/prisma", ["migrate", "deploy"], {
        env: hermeticEnv({ DATABASE_URL: template, DIRECT_URL: template }),
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`prisma migrate deploy exited ${code}.`)),
      );
    });

    return {
      name,
      port,
      url,
      stop,
      urlVia(proxy, database, params = "sslmode=disable") {
        if (proxy.targetPort !== port) {
          throw new Error("Refusing a proxy that forwards anywhere but this throwaway server.");
        }
        const value = `postgresql://${USER}:${USER}@127.0.0.1:${proxy.port}/${database}?${params}`;
        assertThrowawayUrl(value, proxy.port);
        return value;
      },
      async createDatabase(database, options = {}) {
        const target = url(database);
        const creator = new PrismaClient({ datasourceUrl: url("admin_test"), log: [] });
        await creator.$executeRawUnsafe(`CREATE DATABASE "${database}" TEMPLATE template_test`);
        await creator.$disconnect();
        if (options.faultFixtures) {
          const fixtures = new PrismaClient({ datasourceUrl: target, log: [] });
          for (const statement of FAULT_FIXTURES) await fixtures.$executeRawUnsafe(statement);
          await fixtures.$disconnect();
        }
        return target;
      },
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
