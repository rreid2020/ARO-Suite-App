-- Persist per-role "complete" marks on a posting scenario so GL assignment
-- can be resumed after leaving company setup.
ALTER TABLE "posting_scenario" ADD COLUMN "completedRoles" JSONB NOT NULL DEFAULT '[]';
