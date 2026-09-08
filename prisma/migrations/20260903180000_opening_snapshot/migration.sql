-- Frozen conversion TCA listing and obligation ids, captured when opening balances lock.
-- Go-forward master TCA loads must not overwrite this snapshot.
ALTER TABLE "reporting_unit" ADD COLUMN "openingSnapshot" JSONB;
