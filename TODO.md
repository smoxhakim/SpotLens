# SpotLens Development Roadmap

**All eight phases are shipped and merged to `main`.** What follows is the
original roadmap with its outcomes; open items are collected here.

## Where we left off

- [x] Finish the manual walkthrough — done against live Binance data. Restraint
      census over all 45 markets: POTENTIAL_SETUP on 0% of 1h runs and 2% of 4h
      runs, which is the design working rather than failing. The
      risk/reward-below-1 AVOID rule fired on 4 real markets (APTUSDT 1h: bullish
      trend, 77/100, correctly refused with no levels), so that fix was load
      bearing and not theoretical. 1m/5m verified live — forming candle detected
      every time, volume read intact. 4h backtests run end to end on five
      markets. No level leaks anywhere.
- [x] Add a "Getting started" article to `/learn` — shipped as the 15th seeded
      article, under a new "Getting started" category that sorts first on the
      index. Covers the whole loop: settings, watchlist, running an analysis,
      reading the status before the numbers, sizing, and placing the order
      yourself.
- [x] Next 14 → 16 — done on `chore/upgrade-next-16`. React 19, ESLint 9 flat
      config, Vitest 4. `npm audit` now reports zero vulnerabilities in the
      production tree and across dev dependencies. SECURITY.md updated.
- [x] Phase A P0 correctness fixes — done on `fix/phase-a-correctness`:
      backtest warmup pre-roll, backtest/live MTF parity with no lookahead, and
      the synthetic-target risk/reward correction. See "Phase A" below.
- [ ] Deploy. Nothing has been deployed anywhere yet. Note that Docker is not
      the blocker it was written up as: ARCHITECTURE.md names Vercel as the
      host and the Dockerfile as a self-host escape hatch, so the deploy needs
      a Vercel project and a Neon database, not a local Docker install. The
      image has still never been built.
- [ ] Optional: tighten CSP off `unsafe-inline`/`unsafe-eval` via nonces.

## Phase A — correctness (done, awaiting review)

Branch `fix/phase-a-correctness`, on top of `chore/upgrade-next-16`.

- [x] **Backtest warmup.** The runner ate its 260-bar warmup out of the
      requested range, so a request for 300 H4 bars of BTCUSDT evaluated 39 of
      them — 13%. Pre-roll is now fetched from before the range and the report
      states `warmupBars`, `evaluatedBars` and `candlesUsed` separately. The
      same request now evaluates 299 of 300.
- [x] **Backtest/live MTF parity.** `runBacktest` never passed `mtf`, so the
      counter-trend veto that live multi-timeframe analysis applies did not
      exist in backtests. It now takes higher-timeframe candles and re-slices
      them per bar to `closeTime <= current closeTime`, so no forming
      higher-timeframe candle can reach a decision. Across five live markets
      the veto cut setups from 7/6/4/4/0 to 2/2/2/2/0.
- [x] **Synthetic-target R:R.** Risk/reward was measured to TP2 whatever it
      was, so a chart with no resistance above it reported the fallback
      ladder's own 1:2.5 and outranked setups with real levels. The ratio is
      now measured to a structural target at least 1R away; when none exists
      it is flagged `isSynthetic`, scored neutral rather than credited, and
      cannot reach POTENTIAL_SETUP.
- [x] **Supporting fix — blank optional env vars.** `UPSTASH_REDIS_REST_URL=`
      with an empty value parsed as present-but-invalid and stopped the
      production server booting outright, which blocked local E2E against a
      production build. Blanks are now treated as unset, which is what
      `.optional()` already implied.
- [x] Tests: 264 unit (was 237), including deliberate re-introduction of each
      defect to confirm the new tests catch it. 27 Playwright specs pass.

### Known limitation — backtest sample size

A run evaluates at most **740 candles**, because pre-roll (260) and the
evaluated range share a single 1000-candle exchange page. **Do not read a
backtest as a full historical evaluation**: on H4 that is about four months,
and on H1 about a month. It is a sample from the recent past, and a small one.
Deeper history needs pagination, which is deferred to Phase G by decision.

## Phase B — structured explanations (done, awaiting review)

Branch `feat/phase-b-structured-explanations`.

- [x] `lib/analysis/explanations/` — an `Explanation` model (id, category,
      signal, title, detail) and `buildExplanations(result)`, a pure function
      over a finished `AnalysisResult`. It computes nothing and reaches nothing.
- [x] Ten categories in a fixed order, ending on the verdict. A category with
      nothing to say is omitted rather than padded — there is no price-position
      entry when no entry zone exists.
- [x] Removed duplicated strategy wording from components: `TradeSetupPanel`
      held its own copy of the four status labels, and `MtfPanel` its own copy
      of the five MTF classification labels. Both now read the engine's
      (`STATUS_LABELS`, `MTF_AGREEMENT_LABELS`); the components keep only
      colour and icon.
