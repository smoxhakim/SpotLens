# SpotLens Development Roadmap

## Phase 1 — Chart Foundation ✅

- [x] Repo scaffold, lint/test/CI
- [x] Prisma schema + seed 45 curated assets
- [x] MarketDataProvider interface + BinanceProvider (retry/backoff, typed errors)
- [x] Candle cache service + candles/ticker/markets API routes
- [x] Asset/pair/timeframe selector + candlestick chart + live header (WS + polling fallback)
- [x] Dashboard shell with sidebar nav + stub pages
- [x] Loading/error states + smoke E2E

Deferred to Phase 8 (tracked, not forgotten):

- [ ] `npm audit`: remaining advisories need Next 15+/glob 11 majors — revisit in the hardening pass

## Phase 2 — Technical Analysis Engine v1

- [ ] Indicator library (EMA20/50/200, RSI14, avg volume) + fixture tests
- [ ] Swing-point detection + trend classifier
- [ ] Support/resistance zone clustering
- [ ] Volume analysis (breakout strength)
- [ ] Chart overlay toggles (EMA, S/R)
- [ ] Market Read panel with reasons
- [ ] Unit test suite for indicators/structure

## Phase 3 — Trade Setup Engine

- [ ] Entry zone calculator + confirmation checklist
- [ ] Structure-based stop-loss calculator
- [ ] Multi-target take-profit calculator
- [ ] Risk/reward calculator + poor-R:R flagging
- [ ] Setup Score (0-100) + breakdown
- [ ] Trade status engine (Potential/Wait/HighRisk/Avoid)
- [ ] /api/analysis/run end-to-end + result panel UI
- [ ] Unit tests incl. deliberately poor setups

## Phase 4 — Accounts, Risk Management & Watchlist

- [ ] NextAuth (Credentials + Google)
- [ ] Watchlist CRUD + sidebar
- [ ] Position size calculator
- [ ] Persisted AnalysisSnapshot + history view
- [ ] Settings page
- [ ] plan/Subscription scaffolding

## Phase 5 — Multi-Timeframe Analysis

- [ ] MTF trend/structure detection
- [ ] MTF summary panel
- [ ] Conflict warning banner
- [ ] Fold MTF agreement into score/status
- [ ] Timeframe-pair selector + /api/analysis/mtf

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

## Phase 8 — Hardening & Launch

- [ ] Full test coverage (unit/integration/E2E)
- [ ] Security pass (rate limiting, zod audit, secrets)
- [ ] Performance pass (caching, indexing, chart rendering)
- [ ] Realtime reconnect/backoff hardening
- [ ] Stripe billing + plan gating
- [ ] Docker packaging + CI/CD
- [ ] Sentry + uptime + usage dashboards
