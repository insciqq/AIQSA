CREATE TYPE "KnowledgeSourceArtifactProcessingStage" AS ENUM (
  'queued', 'parsing', 'chunking', 'embedding'
);

ALTER TABLE "KnowledgeSourceIndexArtifact"
  ADD COLUMN "processingStage" "KnowledgeSourceArtifactProcessingStage",
  ADD COLUMN "embeddedPassageCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "claimToken" VARCHAR(128),
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "processingStartedAt" TIMESTAMP(3);

CREATE TABLE "KnowledgeArtifactPassageEmbedding" (
  "passageId" TEXT NOT NULL,
  "indexArtifactId" TEXT NOT NULL,
  "embeddingTextHash" CHAR(64) NOT NULL,
  "embeddingDimension" INTEGER NOT NULL,
  "embedding" vector NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeArtifactPassageEmbedding_pkey" PRIMARY KEY ("passageId"),
  CONSTRAINT "KnowledgeArtifactPassageEmbedding_shape_check" CHECK (
    btrim("embeddingTextHash") ~ '^[0-9a-f]{64}$'
    AND "embeddingDimension" IN (1024, 1536)
    AND vector_dims("embedding") = "embeddingDimension"
  )
);

CREATE UNIQUE INDEX "KnowledgeArtifactPassageEmbedding_indexArtifactId_passageId_key"
  ON "KnowledgeArtifactPassageEmbedding"("indexArtifactId", "passageId");
CREATE INDEX "KAPE_artifact_embedding_hash_idx"
  ON "KnowledgeArtifactPassageEmbedding"("indexArtifactId", "embeddingTextHash");

