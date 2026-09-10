# SpotLens

An educational crypto **spot trading** analysis tool. It reads market structure
on a chart and produces an entry zone, a stop loss, take-profit targets, a
0–100 quality score and a verdict — with a plain-language reason attached to
every single number.

It is built around one idea: **most of the time, the honest answer is "not
this, not now."** A tool that hunts for reasons to say yes will always find
them. This one is ordered so that every disqualifying condition has to be ruled
out before it can call anything a setup, which is why it says _wait_ far more
often than it says _go and look_.

> This analysis is educational and informational only. Market conditions can
> change, and no trade outcome is guaranteed.

---

## The rules that define it

These are not preferences. They are enforced in code and covered by tests.

**Spot only.** No futures, no margin, no leverage, no short selling. Every
setup is a LONG. When the trend is down, the answer is not "go short" — it is
that there is nothing to do.

**It cannot place a trade.** There is no code path in this application capable
of submitting an order, and it never asks for exchange keys with trade
permissions. It is a second opinion you read before deciding.

**It never says "buy".** Every analysis ends on one of four statuses, and even
the best one is phrased as a candidate rather than an instruction.

**AVOID shows no numbers.** When the verdict is "avoid", no entry, stop or
targets are returned — only the score explaining the refusal. Handing over
levels for a trade the tool has just advised against would undo the point of
saying it.

**Every number carries a reason.** The deterministic engine decides;
`lib/analysis/explain` phrases it. No AI produces a number anywhere in this
application.

**No meme coins.** The list of 45 tradeable markets is curated in
`lib/market-data/curated-assets.ts`.

**Disclaimer wording lives in one place** — `lib/constants/disclaimers.ts`,
version-stamped so a saved analysis records which text it was shown under.

---

## How an analysis works

`POST /api/analysis/run` takes a trading pair and a timeframe and runs four
stages. The whole engine is pure: no clock, no randomness, no I/O. Anything
that depends on "now" is passed in, which is what lets the backtester replay
history and get identical results.

### 1. Market read

Swing highs and lows are detected and classified into a trend (bullish,
bearish, sideways) using a deadband, so a flat market reads as _sideways_
rather than being forced into a direction. Support and resistance are clustered
into **ATR-scaled zones, never single lines**, and scored on how often they have
been touched, how recently, and whether the level has flipped between support
and resistance.

Indicators: EMA 20 / 50 / 200, RSI 14, ATR 14, and average volume. Volume
deliberately ignores the currently forming candle — it is an accumulation, not
a level, and reading a half-finished bar makes every live analysis wrong.

### 2. Trade setup

- **Entry** is the nearest support zone below price — not the current price.
  The tool does not say "buy now"; it says where the trade makes sense.
- **Stop loss** sits below whichever is lower, the zone floor or the most
  recent swing low beneath it, plus 0.5 ATR of breathing room. It marks the
  level that would prove the idea wrong, not a round percentage.
- **Take profit** targets are structural — the near edge of a resistance zone,
  or a prior significant high — capped at 8R so a cycle high months away does
  not get listed as a target.
- **Risk/reward** is measured to TP2. TP1 is usually the nearest resistance and
  often sits under 1R; TP3 is the most speculative. TP2 is the level a trade is
  realistically managed toward.

### 3. Score

0–100 across six weighted categories, each with its own written reasoning:

| Category             | Weight |
| -------------------- | ------ |
| Trend                | 25     |
| Support / resistance | 25     |
| Volume               | 15     |
| Risk / reward        | 15     |
| RSI                  | 10     |
| EMA alignment        | 10     |

Grades: **strong** 75+, **moderate** 60–74, **weak** 45–59, **avoid** below 45.

The score is a measure of how much of the evidence agrees. It is not a
probability — a setup scoring 78 does not have a 78% chance of working.

### 4. Status

The rules are evaluated in a fixed order, and every disqualifying condition is
checked before `POTENTIAL_SETUP` becomes reachable at all.

| Status                    | Meaning                                                                                              | Levels shown |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ------------ |
| **Avoid for now**         | Bearish trend, bearish higher timeframe, risk/reward below 1:1, or a score under 45                  | **No**       |
| **High risk**             | Risk/reward below the 1:1.5 minimum, thin history, or price already inside resistance                | Yes          |
| **Wait for confirmation** | The level is valid but price has not arrived, the market is ranging, or the bounce is on thin volume | Yes          |
| **Potential setup**       | Nothing disqualifying found — a candidate to watch, not an instruction                               | Yes          |

Measured against all 45 live markets, `POTENTIAL_SETUP` came back on **0% of 1h
runs and 2% of 4h runs**. That distribution is the design working. If most
analyses start returning "potential setup", treat it as a bug.

### Multi-timeframe

