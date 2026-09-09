/**
 * Glossary and concept explainers.
 *
 * Source of truth in code, seeded into the LearnArticle table by prisma/seed.ts
 * and read from the file when no database is configured — the same pattern the
 * curated asset list uses.
 *
 * `conceptTags` are what the analysis panel links on: a field in a result names
 * a tag, and the "Learn more" link resolves to the article carrying it.
 */

export interface LearnArticleSeed {
  slug: string;
  title: string;
  category: "Getting started" | "Market structure" | "Indicators" | "Risk" | "Using SpotLens";
  /** One-line summary shown in the index. */
  summary: string;
  conceptTags: string[];
  bodyMarkdown: string;
}

export const LEARN_ARTICLES: LearnArticleSeed[] = [
  {
    slug: "getting-started",
    title: "Getting started: your first analysis",
    category: "Getting started",
    summary: "The whole loop, from opening the app to sizing a position.",
    conceptTags: ["getting-started", "workflow", "onboarding"],
    bodyMarkdown: `SpotLens reads a chart and tells you what it sees: where a trade would make sense, where it would be wrong, and — most often — that there is nothing worth doing yet. It does not place orders, and it has no way to. See [why spot only](/learn/spot-only).

This article is the whole loop, start to finish.

## Set it up once

- **Settings** — choose your default risk per trade and default timeframe. If you have no strong view, 1% risk is the usual starting point; [position sizing](/learn/position-sizing) explains what that number does.
- **Watchlist** — add five to ten markets from the dashboard, not forty-five. The point is a list you can actually work through in one sitting.

## Run an analysis

Open **Market Analysis**, pick a pair from the selector, choose a timeframe, and press **Analyze Market**. Leave **Check 4h trend** on: it brings the higher timeframe into the verdict, and a setup that looks clean on its own chart can be a bounce inside a falling market. That is the single most expensive mistake this tool exists to prevent — see [multi-timeframe](/learn/multi-timeframe).

The left side draws the chart, with toggles for the moving averages and the support and resistance zones. The right side is the read and the verdict.

## Read the status before you read any number

The verdict comes first, and it decides whether the numbers below it matter at all.

| Status | What it is asking you to do |
| --- | --- |
| **Avoid for now** | Nothing. There are no levels shown, on purpose. Move to the next market. |
| **High risk** | Skip it unless you can name something the engine cannot see. The setup is not broken, but the payoff does not justify the capital, or price is already in resistance. |
| **Wait for confirmation** | Set a price alert at the entry zone and leave it alone. This is the most common answer, and usually the most useful one. |
| **Potential setup** | A candidate worth working on. Not an instruction to buy. |

[Potential, Wait, High risk, Avoid](/learn/trade-status) goes through the reasoning behind each one.

## Work the confirmation checklist yourself

Under the entry zone is a short list: a bullish rejection candle from the zone, a strong close back above it, [volume](/learn/volume) rising on the bounce rather than on the drop, a higher low forming after the touch.

**SpotLens does not check these for you.** It is naming what to look at on the chart. If those things are not there, the honest reading is that you are early — which is the same thing the status was telling you.

## Size the position before you act

Take the entry and the [stop](/learn/stop-loss) into the **Risk Calculator**, along with your balance and risk percentage. It returns a position size: the quantity at which being wrong costs what you decided it would, rather than whatever the market feels like charging.

This is the step that decides whether a run of losses is a bad month or a finished account. It matters more than the entry.

## Then place the order yourself

On your exchange, by hand. SpotLens never touches an order book. The analysis is saved to your history so you can go back later and see what the tool said, when it said it, and what happened next.

## Expect to wait

The status rules rule out every disqualifying condition before **Potential setup** can be returned at all. Most runs, on most markets, on most days, come back as **Wait for confirmation** — and that is the tool working, not failing.

If nearly everything you analyse comes back as a potential setup, something is wrong with the engine rather than right with the market.

## Before you risk real money

Run a **Backtest** on two or three of your markets, on the 4h timeframe or lower. On the daily timeframe the warmup period consumes most of a year of history, so very few setups trigger and the result says little.

Look at the win rate, the average realised R, and the maximum drawdown. That is how you find out whether you trust the thing, using history instead of money — though a backtest describes what already happened and is not a promise about what comes next.

## When a word stops you

Every field in an analysis links to the article that explains it, and the [setup score](/learn/setup-score) breaks down which evidence agreed and which did not. The goal is that you eventually stop needing the tool to tell you what the chart says.`,
  },
  {
    slug: "support",
    title: "What is support?",
    category: "Market structure",
    summary: "An area where buyers have stepped in before — not a precise price.",
    conceptTags: ["support", "zones"],
    bodyMarkdown: `Support is an area where buyers previously showed enough interest to stop a fall.

It is an **area, not a line**. Price rarely turns at exactly the same number twice, and treating a level as a single price leads to stops placed a few ticks from where they should be. SpotLens always shows support as a range.

## Why a zone forms

Each time price drops into a region and buyers absorb the selling, that region gains significance. People who bought there remember it. People who wanted to buy and missed it put orders there. The more often price has reacted, the more attention the area has.

## What makes one zone stronger than another

- **Touches.** More reactions mean more agreement that the level matters — though with diminishing returns. A fourth test says much less than the second did.
- **Recency.** A level nothing has tested for hundreds of candles is closer to trivia than to a live zone.
- **Flips.** A level that was resistance and later became support has been respected from both directions, which is stronger evidence than repeated tests from one side.

## What it does not mean

Support is not a guarantee that price will bounce. It is a place where a bounce is more likely than at a random price, and where a failure to bounce tells you something useful: if a well-tested zone breaks, the people who were defending it have stopped.`,
  },
  {
    slug: "resistance",
    title: "What is resistance?",
    category: "Market structure",
    summary: "Support's mirror image — an area where sellers have stepped in before.",
    conceptTags: ["resistance", "zones", "take-profit"],
    bodyMarkdown: `Resistance is an area where sellers previously showed enough interest to stop a rise. Everything true of [support](/learn/support) applies, in reverse.

## Why it matters for taking profit

Resistance is the natural place to plan an exit. Somebody who bought lower is deciding whether to sell; somebody who bought at the previous high and watched it fall is relieved to get out at breakeven. Both create supply.

SpotLens sets take-profit targets at the **near edge** of a resistance zone rather than its middle or far side. Getting filled matters more than squeezing the last fraction out of a level that has rejected price before.

## Buying into resistance

Entering just below resistance is one of the most common ways to get a poor result from a correct idea. The trade may still work, but most of the reward has been given away before entry — which is why SpotLens marks a setup **High risk** when price is already inside the resistance zone.`,
  },
  {
    slug: "market-structure",
    title: "Market structure: highs and lows",
    category: "Market structure",
    summary: "How the sequence of swing highs and lows defines the trend.",
    conceptTags: ["market-structure", "trend", "swing"],
    bodyMarkdown: `Market structure is the sequence of turning points on a chart, read as a pattern rather than one at a time.

- **Higher high (HH)** — a peak above the previous peak.
- **Higher low (HL)** — a trough above the previous trough.
- **Lower high (LH)** — a peak below the previous peak.
- **Lower low (LL)** — a trough below the previous trough.

## Reading the pattern

- Higher highs **and** higher lows is an **uptrend**: buyers are paying more each time and sellers are giving up ground.
- Lower highs **and** lower lows is a **downtrend**.
- Anything else is a **range**. If highs are rising but lows are falling, the market is expanding, not trending — and SpotLens will say ranging rather than pick a side.

## Why structure leads and indicators follow

Moving averages are calculated *from* price, so they always lag it. If the sequence of highs and lows says the trend has changed and the averages have not caught up, the chart is right and the averages are late. SpotLens uses structure to decide direction and moving averages to decide how confident to be.

## When a swing is real

A turning point is only a swing once enough candles have printed after it to confirm it. SpotLens will not mark a swing in the most recent candles for that reason — which also means the backtester can never see a level earlier than you would have.`,
  },
  {
    slug: "trend",
    title: "What is a trend, and why 'sideways' is an answer",
    category: "Market structure",
    summary: "Why the honest verdict is often 'no clear direction'.",
    conceptTags: ["trend", "sideways"],
    bodyMarkdown: `A trend is a persistent direction in [market structure](/learn/market-structure), confirmed by moving averages.

SpotLens returns one of three verdicts: **bullish**, **bearish**, or **sideways** — and sideways is a real answer, not a failure to decide.

## When the evidence splits

If swing structure says one thing and the moving averages say another, SpotLens returns sideways with low confidence rather than picking the more interesting side. A tool that always has an opinion is easy to build and expensive to follow.

## Confidence

- **High** — structure and moving averages agree.
- **Medium** — structure is clear, the averages are mixed.
- **Low** — the evidence conflicts, or there is too little history.

Confidence describes the agreement of the evidence, not the probability of a trade working.`,
  },
  {
    slug: "rsi",
    title: "RSI, and why it is never a signal on its own",
    category: "Indicators",
    summary: "Overbought does not mean sell. Oversold does not mean buy.",
    conceptTags: ["rsi", "indicators", "overbought", "oversold"],
    bodyMarkdown: `The Relative Strength Index measures how much of recent movement has been upward, on a scale of 0 to 100.

- Above **70** is conventionally "overbought".
- Below **30** is conventionally "oversold".

## The mistake almost everyone makes

Overbought is not a sell signal. In a strong uptrend RSI can sit above 70 for weeks, and selling every time it crossed would mean fighting the trend the whole way up. Oversold is not a buy signal either: price can stay oversold for the entire duration of a downtrend.

RSI describes **how extended a move is**, not whether it is about to reverse.

## How SpotLens uses it

Strictly as confirmation, never as a trigger. RSI is worth ten points of the setup score out of a hundred, and it only ever adjusts a case that trend, structure and support have already made. An overbought reading is reported as "the move is extended, so entries here carry worse risk/reward" — which is what it actually means.`,
  },
  {
    slug: "moving-averages",
    title: "Moving averages (EMA 20, 50, 200)",
    category: "Indicators",
    summary: "A smoothed view of price that lags it — useful for context, not timing.",
    conceptTags: ["ema", "moving-average", "indicators"],
    bodyMarkdown: `An exponential moving average is the average price over a period, weighted toward recent candles.

SpotLens uses three: **EMA 20** (short-term), **EMA 50** (medium), and **EMA 200** (long-term).

## Alignment

The three conditions SpotLens checks are:

1. Price above the EMA 50
2. EMA 20 above the EMA 50
3. EMA 50 above the EMA 200

All three holding is a bullish stack; all three failing is a bearish one; anything else is mixed.

## Level is not a direction

When two averages are within a fraction of a percent of each other they are **level**, not "one above the other". Treating equality as a direction would read a perfectly flat market as bearish — every "is X above Y" is false when X equals Y. SpotLens reports that case as flat, and gives it no directional weight.

## They lag, always

A moving average cannot tell you about a turn until after it has happened. That is not a flaw to tune away; it is what an average is. Use them for context and [market structure](/learn/market-structure) for direction.`,
  },
  {
    slug: "volume",
    title: "Volume: what confirms a move",
    category: "Indicators",
    summary: "A breakout on thin volume is a breakout very few people participated in.",
    conceptTags: ["volume", "breakout", "confirmation"],
    bodyMarkdown: `Volume is how much was traded in a candle. On its own it says nothing about direction — it says how much **participation** a move had.

## Why it matters

A move on well above average volume means many people acted. A move on thin volume means few did, and it is much easier to reverse. This is why a breakout on weak volume is treated with suspicion: the price went somewhere, but almost nobody went with it.

## How SpotLens measures it

The latest candle is compared against the average of the candles *before* it. Including the latest candle in its own average would dilute exactly the spike being measured — on a 20-period window, a genuine 10× spike would read as about 7×.

It also compares the recent half of the window against the older half to say whether participation is building or fading, with a band around the middle so ordinary noise does not read as a trend.

## In a setup

Price arriving at support on falling volume, then bouncing on rising volume, is the sequence worth waiting for. Price arriving on heavy volume and bouncing on nothing is the opposite. SpotLens will say **wait** when price is in the zone but volume has not shown up.`,
  },
  {
    slug: "risk-reward",
    title: "Risk/reward, and why 1:1 is a losing game",
    category: "Risk",
    summary: "How much you stand to make compared with what you are risking.",
    conceptTags: ["risk-reward", "rr"],
    bodyMarkdown: `Risk/reward compares the distance from entry to stop loss against the distance from entry to target.

- **Risk** = entry − stop loss
- **Reward** = target − entry
- **Ratio** = reward ÷ risk

A ratio of 1:2 means making twice what you risked when right.

## Why the ratio decides whether you can survive being wrong

At 1:1 you need to be right more than half the time just to break even — before fees. At 1:2 you can be wrong twice as often as you are right and still be flat. Nobody knows their true win rate in advance, so the ratio is the part you can actually control.

SpotLens treats **1:1.5 as the minimum** worth taking and flags anything below it. Below 1:1 the setup is marked **Avoid** outright: risking more than the trade stands to make loses money even with a high win rate.

## Which target the ratio is measured to

SpotLens measures to **TP2**. TP1 is usually the nearest resistance and often sits under 1R, which would condemn perfectly good setups; TP3 is the most speculative and would flatter everything. TP2 is the level a trade is realistically managed toward.`,
  },
  {
    slug: "stop-loss",
    title: "Stop loss: where the idea is wrong",
    category: "Risk",
    summary: "A stop belongs at the level that invalidates the trade, not at a round number.",
    conceptTags: ["stop-loss", "invalidation"],
    bodyMarkdown: `A stop loss is the price at which you accept the trade idea was wrong.

## Structure, not percentage

A stop at "5% below entry" is arbitrary — the market has no idea where your entry was. SpotLens places the stop below whichever is lower of the [support](/learn/support) zone floor and the most recent swing low, then adds half an ATR of breathing room underneath so ordinary volatility does not close the trade.

If price trades below that, the support that justified the entry has failed. There is nothing left of the reason for being in the trade.

## Why the buffer is measured in ATR

Average True Range is what "far" means for this asset on this timeframe. A fixed percentage is far too wide for a large cap on a daily chart and far too tight for a small cap on 15 minutes. ATR retunes itself.

## Moving a stop

Moving a stop **further away** to avoid being closed converts a planned small loss into an unplanned large one. It is the single most common way a manageable position becomes an unmanageable one.`,
  },
  {
    slug: "position-sizing",
    title: "Position sizing: the part that keeps you solvent",
    category: "Risk",
    summary: "Size from the stop distance, so a loss costs what you decided it would.",
    conceptTags: ["position-size", "risk-management"],
    bodyMarkdown: `Position size is how much of an asset to buy. Sizing from the **stop distance** rather than from a fixed fraction of the balance is what makes losses predictable.

## The calculation

    risk amount   = balance × risk %
    risk per unit = entry − stop loss
    position size = risk amount ÷ risk per unit

Risking 1% of 10,000 with a stop 10 below a 100 entry gives 100 ÷ 10 = **10 units**.

## What this buys you

The same money is at risk on every trade regardless of how wide the stop is. A wider stop simply means a smaller position. Without this, a wide stop quietly turns into an oversized loss.

## A tight stop is not free

A very tight stop demands a very large position to keep the risk constant — sometimes larger than the account. On spot you cannot buy that without leverage, which SpotLens does not support. The honest answer there is a smaller position and less risk, or no trade.

At 1% per trade, twenty consecutive losses cost about a fifth of the account. At 5%, they end it. **Never risk money that you cannot afford to lose.**`,
  },
  {
    slug: "setup-score",
    title: "How the setup score works",
    category: "Using SpotLens",
    summary: "A measure of how much evidence agrees — not a probability.",
    conceptTags: ["setup-score", "score"],
    bodyMarkdown: `Every analysis produces a score from 0 to 100, split across six categories:

| Category | Max |
| --- | --- |
| Trend | 25 |
| Support / resistance | 25 |
| Volume | 15 |
| Risk / reward | 15 |
| RSI | 10 |
| EMA alignment | 10 |

## What it is not

The score is **not a probability**. A setup scoring 78 does not have a 78% chance of working. It means most of the conditions SpotLens checks are in agreement — nothing more. No score is a prediction, and a high one is not permission to skip your own judgement.

## Grades

- **Strong** — 75 and above
- **Moderate** — 60 to 74
- **Weak** — 45 to 59
- **Avoid** — below 45

## Higher timeframes

When a [higher timeframe](/learn/multi-timeframe) is checked, its agreement adjusts the **trend** category rather than adding a seventh one — it is trend information, and the six categories always total 100.`,
  },
  {
    slug: "trade-status",
    title: "Potential, Wait, High risk, Avoid",
    category: "Using SpotLens",
    summary: "Why the tool would rather tell you to wait.",
    conceptTags: ["status", "wait"],
    bodyMarkdown: `SpotLens never says "buy". Every analysis ends on one of four statuses.

- 🟢 **Potential setup** — every check passed. A candidate to watch for confirmation, not an instruction.
- 🟡 **Wait for confirmation** — the idea is sound but something is missing: price has not reached the zone, volume has not shown up, or the market is ranging.
- 🟠 **High risk** — the setup is not broken but the odds are poor: risk/reward below the minimum, price already at resistance, or too little history.
- 🔴 **Avoid for now** — a disqualifying condition. The trend is bearish, the higher timeframe disagrees, or the reward does not justify the risk.

## The ordering is the product

The rules are checked so that **every disqualifying condition is ruled out before "potential setup" can be returned**. A tool that must rule out every objection before saying "possible" says "wait" far more often than one hunting for reasons to say yes.

Most of the time, the useful answer is that there is nothing worth doing. A good analysis avoids bad trades; it does not manufacture good ones.

## When Avoid means no numbers

When the verdict is Avoid, no entry, stop or target levels are shown. Handing over numbers for a trade the tool has just advised against would undo the point of saying it.`,
  },
  {
    slug: "multi-timeframe",
    title: "Multi-timeframe: bias and entry",
    category: "Using SpotLens",
    summary: "The higher timeframe sets direction; the lower one finds the price.",
    conceptTags: ["multi-timeframe", "mtf", "conflict"],
    bodyMarkdown: `One chart is not enough context. A 1-hour chart that has turned up looks identical whether the 4-hour is rising or falling — and those two situations have opposite outcomes.

SpotLens reads a **higher timeframe for bias** and the **entry timeframe for price**, one step apart (15m→1h, 1h→4h, 4h→1D, 1D→1W).

## The four relationships

- **Aligned bullish** — both rising. An entry trades with the dominant trend.
- **Pullback in an uptrend** — higher timeframe bullish, entry timeframe fallen. This is the combination worth waiting for: the trend still favours buyers and the dip is offering a better price.
- **Counter-trend bounce** — higher timeframe bearish, entry timeframe risen. This is the trap. On the lower chart it looks like a clean setup; most of these fail. SpotLens returns **Avoid** and shows no levels.
- **Both bearish** — nothing to buy into.

The two disagreements are opposites, not one "conflict". Treating them the same would put the best case and the worst case in the same bucket.`,
  },
  {
    slug: "spot-only",
    title: "Why spot only",
    category: "Using SpotLens",
    summary: "No futures, no margin, no leverage, no short selling — by design.",
    conceptTags: ["spot", "leverage", "scope"],
    bodyMarkdown: `SpotLens covers **spot trading only**: buying an asset you then own, with money you already have.

It has no support for futures, margin, leverage, or short selling — not as a missing feature, but as a deliberate boundary. There is no code path in this application capable of placing an order, and it never asks for exchange API keys with trading permissions.

## Why the restriction

Leverage turns an ordinary drawdown into a liquidation. A 20% move against an unleveraged spot position is uncomfortable; against 5× leverage it is terminal. Most people who lose money quickly in crypto do it with borrowed money, not with bad analysis.

## What this means in practice

Every setup SpotLens produces is a **long**. When the trend is down, the answer is not "go short" — it is that there is nothing to do. That is a smaller set of opportunities on purpose.

## And no automation

SpotLens does not execute trades and never will. It is a second opinion you read before deciding, and the decision stays yours.`,
  },
];

export function findArticle(slug: string): LearnArticleSeed | undefined {
  return LEARN_ARTICLES.find((a) => a.slug === slug);
}

/**
 * The article that explains a given concept tag, used for contextual links.
 *
 * An article whose own slug matches the tag wins. Several articles legitimately
 * mention the same concept — "market-structure" carries the tag "trend" because
 * it explains trend structure — and without this the link for a field would
 * resolve by array order, which is both arbitrary and silently wrong.
 */
export function articleForConcept(tag: string): LearnArticleSeed | undefined {
  return (
    LEARN_ARTICLES.find((a) => a.slug === tag) ??
    LEARN_ARTICLES.find((a) => a.conceptTags.includes(tag))
  );
}
