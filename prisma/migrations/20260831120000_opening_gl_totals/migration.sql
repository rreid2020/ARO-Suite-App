-- Opening trial-balance totals for the one-time conversion load.
-- The TB is GL totals only; obligation-level balances live on the extract.
ALTER TABLE "reporting_unit" ADD COLUMN "openingGlProvision" DOUBLE PRECISION;
ALTER TABLE "reporting_unit" ADD COLUMN "openingGlArc" DOUBLE PRECISION;
