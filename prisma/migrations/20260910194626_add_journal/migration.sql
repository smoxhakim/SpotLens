-- CreateEnum
CREATE TYPE "JournalDecision" AS ENUM ('WATCHING', 'SKIPPED', 'TAKEN', 'CANCELLED', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalSkipReason" AS ENUM ('LOW_CONFIDENCE', 'POOR_RR', 'BAD_REGIME', 'NO_CONFIRMATION', 'PERSONAL_RULE', 'MARKET_CONDITION', 'MISSED_ENTRY', 'OTHER');

-- CreateEnum
CREATE TYPE "TradeExitReason" AS ENUM ('TAKE_PROFIT', 'STOP_LOSS', 'MANUAL_EXIT', 'INVALIDATED', 'OTHER');

-- CreateEnum
CREATE TYPE "JournalEventType" AS ENUM ('CREATED', 'DECISION_CHANGED', 'OUTCOME_RECORDED', 'NOTE_ADDED');

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackedSetupId" TEXT NOT NULL,
    "decision" "JournalDecision" NOT NULL DEFAULT 'WATCHING',
    "setupStatusAtDecision" "SetupLifecycleStatus" NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "skipReason" "JournalSkipReason",
    "notes" TEXT,
    "actualEntry" DECIMAL(24,8),
    "actualStopLoss" DECIMAL(24,8),
    "actualTakeProfit" DECIMAL(24,8),
    "actualExit" DECIMAL(24,8),
    "quantity" DECIMAL(30,8),
    "fees" DECIMAL(24,8),
    "slippage" DECIMAL(24,8),
    "exitReason" "TradeExitReason",
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEvent" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "type" "JournalEventType" NOT NULL,
    "fromDecision" "JournalDecision",
    "toDecision" "JournalDecision" NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JournalEntry_userId_decidedAt_idx" ON "JournalEntry"("userId", "decidedAt");

-- CreateIndex
CREATE INDEX "JournalEntry_userId_decision_idx" ON "JournalEntry"("userId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_trackedSetupId_key" ON "JournalEntry"("trackedSetupId");

-- CreateIndex
CREATE INDEX "JournalEvent_journalEntryId_createdAt_idx" ON "JournalEvent"("journalEntryId", "createdAt");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_trackedSetupId_fkey" FOREIGN KEY ("trackedSetupId") REFERENCES "TrackedSetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEvent" ADD CONSTRAINT "JournalEvent_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
