-- Per-GL extra columns from the organisation's own chart file.
-- Headings differ by tenant, so values live in JSON rather than fixed columns.
ALTER TABLE "account" ADD COLUMN "columns" JSONB NOT NULL DEFAULT '{}';