ALTER TABLE "KnowledgeArtifactPassageEmbedding"
  ADD CONSTRAINT "KnowledgeArtifactPassageEmbedding_passage_fkey"
  FOREIGN KEY ("indexArtifactId", "passageId")
  REFERENCES "KnowledgeArtifactPassageIndex"("indexArtifactId", "id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE INDEX "KAPE_embedding_1024_hnsw_idx"
  ON "KnowledgeArtifactPassageEmbedding"
  USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024;
CREATE INDEX "KAPE_embedding_1536_hnsw_idx"
  ON "KnowledgeArtifactPassageEmbedding"
  USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536;

-- Existing V1-backed ready artifacts already own immutable passage identities.
-- Seed their V2 embedding rows before the runtime cutover. A later reconciliation
-- resumes any artifact that cannot be proven complete from the legacy generation.
SET LOCAL aiqsa.knowledge_cutover_backfill = 'on';

INSERT INTO "KnowledgeArtifactPassageEmbedding" (
  "passageId", "indexArtifactId", "embeddingTextHash",
  "embeddingDimension", "embedding", "createdAt"
)
SELECT DISTINCT ON (passage."id")
  passage."id",
  passage."indexArtifactId",
  passage."embeddingTextHash",
  chunk."embeddingDimension",
  chunk."embedding",
  CURRENT_TIMESTAMP
FROM "KnowledgeArtifactPassageIndex" AS passage
INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
  ON hierarchy."id" = passage."indexArtifactId"
 AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
  ON artifact."id" = hierarchy."sourceArtifactId"
 AND artifact."sourceVersionId" = hierarchy."sourceVersionId"
INNER JOIN "KnowledgeIndexProfileRevision" AS profile
  ON profile."id" = artifact."profileRevisionId"
INNER JOIN "KnowledgeV1GenerationArtifactMap" AS artifact_map
  ON artifact_map."artifactId" = artifact."id"
 AND artifact_map."sourceVersionId" = artifact."sourceVersionId"
INNER JOIN "KnowledgeChunk" AS chunk
  ON chunk."indexGenerationId" = artifact_map."indexGenerationId"
 AND chunk."documentVersionId" = artifact_map."documentVersionId"
 AND chunk."chunkIndex" = passage."ordinal"
INNER JOIN "KnowledgeIndexGeneration" AS generation
  ON generation."id" = chunk."indexGenerationId"
WHERE chunk."embedding" IS NOT NULL
  AND chunk."embeddingDimension" = profile."targetDimension"
  AND btrim(chunk."embeddingTextHash") = btrim(passage."embeddingTextHash")
ORDER BY
  passage."id",
  generation."activatedAt" DESC NULLS LAST,
  generation."readyAt" DESC NULLS LAST,
  generation."createdAt" DESC,
  generation."id" DESC;

ALTER TABLE "KnowledgeSourceIndexArtifact"
  DISABLE TRIGGER "KnowledgeSourceIndexArtifact_ready_immutable";

WITH embedding_counts AS (
  SELECT
    hierarchy."sourceArtifactId" AS "artifactId",
    count(embedding."passageId")::integer AS "embeddedCount"
  FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
  LEFT JOIN "KnowledgeArtifactPassageIndex" AS passage
    ON passage."indexArtifactId" = hierarchy."id"
  LEFT JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
    ON embedding."indexArtifactId" = passage."indexArtifactId"
   AND embedding."passageId" = passage."id"
  WHERE hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
  GROUP BY hierarchy."sourceArtifactId"
)
UPDATE "KnowledgeSourceIndexArtifact" AS artifact
SET "embeddedPassageCount" = COALESCE(counts."embeddedCount", 0),
    "processingStage" = CASE
      WHEN artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
       AND artifact."chunkCount" = COALESCE(counts."embeddedCount", 0)
       AND artifact."chunkCount" > 0
        THEN NULL
      WHEN artifact."state" = 'failed'::"KnowledgeSourceArtifactState"
        THEN NULL
      WHEN artifact."chunkCount" IS NOT NULL
        THEN 'embedding'::"KnowledgeSourceArtifactProcessingStage"
      WHEN artifact."normalizedTextStorageKey" IS NOT NULL
       AND artifact."normalizedTextByteSize" IS NOT NULL
       AND artifact."normalizedTextChecksum" IS NOT NULL
        THEN 'chunking'::"KnowledgeSourceArtifactProcessingStage"
      ELSE 'queued'::"KnowledgeSourceArtifactProcessingStage"
    END,
    "state" = CASE
      WHEN artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
       AND (
         artifact."chunkCount" IS NULL
         OR artifact."chunkCount" <= 0
         OR artifact."chunkCount" <> COALESCE(counts."embeddedCount", 0)
       )
        THEN 'processing'::"KnowledgeSourceArtifactState"
      ELSE artifact."state"
    END,
    "readyAt" = CASE
      WHEN artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
       AND (
         artifact."chunkCount" IS NULL
         OR artifact."chunkCount" <= 0
         OR artifact."chunkCount" <> COALESCE(counts."embeddedCount", 0)
       )
        THEN NULL
      ELSE artifact."readyAt"
    END,
    "claimToken" = NULL,
    "claimedAt" = NULL,
    "attemptCount" = 0,
    "nextAttemptAt" = CURRENT_TIMESTAMP,
    "processingStartedAt" = CASE
      WHEN artifact."state" IN ('pending', 'processing') THEN artifact."updatedAt"
      ELSE NULL
    END
FROM embedding_counts AS counts
WHERE counts."artifactId" = artifact."id";

UPDATE "KnowledgeSourceIndexArtifact" AS artifact
SET "processingStage" = CASE
      WHEN artifact."state" = 'failed'::"KnowledgeSourceArtifactState" THEN NULL
      WHEN artifact."chunkCount" IS NOT NULL
        THEN 'embedding'::"KnowledgeSourceArtifactProcessingStage"
      WHEN artifact."normalizedTextStorageKey" IS NOT NULL
       AND artifact."normalizedTextByteSize" IS NOT NULL
       AND artifact."normalizedTextChecksum" IS NOT NULL
        THEN 'chunking'::"KnowledgeSourceArtifactProcessingStage"
      ELSE 'queued'::"KnowledgeSourceArtifactProcessingStage"
    END,
    "state" = CASE
      WHEN artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
        THEN 'processing'::"KnowledgeSourceArtifactState"
      ELSE artifact."state"
    END,
    "readyAt" = CASE
      WHEN artifact."state" = 'ready'::"KnowledgeSourceArtifactState" THEN NULL
      ELSE artifact."readyAt"
    END,
    "claimToken" = NULL,
    "claimedAt" = NULL,
    "attemptCount" = 0,
    "nextAttemptAt" = CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1
  FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
  WHERE hierarchy."sourceArtifactId" = artifact."id"
);

