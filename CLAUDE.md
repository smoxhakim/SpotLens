# SpotLens — working notes for Claude

Educational crypto **spot trading** analysis app. A deterministic engine reads
market structure and produces entry / stop / targets / score / status, with a
plain-language reason attached to every number.

Full spec in `PRD.md`, design in `ARCHITECTURE.md`, roadmap in `TODO.md`,
security posture in `SECURITY.md`. Read those only when the task needs them —
this file is meant to make that unnecessary most of the time.

## Product rules that are not negotiable

- **Spot only.** No futures, margin, leverage, or short selling. Every setup is
  a LONG. There is no code path that can place an order.
- **Never say "buy".** Every analysis ends on one of four statuses: Potential
  setup / Wait for confirmation / High risk / Avoid.
- **Prefer WAIT.** Status rules are ordered so every disqualifying condition is
  ruled out _before_ POTENTIAL_SETUP can be returned. If most analyses start
  returning "potential setup", that is a bug.
- **AVOID shows no numbers.** No entry, stop or targets — handing over levels
  for a trade just advised against defeats the point.
- **Every number carries a reason.** The engine decides; `lib/analysis/explain`
  phrases it. AI never produces a number.
- **Disclaimers come from `lib/constants/disclaimers.ts`.** Never inline the
  wording.
- **No meme coins.** The curated list is `lib/market-data/curated-assets.ts`.

## Stack

Next.js 14 App Router · TypeScript · Tailwind · TradingView Lightweight Charts ·
TanStack Query · Postgres (Neon) + Prisma · Auth.js v5 (credentials only) ·
Vitest · Playwright.

## Layout

```
app/            routes + API handlers
features/       UI per feature (market, analysis, watchlist, learning, ...)
lib/
  analysis/     the engine — pure, deterministic, no I/O
  indicators/   EMA, RSI, ATR, volume
  backtesting/  bar-by-bar replay
  market-data/  provider abstraction + Binance
services/       DB-backed services (markets, candles, snapshots, backtests)
```

## Commands

```bash
npm run dev                  # port 3000
npm run test                 # vitest — scope it: npx vitest run lib/analysis
npm run e2e                  # playwright, serves on 3100 (3000 is often taken)
npm run lint && npm run typecheck
npx prisma migrate deploy    # apply migrations
npm run prisma:seed          # assets, checklists, learn articles (idempotent)
```

## Things that will bite you

- **The engine must stay pure.** No `Date.now()`, no randomness, no I/O in
  `lib/analysis`. State that depends on "now" is passed in (see
  `lastCandleIsForming`). The backtester replays history and must be
  reproducible.
- **Equality is not a direction.** Three bugs so far came from `>` where values
  can be equal: flat EMAs read as bearish, an equal-high range read as a
  downtrend. Use a deadband and an explicit LEVEL/EQUAL state.
- **Volume cannot read a forming candle.** It is an accumulation, not a level.
  Excluded via `lastCandleIsForming`.
- **Fixtures are all closed candles.** Several real bugs only appeared against
  live data. Verify against the running app, not only the suite.
- **No `loading.tsx` at the app root.** It wraps every page in Suspense, the
  response streams, and its 200 is sent before `notFound()` can run — so every
  404 became "200 Page not found". Keep loading boundaries below routes that
  can 404.
- **Timeframes derive from `TIMEFRAMES`** and one Zod schema in
  `lib/market-data/schema.ts`. Never inline a timeframe list.
- **Neon needs two URLs.** `DATABASE_URL` (pooled) for the app, `DIRECT_URL`
  (unpooled) for migrations — Prisma's advisory locks need a direct connection.
- **The `@emnapi/*` devDependencies are load-bearing.** Nothing imports them;
  they exist because npm otherwise omits them from the lockfile and `npm ci`
  fails on Linux. See the troubleshooting note in `README.md`.

## Tuning constants worth knowing

Warmup ~260 candles · minimum 60 for a read · backtest ceiling 1000 candles ·
rate limits 5/min backtest, 30/min analysis, 120/min market data, 5/hr signup ·
minimum acceptable R:R 1.5.

## Decisions already made — do not re-litigate

This is a **single-user app**. Deliberately not built, each by explicit
decision: Stripe billing and plan gating, Sentry, UptimeRobot, staging
environments, the admin interface, Google OAuth, password reset, and QStash
async jobs (backtests run synchronously under the candle ceiling).

Sessions are JWT rather than database sessions — a library constraint, since
Auth.js v5's Credentials provider does not support the database strategy.

Outstanding and needing a decision: 21 Next.js advisories fixable only by
upgrading Next 14 → 16, which `ARCHITECTURE.md` pins. See `SECURITY.md`.

## Git workflow

Branch per phase or fix, **push to the branch, never to `main`**, and **do not
open pull requests** — the user reviews and merges. `gh` is not installed.
