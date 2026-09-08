-- Tenant-owned cost-estimate templates (description / qty / optional rate rows).
ALTER TABLE "tenant_settings" ADD COLUMN "costEstimateTemplates" JSONB NOT NULL DEFAULT '[]';
