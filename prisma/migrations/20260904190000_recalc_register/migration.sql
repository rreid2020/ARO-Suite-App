-- Mode 1 — the recalculation register (BUILD-SEQUENCE Phase 2).
--
-- One register per reporting unit, holding the assumptions the independent
-- recalculation runs on, the provenance of the extracts it was built from and
-- the trial-balance control total that proves the population complete.

CREATE TABLE "recalc_register" (
    "id" TEXT NOT NULL,
    "reportingUnitId" TEXT NOT NULL,
    "fyEnd" TEXT NOT NULL,
    "inflation" DOUBLE PRECISION NOT NULL,
    "materialityUsd" DOUBLE PRECISION NOT NULL,
    "materialityPct" DOUBLE PRECISION NOT NULL,
    "curve" JSONB,
    "curveSource" TEXT NOT NULL,
    "rep04" JSONB,
    "rep06" JSONB,
    "trialBalancePv" DOUBLE PRECISION,
    "seeded" BOOLEAN NOT NULL DEFAULT true,
    "signedOffBy" TEXT,
    "signedOffAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recalc_register_pkey" PRIMARY KEY ("id")
);

-- One register per unit.
CREATE UNIQUE INDEX "recalc_register_reportingUnitId_key" ON "recalc_register"("reportingUnitId");

-- The obligation number is deliberately NOT unique: a duplicate obligation
-- across two extracts is a blocker the register has to hold and report, not
-- something the schema silently drops on the floor (INVARIANTS §5).
CREATE TABLE "recalc_register_row" (
    "id" TEXT NOT NULL,
    "registerId" TEXT NOT NULL,
    "obligationNo" TEXT NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "costEstimateDate" TEXT NOT NULL,
    "settlementDate" TEXT NOT NULL,
    "rateOverride" DOUBLE PRECISION,
    "sourceFv" DOUBLE PRECISION,
    "sourcePv" DOUBLE PRECISION,
    "ord" INTEGER NOT NULL,

    CONSTRAINT "recalc_register_row_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recalc_register_row_registerId_idx" ON "recalc_register_row"("registerId");

ALTER TABLE "recalc_register" ADD CONSTRAINT "recalc_register_reportingUnitId_fkey"
    FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recalc_register_row" ADD CONSTRAINT "recalc_register_row_registerId_fkey"
    FOREIGN KEY ("registerId") REFERENCES "recalc_register"("id") ON DELETE CASCADE ON UPDATE CASCADE;