ALTER TABLE "KnowledgeSourceIndexArtifact"
  ENABLE TRIGGER "KnowledgeSourceIndexArtifact_ready_immutable";

ALTER TABLE "KnowledgeSourceIndexArtifact"
  DROP CONSTRAINT "KnowledgeSourceIndexArtifact_sizes_check",
  DROP CONSTRAINT "KnowledgeSourceIndexArtifact_state_check";

ALTER TABLE "KnowledgeSourceIndexArtifact"
  ADD CONSTRAINT "KnowledgeSourceIndexArtifact_sizes_check" CHECK (
    ("normalizedTextByteSize" IS NULL OR "normalizedTextByteSize" >= 0)
    AND ("pageCount" IS NULL OR "pageCount" >= 0)
    AND ("chunkCount" IS NULL OR "chunkCount" >= 0)
    AND "embeddedPassageCount" >= 0
    AND ("chunkCount" IS NULL OR "embeddedPassageCount" <= "chunkCount")
    AND "attemptCount" >= 0
  ),
  ADD CONSTRAINT "KnowledgeSourceIndexArtifact_state_check" CHECK (
    (
      "state" IN ('pending', 'processing')
      AND "processingStage" IS NOT NULL
      AND "errorCode" IS NULL
      AND "readyAt" IS NULL
    ) OR (
      "state" = 'failed'
      AND "processingStage" IS NULL
      AND "errorCode" IS NOT NULL
      AND "readyAt" IS NULL
      AND "claimToken" IS NULL
      AND "claimedAt" IS NULL
    ) OR (
      "state" = 'ready'
      AND "processingStage" IS NULL
      AND "errorCode" IS NULL
      AND "readyAt" IS NOT NULL
      AND "claimToken" IS NULL
      AND "claimedAt" IS NULL
      AND "normalizedTextStorageKey" IS NOT NULL
      AND "normalizedTextByteSize" IS NOT NULL
      AND "normalizedTextChecksum" IS NOT NULL
      AND "pageCount" IS NOT NULL
      AND "chunkCount" IS NOT NULL
      AND "chunkCount" > 0
      AND "embeddedPassageCount" = "chunkCount"
    )
  );

CREATE INDEX "KnowledgeSourceIndexArtifact_queue_idx"
  ON "KnowledgeSourceIndexArtifact"(
    "state", "nextAttemptAt", "claimedAt", "createdAt"
  );

CREATE FUNCTION "preventKnowledgePassageEmbeddingMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_state "KnowledgeSourceArtifactState";
  index_artifact_id TEXT;
BEGIN
  IF current_setting('aiqsa.knowledge_cutover_backfill', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('aiqsa.knowledge_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'knowledge_passage_embedding_immutable' USING ERRCODE = '55000';
  END IF;
  index_artifact_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD."indexArtifactId"
    ELSE NEW."indexArtifactId"
  END;
  SELECT source_artifact."state" INTO artifact_state
  FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
  INNER JOIN "KnowledgeSourceIndexArtifact" AS source_artifact
    ON source_artifact."id" = hierarchy."sourceArtifactId"
   AND source_artifact."sourceVersionId" = hierarchy."sourceVersionId"
  WHERE hierarchy."id" = index_artifact_id;
  IF artifact_state IS NULL THEN
    RAISE EXCEPTION 'knowledge_passage_embedding_parent_unavailable' USING ERRCODE = '23503';
  END IF;
  IF artifact_state = 'ready'::"KnowledgeSourceArtifactState" THEN
    RAISE EXCEPTION 'knowledge_passage_embedding_ready_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "KnowledgeArtifactPassageEmbedding_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeArtifactPassageEmbedding"
FOR EACH ROW EXECUTE FUNCTION "preventKnowledgePassageEmbeddingMutation"();
