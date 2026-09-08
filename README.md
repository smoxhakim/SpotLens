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

To run with Postgres (enables the candle cache, and everything from Phase 4 on):

```bash
docker compose up -d
npm run prisma:migrate
npm run prisma:seed
```

If `DATABASE_URL` is set but Postgres is not running, the app logs one warning
and falls back to the file-based list rather than failing.

## Testing

```bash
npm run test        # Vitest unit tests — analysis math is the priority surface
npm run e2e         # Playwright end-to-end (serves on port 3100)
npm run lint
npm run typecheck
```

## Status

**Phase 1 (Chart Foundation) — shipped.** Curated market directory, pair /
timeframe selection, live candlestick chart with streamed prices, DB-backed
candle cache, typed provider abstraction with retry/backoff.

Later phases land on their own branches. See `TODO.md` for the roadmap and
`ARCHITECTURE.md` for the design that governs it.

`POST /api/analysis/run` returns **501 until Phase 3**: SpotLens does not return
trade setups it has not actually calculated.
