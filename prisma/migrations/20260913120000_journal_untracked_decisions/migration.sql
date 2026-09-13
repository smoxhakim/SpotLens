-- Journaling a decision about an opportunity SpotLens never tracked.
--
-- The scanner scores every market it looks at and tracks a setup only for the
-- ones it began following. A decision about one of the others had nowhere to
-- live: `trackedSetupId` was NOT NULL, so recording one meant inventing a
-- setup, and a placeholder setup means placeholder levels in the one table
-- that is supposed to hold only what the engine actually produced.
--
-- Additive throughout. Three nullable columns are added, two NOT NULL
-- constraints are relaxed, and nothing is dropped, renamed, defaulted or
-- rewritten — every existing row is a tracked entry and stays exactly as it
-- was, with the three new columns null.
--
-- The reference is (run, pair, timeframe) rather than a copy of the numbers:
-- `ScannerResult` rows are written once per pass and never updated, so those
-- three resolve the same verdict and score for ever. That is a snapshot by
-- construction, the same guarantee `TrackedSetup`'s frozen columns give, and
-- it means no figure is duplicated onto this row to drift from its source.

ALTER TABLE "JournalEntry" ADD COLUMN     "scannerRunId" TEXT,
ADD COLUMN     "timeframe" "Timeframe",
ADD COLUMN     "tradingPairId" TEXT,
ALTER COLUMN "trackedSetupId" DROP NOT NULL,
ALTER COLUMN "setupStatusAtDecision" DROP NOT NULL;

-- One decision per market per pass, the same rule `JournalEntry_trackedSetupId_key`
-- already enforces for tracked setups. Postgres treats nulls as distinct in a
-- unique index, so tracked rows — null in all three of these columns — sit
-- outside this constraint instead of colliding with each other on a shared null.
CREATE UNIQUE INDEX "JournalEntry_userId_scannerRunId_tradingPairId_timeframe_key" ON "JournalEntry"("userId", "scannerRunId", "tradingPairId", "timeframe");

ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_scannerRunId_fkey" FOREIGN KEY ("scannerRunId") REFERENCES "ScannerRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_tradingPairId_fkey" FOREIGN KEY ("tradingPairId") REFERENCES "TradingPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;
