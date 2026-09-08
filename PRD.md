# PRD: SpotLens

## Problem

Retail crypto spot traders either rely on raw charting tools (TradingView, exchange charts) that require them to already know technical analysis, or they follow paid "signal" channels that hand out entry/exit numbers with no reasoning and no accountability. Neither option teaches the trader anything, and neither is built to say "don't trade" — signal sellers need constant activity to justify a subscription, and generic charting tools have no opinion at all. Beginners end up overtrading, entering near resistance, skipping stop losses, and not understanding why a trade worked or failed. There is no tool that combines a deterministic, explainable analysis method with an explicit bias toward telling the user to wait.

## Target user & job-to-be-done

Primary user: a self-directed retail spot trader (beginner to intermediate) who trades established crypto assets on an exchange manually and wants a second opinion before entering a trade.

Secondary user: a religiously-conscious retail investor who wants a structured way to research whether a project's utility and token model raise ethical concerns, without the app making a religious ruling for them.

Job-to-be-done: "When I'm considering a spot trade on a coin I already follow, I want a structured read of trend, support/resistance, and risk/reward — with the reasoning shown — so I can decide to enter, wait, or skip, and get better at reading charts myself over time."

## Value proposition (the wedge)

SpotLens is not a signal bot. It runs a fixed, auditable set of technical analysis rules (trend structure, EMAs, S/R zones, RSI, volume) against real market data and produces entry/stop/target levels with a plain-language reason for every number — and it will tell the user to WAIT or AVOID when the setup is poor, not just when to buy. The asset list is curated to established projects only (no meme coins), and every analysis carries the same disclaimer. The wedge is trust through explainability and restraint: a tool that's honest about uncertainty is more useful, long-term, than one that always has an opinion.

## Product vision (the full build)

At full build, a user opens SpotLens, picks a curated spot asset and pair, and views a professional candlestick chart with EMA overlays and support/resistance zones. Clicking "Analyze Market" runs a deterministic engine that reads market structure, indicators, and volume, and returns a full trade setup: entry zone, stop loss, multiple take-profit targets, risk/reward ratio, a 0–100 setup score with category breakdown, and a status (Potential Setup / Wait / High Risk / Avoid) — every field expandable into a plain-language explanation. The user can layer in multi-timeframe confluence, size their position with a risk calculator tied to their portfolio, save analyses and assets to a watchlist, and backtest the same engine against historical data to see how the method has performed (without claiming future results). A Learn section and per-asset research pages (including an ethical/Shariah research checklist) turn the tool into something that teaches, not just outputs numbers. Everything is data-driven, not AI-generated — AI, if used at all, only phrases the explanations, never invents the numbers.

## Phased delivery

### Phase 1: Chart Foundation

**Goal:** Ship a working, curated-market chart viewer that's useful on its own before any analysis logic exists.

1. Next.js + TypeScript + Tailwind + shadcn/ui scaffold, feature-based folder structure (`/features/market`, `/lib`, `/services`, `/types`), lint/test/CI setup
2. `MarketDataProvider` abstraction (`getMarkets`, `getTicker`, `getCandles`, `getVolume`) with one concrete implementation against a spot-only exchange API (e.g. Binance public REST/WebSocket)
3. Curated asset whitelist (~30–50 established projects) seeded in PostgreSQL via Prisma, with name, symbol, category, official site, description, utility, risk level
4. Asset / pair / timeframe selector (BTC/USDT etc., 15m/1h/4h/1D/1W)
5. Candlestick chart (TradingView Lightweight Charts) with live price and 24h change in the header
6. API error handling, retry/backoff, loading states, and DB-backed caching of historical candles
7. Dashboard shell (sidebar: Dashboard, Market Analysis, Watchlist, Learn, Risk Calculator, Settings) matching the final IA, with later pages stubbed

### Phase 2: Technical Analysis Engine v1

**Goal:** Turn the chart into a read of the market — trend, indicators, S/R, volume — all deterministic and unit tested.

1. Indicator library (`/lib/indicators`): EMA20/50/200, RSI14, average volume — unit tested against fixture data
2. Trend detection using swing-point analysis (HH/HL/LH/LL) combined with EMA alignment rules
3. Support/resistance zone detection (price-reaction clustering into zones, not single lines)
4. Volume analysis (breakout confirmation strength, increasing/decreasing volume)
5. Chart overlay toggles for EMAs and S/R zone shading
6. "Market Read" panel: trend, support, resistance, volume note, each with a plain-language reason
7. Unit test suite covering indicator math and trend/S-R detection

### Phase 3: Trade Setup Engine

**Goal:** Ship the core wedge — full entry/stop/target/score/status output with explanations for every number.

1. Entry zone calculator (confluence of trend + S/R + retest logic) with a confirmation checklist (candle rejection, volume increase, HL formation)
2. Structure-based stop-loss calculator (below support / below latest swing low)
3. Multi-target take-profit calculator (TP1/TP2/TP3 from resistance levels and prior highs)
4. Risk/reward calculator with explicit flagging of poor R:R setups
5. Setup Score (0–100) with category breakdown (trend, S/R, volume, RSI, EMA alignment, R:R) and a Strong/Moderate/Weak/Avoid label
6. Trade status engine: Potential Setup / Wait for Confirmation / High Risk / Avoid, with a written reason
7. "Analyze Market" flow producing a full result panel, every field expandable into "Why?"
8. Disclaimer rendered on every analysis result; RSI wired in as a confirmation-only input, never a standalone trigger

