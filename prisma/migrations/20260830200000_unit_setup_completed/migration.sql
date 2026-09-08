-- Per-unit confirmation that framework, assumptions and the discount table
-- have been reviewed. Company setup only names the entity, year end and currency.
ALTER TABLE "reporting_unit" ADD COLUMN "setupCompletedAt" TIMESTAMP(3);
