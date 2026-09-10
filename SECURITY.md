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

**Telegram.** The bot token is read in one file, from the environment only. It
is never returned by an API, never written to the database, never logged, and
is stripped out of provider errors before they are stored — Telegram echoes the
request URL back on some failures, and that URL contains the token. Connecting a
chat uses a one-time code that is stored only as a SHA-256 hash, expires in ten
minutes, is burned after ten claim attempts, and is bound to the session that
requested it, so it cannot bind a chat to another account. Incoming Telegram
payloads are parsed field by field and anything unrecognised is skipped.
Connection and test endpoints are rate limited. The bot sends notifications and
nothing else: there are no Telegram commands, and no code path from a message
to an order.

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

**Dependency advisories: none.** `npm audit` reports zero vulnerabilities, in
the production tree and across dev dependencies alike. Verified on
2026-09-10 against Next 16.3.4.

The 21 advisories previously recorded here were against Next 14 and were
cleared by the upgrade to Next 16, which also pulled in React 19. The dev-only
advisories that remained afterwards (an esbuild dev-server issue reached
through Vite, and a path-traversal issue in `@vitest/mocker`) were cleared by
moving the test toolchain to Vitest 4. Re-check with:

```bash
npm audit --omit=dev   # production tree
npm audit              # everything, dev included
```

Treat that as a number with a date on it rather than a standing fact: it is
true of the current lockfile and says nothing about advisories published since.

**CSP allows `unsafe-inline` and `unsafe-eval`.** Both are what Next.js
currently requires for hydration and dev tooling. Tightening this needs
nonce-based CSP through middleware, which is worth doing if the app ever serves
other people.
