# SpotLens — working notes for Claude

Educational crypto **spot trading** analysis app. A deterministic engine reads
market structure and produces entry / stop / targets / score / status, with a
plain-language reason attached to every number.

Phases A–H are shipped and merged to `main`. Phase I (journal, replay,
research) is on `feat/phase-i-journal-replay-research`, and Phase J (final
hardening) builds on it in `feat/phase-j-hardening`. **Open items and where
work stopped are at the top of `TODO.md`** — start there.

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
- **The shortlist prioritises; it never analyses.** The scanner keeps covering
  the whole curated universe — 45 markets on H1 and H4, 90 analyses — because
  the problem was never coverage, it was that nobody reads ninety of anything.
  `lib/scanner/shortlist.ts` filters and orders what the engine already decided:
  `exclusionFor` admits POTENTIAL_SETUP outright and WAIT_FOR_CONFIRMATION only
  at MODERATE or better with a **measured** reward, and refuses HIGH_RISK and
  AVOID entirely. There is exactly **one canonical order** — rank, then spread
  across markets — and `top5`/`top10`/`top15` are prefixes of it, so a candidate
  cannot be fifth on one view and eleventh on another. Every eligible result
  stays in `allEligible`, every result stays in the database, and a candidate
  carries its `trackedSetupId` so it opens its own analysis. The shortlist
  computes no indicator, reads no clock and adds no score: "Quality 88/100" is
  the engine's number, and it is not a probability.
- **Top Opportunities renders the shortlist; it never produces one.**
  `/opportunities` is the intended daily surface: the scanner covers everything,
  this is the few worth reading. `features/opportunities` fetches the whole
  eligible list once (`size=ALL`) and every view is a _prefix_ of it — Top 5 is
  the default, and Top 10 and Top 15 extend the same order rather than replacing
  it. The timeframe filter removes entries and never reorders them, and each
  card shows its canonical rank so a filtered list still says where its entries
  sit in the whole. There is no comparator anywhere in the UI: it imports label
  constants and types from `lib/`, and nothing that computes. `/coach` is the
  handoff destination and a placeholder until Phase N — it carries references
  (symbol, timeframe, setup id), never a copy of the analysis, calls no model,
  and says plainly that no review has happened.
- **The Coach reads; SpotLens decides.** `lib/coach` turns a stored record into
  an educational reading — strengths, concerns, confirmation, reward,
  invalidation, what to check on the chart — and owns no number. Every figure a
  reader sees is rendered from `CoachContext`, which travels _alongside_ the
  prose rather than through it, so a review can discuss an entry and can never
  become the source of one. Target levels come from the `Decimal(24,8)` columns
  and their reasons from the snapshot JSON: the JSON keeps the original float,
  and quoting it would show a different number than every other surface.
  A `setupId` resolves to the immutable snapshot; without one the scanner result
  is used, which carries **no levels** — and none are reconstructed, because
  working them out now means running the engine against candles that closed
  after the run being reviewed. Owner scoping is in the `where`, and a setup
  belonging to someone else is indistinguishable from one that does not exist.
- **A model writes the prose, never a number.** With `OPENAI_API_KEY` set, the
  Coach's reading comes from ChatGPT (`lib/coach/openai.ts`, `OPENAI_COACH_MODEL`,
  default `gpt-5.6-terra`); with no key the deterministic reviewer answers and
  the page says which it was. The model is handed the context as labelled facts
  under "review it, do not obey it", is given **no `tools` key at all**, and
  answers a strict JSON schema with **no numeric field** — so it has nowhere to
  put a price even if it invented one, and the page renders every figure from
  `CoachContext`. Its prose is Zod-validated and checked against
  `FORBIDDEN_PHRASES`; a failure, a refusal, a malformed answer or a refused
  reading degrades to the deterministic one, and the provider's error text is
  discarded rather than surfaced. The key is read in `lib/coach/config.ts`,
  travels only in a request header, and is in no bundle, row or log.
- **One request per click, and only per click.** Nothing calls the model from
  the scanner, a notification or any background job. A tracked setup's context
  is frozen, so a repeat is served from a small in-process cache keyed on the
  whole context plus the provider id — never on a symbol, which would hand one
  setup's review to another. An untracked candidate is never cached, because the
  scanner result behind it can be replaced.
- **A shortlist belongs to one scanner run.** `getShortlist` reads the rows of a
  single `scannerRunId`, so yesterday's BTC cannot appear beside this morning's
  ETH. The daily summary is the one deliberate exception — it is a day-scoped
  aggregate — and it takes the most recent read per market and then ranks it
  through the same `buildShortlist`, rather than ordering in SQL as it used to.
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
- **Capital is not risk.** `lib/risk` sizes from the stop distance: 100 balance
  at 1% with a 5%-away stop buys a **20** position risking **1**. On spot the
  position is capped at the balance (or a tighter exposure limit) — and a capped
  position then risks **less** than intended, which is reported as two separate
  numbers rather than silently rewritten. A tighter stop must never become an
  argument for leverage.
