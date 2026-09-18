ALTER TABLE "SystemModelPolicy" ADD COLUMN "chatTitleConfiguredAt" TIMESTAMP(3);

-- Existing NULL may mean an explicit clear. Preserve all prior choices,
-- including writes from the previous release during the replacement window.
-- The untouched baseline policy (version 1) is also created by fresh deploys.
-- Every prior policy save/clear increments version, including title changes.
UPDATE "SystemModelPolicy" SET "chatTitleConfiguredAt" = CURRENT_TIMESTAMP
WHERE version > 1 OR "updatedByUserId" IS NOT NULL OR "chatTitleProviderModelId" IS NOT NULL;
