-- Hourly 1h scan reports on Telegram.
--
-- Additive in every sense: no existing row's value changes, nothing is
-- dropped, and every existing read keeps working unchanged.
--
-- One file, as with the entry-zone monitor: the new enum value is added here
-- but not *used* here (no default, no row), which is the only thing PostgreSQL
-- refuses inside the transaction that added it.

-- AlterEnum
-- Its own type, so a report is never counted as a daily summary or as an
-- alert, and its rows can be told apart in every count that groups by type.
ALTER TYPE "NotificationEventType" ADD VALUE 'SCAN_REPORT';

-- AlterTable
-- The switch for it. Defaults off: twenty-four messages a day is a volume
-- someone has to choose, and `telegramEnabled` must be on as well.
ALTER TABLE "NotificationPreference" ADD COLUMN     "scanReport" BOOLEAN NOT NULL DEFAULT false;