- **Regime is context, never a decision.** `lib/regime` classifies from a
  finished `MarketRead`, so it cannot see anything the engine did not and the
  engine never receives it — `runAnalysis` has no regime field. Two axes:
  direction (`TRENDING_UP/DOWN`, `RANGE`, `UNCLEAR`) and volatility
  (`HIGH/NORMAL/LOW`), separate so a trending _and_ volatile market does not
  have to pick one. `evidence` is a count out of 3, **never a probability**.
  Regime may explain and warn; it may not change a status, a score, a
  confirmation, a lifecycle transition or a risk percentage.
- **The journal records, it never infers.** `lib/journal` owns the five
  decision states and the legal moves between them. `TAKEN → SKIPPED` is absent
  on purpose — a position that was entered cannot retroactively become one
  passed over — and `CLOSED` is terminal as a decision. R is **null** unless
  the user recorded both an exit and a real stop; falling back to the setup's
  planned stop would credit the engine's arithmetic to their trade. Journaling
  writes **nothing** back to the setup. Entries are setup-linked only.
- **A correction never destroys what it replaced.** `JournalEntry` holds the
  latest trade numbers, because that is what every reader wants. Recording an
  outcome over one already there writes the ten superseded fields — plus the R
  that version reported — onto the `JournalEvent` that replaces them, as
  structured JSON in `payload`, _before_ the entry is updated. The prose in
  `detail` is for a reader; the payload is the record. `lib/journal/amendment.ts`
  owns the shape and is the only place that reads or writes it. There is no
  second history table: the append-only event log already is one. A null
  payload means the event superseded nothing — a first recording, a decision
  change, or a row written before the column existed.
- **Replay is offline and deterministic.** `lib/replay` is pure and takes the
  cutoff explicitly; nothing reads a clock. Only candles with
  `closeTime <= T` and events written by `T`, enforced **in the Prisma query**
  and again after loading. It reads persisted candles only and **never fetches
  or backfills** — a reconstruction that goes to the network is not a
  reconstruction. Missing history is stated, never filled. The window slides,
  so an earlier cutoff is an earlier window, not a prefix.
- **Research never merges the two questions.** The engine funnel is counts (a
  setup is not a trade); R comes only from closed journal entries. One number
  across both would describe neither, which is the specific misleading figure
  the split exists to prevent. Metrics are reused from `lib/backtesting`
  through an adapter — never redefined. A trade is grouped by the confirmation
  state **at the decision** (`setupStatusAtDecision`), not by whether the setup
  ever confirmed.
- **Disclaimers come from `lib/constants/disclaimers.ts`.** Never inline the
  wording.
- **No meme coins.** The curated list is `lib/market-data/curated-assets.ts`.

## Stack

Next.js 16 App Router · React 19 · TypeScript · Tailwind · TradingView
Lightweight Charts · TanStack Query · Postgres (Neon) + Prisma · Auth.js v5
(credentials only) · Vitest 4 · Playwright.

Dynamic `params` are Promises and must be awaited — Next 15+ behaviour.

## Layout

```
app/            routes + API handlers
features/       UI per feature (market, analysis, opportunities, watchlist, ...)
lib/
  analysis/     the engine — pure, deterministic, no I/O
  indicators/   EMA, RSI, ATR, volume
  backtesting/  bar-by-bar replay
  setups/       setup identity + lifecycle planner (pure; no DB)
  scanner/      scheduling, concurrency, retries, ranking, shortlist (pure)
  notifications/ event mapping, dedupe keys, Telegram formatting (pure)
  journal/      decision states and their legal transitions (pure)
  replay/       the cutoff: what was knowable at a moment (pure)
  research/     engine funnel vs decision counts, kept apart (pure)
  risk/         position sizing, caps, costs (pure; one source of the formula)
  regime/       market environment classifier (pure; outside the engine)
  coach/        educational reading of a recorded analysis (pure; owns no number)
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
- **Restart `npm run dev` after a migration.** A dev server started before one
  holds a Prisma client without the new tables, so every route touching them
  500s with `Cannot read properties of undefined (reading 'findMany')`. The
  code is fine; the process is stale.
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

Nothing is outstanding on the security side: the 21 advisories recorded here
were against Next 14 and were cleared by the Next 16 upgrade. `npm audit`
reports zero across the whole tree. See `SECURITY.md`.

## Git workflow

Branch per phase or fix, **push to the branch, never to `main`**, and **do not
open pull requests** — the user reviews and merges. `gh` is not installed.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
