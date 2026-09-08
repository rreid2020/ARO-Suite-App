-- Opening GL totals for the ARO asset: gross acquisition cost and accumulated amortization.
-- NBV is listing ARO asset minus listing accum, agreed to GL cost minus GL accum.
ALTER TABLE "reporting_unit" ADD COLUMN "openingGlAroCost" DOUBLE PRECISION;
ALTER TABLE "reporting_unit" ADD COLUMN "openingGlAroAccum" DOUBLE PRECISION;