With the higher-timeframe check enabled, the entry timeframe is read alongside
a higher one. Agreement feeds the trend score rather than becoming a seventh
category. A lower timeframe turning up inside a falling higher one is a
**counter-trend bounce** — the single most expensive mistake the tool exists to
prevent — and returns AVOID with no levels.

---

## What's in the app

| Section             | What it does                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Dashboard**       | The 45 curated markets with risk tags, and your saved analysis history                                         |
| **Market analysis** | Candlestick chart with EMA and S/R overlays, the market read, and the full trade setup                         |
| **Watchlist**       | Your own shortlist, toggleable on the chart                                                                    |
| **Backtest**        | Bar-by-bar replay of the same engine over history, with win rate, average realised R, total R and max drawdown |
| **Learn**           | 15 articles covering every concept the engine uses, linked contextually from each analysis field               |
| **Risk calculator** | Position size from balance, risk percentage, entry and stop                                                    |
| **Asset research**  | Per-asset detail plus an ethical checklist for all 45 assets (informational, not a fatwa)                      |
| **Settings**        | Default risk percentage and default timeframe                                                                  |

Timeframes: 1m, 5m, 15m, 1h, 4h, 1D, 1W — all derived from `TIMEFRAMES` and one
Zod schema in `lib/market-data/schema.ts`.

New here? Start at `/learn/getting-started`, which walks the whole loop.

---

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind with shadcn-style primitives ·
TradingView Lightweight Charts · TanStack Query · PostgreSQL + Prisma ·
Auth.js v5 (credentials only) · Upstash Redis for rate limiting · Vitest ·
Playwright.

Sessions are JWT rather than database sessions — a library constraint, since
Auth.js v5's Credentials provider does not support the database strategy. The
Prisma adapter is wired up, so adding OAuth later would allow switching without
a data-model change.

---

## Structure

```
app/                 routes (pages + API handlers)
components/          shared UI primitives, layout chrome, markdown renderer
features/
  analysis/          market read + trade setup panels
  backtesting/       backtest form and report
  learning/          learn index and article view
  market/            chart, selectors, live header
  risk-management/   position size calculator
  watchlist/  auth/  settings/
lib/
  analysis/          the engine — pure, deterministic, no I/O
    setup/           entry, stop, targets, risk/reward, score, status
    explain/         phrasing for every number the engine produces
    explanations/    structured, ordered Explanation[] built from a result
    confirmation/    the deterministic gate before POTENTIAL_SETUP
  setups/          setup identity + lifecycle planner (pure; services/ writes)
  indicators/        EMA, RSI, ATR, volume — pure math
  backtesting/       bar-by-bar replay + metrics
  market-data/       MarketDataProvider abstraction + Binance implementation
  ethics/            per-asset checklist
  learn/             article content, source of truth for the seed
  constants/         disclaimer text, version-stamped
  api/  auth/  db/  test-utils/
services/            DB-backed services (markets, candles, snapshots, backtests, learn)
types/               shared API/response types
prisma/              schema + migrations + seed
e2e/                 Playwright specs
```

---

## Getting started

```bash
cp .env.example .env
npm install
npm run dev
```

The app runs **without a database**: the curated asset list is read from
`lib/market-data/curated-assets.ts` and candles come straight from the provider.
Analysis, charts and the risk calculator all work in this mode.

To run with Postgres — which enables the candle cache, accounts, watchlist,
settings, saved analysis history and backtesting:

```bash
docker compose up -d        # or point DATABASE_URL at a hosted Postgres
npm run prisma:migrate
npm run prisma:seed         # 45 assets, 45 pairs, ethical checklists, 15 articles
```

The seed is idempotent — re-run it after editing `curated-assets.ts`,
`lib/ethics/checklist.ts` or `lib/learn/articles.ts`.

If `DATABASE_URL` is set but Postgres is not running, the app logs one warning
and falls back to the file-based list rather than failing.

### Neon

Set both `DATABASE_URL` (pooled) and `DIRECT_URL` (unpooled). Prisma migrations
take advisory locks that a transaction-mode pooler cannot hold. Apply the
schema with `npx prisma migrate deploy`.

### Environment

| Variable                            | Required       | Purpose                                        |
| ----------------------------------- | -------------- | ---------------------------------------------- |
| `DATABASE_URL`                      | for DB mode    | Pooled Postgres connection                     |
| `DIRECT_URL`                        | for migrations | Unpooled connection                            |
| `AUTH_SECRET`                       | in production  | Session signing                                |
| `NEXTAUTH_URL`                      | yes            | Callback base URL                              |
| `BINANCE_API_BASE_URL`              | no             | Defaults to the public REST endpoint           |
| `NEXT_PUBLIC_BINANCE_WS_BASE_URL`   | no             | Realtime price stream                          |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | no             | Shared rate limiting; falls back to in-process |

