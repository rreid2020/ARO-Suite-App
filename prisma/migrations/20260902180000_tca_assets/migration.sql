-- Master TCA / PPE listing. Obligation assetId matches assetNumber.
-- An asset with a related obligation is in scope; remaining rows are marked
-- In scope, Out of scope, or Undecided so the listing has no unmarked gaps.
CREATE TABLE "tca_asset" (
    "id" TEXT NOT NULL,
    "reportingUnitId" TEXT NOT NULL,
    "assetNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "assetClass" TEXT NOT NULL DEFAULT '',
    "acquisitionDate" TEXT NOT NULL DEFAULT '',
    "site" TEXT NOT NULL DEFAULT '',
    "scope" TEXT NOT NULL DEFAULT 'Undecided',
    "scopeReason" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tca_asset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tca_asset_reportingUnitId_assetNumber_key" ON "tca_asset"("reportingUnitId", "assetNumber");
CREATE INDEX "tca_asset_reportingUnitId_idx" ON "tca_asset"("reportingUnitId");

ALTER TABLE "tca_asset" ADD CONSTRAINT "tca_asset_reportingUnitId_fkey" FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