- [x] Phase A's risk/reward rule is restated, not relaxed: an unmeasured reward
      is `negative`, never `neutral`, and the ratio now carries an "unmeasured"
      badge in the setup panel so a synthetic 1:2.5 cannot be read as a
      measured one.
- [x] 35 tests, including injected-defect checks for the synthetic signal and
      the ordering guarantee. 299 unit total, 27 E2E.

## Phase C — strict confirmation engine (done, awaiting review)

Branch `feat/phase-c-confirmation-engine`.

- [x] `lib/analysis/confirmation/` — five deterministic signals, each tri-state,
      judged on **closed candles only**. Called from `runAnalysis`, so the
      backtester and live analysis run the identical function.
- [x] Applied as the **last** gate in `determineStatus`, after every existing
      disqualifier. It can only hold a setup at WAIT; there is no path by which
      it promotes one past the counter-trend veto, an unmeasured reward, or a
      failing grade. No fifth status, no new score category.
- [x] The rule, stated once: any negative signal ⇒ CONTRADICTED; otherwise ≥1
      positive _primary_ signal **and** ≥2 positive signals total ⇒ PRESENT;
      else NOT_PRESENT. Volume is supporting-only and can never confirm alone.

### Effect on quality (700 bars × 45 markets, both timeframes)

Confirmation cut setup count by about two thirds and roughly doubled per-trade
expectancy on H1, with drawdown less than half what it was:

|              | H1 before | H1 after  | H4 before | H4 after  |
| ------------ | --------- | --------- | --------- | --------- |
| setups       | 146       | **51**    | 133       | **43**    |
| win rate     | 58.1%     | **75.0%** | 50.8%     | **53.3%** |
| avg R        | 0.252     | **0.481** | 0.030     | **0.086** |
| max drawdown | 4.9%      | **2.0%**  | 5.5%      | **4.7%**  |

Live census over all 45 curated markets was 0 POTENTIAL_SETUP on H1 and H4
both before and after — the live boundary was already at zero, which is why
the backtest is the measurement that says anything.

**H4 remains close to breakeven** (avg R 0.086). Confirmation improves it but
does not fix it, and that is worth knowing before H4 is trusted.

## Phase D — setup persistence + lifecycle (done, awaiting review)

Branch `feat/phase-d-setup-lifecycle`.

- [x] `lib/setups/` — a **pure** planner. Given the stored setup and a finished
      `AnalysisResult` it returns NONE / CREATE / TRANSITION / REPLACE.
      `services/setups.ts` executes it and is the only thing that writes, so
      `lib/analysis` stays free of I/O and every rule is testable without a
      database.
- [x] **Identity:** (user, pair, timeframe) + an entry zone that _overlaps_ the
      stored origin. Overlap rather than equality because zones are ATR-scaled
      and drift each candle — exact bounds, or a rounded bucket, would mint a
      new setup almost every run. Consequence, stated openly: a zone drifting
      over many candles stays one setup, because each step overlapped the last.
- [x] **Deduplication:** an unchanged analysis writes **nothing at all** — no
      row update, no event. Verified against the real database: 10 identical
      runs produced 1 setup and 1 event.
- [x] **Lifecycle:** SETUP_FORMING → WAITING_CONFIRMATION →
      CONFIRMATION_DETECTED → POTENTIAL_SETUP → INVALIDATED. Regressions are
      allowed (confirmation is evidence about the last closed candle and can
      lapse); INVALIDATED is terminal, so a level that returns is a new setup
      with its own id and history.
- [x] **Immutable snapshot:** `TrackedSetup` splits columns written once at
      creation from lifecycle columns that change. `applyTransition` never
      names a snapshot column. `confirmedAt` is stamped only when still null,
      so a setup that loses and regains confirmation keeps the first time.
- [x] **Invalidation** — supported conditions, all deterministic and all
      already computed by the engine: confirmation CONTRADICTED (which includes
      support lost and structure broken downward), the engine no longer
      offering a setup at all (AVOID), and the entry re-anchoring to a
      different zone. **No time-based expiry** — the engine defines none, and
      inventing one would be a strategy change.
- [x] **API:** `GET /api/setups`, `GET /api/setups/:id`. Read-only — setups are
      created by the lifecycle, never by a client. Zod-validated, owner-scoped
      at the query, 404 rather than 403 for another account's row.
- [x] Migration `20260910145846_add_setup_lifecycle` — purely additive (2
      enums, 2 tables, 3 indexes, 3 FKs; no ALTER or DROP on anything
      existing). Applied locally; every pre-existing row count unchanged.

Phase E's scanner can call `trackSetup` after `runAnalysis` without changing
this model.

## Phase E — local autonomous scanner (done, awaiting review)