Production refuses to start without `AUTH_SECRET` and a non-localhost
`DATABASE_URL` — see `lib/env.ts`.

---

## Testing

```bash
npm run test        # 379 Vitest unit tests — the analysis math is the priority surface
npm run e2e         # Playwright: a smoke suite and the full signed-in journey (port 3100)
npm run lint
npm run typecheck
```

CI runs lint, typecheck and the unit tests on every push. E2E is manual — it
drives the live exchange API, which is unreachable from GitHub's US-based
runners, so run it locally or trigger it from the Actions tab.

**Stop `npm run dev` before running E2E.** Next 16 refuses to start a second
dev server in the same directory, and `npm run e2e` starts its own on 3100.
Alternatively run the suite against a production build, which is what CI does
and what the signed-in journey needs:

```bash
npm run build
CI=1 AUTH_TRUST_HOST=true NEXTAUTH_URL=http://127.0.0.1:3100 npm run e2e
```

`AUTH_TRUST_HOST` is required because Auth.js only trusts the host in
`NEXTAUTH_URL` when running a production build; without it sign-in returns
"There is a problem with the server configuration" and the journey spec fails
while every other spec passes.

The engine's tests are written as behaviour, not arithmetic: a failure says
"it offered a long in a downtrend", not "expected 1.42 to be 1.41". The
backtester has a test proving it cannot see the future, because look-ahead bias
is what makes most published backtests meaningless.

**Fixtures are all closed candles.** Several real bugs have only appeared
against live data — verify changes against the running app, not only the suite.

---

## Tuning constants

| Constant                                   | Value                                                                |
| ------------------------------------------ | -------------------------------------------------------------------- |
| Warmup before the engine will read a chart | ~260 candles                                                         |
| Absolute minimum candles for a read        | 60                                                                   |
| Backtest ceiling per run                   | 1000 candles                                                         |
| Minimum acceptable risk/reward             | 1:1.5                                                                |
| Stop buffer below the invalidation level   | 0.5 ATR                                                              |
| Maximum target distance                    | 8R                                                                   |
| Rate limits                                | analysis 30/min · backtest 5/min · market data 120/min · signup 5/hr |

Backtests run **synchronously**, which the 1000-candle ceiling is what makes
safe. Raising the cap is the point at which async job processing becomes
necessary.

---

## Deployment

The intended host is **Vercel** — Next.js-native, and the app is designed
around serverless routes. Point it at a Neon database, set the environment
variables above, then apply migrations and seed:

```bash
npx prisma migrate deploy
npm run prisma:seed
```

A Dockerfile and compose file are included as a self-host escape hatch, not the
primary path:

```bash
docker compose --profile app up --build   # app + Postgres
```

The image builds from the Next.js standalone output and runs as a non-root
user.

Security posture — rate limiting, headers, Zod validation at every boundary,
boot-time env validation, and the outstanding Next.js advisories — is
documented in [SECURITY.md](SECURITY.md).

---

## Troubleshooting

### `npm ci` fails with `EUSAGE ... Missing: @emnapi/core from lock file`

`eslint-config-next` pulls in `@unrs/resolver-binding-wasm32-wasi`, whose own
dependencies npm does not record in the lockfile when it skips that package on
the current platform. The tree is then complete for the machine that ran
`npm install` and incomplete for CI.

The `@emnapi/*` packages are therefore listed as explicit devDependencies. They
are not imported anywhere — they exist so npm always writes them to the
lockfile. Do not remove them without checking that `npm ci` still passes on
Linux.

`npm ci --dry-run --os=linux --cpu=x64` does **not** reliably catch this: it
reuses the existing tree rather than fully re-resolving. The only real check is
CI itself.

### Every 404 renders as "200 Page not found"

Do not add `loading.tsx` at the app root. It wraps every page in Suspense, the
response streams, and its 200 is sent before `notFound()` can run. Keep loading
boundaries below routes that can 404.

---

## Status

**All eight phases are shipped and merged.** The engine, the full setup
calculator, accounts and watchlist, multi-timeframe analysis, the learning
section, backtesting, and the hardening pass are all complete and verified
against live market data.

Deliberately **not** built, each by explicit decision for a single-user app:
Stripe billing and plan gating, Sentry, uptime monitoring, staging
environments, an admin interface, Google OAuth, password reset, and QStash
async jobs. The schema keeps the fields these would need (`Subscription`,
`AdminAuditLog`, the backtest status enum), so any of them can be added later
without a migration.

Nothing has been deployed yet. See `TODO.md` for what remains, `PRD.md` for the
product specification, `ARCHITECTURE.md` for the design, `SECURITY.md` for the
security posture, and `CLAUDE.md` for the working notes that keep a new session
oriented.
