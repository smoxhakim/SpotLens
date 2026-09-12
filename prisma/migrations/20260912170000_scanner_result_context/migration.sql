-- Context on a scanner result, for the shortlist's explanation.
--
-- Nullable and additive: existing rows keep their meaning, and a shortlist
-- built from them simply has fewer lines to say. Written at scan time from the
-- analysis the scanner already produced, so no new computation and no reading
-- of a frozen setup snapshot.
ALTER TABLE "ScannerResult" ADD COLUMN "trend" TEXT;
ALTER TABLE "ScannerResult" ADD COLUMN "mtfAgreement" TEXT;
ALTER TABLE "ScannerResult" ADD COLUMN "regimeDirection" TEXT;