### Phase 4: Accounts, Risk Management & Watchlist

**Goal:** Add persistence and practical risk tools so the product retains users across sessions.

1. Authentication (email/password + OAuth via NextAuth) and user accounts
2. Watchlist: save asset/pair combos, quick access from the sidebar
3. Position size calculator: portfolio balance + max risk % → position size from entry/stop distance, with a configurable default risk %
4. Saved analysis history per user (timestamped snapshot of each "Analyze Market" run)
5. Settings page (default risk %, default timeframe)
6. Free/paid plan flag scaffolding in the data model (no billing logic yet)

### Phase 5: Multi-Timeframe Analysis

**Goal:** Add higher-timeframe context so entries aren't taken against the dominant trend.

1. Run trend + structure detection across a higher/lower timeframe pair (e.g. 4H+1H, 1D+4H)
2. Multi-timeframe summary panel showing both trends and their agreement/conflict
3. Conflict warning banner (e.g. "1H bullish but 4H bearish")
4. MTF agreement factored into Setup Score and Trade Status, not just displayed
5. Timeframe-pair selector for MTF mode, separate from single-timeframe analysis

### Phase 6: Learning Mode & Asset Research

**Goal:** Add the educational layer and ethical research tooling that differentiate SpotLens from a bare signal tool.

1. Learn section: glossary and concept explainers (support, resistance, RSI, R:R, market structure), linked contextually from the analysis panel
2. Per-asset research page: description, utility, category, official links, risk level
3. Ethical/Shariah Research Checklist per asset (structured questions on lending/interest, gambling exposure, prohibited industries, token utility) with the required non-fatwa disclaimer
4. Simple protected admin interface to manage the curated asset whitelist and checklist content without a redeploy
5. Contextual links from every analysis result into the relevant Learn article

### Phase 7: Backtesting

**Goal:** Let users see how the deterministic engine would have performed historically, with no forward-looking promises.

1. Historical run: pick asset, timeframe, and date range; replay the Phase 2/3 engine bar-by-bar
2. Metrics: number of setups triggered, win rate (TP vs. SL hit), average realized R:R, max drawdown across the setup series, best/worst setup
3. Setup-by-setup list with entry/stop/targets and actual outcome
4. Prominent "past performance is not a guarantee" disclaimer on every report
5. Stored historical candle sets so repeat backtests don't re-fetch from the provider

### Phase 8: Hardening & Launch

**Goal:** Make the product secure, fast, and monetizable in production.

1. Full test coverage: unit tests for all analysis math, integration tests for API routes, Playwright E2E for the core analyze flow
2. Security pass: request rate limiting, zod input validation on all routes, session hardening, environment/secrets audit
3. Performance pass: candle caching strategy, query optimization, chart rendering on large datasets
4. Real-time price updates via WebSocket with reconnect/backoff (if not already done in Phase 1)
5. Billing (Stripe) for a paid tier gating backtesting volume, MTF analysis, and watchlist size
6. Docker packaging, CI/CD pipeline, staging and production environment configs
7. Error tracking, uptime monitoring, and basic usage dashboards

## Success metrics

- **Activation:** % of new signups who run at least one "Analyze Market" within their first session
- **Engine credibility:** % of analyses that return Wait/Avoid vs. Potential Setup — should track real market conditions, not always favor "buy," and this ratio should be monitored as a health signal, not optimized toward more trades
- **Retention:** weekly active users returning to run a new analysis or check their watchlist
- **Depth of use:** % of active users who use Multi-Timeframe or Backtesting features (signals the product is doing more than one-off lookups)
- **Conversion:** free-to-paid conversion rate once billing ships
- **Trust proxy:** support/feedback volume complaining about "wrong calls" or perceived guarantees should stay near zero — a spike indicates the disclaimers and framing aren't landing

## Risks & assumptions

- **Data provider risk:** relying on one exchange's public API (rate limits, regional restrictions, or API changes) can break core functionality; the provider abstraction (Phase 1) is the mitigation but the first implementation is still a single point of failure.
- **Algorithm correctness risk:** trend/S-R/scoring logic is nontrivial quant work for a solo developer; under-tested detection logic (bad swing-point or zone-clustering rules) will produce nonsensical analyses and destroy trust fast — Phase 2/3 unit tests against fixture data are non-negotiable before shipping further phases.
- **Regulatory/liability risk:** even with disclaimers, an app suggesting entries/stops/targets can be perceived as financial advice in some jurisdictions; needs a reviewed ToS and consistent disclaimer placement, not just a single footer line.
- **Curated list maintenance:** the "no meme coins, established projects only" promise requires ongoing manual curation; assumption is that a solo founder can maintain a whitelist of ~30–50 assets without it becoming a bottleneck.
- **Backtesting integrity:** look-ahead bias (accidentally using future data in historical rule evaluation) is an easy mistake that would invalidate the whole feature; needs explicit test coverage simulating bar-by-bar replay.
- **Scope risk for a solo dev:** eight phases covering charting, a full analysis engine, MTF logic, learning content, backtesting, and billing is a multi-quarter build; assumption is the founder ships and gets user feedback after each phase rather than building all eight before any real users touch it.
- **Ethical checklist risk:** the Shariah/ethical section must stay clearly labeled as research, not a ruling — mislabeling this is both a trust risk and a potential legal one.
