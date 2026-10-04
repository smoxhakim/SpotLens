-- Live entry-zone monitoring.
--
-- Additive in every sense: no existing row's value changes, nothing is
-- dropped, and every existing read keeps working unchanged.
--
-- One file rather than Phase Q's two: the new enum value is added here but not
-- *used* here (no default, no row), which is the only thing PostgreSQL refuses
-- inside the transaction that added it.

-- AlterEnum
-- One canonical event for "price moved into a tracked setup's entry zone".
ALTER TYPE "NotificationEventType" ADD VALUE 'ENTRY_ZONE_REACHED';

-- AlterTable
-- The switch for it. Defaults on: the event is at most one per setup, and
-- Telegram still only carries the routed subset.
ALTER TABLE "NotificationPreference" ADD COLUMN     "entryZoneReached" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
-- What the monitor must remember across a restart: whether the setup has been
-- seen outside its zone, and whether its one alert has been raised. Written on
-- those two transitions only, never per price tick.
CREATE TABLE "SetupEntryZoneWatch" (
    "trackedSetupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "armedAt" TIMESTAMP(3),
    "reachedAt" TIMESTAMP(3),
    "reachedPrice" DECIMAL(24,8),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SetupEntryZoneWatch_pkey" PRIMARY KEY ("trackedSetupId")
);

-- CreateIndex
CREATE INDEX "SetupEntryZoneWatch_userId_idx" ON "SetupEntryZoneWatch"("userId");

-- AddForeignKey
-- Cascades with the setup: a watch for a setup that no longer exists
-- describes nothing.
ALTER TABLE "SetupEntryZoneWatch" ADD CONSTRAINT "SetupEntryZoneWatch_trackedSetupId_fkey" FOREIGN KEY ("trackedSetupId") REFERENCES "TrackedSetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
