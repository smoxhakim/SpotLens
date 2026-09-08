# SpotLens Development Roadmap

**All eight phases are shipped and merged to `main`.** What follows is the
original roadmap with its outcomes; open items are collected here.

## Where we left off

- [ ] Finish the manual walkthrough — the restraint test (find markets it
      refuses) and a 4h backtest are the two worth doing.
- [ ] Add a "Getting started" article to `/learn`. Offered, not built: how to
      actually use the app from zero, which is the one thing the Learn section
      is missing.
- [ ] Decide on Next 14 → 16 (21 advisories — see SECURITY.md).
- [ ] Deploy. Nothing has been deployed anywhere yet; the Docker image has
      never been built, because Docker is not installed on the dev machine.
- [ ] Optional: tighten CSP off `unsafe-inline`/`unsafe-eval` via nonces.

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

- [ ] 21 high-severity Next.js advisories, fixable only by upgrading Next 14 →
      16 (two majors, and ARCHITECTURE.md pins 14). Most do not apply to this
      app. See the "Outstanding" section of SECURITY.md.
- [ ] CSP still allows `unsafe-inline`/`unsafe-eval`; tightening needs
      nonce-based CSP via middleware.
