-- Split ARO asset class into code and name so the register and posting
-- scenarios share the same identity (ANLKL / class code vs class name).

ALTER TABLE "aro_asset_class" ADD COLUMN "code" TEXT NOT NULL DEFAULT '';

UPDATE "aro_asset_class"
SET
  "code" = TRIM(SPLIT_PART(REPLACE(REPLACE("name", ' — ', ' '), ' – ', ' '), ' ', 1)),
  "name" = TRIM(SUBSTRING(
    REPLACE(REPLACE("name", ' — ', ' '), ' – ', ' ')
    FROM POSITION(' ' IN REPLACE(REPLACE("name", ' — ', ' '), ' – ', ' ')) + 1
  ))
WHERE "name" ~ '^[0-9]+[ —–-]';

CREATE INDEX "aro_asset_class_tenantId_code_idx" ON "aro_asset_class"("tenantId", "code");
