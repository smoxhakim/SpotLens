# Architecture: SpotLens

## Recommended stack

- **Framework:** Next.js 16 (App Router) + TypeScript — one codebase for UI, API routes, and server logic; matches PRD requirement directly. Upgraded from 14 to clear the advisories against that line; the App Router structure is unchanged, and dynamic `params` are awaited as Next 15+ requires.
- **Styling/UI:** Tailwind CSS + shadcn/ui — fast to build a professional dashboard solo, no design system to maintain.
- **Charts:** TradingView Lightweight Charts — purpose-built for candlesticks/overlays, free, lightweight.
- **Data fetching/cache (client):** TanStack Query — handles polling, retries, cache invalidation for market data.
- **Database:** PostgreSQL, hosted on Neon (serverless Postgres, branching for staging, zero ops).
- **ORM:** Prisma — type-safe schema, migrations, matches PRD.
- **Auth:** Auth.js (NextAuth) v5, Prisma adapter, database sessions (revocable), Credentials + Google OAuth.
- **Validation:** Zod on every API route input/output boundary.
- **Realtime prices:** Browser connects directly to exchange public WebSocket (Binance) for ticker/candle streaming — no server-side WS relay needed, keeps infra boring.
- **Rate limiting & queue:** Upstash Redis + `@upstash/ratelimit` for API rate limiting; Upstash QStash for async/long-running jobs (backtests, candle backfills) since Vercel functions are stateless/time-limited.
- **Background/scheduled work:** Vercel Cron hitting internal `/api/cron/*` routes (candle refresh, queued backtest processing).
- **Testing:** Vitest for unit tests (analysis engine math is the highest-risk code), Playwright for E2E, `@testing-library/react` for components.
- **Billing (Phase 8):** Stripe Checkout + Billing Portal + webhooks.
- **Monitoring:** Sentry (errors), UptimeRobot (uptime), Vercel Analytics (basic usage).
- **Email:** Resend (verification, password reset, backtest-complete notification).
- **Hosting:** Vercel (Next.js-native, near-zero ops). Dockerfile + docker-compose provided for local dev parity and as a self-host escape hatch (satisfies "Docker-ready" without adding ops burden day-to-day).

## Data model

All tables via Prisma. Enums noted inline.

**User**

- id (uuid, pk), email (unique), passwordHash (nullable — null if OAuth-only), name, image
- role: enum `USER | ADMIN` (default USER)
- plan: enum `FREE | PRO` (default FREE) — scaffolded in Phase 4, used by Stripe in Phase 8
- defaultRiskPercent (decimal, default 1.0), defaultTimeframe (enum Timeframe, default `ONE_HOUR`)
- acceptedTermsAt (datetime nullable)
- createdAt, updatedAt
- relations: Account[], Session[], Watchlist[], AnalysisSnapshot[], BacktestRun[], Subscription (1:1)

**Account / Session / VerificationToken** — standard NextAuth Prisma adapter tables (unchanged shape).

**Asset**

- id (uuid, pk), symbol (unique, e.g. "BTC"), name, category: enum `LAYER1 | LAYER2 | INFRASTRUCTURE | ORACLE | DEFI_INFRASTRUCTURE | PAYMENTS | OTHER`
- officialWebsite, description (text), utilityExplanation (text)
- riskLevel: enum `LOW | MEDIUM | HIGH`
- isActive (bool, default true) — whitelist toggle
- createdAt, updatedAt
- relations: TradingPair[], EthicalChecklist (1:1)

**TradingPair**

- id (uuid, pk), assetId (fk → Asset), quoteCurrency (e.g. "USDT"), exchangeSymbol (e.g. "BTCUSDT", exchange-native), isActive (bool)
- unique (assetId, quoteCurrency)
- relations: Candle[], Watchlist[], AnalysisSnapshot[], BacktestRun[]

**EthicalChecklist**

