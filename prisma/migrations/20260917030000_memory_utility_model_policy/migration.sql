CREATE TYPE "MemoryUtilityAssignmentSource" AS ENUM ('UNASSIGNED', 'INHERITED', 'BOOTSTRAP', 'OPERATOR');

CREATE TABLE "MemoryUtilityModelPolicy" (
  "id" TEXT NOT NULL,
  "providerModelId" TEXT,
  "reasoningEffort" VARCHAR(32),
  "assignmentSource" "MemoryUtilityAssignmentSource" NOT NULL DEFAULT 'UNASSIGNED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MemoryUtilityModelPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryUtilityModelPolicy_singleton_check" CHECK ("id" = 'installation'),
  CONSTRAINT "MemoryUtilityModelPolicy_version_check" CHECK ("version" >= 1),
  CONSTRAINT "MemoryUtilityModelPolicy_reasoning_check" CHECK (
    "providerModelId" IS NOT NULL OR "reasoningEffort" IS NULL
  ),
  CONSTRAINT "MemoryUtilityModelPolicy_assignment_check" CHECK (
    "assignmentSource" <> 'UNASSIGNED' OR "providerModelId" IS NULL
  ),
  CONSTRAINT "MemoryUtilityModelPolicy_providerModelId_fkey" FOREIGN KEY ("providerModelId")
    REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MemoryUtilityModelPolicy_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "MemoryUtilityModelPolicy_providerModelId_idx" ON "MemoryUtilityModelPolicy"("providerModelId");
CREATE INDEX "MemoryUtilityModelPolicy_updatedByUserId_idx" ON "MemoryUtilityModelPolicy"("updatedByUserId");

-- Preserve the exact revision as well as the model/reasoning. Accepted Memory
-- execution fingerprints include that revision and must survive this split.
-- Keep the old policy writable for the previous release during replacement.
INSERT INTO "MemoryUtilityModelPolicy" (
  "id", "providerModelId", "reasoningEffort", "assignmentSource", "version",
  "updatedByUserId", "createdAt", "updatedAt"
)
SELECT "id", "providerModelId", "reasoningEffort",
  CASE WHEN "providerModelId" IS NULL AND "version" = 1 AND "updatedByUserId" IS NULL
    THEN 'UNASSIGNED' ELSE 'INHERITED' END::"MemoryUtilityAssignmentSource",
  "version", "updatedByUserId", "createdAt", "updatedAt"
FROM "SystemModelPolicy" WHERE "id" = 'installation'
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "MemoryUtilityModelPolicy" ("id", "updatedAt")
VALUES ('installation', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
