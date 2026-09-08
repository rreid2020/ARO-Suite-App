-- One ARO asset class per common obligation type, all on the tenant's default
-- scenario. Organisations split scenarios later when their chart has more than
-- one provision or retirement-cost-asset GL.

INSERT INTO "aro_asset_class" ("id", "tenantId", "name", "scenarioId", "createdAt", "updatedAt")
SELECT
    t.id || '-cls-' || n.ord,
    t.id,
    n.name,
    t.id || '-scn-default',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "tenant" t
CROSS JOIN (VALUES
    (0, 'Well abandonment'),
    (1, 'Site restoration'),
    (2, 'Plant decommissioning'),
    (3, 'Pipeline removal'),
    (4, 'Tailings closure'),
    (5, 'Mine reclamation')
) AS n(ord, name)
ON CONFLICT ("tenantId", "name") DO NOTHING;
