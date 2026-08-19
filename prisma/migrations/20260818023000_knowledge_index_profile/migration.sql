CREATE TYPE "KnowledgeIndexProfileExecutionAuthority" AS ENUM ('installation', 'legacy_user');
CREATE TYPE "KnowledgeIndexProfilePreflightStatus" AS ENUM ('ready', 'failed');

CREATE TABLE "KnowledgeIndexProfile" (
  "id" TEXT NOT NULL,
  "activeRevisionId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeIndexProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeIndexProfile_version_check" CHECK ("version" > 0)
);

CREATE TABLE "KnowledgeIndexProfileRevision" (
  "id" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "revisionNumber" INTEGER NOT NULL,
  "embeddingProviderModelId" TEXT NOT NULL,
  "embeddingConfiguration" JSONB NOT NULL,
  "vectorSpaceFingerprint" CHAR(64) NOT NULL,
  "targetDimension" INTEGER NOT NULL,
  "chunkingProfileVersion" INTEGER NOT NULL,
  "executionAuthority" "KnowledgeIndexProfileExecutionAuthority" NOT NULL,
  "profileConfiguration" JSONB NOT NULL,
  "egressPolicy" JSONB NOT NULL,
  "preflightStatus" "KnowledgeIndexProfilePreflightStatus" NOT NULL,
  "preflightErrorCode" VARCHAR(64),
  "preflightCheckedAt" TIMESTAMP(3) NOT NULL,
  "activatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeIndexProfileRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeIndexProfileRevision_revisionNumber_check" CHECK ("revisionNumber" > 0),
  CONSTRAINT "KnowledgeIndexProfileRevision_targetDimension_check" CHECK ("targetDimension" > 0),
  CONSTRAINT "KnowledgeIndexProfileRevision_chunkingProfileVersion_check" CHECK ("chunkingProfileVersion" > 0),
  CONSTRAINT "KnowledgeIndexProfileRevision_fingerprint_check" CHECK (btrim("vectorSpaceFingerprint") ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "KnowledgeIndexProfileRevision_configuration_check" CHECK (
    jsonb_typeof("embeddingConfiguration") = 'object' AND
    jsonb_typeof("profileConfiguration") = 'object' AND
    jsonb_typeof("egressPolicy") = 'object'
  ),
  CONSTRAINT "KnowledgeIndexProfileRevision_preflight_check" CHECK (
    ("preflightStatus" = 'ready' AND "preflightErrorCode" IS NULL) OR
    ("preflightStatus" = 'failed' AND "preflightErrorCode" IS NOT NULL)
  )
);

ALTER TABLE "KnowledgeIndexGeneration"
  ADD COLUMN "profileRevisionId" TEXT;

CREATE UNIQUE INDEX "KnowledgeIndexProfile_activeRevisionId_key"
  ON "KnowledgeIndexProfile"("activeRevisionId");
CREATE UNIQUE INDEX "KnowledgeIndexProfile_id_activeRevisionId_key"
  ON "KnowledgeIndexProfile"("id", "activeRevisionId");
CREATE INDEX "KnowledgeIndexProfile_updatedByUserId_idx"
  ON "KnowledgeIndexProfile"("updatedByUserId");
CREATE UNIQUE INDEX "KnowledgeIndexProfileRevision_profileId_revisionNumber_key"
  ON "KnowledgeIndexProfileRevision"("profileId", "revisionNumber");
CREATE UNIQUE INDEX "KnowledgeIndexProfileRevision_profileId_id_key"
  ON "KnowledgeIndexProfileRevision"("profileId", "id");
CREATE INDEX "KnowledgeIndexProfileRevision_embeddingProviderModelId_idx"
  ON "KnowledgeIndexProfileRevision"("embeddingProviderModelId");
CREATE INDEX "KnowledgeIndexProfileRevision_profileId_activatedAt_idx"
  ON "KnowledgeIndexProfileRevision"("profileId", "activatedAt");
CREATE INDEX "KnowledgeIndexGeneration_profileRevisionId_idx"
  ON "KnowledgeIndexGeneration"("profileRevisionId");

ALTER TABLE "KnowledgeIndexProfile"
  ADD CONSTRAINT "KnowledgeIndexProfile_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeIndexProfileRevision"
  ADD CONSTRAINT "KnowledgeIndexProfileRevision_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "KnowledgeIndexProfile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnowledgeIndexProfileRevision"
  ADD CONSTRAINT "KnowledgeIndexProfileRevision_embeddingProviderModelId_fkey"
  FOREIGN KEY ("embeddingProviderModelId") REFERENCES "ProviderModel"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnowledgeIndexGeneration"
  ADD CONSTRAINT "KnowledgeIndexGeneration_profileRevisionId_fkey"
  FOREIGN KEY ("profileRevisionId") REFERENCES "KnowledgeIndexProfileRevision"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

INSERT INTO "KnowledgeIndexProfile" ("id", "version", "updatedAt")
VALUES ('installation', 1, CURRENT_TIMESTAMP);

WITH retrieval_policy AS (
  SELECT
    COALESCE("candidateLimit", 40) AS "candidateLimit",
    COALESCE("resultLimit", 8) AS "resultLimit",
    COALESCE("scoreThreshold", 0.01) AS "scoreThreshold"
  FROM (SELECT 1) AS singleton
  LEFT JOIN "KnowledgePolicy" ON "KnowledgePolicy"."id" = 'installation'
), legacy AS (
  SELECT
    generation."embeddingProviderModelId",
    generation."embeddingConfiguration",
    btrim(generation."vectorSpaceFingerprint") AS "vectorSpaceFingerprint",
    generation."targetDimension",
    generation."chunkingProfileVersion",
    min(generation."createdAt") AS "createdAt",
    min(COALESCE(generation."activatedAt", generation."readyAt", generation."createdAt")) AS "activatedAt"
  FROM "KnowledgeIndexGeneration" AS generation
  GROUP BY
    generation."embeddingProviderModelId",
    generation."embeddingConfiguration",
    btrim(generation."vectorSpaceFingerprint"),
    generation."targetDimension",
    generation."chunkingProfileVersion"
), numbered AS (
  SELECT
    legacy.*,
    row_number() OVER (
      ORDER BY legacy."createdAt", legacy."embeddingProviderModelId", legacy."vectorSpaceFingerprint"
    )::integer AS "revisionNumber"
  FROM legacy
)
INSERT INTO "KnowledgeIndexProfileRevision" (
  "id",
  "profileId",
  "revisionNumber",
  "embeddingProviderModelId",
  "embeddingConfiguration",
  "vectorSpaceFingerprint",
  "targetDimension",
  "chunkingProfileVersion",
  "executionAuthority",
  "profileConfiguration",
  "egressPolicy",
  "preflightStatus",
  "preflightErrorCode",
  "preflightCheckedAt",
  "activatedAt",
  "createdAt"
)
SELECT
  'legacy-' || md5(
    numbered."embeddingProviderModelId" || '|' ||
    numbered."vectorSpaceFingerprint" || '|' ||
    numbered."targetDimension"::text || '|' ||
    numbered."chunkingProfileVersion"::text || '|' ||
    numbered."embeddingConfiguration"::text
  ),
  'installation',
  numbered."revisionNumber",
  numbered."embeddingProviderModelId",
  numbered."embeddingConfiguration",
  numbered."vectorSpaceFingerprint",
  numbered."targetDimension",
  numbered."chunkingProfileVersion",
  'legacy_user',
  jsonb_build_object(
    'schemaVersion', 1,
    'parserRouting', 'legacy_current',
    'lexicalConfiguration', 'current_fts',
    'retrievalBudgets', jsonb_build_object(
      'candidateLimit', retrieval_policy."candidateLimit",
      'resultLimit', retrieval_policy."resultLimit",
      'scoreThreshold', retrieval_policy."scoreThreshold"
    )
  ),
  jsonb_build_object(
    'policyVersion', 'knowledge-profile-egress-v1',
    'operations', jsonb_build_array(
      jsonb_build_object(
        'operation', 'embeddings',
        'representations', jsonb_build_array('document_text_chunks', 'search_queries')
      )
    )
  ),
  'ready',
  NULL,
  numbered."activatedAt",
  numbered."activatedAt",
  numbered."createdAt"
FROM numbered
CROSS JOIN retrieval_policy;

UPDATE "KnowledgeIndexGeneration" AS generation
SET "profileRevisionId" = revision."id"
FROM "KnowledgeIndexProfileRevision" AS revision
WHERE revision."profileId" = 'installation'
  AND revision."embeddingProviderModelId" = generation."embeddingProviderModelId"
  AND revision."embeddingConfiguration" = generation."embeddingConfiguration"
  AND btrim(revision."vectorSpaceFingerprint") = btrim(generation."vectorSpaceFingerprint")
  AND revision."targetDimension" = generation."targetDimension"
  AND revision."chunkingProfileVersion" = generation."chunkingProfileVersion";

UPDATE "KnowledgeIndexProfile"
SET "activeRevisionId" = active_revision."id"
FROM (
  SELECT revision."id"
  FROM "KnowledgeBase" AS base
  INNER JOIN "KnowledgeIndexGeneration" AS generation
    ON generation."id" = base."activeIndexGenerationId"
  INNER JOIN "KnowledgeIndexProfileRevision" AS revision
    ON revision."id" = generation."profileRevisionId"
  ORDER BY generation."activatedAt" DESC NULLS LAST, generation."createdAt" DESC, generation."id"
  LIMIT 1
) AS active_revision
WHERE "KnowledgeIndexProfile"."id" = 'installation';

ALTER TABLE "KnowledgeIndexProfile"
  ADD CONSTRAINT "KnowledgeIndexProfile_activeRevision_fkey"
  FOREIGN KEY ("id", "activeRevisionId")
  REFERENCES "KnowledgeIndexProfileRevision"("profileId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "preventKnowledgeIndexProfileRevisionMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'knowledge_index_profile_revision_immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "KnowledgeIndexProfileRevision_immutable"
BEFORE UPDATE OR DELETE ON "KnowledgeIndexProfileRevision"
FOR EACH ROW EXECUTE FUNCTION "preventKnowledgeIndexProfileRevisionMutation"();