- id (uuid, pk), assetId (fk, unique)
- whatProjectDoes, tokenUtility (text)
- involvesInterestLending, supportsGambling, supportsProhibitedIndustries, hasClearUtility (each: enum `YES | NO | UNCLEAR` + text note field)
- updatedAt, updatedByUserId (fk → User, nullable)

**Candle** (historical + cache store — also backtest data source)

- id (uuid, pk), tradingPairId (fk), timeframe: enum `M15 | H1 | H4 | D1 | W1`
- openTime (datetime), open/high/low/close (decimal), volume (decimal), closeTime (datetime)
- unique (tradingPairId, timeframe, openTime)
- index (tradingPairId, timeframe, openTime)

**Watchlist**

- id (uuid, pk), userId (fk), tradingPairId (fk), createdAt
- unique (userId, tradingPairId)

**AnalysisSnapshot** (result of one "Analyze Market" run, persisted if user is authenticated)

- id (uuid, pk), userId (fk, nullable — anonymous runs not persisted server-side beyond response), tradingPairId (fk), timeframe (enum)
- trend: enum `BULLISH | BEARISH | SIDEWAYS`, trendReason (text)
- supportZones (json: `{low, high}[]`), resistanceZones (json: same shape)
- entryLow, entryHigh (decimal), entryReason (text), confirmationChecklist (json string[])
- stopLoss (decimal), stopLossReason (text)
- takeProfits (json: `{level: decimal, reason: string}[]`)
- riskRewardRatio (decimal)
- setupScore (int 0–100), setupScoreBreakdown (json: `{trend, supportResistance, volume, rsi, emaAlignment, riskReward}` each `{score, max}`)
- status: enum `POTENTIAL_SETUP | WAIT_FOR_CONFIRMATION | HIGH_RISK | AVOID`, statusReason (text)
- indicatorsSnapshot (json: ema20/50/200, rsi14, avgVolume, volumeTrend)
- mtfSummary (json nullable: `{higherTimeframe, higherTrend, lowerTimeframe, lowerTrend, agreement: bool, conflictNote}`)
- disclaimerVersion (string)
- createdAt
- index (userId, createdAt)

**BacktestRun**

- id (uuid, pk), userId (fk), tradingPairId (fk), timeframe (enum)
- startDate, endDate (date)
- status: enum `QUEUED | RUNNING | COMPLETED | FAILED`
- numSetups (int), winRate (decimal), avgRealizedRR (decimal), maxDrawdownPct (decimal)
- bestSetupId, worstSetupId (fk → BacktestSetup, nullable)
- errorMessage (text, nullable)
- createdAt, completedAt

**BacktestSetup**

- id (uuid, pk), backtestRunId (fk)
- triggeredAt (datetime — candle time the setup fired)
- entry, stopLoss (decimal), takeProfits (json same shape as AnalysisSnapshot)
- outcome: enum `TP1_HIT | TP2_HIT | TP3_HIT | SL_HIT | NO_HIT | STILL_OPEN`
- realizedRR (decimal, nullable), exitTime (datetime, nullable), exitPrice (decimal, nullable)
- index (backtestRunId, triggeredAt)

**LearnArticle**

- id (uuid, pk), slug (unique), title, category (string), bodyMarkdown (text)
- relatedConceptTags (string[]) — used for contextual linking from analysis results
- createdAt, updatedAt

**AdminAuditLog**

- id (uuid, pk), adminUserId (fk → User), action (string, e.g. "asset.update"), entityType, entityId (string)
- diff (json), createdAt

**Subscription** (Phase 8)

- id (uuid, pk), userId (fk, unique), stripeCustomerId, stripeSubscriptionId
- plan: enum `FREE | PRO`, status (string — mirrors Stripe status), currentPeriodEnd (datetime)
- createdAt, updatedAt

## System components

