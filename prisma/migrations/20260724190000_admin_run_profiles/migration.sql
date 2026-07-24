CREATE TABLE "RunProfile" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "providerModelId" TEXT,
    "reasoningEffort" TEXT NOT NULL DEFAULT 'medium',
    "reasoningMode" TEXT NOT NULL DEFAULT 'standard',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunProfile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RunProfile_id_check" CHECK ("id" IN ('fast', 'balanced', 'deep')),
    CONSTRAINT "RunProfile_description_check" CHECK (char_length("description") BETWEEN 1 AND 240),
    CONSTRAINT "RunProfile_reasoning_effort_check" CHECK (char_length("reasoningEffort") BETWEEN 1 AND 64),
    CONSTRAINT "RunProfile_reasoning_mode_check" CHECK (char_length("reasoningMode") BETWEEN 1 AND 64),
    CONSTRAINT "RunProfile_version_check" CHECK ("version" >= 1),
    CONSTRAINT "RunProfile_enabled_target_check" CHECK ("enabled" = ("providerModelId" IS NOT NULL))
);

CREATE INDEX "RunProfile_providerModelId_idx" ON "RunProfile"("providerModelId");
CREATE INDEX "RunProfile_updatedByUserId_idx" ON "RunProfile"("updatedByUserId");

ALTER TABLE "RunProfile"
ADD CONSTRAINT "RunProfile_providerModelId_fkey"
FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RunProfile"
ADD CONSTRAINT "RunProfile_updatedByUserId_fkey"
FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

WITH defaults("id", "description", "templateKey", "reasoningEffort", "reasoningMode") AS (
    VALUES
      ('fast', 'Simple, well-defined questions', 'openai:gpt-5.6-luna', 'medium', 'standard'),
      ('balanced', 'Most everyday questions', 'openai:gpt-5.6-terra', 'medium', 'standard'),
      ('deep', 'Difficult or open-ended questions', 'openai:gpt-5.6-sol', 'max', 'pro')
)
INSERT INTO "RunProfile" (
    "id",
    "description",
    "enabled",
    "providerModelId",
    "reasoningEffort",
    "reasoningMode",
    "version",
    "createdAt",
    "updatedAt"
)
SELECT
    defaults."id",
    defaults."description",
    model."id" IS NOT NULL,
    model."id",
    defaults."reasoningEffort",
    defaults."reasoningMode",
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM defaults
LEFT JOIN "ProviderModel" AS model
  ON model."templateKey" = defaults."templateKey";
