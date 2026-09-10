-- CreateEnum
CREATE TYPE "ScannerRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ScannerResultStatus" AS ENUM ('OK', 'FAILED');

-- CreateEnum
CREATE TYPE "ScannerFailureCategory" AS ENUM ('MARKET_DATA_ERROR', 'INVALID_DATA', 'ANALYSIS_ERROR', 'DATABASE_ERROR', 'UNKNOWN');

-- CreateTable
CREATE TABLE "ScannerRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" "ScannerRunStatus" NOT NULL DEFAULT 'RUNNING',
    "timeframes" "Timeframe"[],
    "triggeredBy" TEXT NOT NULL DEFAULT 'SCHEDULE',
    "marketCount" INTEGER NOT NULL DEFAULT 0,
    "analysed" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "potentialSetups" INTEGER NOT NULL DEFAULT 0,
    "waiting" INTEGER NOT NULL DEFAULT 0,
    "highRisk" INTEGER NOT NULL DEFAULT 0,
    "avoided" INTEGER NOT NULL DEFAULT 0,
    "setupsCreated" INTEGER NOT NULL DEFAULT 0,
    "stateChanges" INTEGER NOT NULL DEFAULT 0,
    "invalidations" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,

    CONSTRAINT "ScannerRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScannerResult" (
    "id" TEXT NOT NULL,
    "scannerRunId" TEXT NOT NULL,
    "tradingPairId" TEXT NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "status" "ScannerResultStatus" NOT NULL,
    "analysisStatus" "SetupStatus",
    "score" INTEGER,
    "riskReward" DECIMAL(10,2),
    "riskRewardIsSynthetic" BOOLEAN,
    "analysedAtCandle" BIGINT,
    "trackedSetupId" TEXT,
    "lifecycleStatus" "SetupLifecycleStatus",
    "failureCategory" "ScannerFailureCategory",
    "failureMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScannerResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScannerRun_startedAt_idx" ON "ScannerRun"("startedAt");

-- CreateIndex
CREATE INDEX "ScannerResult_scannerRunId_timeframe_idx" ON "ScannerResult"("scannerRunId", "timeframe");

-- CreateIndex
CREATE INDEX "ScannerResult_tradingPairId_createdAt_idx" ON "ScannerResult"("tradingPairId", "createdAt");

-- AddForeignKey
ALTER TABLE "ScannerResult" ADD CONSTRAINT "ScannerResult_scannerRunId_fkey" FOREIGN KEY ("scannerRunId") REFERENCES "ScannerRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScannerResult" ADD CONSTRAINT "ScannerResult_tradingPairId_fkey" FOREIGN KEY ("tradingPairId") REFERENCES "TradingPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;
