-- Align prompt default flags with the persisted user default prompt.
UPDATE "PromptPreset"
SET "isDefault" = false;

UPDATE "PromptPreset" AS "prompt"
SET "isDefault" = true
FROM "UserSettings" AS "settings"
WHERE "settings"."userId" = "prompt"."userId"
  AND "settings"."defaultPromptPresetId" = "prompt"."id";

CREATE UNIQUE INDEX "PromptPreset_one_default_per_user_idx"
ON "PromptPreset"("userId")
WHERE "isDefault" = true;
