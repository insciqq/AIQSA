-- Existing Personal Memory versions were written before the v1 semantic
-- safety boundary.  Keep their immutable content, but fence every version
-- until the reclassification worker records an installation System Model
-- decision.  New versions use CLASSIFIED as the application-side default.
CREATE TYPE "MemorySafetyClassificationState" AS ENUM (
  'PENDING',
  'CLASSIFIED',
  'UNCERTAIN',
  'SECRET_FENCED'
);

ALTER TABLE "MemoryFactVersion"
  ADD COLUMN "safetyClassificationState" "MemorySafetyClassificationState"
    NOT NULL DEFAULT 'CLASSIFIED',
  ADD COLUMN "safetyClassifierProviderId" VARCHAR(128),
  ADD COLUMN "safetyClassifierModelId" VARCHAR(256),
  ADD COLUMN "safetyClassifierPolicyVersion" VARCHAR(64),
  ADD COLUMN "safetyClassifiedAt" TIMESTAMP(3);

-- The migration itself is not a semantic classifier. Fence only canonical
-- Personal-v1 global facts for the durable RECLASSIFY_FACTS coordinator job;
-- legacy target-scoped facts and the separate Project Memory tables stay
-- untouched and dormant.
UPDATE "MemoryFactVersion" AS version
SET
  "safetyClassificationState" = 'PENDING',
  "safetyClassifierProviderId" = NULL,
  "safetyClassifierModelId" = NULL,
  "safetyClassifierPolicyVersion" = NULL,
  "safetyClassifiedAt" = NULL
FROM "MemoryFact" AS fact
INNER JOIN "MemoryScope" AS scope
  ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
WHERE version."userId" = fact."userId"
  AND version."factId" = fact."id"
  AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
  AND scope."targetIdSnapshot" IS NULL
  AND scope."targetDisplaySnapshot" IS NULL
  AND scope."folderId" IS NULL
  AND scope."assistantId" IS NULL
  AND scope."chatId" IS NULL;

CREATE INDEX "MemoryFactVersion_userId_safetyClassificationState_state_idx"
  ON "MemoryFactVersion"("userId", "safetyClassificationState", "state");

ALTER TABLE "MemoryFactVersion"
  ALTER COLUMN "safetyClassifierProviderId"
    SET DEFAULT 'installation-system-model',
  ALTER COLUMN "safetyClassifierModelId"
    SET DEFAULT 'policy-selected',
  ALTER COLUMN "safetyClassifierPolicyVersion"
    SET DEFAULT 'memory-safety-classification-v1',
  ALTER COLUMN "safetyClassifiedAt"
    SET DEFAULT CURRENT_TIMESTAMP;

ALTER TYPE "MemoryJobKind" ADD VALUE 'RECLASSIFY_FACTS';
