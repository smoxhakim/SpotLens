# Security posture

What is in place, what is deliberately not, and what is currently outstanding.

## In place

**Authentication.** Passwords hashed with bcrypt at cost 12. Sign-in returns an
identical rejection whether the account is missing or the password is wrong, so
the endpoint cannot be used to enumerate accounts. Sessions are JWT — a library
constraint, not a preference: Auth.js v5's Credentials provider does not
support database sessions. Cookies are `httpOnly`, `secure` in production and
`sameSite=lax` by Auth.js default.

**Authorization.** Every user-scoped handler checks ownership on the row, not
just that a session exists. A row belonging to someone else returns 404 rather
than 403, so the endpoints cannot be used to probe for other users' data.

**Input validation.** Every route that accepts a body, a query or a dynamic
segment parses it with Zod before touching the database or the engine. Routes
that take no input are the only ones without a schema.

**Rate limiting.** Applied to signup, the analysis routes, backtesting, and the
market-data reads that can fall through to the exchange. Backed by Upstash when
`UPSTASH_REDIS_REST_*` are set, and by an in-process sliding window otherwise —
per-instance counters that a restart clears, which is correct for a single
instance and inadequate for several. Limits are tuned to cost: 5/min for a
backtest, 30/min for analysis, 120/min for cached reads, 5/hour for signup.

**Headers.** CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy`, `Permissions-Policy`, and the framework banner removed. The
CSP allows the exchange's REST and WebSocket origins because the browser
connects to them directly, which is the architecture's realtime design.

**Secrets.** Validated at boot. Production refuses to start without an auth
secret or a database, and rejects a database pointed at localhost. `.env` is
git-ignored and has never been committed.

**No trade execution.** No code path can place an order, and no exchange API
key with trading scope is ever requested or stored. This is structural, not a
setting.

## Deliberately not built

This is a single-user application, so the following are cost without benefit
and were skipped by explicit decision: Stripe billing and plan gating, Sentry,
UptimeRobot, staging environments, and the admin interface. Password reset is
also absent — it needs a transactional email provider, and the only account can
be reset directly in the database.

## Outstanding

**Next.js advisories.** `npm audit` reports 21 high-severity advisories against
Next 14, all fixed only by upgrading to Next 16 — two major versions, and
ARCHITECTURE.md pins Next 14.

Most do not apply to this application: it uses no image optimization, no
rewrites, no middleware, no i18n, no custom server and no Server Actions. The
ones that could matter are the cache-poisoning and denial-of-service issues in
React Server Component responses.

For a single-user deployment behind no public traffic the practical risk is
low. If this is ever exposed publicly, upgrade first. Re-check with:

```bash
npm audit --omit=dev
```

**CSP allows `unsafe-inline` and `unsafe-eval`.** Both are what Next.js
currently requires for hydration and dev tooling. Tightening this needs
nonce-based CSP through middleware, which is worth doing if the app ever serves
other people.
