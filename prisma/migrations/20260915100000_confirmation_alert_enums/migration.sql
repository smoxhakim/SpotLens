-- Phase Q, part 1 of 2: enum values only.
--
-- Split from the schema changes that use them because PostgreSQL refuses to
-- use a value added by ALTER TYPE ... ADD VALUE inside the same transaction
-- that added it, and Prisma runs each migration file in one transaction. The
-- next migration is what creates the column defaulting to 'MAIN'.
--
-- Additive in every sense: no existing row's value changes, and every existing
-- read of these enums keeps working unchanged.

-- AlterEnum
-- Confirmation traffic gets its own event types so it can be routed, counted
-- and switched off separately from the lifecycle events it sits beside.
ALTER TYPE "NotificationEventType" ADD VALUE 'CONFIRMATION_EVIDENCE';
ALTER TYPE "NotificationEventType" ADD VALUE 'CONFIRMATION_REACHED';

-- AlterEnum
-- A second Telegram destination. The unique index on Notification is per
-- channel, so the confirmation bot gets its own deduplication namespace and
-- cannot silence, or be silenced by, the main bot.
ALTER TYPE "NotificationChannel" ADD VALUE 'TELEGRAM_CONFIRMATION';

-- CreateEnum
CREATE TYPE "TelegramBot" AS ENUM ('MAIN', 'CONFIRMATION');
