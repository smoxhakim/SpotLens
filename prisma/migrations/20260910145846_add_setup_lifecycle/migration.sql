-- CreateEnum
CREATE TYPE "SetupLifecycleStatus" AS ENUM ('SETUP_FORMING', 'WAITING_CONFIRMATION', 'CONFIRMATION_DETECTED', 'POTENTIAL_SETUP', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "SetupEventType" AS ENUM ('CREATED', 'STATUS_CHANGED', 'CONFIRMATION_DETECTED', 'POTENTIAL_SETUP', 'INVALIDATED');

-- CreateTable
CREATE TABLE "TrackedSetup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tradingPairId" TEXT NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "status" "SetupLifecycleStatus" NOT NULL,
    "entryLow" DECIMAL(24,8) NOT NULL,
    "entryHigh" DECIMAL(24,8) NOT NULL,
    "stopLoss" DECIMAL(24,8) NOT NULL,
    "takeProfit1" DECIMAL(24,8),
    "takeProfit2" DECIMAL(24,8),
    "takeProfit3" DECIMAL(24,8),
    "riskReward" DECIMAL(10,2) NOT NULL,
    "riskRewardIsSynthetic" BOOLEAN NOT NULL,
    "score" INTEGER NOT NULL,
    "scoreGrade" TEXT NOT NULL,
    "analysisStatus" "SetupStatus" NOT NULL,
    "snapshot" JSONB NOT NULL,
    "originZoneLow" DECIMAL(24,8) NOT NULL,
    "originZoneHigh" DECIMAL(24,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "invalidationReason" TEXT,
    "analysisSnapshotId" TEXT,

    CONSTRAINT "TrackedSetup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SetupEvent" (
    "id" TEXT NOT NULL,
    "setupId" TEXT NOT NULL,
    "type" "SetupEventType" NOT NULL,
    "fromStatus" "SetupLifecycleStatus",
    "toStatus" "SetupLifecycleStatus" NOT NULL,
    "detail" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SetupEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackedSetup_userId_tradingPairId_timeframe_status_idx" ON "TrackedSetup"("userId", "tradingPairId", "timeframe", "status");

-- CreateIndex
CREATE INDEX "TrackedSetup_userId_createdAt_idx" ON "TrackedSetup"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SetupEvent_setupId_createdAt_idx" ON "SetupEvent"("setupId", "createdAt");

-- AddForeignKey
ALTER TABLE "TrackedSetup" ADD CONSTRAINT "TrackedSetup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedSetup" ADD CONSTRAINT "TrackedSetup_tradingPairId_fkey" FOREIGN KEY ("tradingPairId") REFERENCES "TradingPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupEvent" ADD CONSTRAINT "SetupEvent_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "TrackedSetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