Branch `feat/phase-e-scanner`.

- [x] `scripts/scanner.ts` — a plain local Node process. `npm run scanner`
      schedules; `npm run scanner:once` runs one pass. No queue, no cron
      service, no worker: on a single machine none of them would make the
      result more correct.
- [x] **Candle-close driven, not polled.** Wakes 90s after each close, groups
      timeframes closing at the same instant into one pass (an H4 close is also
      an H1 close). Configurable via `SCANNER_CLOSE_DELAY_MS`.
- [x] **Closed candles only.** The forming candle is dropped before the engine
      sees anything — so a wick that has not finished forming can never trigger
      a transition, and a scan repeated inside the same candle sees identical
      input.
- [x] **One strategy.** Calls the same `runAnalysis`, confirmation engine,
      setup lifecycle and market-data layer as everything else. No scanner
      analysis engine, no second exchange client.
- [x] All decision logic pure in `lib/scanner` (scheduling, concurrency,
      retries, failure classes, ranking, events); `services/scanner.ts` does
      the I/O and owns no rules.
- [x] Bounded concurrency (default 4), retries only for faults the provider
      calls transient (max 3 attempts), per-market isolation, sanitised failure
      categories that never store a URL, connection string or token.
- [x] **Ranking:** status → quality score → measured R:R (an unmeasured one
      counts as zero, per Phase A) → symbol as a stable tie-breaker.
- [x] No-trade outcomes are counted and displayed. A pass where 45 markets say
      avoid is the engine working.

### Verified against live Binance data

|                      | first pass (cold cache) | warm passes         |
| -------------------- | ----------------------- | ------------------- |
| markets × timeframes | 45 × 2 = 90             | 90                  |
| succeeded / failed   | 90 / 0                  | 90 / 0              |
| duration             | 36.4s                   | ~12s                |
| candle requests      | ~180                    | ~180 (cache-served) |
| rate-limit responses | none                    | none                |

**Idempotency** — two consecutive scans on a warm cache: _"nothing changed
since the last pass"_ both times, setups 20 → 20 → 20, events 21 → 21 → 21.
Zero writes.

## Phase F — notifications and Telegram (done, awaiting review)

Branch `feat/phase-f-notifications`.

- [x] `lib/notifications/` (pure: mapping, dedupe keys, MarkdownV2 formatting)
      and `services/notifications.ts` (delivery, preferences, persistence).
      The scanner emits events and knows nothing about Telegram;
      `scripts/scanner.ts` is the composition root that joins them.
- [x] Six event types, every one derived from a Phase D `SetupEvent` or a
      finished scanner run. **No second state machine.**
- [x] **STRUCTURE_CHANGED only when structure actually changed.** It fires on a
      confirmation-engine `STRUCTURE_BREAK` or `RECLAIM`, not on any lifecycle
      transition. A plain `SETUP_FORMING → WAITING_CONFIRMATION` is price
      arriving at a level already identified, and says nothing.
- [x] **Dedupe is Phase D's `SetupEvent.id`**, enforced by a unique index on
      `(userId, channel, dedupeKey)` — the index is the guard, not a
      check-then-write, so two passes racing cannot both insert.
- [x] Telegram: one-time code hashed at rest, ten-minute expiry, burned after
      ten claim attempts, bound to the requesting session. `getUpdates`
      polling, no webhook — a local machine should not be exposed to receive a
      message the user is about to send.
- [x] Token read in exactly one file; never returned, logged, stored, and
      stripped from provider errors before they reach a row.
- [x] Conservative defaults: confirmations, invalidations and scanner errors
      on; potential setups, structure changes and daily summary off.

### Verified live

One real scan produced **10 notifications from 24 lifecycle events** — the
filtering working, not a bug: 4 confirmations + 6 invalidations delivered,
setups created at forming/waiting silent. Two further scans added **zero**
duplicates. A simulated Telegram outage returned in 774ms without throwing:
in-app `SENT`, Telegram `FAILED` with a sanitised error, no token stored, and
the 401 correctly not retried.

