-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO');

-- CreateEnum
CREATE TYPE "Timeframe" AS ENUM ('M15', 'H1', 'H4', 'D1', 'W1');

-- CreateEnum
CREATE TYPE "AssetCategory" AS ENUM ('LAYER1', 'LAYER2', 'INFRASTRUCTURE', 'ORACLE', 'DEFI_INFRASTRUCTURE', 'PAYMENTS', 'OTHER');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "Trend" AS ENUM ('BULLISH', 'BEARISH', 'SIDEWAYS');

-- CreateEnum
CREATE TYPE "SetupStatus" AS ENUM ('POTENTIAL_SETUP', 'WAIT_FOR_CONFIRMATION', 'HIGH_RISK', 'AVOID');

-- CreateEnum
CREATE TYPE "YesNoUnclear" AS ENUM ('YES', 'NO', 'UNCLEAR');

-- CreateEnum
CREATE TYPE "BacktestStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SetupOutcome" AS ENUM ('TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'SL_HIT', 'NO_HIT', 'STILL_OPEN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "passwordHash" TEXT,
    "name" TEXT,
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "defaultRiskPercent" DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    "defaultTimeframe" "Timeframe" NOT NULL DEFAULT 'H1',
    "acceptedTermsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "AssetCategory" NOT NULL,
    "officialWebsite" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "utilityExplanation" TEXT NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingPair" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "exchangeSymbol" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TradingPair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EthicalChecklist" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "whatProjectDoes" TEXT NOT NULL,
    "tokenUtility" TEXT NOT NULL,
    "involvesInterestLending" "YesNoUnclear" NOT NULL,
    "involvesInterestLendingNote" TEXT,
    "supportsGambling" "YesNoUnclear" NOT NULL,
    "supportsGamblingNote" TEXT,
    "supportsProhibitedIndustries" "YesNoUnclear" NOT NULL,
    "supportsProhibitedNote" TEXT,
    "hasClearUtility" "YesNoUnclear" NOT NULL,
    "hasClearUtilityNote" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "EthicalChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "id" TEXT NOT NULL,
    "tradingPairId" TEXT NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(24,8) NOT NULL,
    "high" DECIMAL(24,8) NOT NULL,
    "low" DECIMAL(24,8) NOT NULL,
    "close" DECIMAL(24,8) NOT NULL,
    "volume" DECIMAL(30,8) NOT NULL,
    "closeTime" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Watchlist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tradingPairId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "tradingPairId" TEXT NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "trend" "Trend" NOT NULL,
    "trendReason" TEXT NOT NULL,
    "supportZones" JSONB NOT NULL,
    "resistanceZones" JSONB NOT NULL,
    "entryLow" DECIMAL(24,8) NOT NULL,
    "entryHigh" DECIMAL(24,8) NOT NULL,
    "entryReason" TEXT NOT NULL,
    "confirmationChecklist" JSONB NOT NULL,
    "stopLoss" DECIMAL(24,8) NOT NULL,
    "stopLossReason" TEXT NOT NULL,
    "takeProfits" JSONB NOT NULL,
    "riskRewardRatio" DECIMAL(10,2) NOT NULL,
    "setupScore" INTEGER NOT NULL,
    "setupScoreBreakdown" JSONB NOT NULL,
    "status" "SetupStatus" NOT NULL,
    "statusReason" TEXT NOT NULL,
    "indicatorsSnapshot" JSONB NOT NULL,
    "mtfSummary" JSONB,
    "disclaimerVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tradingPairId" TEXT NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "BacktestStatus" NOT NULL DEFAULT 'QUEUED',
    "numSetups" INTEGER,
    "winRate" DECIMAL(5,2),
    "avgRealizedRR" DECIMAL(10,2),
    "maxDrawdownPct" DECIMAL(6,2),
    "bestSetupId" TEXT,
    "worstSetupId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestSetup" (
    "id" TEXT NOT NULL,
    "backtestRunId" TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL,
    "entry" DECIMAL(24,8) NOT NULL,
    "stopLoss" DECIMAL(24,8) NOT NULL,
    "takeProfits" JSONB NOT NULL,
    "outcome" "SetupOutcome" NOT NULL,
    "realizedRR" DECIMAL(10,2),
    "exitTime" TIMESTAMP(3),
    "exitPrice" DECIMAL(24,8),

    CONSTRAINT "BacktestSetup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearnArticle" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "relatedConceptTags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "diff" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "plan" "Plan" NOT NULL,
    "status" TEXT NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_symbol_key" ON "Asset"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "TradingPair_exchangeSymbol_key" ON "TradingPair"("exchangeSymbol");

-- CreateIndex
CREATE UNIQUE INDEX "TradingPair_assetId_quoteCurrency_key" ON "TradingPair"("assetId", "quoteCurrency");

-- CreateIndex
CREATE UNIQUE INDEX "EthicalChecklist_assetId_key" ON "EthicalChecklist"("assetId");

-- CreateIndex
CREATE INDEX "Candle_tradingPairId_timeframe_openTime_idx" ON "Candle"("tradingPairId", "timeframe", "openTime");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_tradingPairId_timeframe_openTime_key" ON "Candle"("tradingPairId", "timeframe", "openTime");

-- CreateIndex
CREATE UNIQUE INDEX "Watchlist_userId_tradingPairId_key" ON "Watchlist"("userId", "tradingPairId");

-- CreateIndex
CREATE INDEX "AnalysisSnapshot_userId_createdAt_idx" ON "AnalysisSnapshot"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BacktestRun_userId_createdAt_idx" ON "BacktestRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BacktestSetup_backtestRunId_triggeredAt_idx" ON "BacktestSetup"("backtestRunId", "triggeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "LearnArticle_slug_key" ON "LearnArticle"("slug");

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminUserId_createdAt_idx" ON "AdminAuditLog"("adminUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingPair" ADD CONSTRAINT "TradingPair_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EthicalChecklist" ADD CONSTRAINT "EthicalChecklist_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EthicalChecklist" ADD CONSTRAINT "EthicalChecklist_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candle" ADD CONSTRAINT "Candle_tradingPairId_fkey" FOREIGN KEY ("tradingPairId") REFERENCES "TradingPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watchlist" ADD CONSTRAINT "Watchlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watchlist" ADD CONSTRAINT "Watchlist_tradingPairId_fkey" FOREIGN KEY ("tradingPairId") REFERENCES "TradingPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisSnapshot" ADD CONSTRAINT "AnalysisSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisSnapshot" ADD CONSTRAINT "AnalysisSnapshot_tradingPairId_fkey" FOREIGN KEY ("tradingPairId") REFERENCES "TradingPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_tradingPairId_fkey" FOREIGN KEY ("tradingPairId") REFERENCES "TradingPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestSetup" ADD CONSTRAINT "BacktestSetup_backtestRunId_fkey" FOREIGN KEY ("backtestRunId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

