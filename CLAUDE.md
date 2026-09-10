# SpotLens — working notes for Claude

Educational crypto **spot trading** analysis app. A deterministic engine reads
market structure and produces entry / stop / targets / score / status, with a
plain-language reason attached to every number.

All eight phases are shipped and merged to `main`. **Open items and where work
stopped are at the top of `TODO.md`** — start there.

Full spec in `PRD.md`, design in `ARCHITECTURE.md`, security posture in
`SECURITY.md`. Read those only when the task needs them — this file is meant to
make that unnecessary most of the time.

## Product rules that are not negotiable

- **Spot only.** No futures, margin, leverage, or short selling. Every setup is
  a LONG. There is no code path that can place an order.
- **Never say "buy".** Every analysis ends on one of four statuses: Potential
  setup / Wait for confirmation / High risk / Avoid.
- **Prefer WAIT.** Status rules are ordered so every disqualifying condition is
  ruled out _before_ POTENTIAL_SETUP can be returned. If most analyses start
  returning "potential setup", that is a bug.
- **Confirmation is the last gate, and only a gate.** `lib/analysis/confirmation`
  runs after every other rule, so it can hold a setup at WAIT and nothing else —
  it cannot promote past the counter-trend veto, an unmeasured reward, or a
  failing grade. It judges **closed candles only**. It adds no status and no
  score category. CONTRADICTED means opposing evidence (a primary signal fired
  negative); NOT_PRESENT means missing evidence. Thin volume is the latter — an
  absence cannot refute evidence that visibly happened.
- **AVOID shows no numbers.** No entry, stop or targets — handing over levels
  for a trade just advised against defeats the point.
- **Every number carries a reason.** The engine decides; `lib/analysis/explain`
  phrases it. AI never produces a number.
- **Explanations are structured, not prose stitched in components.**
  `lib/analysis/explanations` turns a finished `AnalysisResult` into an ordered
  `Explanation[]` (category, signal, title, detail). It is pure — it explains
  the score, it never computes one. UI renders that list; it must not re-derive
  strategy meaning. A label that describes a verdict (a status, an MTF
  classification) belongs in the engine, not in a component.
- **Setup identity is zone overlap, not equality.** `lib/setups` decides
  whether an analysis belongs to a setup already being tracked: same pair, same
  timeframe, and an entry zone that _overlaps_ the stored one. Zones are
  ATR-scaled and drift every candle, so keying on exact bounds would mint a new
  setup on every run. Re-running an unchanged analysis writes **nothing** —
  that is what stops the future scanner filling the table. INVALIDATED is
  terminal; a level that comes back is a new setup with a new id.
- **A stored setup's numbers never change.** `TrackedSetup`'s snapshot columns
  are written once. Later analysis moving the entry or the score is the market,
  not a correction — rewriting them would destroy the record of what was
  actually on offer. Lifecycle columns change, and every change appends a
  `SetupEvent`.
- **The scanner has no strategy of its own.** `services/scanner.ts` calls the
  same `runAnalysis` and the same `trackSetup` everything else does; all its
  rules (scheduling, retries, ranking, failure classes) are pure functions in
  `lib/scanner`. It reads **closed candles only** — the forming candle is
  dropped before the engine sees it, which is what makes a repeated scan
  idempotent. It knows nothing about notifications.
- **The notification layer consumes truth, it never re-derives it.**
  `lib/notifications` maps Phase D lifecycle events onto messages; Phase D
  decides whether a setup moved and Phase C decides what the market did.
  STRUCTURE_CHANGED fires only when the confirmation engine reports a
  `STRUCTURE_BREAK` or `RECLAIM` — a plain `SETUP_FORMING →
WAITING_CONFIRMATION` is price arriving somewhere, not structure changing,
  and says nothing. Dedupe is Phase D's `SetupEvent.id`, enforced by a unique
  index, so re-observing an unchanged setup cannot notify twice.
- **`TELEGRAM_BOT_TOKEN` is read in exactly one file**
  (`lib/notifications/telegram-provider.ts`) and never returned, logged, or
  stored. Errors are stripped of it before they reach a database row.
- **A backtest reports its own assumptions.** Fees, slippage, the entry policy
  and the same-candle stop/target policy travel on the report, because a result
  is uninterpretable without them. Fees are charged on both legs and **never
  change a decision** — trade count is identical with fees on or off; they only
  change what the trade was worth. Everything is measured in **R**; the
  backtester models no account and no position sizing, so a currency figure
  would be an invention.
- **Backtest history is paged.** `services/candle-history.ts` walks a range one
  exchange page at a time, drops the candle each page repeats, and stops rather
  than looping when a page makes no progress. `checkIntegrity` refuses
  duplicated or out-of-order candles outright and reports gaps without
  fabricating anything.
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
  setups/       setup identity + lifecycle planner (pure; no DB)
  scanner/      scheduling, concurrency, retries, ranking (pure; no I/O)
  notifications/ event mapping, dedupe keys, Telegram formatting (pure)
scripts/        the local scanner process (npm run scanner)
  market-data/  provider abstraction + Binance
services/       DB-backed services (markets, candles, snapshots, backtests)
```

## Commands

```bash
npm run dev                  # port 3000
npm run test                 # vitest — scope it: npx vitest run lib/analysis
npm run e2e                  # playwright, serves on 3100 (3000 is often taken)
npm run scanner              # local scanner: wakes after each candle close
npm run scanner:once         # one pass over the universe, then exit
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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
