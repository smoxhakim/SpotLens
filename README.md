# SpotLens

Educational Crypto **Spot Trading** analysis app. A deterministic technical analysis
engine (trend, S/R, RSI, EMA, volume) produces explainable entry / stop loss /
take profit / score / status output, and prefers telling you to **wait** over
manufacturing a trade.

No trade execution. No futures, margin, leverage, or short selling. No meme coins.

> This analysis is educational and informational only. Market conditions can
> change, and no trade outcome is guaranteed.

## Stack

Next.js 14 (App Router) + TypeScript, Tailwind + shadcn-style UI primitives,
TradingView Lightweight Charts, TanStack Query, PostgreSQL + Prisma, NextAuth,
Upstash (rate limit + queue), Vitest / Playwright.

## Structure

```
app/                 routes (pages + API handlers)
components/          shared UI primitives + layout chrome
features/            feature UI modules (market, analysis, watchlist, ...)
lib/
  api/               API route helpers (error envelope)
  constants/         disclaimer text, version-stamped
  db/                Prisma client singleton
  market-data/       MarketDataProvider abstraction + Binance implementation
  indicators/        pure indicator math (Phase 2)
  analysis/          deterministic analysis engine (Phase 2/3)
services/            DB-backed services (markets, candle cache)
types/               shared API/response types
prisma/              schema + migrations + seed
e2e/                 Playwright specs
```

## Getting started

```bash
cp .env.example .env
npm install
npm run dev
```

The app runs without a database: the curated asset list is read from
`lib/market-data/curated-assets.ts` and candles come straight from the provider.

To run with Postgres (enables the candle cache, accounts, watchlist, settings
and analysis history):

```bash
docker compose up -d        # or point DATABASE_URL at a hosted Postgres
npm run prisma:migrate
npm run prisma:seed
```

On Neon, set both `DATABASE_URL` (pooled) and `DIRECT_URL` (unpooled) — Prisma
migrations take advisory locks that a transaction-mode pooler cannot hold — and
apply the schema with `npx prisma migrate deploy`.

If `DATABASE_URL` is set but Postgres is not running, the app logs one warning
and falls back to the file-based list rather than failing.

## Testing

```bash
npm run test        # Vitest unit tests — analysis math is the priority surface
npm run e2e         # Playwright end-to-end (serves on port 3100)
npm run lint
npm run typecheck
```

CI runs lint, typecheck, and the unit tests on every push. E2E is manual — it
drives the live exchange API, which is unreachable from GitHub's US-based
runners, so run it locally or trigger it from the Actions tab.

## Status

**Phases 1–4 shipped.** Curated market directory and live candlestick chart;
a deterministic analysis engine (trend, S/R zones, volume, RSI) with a reason
behind every field; the full trade setup engine (entry, stop, targets,
risk/reward, 0–100 score, and a Potential/Wait/High-risk/Avoid status); and
accounts with a watchlist, saved analysis history, settings and a position
size calculator.

Auth is email/password only. Sessions are JWT rather than database sessions,
because Auth.js v5's Credentials provider does not support the database
strategy; the Prisma adapter is wired up so adding OAuth later would allow
switching without a data-model change.

Later phases land on their own branches. See `TODO.md` for the roadmap and
`ARCHITECTURE.md` for the design that governs it.

`POST /api/analysis/run` returns **501 until Phase 3**: SpotLens does not return
trade setups it has not actually calculated.
