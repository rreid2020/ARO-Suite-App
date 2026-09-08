-- Posting scenarios map engine roles onto imported GLs. ARO asset classes
-- pick a scenario so obligations with different charts (wells vs plant, …)
-- do not share a single provision or retirement-cost-asset account.

CREATE TABLE "posting_scenario" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "roleAccounts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posting_scenario_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "aro_asset_class" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aro_asset_class_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "posting_scenario_tenantId_idx" ON "posting_scenario"("tenantId");
CREATE INDEX "aro_asset_class_tenantId_idx" ON "aro_asset_class"("tenantId");
CREATE INDEX "aro_asset_class_scenarioId_idx" ON "aro_asset_class"("scenarioId");
CREATE UNIQUE INDEX "aro_asset_class_tenantId_name_key" ON "aro_asset_class"("tenantId", "name");

ALTER TABLE "posting_scenario" ADD CONSTRAINT "posting_scenario_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "aro_asset_class" ADD CONSTRAINT "aro_asset_class_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "aro_asset_class" ADD CONSTRAINT "aro_asset_class_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "posting_scenario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing tenants: one default scenario from account.engineRole, plus an
-- asset class per distinct leftover mapping so journals keep posting.
INSERT INTO "posting_scenario" ("id", "tenantId", "name", "isDefault", "roleAccounts", "createdAt", "updatedAt")
SELECT
    t.id || '-scn-default',
    t.id,
    'Standard ARO',
    true,
    COALESCE(
        (SELECT jsonb_object_agg(a."engineRole", a.id)
         FROM "account" a
         WHERE a."tenantId" = t.id AND a."engineRole" <> ''),
        '{}'::jsonb
    ),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "tenant" t;
