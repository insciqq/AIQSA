-- Only installations which already exist at this upgrade need startup adoption.
-- Fresh installations use the ordinary OpenRouter setup and its verified defaults.
ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "decisionAdoptionVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "decisionAdoptionReason" VARCHAR(32);
UPDATE "SystemModelPolicy" SET "decisionAdoptionVersion" = 0;
