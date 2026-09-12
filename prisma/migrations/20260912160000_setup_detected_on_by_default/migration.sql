-- Potential setups default on for new accounts.
--
-- The rarest event the engine produces was the only valuable one defaulting
-- off, while the noisiest defaulted on. This changes the column default only:
-- ALTER COLUMN ... SET DEFAULT does not touch existing rows, so every account
-- that has already chosen keeps exactly what it chose.
ALTER TABLE "NotificationPreference" ALTER COLUMN "setupDetected" SET DEFAULT true;
