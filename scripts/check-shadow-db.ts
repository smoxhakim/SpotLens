/**
 * Refuses to run `prisma migrate dev` unless the whole configuration is safe.
 *
 * ## Why this exists
 *
 * `prisma migrate dev` needs a *shadow* database: a scratch database Prisma
 * **drops and recreates** to replay the migration chain into. Two separate
 * things about that command can destroy a real database, and both have to be
 * closed off:
 *
 *  1. **The shadow.** With no `shadowDatabaseUrl` in the datasource, Prisma
 *     invents one — `prisma_migrate_shadow_db_<uuid>` on the `directUrl`
 *     server — so a hosted Postgres gets CREATE DATABASE and DROP DATABASE
 *     issued against its production endpoint. This project now names the
 *     shadow in `prisma/schema.prisma`, and this script checks the value
 *     Prisma will actually read.
 *
 *  2. **The main database.** `migrate dev` resets the database it is pointed
 *     at when it detects drift — "We need to reset the … database. All data
 *     will be lost." An isolated shadow does nothing to prevent that. So a
 *     remote `DIRECT_URL` is refused outright: development migrations belong
 *     against a local database, and a real one is migrated with
 *     `npm run prisma:deploy`, which uses no shadow and resets nothing.
 *
 * This is not hypothetical. This project's development database was destroyed
 * by passing the live `DIRECT_URL` to `--shadow-database-url`. Prisma reset it
 * exactly as documented; the argument was the mistake. Hence a mechanical
 * check rather than a remembered rule.
 *
 * Nothing here prints a connection string. Host and database name are
 * identifiers, not credentials, and are the only parts ever shown.
 */

/** Hosts treated as local and therefore disposable. */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];

function fail(lines: string[]): never {
  console.error(`\n  ${lines.join("\n  ")}\n`);
  process.exit(1);
}

interface Target {
  host: string;
  database: string;
  /** Everything that is not a credential, for a message a reader can act on. */
  label: string;
}

/**
 * A connection string reduced to what is safe to show.
 *
 * The user, the password and the query string are dropped rather than masked —
 * a redaction that keeps the shape is still an invitation to paste it
 * somewhere. Only the host and the database name survive.
 */
function describe(raw: string): Target | null {
  try {
    const url = new URL(raw);
    if (!url.hostname) return null;
    const database = url.pathname.replace(/^\//, "");
    return { host: url.hostname, database, label: `${url.hostname}/${database || "(none)"}` };
  } catch {
    return null;
  }
}

function isLocal(target: Target): boolean {
  return LOCAL_HOSTS.includes(target.host);
}

/** Same server and same database: the shadow *is* the application's database. */
function sameDatabase(a: Target, b: Target): boolean {
  return a.host === b.host && a.database === b.database;
}

const shadowRaw = process.env.SHADOW_DATABASE_URL?.trim();
const directRaw = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
const pooledRaw = process.env.DATABASE_URL?.trim();

const SET_IT = [
  "  npm run db:shadow",
  '  SHADOW_DATABASE_URL="postgresql://spotlens:spotlens@localhost:5432/spotlens_shadow"',
];

// --- 1. the shadow must exist --------------------------------------------
if (!shadowRaw) {
  fail([
    "No SHADOW_DATABASE_URL is set.",
    "",
    "`prisma migrate dev` needs a shadow database — a scratch database Prisma",
    "DROPS and recreates. prisma/schema.prisma names it via",
    "SHADOW_DATABASE_URL, so without a value Prisma cannot run at all.",
    "",
    "Start the disposable local one and point at it:",
    "",
    ...SET_IT,
    "",
    "To migrate a real database use `npm run prisma:deploy`, which needs no",
    "shadow database and never resets anything.",
  ]);
}

// --- 2. and be a connection string ---------------------------------------
const shadow = describe(shadowRaw);
if (!shadow) {
  fail([
    "SHADOW_DATABASE_URL is not a valid connection string.",
    "",
    "Expected something of the form:",
    "",
    ...SET_IT.slice(1),
  ]);
}

// --- 3. and be disposable -------------------------------------------------
//
// Checked before the comparisons below, so a remote shadow is refused even
// when it happens to differ from DIRECT_URL. "Not the production database" is
// a weaker property than "safe to drop", and this is the one that matters.
if (!isLocal(shadow)) {
  fail([
    "SHADOW_DATABASE_URL is not local.",
    "",
    `  shadow: ${shadow.label}`,
    "",
    "Prisma drops and recreates this database on every `migrate dev`. Only a",
    "disposable local database may be used for it — a remote one is somebody's",
    "real data, whether or not it is this project's.",
    "",
    ...SET_IT,
  ]);
}

const direct = directRaw ? describe(directRaw) : null;
const pooled = pooledRaw ? describe(pooledRaw) : null;

// --- 4. and must not be either of the application's own connections -------
for (const [name, target] of [
  ["DIRECT_URL", direct],
  ["DATABASE_URL", pooled],
] as const) {
  if (target && sameDatabase(target, shadow)) {
    fail([
      `SHADOW_DATABASE_URL points at the SAME database as ${name}.`,
      "",
      `  ${shadow.label}`,
      "",
      "Prisma drops and recreates the shadow database. Running this would",
      "destroy every row in the database the application uses — which is",
      "exactly how this project's development database was lost once already.",
      "",
      "Point SHADOW_DATABASE_URL at a disposable database instead:",
      "",
      ...SET_IT,
    ]);
  }
}

// --- 5. and the main database must itself be safe to migrate --------------
//
// The check the shadow cannot make. `migrate dev` resets the database it is
// pointed at when it finds drift, so an isolated shadow protects nothing if
// DIRECT_URL is production.
if (!direct) {
  fail([
    "Neither DIRECT_URL nor DATABASE_URL is set.",
    "",
    "`prisma migrate dev` would have no database to migrate. Set one, or use",
    "`npm run prisma:deploy` against a real database.",
  ]);
}

if (!isLocal(direct)) {
  fail([
    "DIRECT_URL is not local, so `prisma migrate dev` is refused.",
    "",
    `  database: ${direct.label}`,
    "",
    "`migrate dev` resets the database it is pointed at when it detects drift:",
    '"We need to reset the … database. All data will be lost." An isolated',
    "shadow database does nothing to prevent that.",
    "",
    "Development migrations belong against a local database:",
    "",
    "  docker compose up -d postgres",
    "",
    "To apply migrations to this remote database, use:",
    "",
    "  npm run prisma:deploy",
    "",
    "which runs `prisma migrate deploy` — no shadow database, no reset, and it",
    "only ever applies migrations that are already committed.",
  ]);
}

console.log(
  `Shadow database OK: ${shadow.label} — disposable, and not ${direct.label}, ` +
    "which is local. `prisma migrate dev` may run.",
);