- **Web app (Next.js App Router):** server components for pages, client components for chart/interactivity; route handlers under `/app/api/*` serve as the backend.
- **Feature modules** (`/features/market`, `/features/analysis`, `/features/watchlist`, `/features/learning`, `/features/risk-management`, `/features/backtesting`, `/features/admin`): UI + hooks per feature, no cross-feature imports except through `/lib` and `/services`.
- **Market Data Provider layer** (`/lib/market-data`): `MarketDataProvider` interface (`getMarkets`, `getTicker`, `getCandles`, `getVolume`) with a `BinanceProvider` implementation. All chart/analysis code depends only on the interface.
- **Candle cache service:** reads through Postgres `Candle` table first; on cache miss/staleness, calls provider, upserts, returns. Cron job refreshes recent candles for all active pairs/timeframes.
- **Analysis Engine** (`/lib/analysis`, `/lib/indicators`): pure, deterministic, framework-agnostic functions — indicator math, swing/structure detection, S/R zone clustering, volume analysis, entry/SL/TP calculators, scoring, status engine. No I/O; takes candle arrays in, returns typed results out. This is the most heavily unit-tested layer.
- **Explanation layer:** thin function that maps engine output to plain-language strings (templated, deterministic — not LLM-dependent for correctness; an optional LLM rephrasing pass can be layered on top later without changing numbers).
- **Backtest runner** (`/lib/backtesting`): replays the Phase 2/3 engine bar-by-bar over stored candles, strictly using only candles up to the current bar index (guards against look-ahead bias), records BacktestSetup outcomes. Runs as an async job (QStash) since ranges can be long-running.
- **Realtime price client:** browser-side hook subscribing directly to Binance WebSocket streams; falls back to REST polling via TanStack Query on WS failure.
- **Admin panel:** protected route group under `/app/admin`, reuses the same API routes with role-gated middleware.
- **Auth module:** NextAuth config, Prisma adapter, credentials + OAuth providers, session callbacks that attach role/plan to session.
- **Billing module:** Stripe SDK wrapper, webhook handler that syncs `Subscription` table.
- **Job/cron routes:** `/api/cron/*` — protected by a shared secret header, triggered by Vercel Cron; also handle QStash callbacks for backtest processing.

## API design

All routes under `/app/api`. "Auth" = required session unless noted.

**Markets & assets (public)**

- `GET /api/markets` — list active trading pairs (asset + pair metadata) for selector
- `GET /api/assets` — list curated assets with metadata
- `GET /api/assets/:symbol` — asset detail incl. ethical checklist
- `GET /api/pairs/:pairId/ticker` — current price, 24h change
- `GET /api/pairs/:pairId/candles?timeframe=&from=&to=&limit=` — OHLCV, served from cache

**Analysis**

- `POST /api/analysis/run` — body `{tradingPairId, timeframe}`; runs engine, returns full result; persists snapshot if authenticated (auth optional)
- `POST /api/analysis/mtf` — body `{tradingPairId, higherTimeframe, lowerTimeframe}`; runs MTF engine (Phase 5) (auth optional)
- `GET /api/analysis/history` — list caller's saved snapshots, paginated (auth)
- `GET /api/analysis/:id` — fetch one snapshot (auth, owner-only)
- `DELETE /api/analysis/:id` (auth, owner-only)

**Risk tools**

- `POST /api/risk/position-size` — body `{balance, riskPercent, entry, stopLoss}` → `{positionSize, riskAmount}`; stateless, public

**Watchlist**

- `GET /api/watchlist` (auth)
- `POST /api/watchlist` — body `{tradingPairId}` (auth)
- `DELETE /api/watchlist/:id` (auth, owner-only)

**User**

- `GET /api/user/me` (auth)
- `PATCH /api/user/settings` — body `{defaultRiskPercent?, defaultTimeframe?}` (auth)
- `POST /api/auth/register` — email/password signup (public; NextAuth handles login/session/OAuth under `/api/auth/*`)

**Learn**

