ALTER TABLE "WorkspacePolicy"
  ALTER COLUMN "enabled" SET DEFAULT true;

-- The original migration seeds an Off singleton even on a fresh install.
-- Every administrator save advances version; preserve all saved choices,
-- including those whose author has since been deleted.
UPDATE "WorkspacePolicy"
SET "enabled" = true, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'installation'
  AND "enabled" = false
  AND "version" = 1
  AND "updatedByUserId" IS NULL;
