ALTER TABLE "UserSettings"
  ALTER COLUMN "defaultWorkspaceEnabled" SET DEFAULT true;

UPDATE "UserSettings"
SET "defaultWorkspaceEnabled" = true
WHERE "defaultWorkspaceEnabled" = false;