- `GET /api/learn/articles` (public)
- `GET /api/learn/articles/:slug` (public)

**Backtesting**

- `POST /api/backtest/run` — body `{tradingPairId, timeframe, startDate, endDate}`; creates `QUEUED` run, enqueues job, returns `{runId}` (auth; plan-gated volume via middleware)
- `GET /api/backtest` — list caller's runs (auth)
- `GET /api/backtest/:id` — run status + summary metrics (auth, owner-only)
- `GET /api/backtest/:id/setups?cursor=` — paginated setup list (auth, owner-only)

**Admin** (auth, role=ADMIN)

- `GET /api/admin/assets`
- `POST /api/admin/assets`
- `PATCH /api/admin/assets/:id`
- `DELETE /api/admin/assets/:id` (soft delete → `isActive=false`)
- `PUT /api/admin/assets/:id/ethical-checklist`
- `GET /api/admin/audit-log`

**Billing** (Phase 8)

- `POST /api/billing/checkout` (auth)
- `POST /api/billing/portal` (auth)
- `POST /api/webhooks/stripe` (no session auth; Stripe signature verification)

**Jobs/ops**

- `POST /api/cron/refresh-candles` — cron-secret protected
- `POST /api/cron/process-backtests` — cron-secret / QStash-signature protected
- `GET /api/health` — public, for uptime checks

## External services & integrations

- **Binance public REST + WebSocket API** — sole market data source at launch, accessed only through `MarketDataProvider` so a second provider can be added without touching engine/UI code.
- **Neon** — managed Postgres, branch-per-environment (dev/staging/prod).
- **Upstash Redis** — rate limiting counters.
- **Upstash QStash** — async job dispatch for backtest runs and scheduled candle backfills (works within serverless function limits).
- **Vercel Cron** — triggers `/api/cron/*` on schedule (e.g. every 1–5 min for active-pair candle refresh).
- **NextAuth OAuth provider:** Google (email/password also supported via Credentials).
- **Resend** — transactional email (verification, password reset, backtest-complete).
- **Stripe** — Checkout, Billing Portal, webhooks (Phase 8 only).
- **Sentry** — error tracking, both client and server.
- **UptimeRobot** — external uptime polling of `/api/health`.

## Auth & security

- **Sessions:** NextAuth database sessions (Prisma adapter) — revocable server-side, unlike pure JWT.
- **Credentials:** bcrypt/argon2 password hashing; email verification required before password-reset flows are trusted.
- **Authorization:** middleware checks `session.user.role === 'ADMIN'` for all `/api/admin/*`; ownership checks (`resource.userId === session.user.id`) enforced in every handler touching user-scoped rows (watchlist, analysis history, backtests).
- **Input validation:** every route validates request body/query with Zod before touching the DB or engine; typed API responses shared via `/types` package between client and server.
- **Rate limiting:** Upstash-backed limiter on `/api/analysis/run`, `/api/backtest/run`, and auth endpoints (per-IP for anonymous, per-user for authenticated) to prevent abuse and control exchange API load.
- **Secrets:** all provider keys, cron secret, Stripe keys, DB URL via environment variables; never committed; validated at boot (fail fast if missing in prod).
- **CSRF/session security:** handled by NextAuth defaults; cookies `httpOnly`, `secure`, `sameSite=lax`.
- **Webhook verification:** Stripe webhook signature checked before processing; cron routes require a shared-secret header, not public.
- **Compliance posture:** ToS acceptance timestamp stored per user; disclaimer text version-stamped on every `AnalysisSnapshot` and every backtest report so historical UI always shows the disclaimer that was current at generation time; ethical checklist and analysis disclaimers rendered from a single shared constants module to guarantee consistent wording everywhere (mitigates the "perceived as advice" and "mislabeled fatwa" risks called out in the PRD).
- **No trade execution ever:** no exchange API keys with trading scopes are ever requested or stored — architecture has no code path capable of placing an order, by design.

