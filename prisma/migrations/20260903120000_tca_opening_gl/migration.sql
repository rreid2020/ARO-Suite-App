-- Opening GL totals for the master TCA listing recon (acquisition cost and accum).
-- NBV is listing cost minus listing accum, agreed to GL cost minus GL accum.
ALTER TABLE "reporting_unit" ADD COLUMN "openingGlTcaCost" DOUBLE PRECISION;
ALTER TABLE "reporting_unit" ADD COLUMN "openingGlTcaAccum" DOUBLE PRECISION;
