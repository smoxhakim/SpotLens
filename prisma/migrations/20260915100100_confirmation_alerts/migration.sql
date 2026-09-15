-- Phase Q, part 2 of 2: tables and columns.
--
-- Nothing here deletes, rewrites or resets anything. Every existing
-- TelegramConnection row keeps its chatId and becomes the MAIN binding, so no
-- connection is invalidated and the main bot's behaviour is untouched.

-- AlterTable: which bot a binding belongs to.
--
-- The default is what makes this safe on a live table: the two existing rows
-- become MAIN bindings without being read or rewritten. The primary key then
-- widens to (userId, bot) so a second row can exist for the confirmation bot —
-- necessary because Telegram will not let a bot message someone who has never
-- started a chat with that bot, and because each bot has its own getUpdates
-- cursor and its own pending connection code.
--
-- One statement, exactly as `prisma migrate diff` computes it, so the table is
-- never momentarily without a primary key and Prisma's drift detection sees
-- what it expects.
ALTER TABLE "TelegramConnection" DROP CONSTRAINT "TelegramConnection_pkey",
ADD COLUMN     "bot" "TelegramBot" NOT NULL DEFAULT 'MAIN',
ADD CONSTRAINT "TelegramConnection_pkey" PRIMARY KEY ("userId", "bot");

-- AlterTable: the switch for confirmation alerts.
--
-- Defaults on, unlike telegramEnabled, because these reach a bot the user has
-- to create and connect deliberately — connecting it is the opt-in.
ALTER TABLE "NotificationPreference" ADD COLUMN "confirmationAlerts" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable: what the confirmation watcher has already said about a setup.
--
-- One row per tracked setup, created the first time the watcher sees it. That
-- first sight is a baseline: whatever evidence already exists is recorded as
-- known and announces nothing, so arming the watcher over setups that have
-- been open for days cannot produce a burst of messages about evidence the
-- reader never asked to hear about.
--
-- announcedEvidence is a high-water mark, not the last set observed. Evidence
-- that lapses and returns is the same evidence, and re-announcing it on every
-- oscillation is the spam this layer exists to prevent.
CREATE TABLE "SetupConfirmationWatch" (
    "trackedSetupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "announcedEvidence" TEXT NOT NULL,
    "reachedAnnounced" BOOLEAN NOT NULL DEFAULT false,
    "lastEvaluatedAt" BIGINT NOT NULL,
    "baselinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SetupConfirmationWatch_pkey" PRIMARY KEY ("trackedSetupId")
);

-- CreateIndex
CREATE INDEX "SetupConfirmationWatch_userId_idx" ON "SetupConfirmationWatch"("userId");

-- AddForeignKey
-- Cascades with the setup: a watch record for a setup that no longer exists
-- describes nothing.
ALTER TABLE "SetupConfirmationWatch" ADD CONSTRAINT "SetupConfirmationWatch_trackedSetupId_fkey" FOREIGN KEY ("trackedSetupId") REFERENCES "TrackedSetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