## Deployment

- **Hosting:** Vercel (app + serverless API routes + cron). Preview deployments per PR double as review/staging environments.
- **Database:** Neon Postgres; separate branches for `dev`, `staging`, `production`; Prisma Migrate run in CI before deploy.
- **Local dev:** `docker-compose.yml` with Postgres + Redis (Upstash-compatible) for parity; `Dockerfile` provided for self-host fallback if ever needed off Vercel.
- **CI/CD:** GitHub Actions — lint, typecheck, Vitest unit tests, Prisma migration check on every PR; Playwright E2E on merge to `main`; auto-deploy to Vercel on merge.
- **Environments:** `.env.local` (dev), Vercel project env vars for staging/production, distinct Stripe keys and Binance rate-limit budgets per environment.
- **Monitoring:** Sentry DSN per environment, UptimeRobot hitting production `/api/health`, Vercel dashboard for request/latency metrics.

## Development roadmap

### Phase 1 — Chart Foundation

1. Repo scaffold: Next.js + TS + Tailwind + shadcn/ui, feature-based folders, ESLint/Prettier, Vitest + Playwright wired into CI. (2–3 days)
2. Prisma schema for `Asset`, `TradingPair`, `Candle`, base migration; seed script for ~30–50 curated assets. (2 days)
3. `MarketDataProvider` interface + `BinanceProvider` implementation (`getMarkets`, `getTicker`, `getCandles`, `getVolume`) with retry/backoff and typed errors. (3 days)
4. Candle cache service (DB-backed) + `/api/pairs/:id/candles` and `/api/pairs/:id/ticker` routes. (2 days)
5. Asset/pair/timeframe selector UI + TradingView Lightweight Charts candlestick rendering + live header (price, 24h change) via direct Binance WS. (3–4 days)
6. Dashboard shell: sidebar nav (Dashboard, Market Analysis, Watchlist, Learn, Risk Calculator, Settings) with stub pages for later phases. (2 days)
7. Loading/error states across all data fetches; smoke E2E test (load app → pick pair → see chart). (1–2 days)

_Milestone: a user can browse the curated list and watch a live, cached candlestick chart. Ship it, get eyes on it._

### Phase 2 — Technical Analysis Engine v1

1. Indicator library: EMA20/50/200, RSI14, average volume, with fixture-based unit tests. (3 days)
2. Swing-point detection (HH/HL/LH/LL) + trend classifier combining swing structure with EMA alignment. (4 days)
3. Support/resistance zone detection via price-reaction clustering (zones, not lines). (4 days)
4. Volume analysis (breakout strength, increasing/decreasing classification). (2 days)
5. Chart overlays: EMA lines + S/R zone shading toggles. (2 days)
6. "Market Read" panel (trend/support/resistance/volume + plain-language reason strings). (3 days)
7. Full unit test suite for indicators + structure/S-R detection against known historical fixtures (non-negotiable per PRD risk notes). (ongoing, ~3 days dedicated)

_Milestone: chart shows a correct, explainable market read with no trade numbers yet._

### Phase 3 — Trade Setup Engine

1. Entry zone calculator (trend + S/R confluence + retest logic) + confirmation checklist. (4 days)
2. Structure-based stop-loss calculator. (2 days)
3. Multi-target take-profit calculator (TP1/2/3 from resistance/prior highs). (3 days)
4. Risk/reward calculator with poor-R:R flagging. (1 day)
5. Setup Score (0–100, category breakdown) + Strong/Moderate/Weak/Avoid label. (3 days)
6. Trade status engine (Potential/Wait/High Risk/Avoid) with reason text. (2 days)
7. `POST /api/analysis/run` end-to-end + result panel UI with expandable "Why?" on every field + disclaimer everywhere. (4 days)
8. Unit tests for entry/SL/TP/score/status logic, including deliberately poor setups to verify WAIT/AVOID bias. (3 days)