**Fixed during verification:** replacement invalidations were being dropped.
Phase E reports those with no setup id (the lifecycle returns the _new_ setup's),
so six real "the level you were waiting on is gone" events went unreported.
Resolved inside Phase F by looking the setup up from stored truth — no Phase A–E
file was changed.

Next up, once reviewed: **Phase G — advanced backtesting.**

## Phase 1 — Chart Foundation ✅

- [x] Repo scaffold, lint/test/CI
- [x] Prisma schema + seed 45 curated assets
- [x] MarketDataProvider interface + BinanceProvider (retry/backoff, typed errors)
- [x] Candle cache service + candles/ticker/markets API routes
- [x] Asset/pair/timeframe selector + candlestick chart + live header (WS + polling fallback)
- [x] Dashboard shell with sidebar nav + stub pages
- [x] Loading/error states + smoke E2E

## Phase 2 — Technical Analysis Engine v1 ✅

- [x] Indicator library (EMA 20/50/200, RSI 14, ATR 14, avg volume) + fixture tests
- [x] Swing-point detection (HH/HL/LH/LL) + trend classifier
- [x] Support/resistance zone clustering — ATR-scaled zones, never single lines
- [x] Volume analysis (breakout strength, increasing/decreasing)
- [x] Chart overlay toggles (EMA, S/R)
- [x] Market Read panel with a reason behind every field
- [x] Unit test suite for indicators/structure

## Phase 3 — Trade Setup Engine ✅

- [x] Entry zone calculator + confirmation checklist
- [x] Structure-based stop-loss calculator
- [x] Multi-target take-profit calculator (structural, capped at 8R)
- [x] Risk/reward calculator + poor-R:R flagging
- [x] Setup Score (0-100) + the PRD's category breakdown
- [x] Trade status engine (Potential/Wait/HighRisk/Avoid)
- [x] /api/analysis/run end-to-end + result panel with "Why?" on every field
- [x] Unit tests incl. deliberately poor setups

## Phase 4 — Accounts, Risk Management & Watchlist ✅

- [x] Auth.js (Credentials only — Google OAuth skipped, single-user app)
- [x] Watchlist CRUD + sidebar + chart toggle
- [x] Position size calculator (page + API)
- [x] Persisted AnalysisSnapshot + history on the dashboard
- [x] Settings page (default risk %, default timeframe)
- [x] plan/Subscription in the schema; billing intentionally not wired

Notes:

- Sessions are JWT, not database sessions: Auth.js v5's Credentials provider
  does not support the database strategy.
- Password reset needs a transactional email service. Skipped.

## Phase 5 — Multi-Timeframe Analysis ✅

- [x] MTF trend/structure detection
- [x] MTF summary panel showing both timeframes
- [x] Conflict warning — a counter-trend bounce returns AVOID with no levels
- [x] MTF agreement folded into the trend score category, not just displayed
- [x] "Check higher trend" toggle + /api/analysis/mtf

## Phase 6 — Learning Mode & Asset Research

- [x] LearnArticle model + 14 seeded articles
- [x] Learn section UI (index + article view)
- [x] Contextual "Learn more" links from every analysis field
- [x] Per-asset research page
- [x] EthicalChecklist for all 45 assets + UI + non-fatwa disclaimer
- [~] Admin interface + AdminAuditLog — deliberately skipped for a single-user
  app. Editing lib/market-data/curated-assets.ts or lib/ethics/checklist.ts
  and running `npm run prisma:seed` already covers it, and the seed is
  idempotent. AdminAuditLog and the ADMIN role stay in the schema so this
  can be added later without a migration.

## Phase 7 — Backtesting ✅

- [x] BacktestRun/BacktestSetup schema + historical storage (reuses the candle cache)
- [x] Bar-by-bar replay runner, with look-ahead bias proven by test
- [~] Async job wiring (QStash + cron) — deliberately skipped. Runs execute
  synchronously with a 1000-candle ceiling, which is what keeps that safe.
  The QUEUED/RUNNING/COMPLETED/FAILED status field stays in the schema, so
  the async path can be added later without a migration. Raising the cap is
  the point at which it becomes necessary.
- [x] Metrics: win rate, avg realised R, total R, max drawdown, best/worst
- [x] Backtest report UI + disclaimer above the tool, not only on the report

Notes:

- "Backtest" is a seventh sidebar entry, beyond the PRD's six. It is a full
  workflow with its own page rather than a panel, and burying it would be worse
  than the extra entry.
- On a daily timeframe the 260-candle warmup consumes most of a year's range,
  so few setups trigger. Lower timeframes give the replay more bars to work
  with.

## Phase 8 — Hardening & Launch ✅

- [x] Test pass: 219 unit tests, 25 E2E including the full signed-in journey
- [x] Security pass: rate limiting, Zod audit, security headers, boot-time env
      validation, dependency scan — see SECURITY.md
- [x] Performance pass: market list memoised off the hot path; DB indexes
      reviewed (already covered by the schema)
- [x] Realtime reconnect/backoff — shipped in Phase 1, verified here
- [~] Stripe billing + plan gating — skipped, single-user app
- [x] Docker packaging (image not built: Docker is not installed on this
      machine) + CI already in place
- [~] Sentry + uptime + usage dashboards — skipped, single-user app

Outstanding, needs a decision:

- [x] 21 high-severity Next.js advisories — cleared by the Next 16 upgrade.
      `npm audit` reports zero across the whole tree. See SECURITY.md.
- [ ] CSP still allows `unsafe-inline`/`unsafe-eval`; tightening needs
      nonce-based CSP via middleware.