_Milestone: full "Analyze Market" flow works and is the core demo-able product._

### Phase 4 — Accounts, Risk Management & Watchlist

1. NextAuth setup: Credentials + Google OAuth, Prisma adapter, register/login/forgot-password flows. (3 days)
2. Watchlist CRUD + sidebar integration. (2 days)
3. Position size calculator (`/api/risk/position-size` + UI) wired to user's default risk %. (2 days)
4. Persist `AnalysisSnapshot` on run when authenticated; history list + detail view. (3 days)
5. Settings page (default risk %, default timeframe). (1 day)
6. `plan` field on User + `Subscription` table scaffolded (no billing logic wired yet). (1 day)

_Milestone: users can create accounts and the product retains state across sessions._

### Phase 5 — Multi-Timeframe Analysis

1. Run trend/structure detection across a higher/lower timeframe pair reusing Phase 2 engine. (2 days)
2. MTF summary panel (both trends shown side by side). (2 days)
3. Conflict warning banner logic + copy. (1 day)
4. Fold MTF agreement into Setup Score and Trade Status calculation (not just display). (3 days)
5. Timeframe-pair selector UI, `POST /api/analysis/mtf` route. (2 days)
6. Unit tests for agreement/conflict scoring logic. (1–2 days)

_Milestone: entries are checked against higher-timeframe context, not just single-chart signals._

### Phase 6 — Learning Mode & Asset Research

1. `LearnArticle` model + seed content (glossary: support, resistance, RSI, R:R, market structure, trend). (3 days)
2. Learn section UI (list + article view) + contextual "Learn more" links from every analysis result field. (3 days)
3. Per-asset research page (description, utility, category, links, risk level). (2 days)
4. `EthicalChecklist` model + UI with required non-fatwa disclaimer. (2 days)
5. Protected admin interface: manage assets, whitelist toggle, ethical checklist content, with `AdminAuditLog` on every change. (4 days)

_Milestone: the product teaches, and the curated list is maintainable without a redeploy._

### Phase 7 — Backtesting

1. `BacktestRun`/`BacktestSetup` schema + historical candle storage strategy (reuse `Candle` cache, backfill deep history for requested ranges). (3 days)
2. Bar-by-bar replay runner reusing Phase 2/3 engine, with explicit test coverage proving no look-ahead bias (engine only sees candles ≤ current index). (5 days)
3. Async job wiring: `POST /api/backtest/run` enqueues via QStash, `/api/cron/process-backtests` (or QStash callback) executes and updates run status. (3 days)
4. Metrics computation: win rate, avg realized R:R, max drawdown, best/worst setup. (2 days)
5. Backtest report UI: summary + setup-by-setup outcome list + prominent "no guarantee" disclaimer. (3 days)

_Milestone: users can validate (or doubt) the engine against history — with integrity guarantees tested, not assumed._

### Phase 8 — Hardening & Launch

1. Full test pass: unit coverage on all analysis math, integration tests for every API route, Playwright E2E for signup → analyze → watchlist → backtest happy paths. (5 days)
2. Security pass: Upstash rate limiting on all public/mutating routes, Zod validation audit, session/cookie hardening, secrets audit, dependency scan. (3 days)
3. Performance pass: candle cache TTL/refresh tuning, query indexing review, chart rendering profiling on large candle sets. (3 days)
4. Realtime price reconnect/backoff hardening if gaps remain from Phase 1. (2 days)
5. Stripe billing: Checkout, Billing Portal, webhook sync to `Subscription`; gate backtest volume, MTF analysis frequency, and watchlist size by plan. (5 days)
6. Docker packaging (Dockerfile + compose) validated end-to-end; CI/CD pipeline finalized (staging + production Vercel projects, Neon branches). (2 days)
7. Sentry + UptimeRobot + basic usage dashboard wired into production. (2 days)

_Milestone: production-ready, monetizable, monitored product — matches full PRD scope._
