-- Knowledge Base foundation: private publishable bases, append-only document
-- versions, immutable vector-space generations, and hybrid-search storage.
--
-- The bundled Postgres image supplies pgvector, while this schema migration
-- alone owns extension activation. An unbundled database must install a
-- compatible pgvector package before this migration runs.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TYPE "KnowledgeBasePublicationScope" AS ENUM ('group', 'installation');
CREATE TYPE "KnowledgeDocumentIngestState" AS ENUM (
  'queued', 'parsing', 'chunking', 'embedding', 'ready', 'failed'
);
CREATE TYPE "KnowledgeIndexGenerationStatus" AS ENUM (
  'building', 'ready', 'active', 'retired', 'failed'
);

-- These attach points are inert until run-plan admission lands. NULL means no
-- local default; Assistant revisions carry an exact governed allowlist.
ALTER TABLE "AssistantRevision"
  ADD COLUMN "knowledgeBaseIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AssistantRevision"
  ADD CONSTRAINT "AssistantRevision_knowledge_base_ids_check"
  CHECK (cardinality("knowledgeBaseIds") <= 3);
ALTER TABLE "Folder" ADD COLUMN "defaultKnowledgePlan" JSONB;
ALTER TABLE "Chat" ADD COLUMN "defaultKnowledgePlan" JSONB;

CREATE TABLE "KnowledgeBase" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "activeIndexGenerationId" TEXT,
  "contentRevision" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeBase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeBase_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "KnowledgeBase_description_check" CHECK (char_length("description") <= 2000),
  CONSTRAINT "KnowledgeBase_content_revision_check" CHECK ("contentRevision" >= 0),
  CONSTRAINT "KnowledgeBase_version_check" CHECK ("version" >= 1)
);

-- Configuration is an immutable, safe JSON projection of the embedding
-- deployment's vector-space inputs. The deployment may later be edited, but
-- accepted generations retain this fingerprint and exact configuration.
CREATE TABLE "KnowledgeIndexGeneration" (
  "id" TEXT NOT NULL,
  "knowledgeBaseId" TEXT NOT NULL,
  "embeddingProviderModelId" TEXT NOT NULL,
  "embeddingConfiguration" JSONB NOT NULL,
  "vectorSpaceFingerprint" CHAR(64) NOT NULL,
  "targetDimension" INTEGER NOT NULL,
  "chunkingProfileVersion" INTEGER NOT NULL,
  "indexedContentRevision" INTEGER NOT NULL DEFAULT 0,
  "status" "KnowledgeIndexGenerationStatus" NOT NULL DEFAULT 'building',
  "readyAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeIndexGeneration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeIndexGeneration_fingerprint_check"
    CHECK ("vectorSpaceFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "KnowledgeIndexGeneration_dimension_check"
    CHECK ("targetDimension" IN (1024, 1536)),
  CONSTRAINT "KnowledgeIndexGeneration_chunking_profile_check"
    CHECK ("chunkingProfileVersion" >= 1),
  CONSTRAINT "KnowledgeIndexGeneration_indexed_revision_check"
    CHECK ("indexedContentRevision" >= 0),
  CONSTRAINT "KnowledgeIndexGeneration_lifecycle_check" CHECK (
    ("status" = 'building'
      AND "readyAt" IS NULL AND "activatedAt" IS NULL
      AND "retiredAt" IS NULL AND "failedAt" IS NULL)
    OR ("status" = 'ready'
      AND "readyAt" IS NOT NULL AND "activatedAt" IS NULL
      AND "retiredAt" IS NULL AND "failedAt" IS NULL)
    OR ("status" = 'active'
      AND "readyAt" IS NOT NULL AND "activatedAt" IS NOT NULL
      AND "retiredAt" IS NULL AND "failedAt" IS NULL)
    OR ("status" = 'retired'
      AND "readyAt" IS NOT NULL AND "activatedAt" IS NOT NULL
      AND "retiredAt" IS NOT NULL AND "failedAt" IS NULL)
    OR ("status" = 'failed'
      AND "activatedAt" IS NULL AND "retiredAt" IS NULL
      AND "failedAt" IS NOT NULL)
  )
);

CREATE TABLE "KnowledgeDocument" (
  "id" TEXT NOT NULL,
  "knowledgeBaseId" TEXT NOT NULL,
  "currentVersionId" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- A version becomes retrieval-visible only when both the version activation
-- and base revision advance commit. The upper bound is exclusive, so revision
-- R resolves with from <= R < until (or no upper bound).
CREATE TABLE "KnowledgeDocumentVersion" (
  "id" TEXT NOT NULL,
  "knowledgeBaseId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "originalStorageKey" TEXT NOT NULL,
  "normalizedTextStorageKey" TEXT,
  "pageCount" INTEGER,
  "visibleFromRevision" INTEGER,
  "visibleUntilRevision" INTEGER,
  "ingestState" "KnowledgeDocumentIngestState" NOT NULL DEFAULT 'queued',
  "ingestErrorCode" VARCHAR(64),
  "ingestClaimToken" VARCHAR(128),
  "ingestClaimedAt" TIMESTAMP(3),
  "ingestAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "ingestNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ingestStartedAt" TIMESTAMP(3),
  "ingestCompletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeDocumentVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeDocumentVersion_version_check" CHECK ("versionNumber" >= 1),
  CONSTRAINT "KnowledgeDocumentVersion_file_name_check"
    CHECK (char_length("fileName") BETWEEN 1 AND 512),
  CONSTRAINT "KnowledgeDocumentVersion_mime_type_check"
    CHECK (char_length("mimeType") BETWEEN 1 AND 255),
  CONSTRAINT "KnowledgeDocumentVersion_byte_size_check" CHECK ("byteSize" > 0),
  CONSTRAINT "KnowledgeDocumentVersion_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "KnowledgeDocumentVersion_storage_key_check" CHECK (
    char_length("originalStorageKey") BETWEEN 1 AND 1024
    AND ("normalizedTextStorageKey" IS NULL
      OR char_length("normalizedTextStorageKey") BETWEEN 1 AND 1024)
  ),
  CONSTRAINT "KnowledgeDocumentVersion_page_count_check"
    CHECK ("pageCount" IS NULL OR "pageCount" >= 1),
  CONSTRAINT "KnowledgeDocumentVersion_visibility_check" CHECK (
    ("visibleFromRevision" IS NULL AND "visibleUntilRevision" IS NULL)
    OR ("visibleFromRevision" >= 1
      AND ("visibleUntilRevision" IS NULL
        OR "visibleUntilRevision" > "visibleFromRevision"))
  ),
  CONSTRAINT "KnowledgeDocumentVersion_ingest_attempt_check"
    CHECK ("ingestAttemptCount" >= 0),
  CONSTRAINT "KnowledgeDocumentVersion_claim_check"
    CHECK (("ingestClaimToken" IS NULL) = ("ingestClaimedAt" IS NULL)),
  CONSTRAINT "KnowledgeDocumentVersion_error_check" CHECK (
    ("ingestState" = 'failed' AND "ingestErrorCode" IS NOT NULL)
    OR ("ingestState" <> 'failed' AND "ingestErrorCode" IS NULL)
  )
);

-- Prisma treats vector/tsvector as Unsupported fields. Retrieval and ingestion
-- use parameterized raw SQL; the generated FTS column is never request input.
CREATE TABLE "KnowledgeChunk" (
  "id" TEXT NOT NULL,
  "knowledgeBaseId" TEXT NOT NULL,
  "documentVersionId" TEXT NOT NULL,
  "indexGenerationId" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "page" INTEGER NOT NULL,
  "headingPath" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "text" TEXT NOT NULL,
  "embeddingDimension" INTEGER NOT NULL,
  "embedding" vector NOT NULL,
  "searchVector" tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, "text")
  ) STORED,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeChunk_index_check" CHECK ("chunkIndex" >= 0),
  CONSTRAINT "KnowledgeChunk_page_check" CHECK ("page" >= 1),
  CONSTRAINT "KnowledgeChunk_heading_path_check" CHECK (cardinality("headingPath") <= 16),
  CONSTRAINT "KnowledgeChunk_text_check" CHECK (char_length("text") BETWEEN 1 AND 20000),
  CONSTRAINT "KnowledgeChunk_dimension_check" CHECK (
    "embeddingDimension" IN (1024, 1536)
    AND vector_dims("embedding") = "embeddingDimension"
  )
);

CREATE TABLE "KnowledgeBasePublication" (
  "id" TEXT NOT NULL,
  "knowledgeBaseId" TEXT NOT NULL,
  "scope" "KnowledgeBasePublicationScope" NOT NULL,
  "groupId" TEXT,
  "publishedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeBasePublication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeBasePublication_scope_group_check" CHECK (
    ("scope" = 'group' AND "groupId" IS NOT NULL)
    OR ("scope" = 'installation' AND "groupId" IS NULL)
  )
);

CREATE UNIQUE INDEX "KnowledgeBase_activeIndexGenerationId_key"
  ON "KnowledgeBase"("activeIndexGenerationId");
CREATE UNIQUE INDEX "KnowledgeBase_id_activeIndexGenerationId_key"
  ON "KnowledgeBase"("id", "activeIndexGenerationId");
CREATE INDEX "KnowledgeBase_ownerUserId_archivedAt_idx"
  ON "KnowledgeBase"("ownerUserId", "archivedAt");

CREATE UNIQUE INDEX "KnowledgeIndexGeneration_knowledgeBaseId_id_key"
  ON "KnowledgeIndexGeneration"("knowledgeBaseId", "id");
CREATE INDEX "KnowledgeIndexGeneration_embeddingProviderModelId_idx"
  ON "KnowledgeIndexGeneration"("embeddingProviderModelId");
CREATE INDEX "KnowledgeIndexGeneration_knowledgeBaseId_status_idx"
  ON "KnowledgeIndexGeneration"("knowledgeBaseId", "status");

CREATE UNIQUE INDEX "KnowledgeDocument_currentVersionId_key"
  ON "KnowledgeDocument"("currentVersionId");
CREATE UNIQUE INDEX "KnowledgeDocument_knowledgeBaseId_id_key"
  ON "KnowledgeDocument"("knowledgeBaseId", "id");
CREATE UNIQUE INDEX "KnowledgeDocument_id_currentVersionId_key"
  ON "KnowledgeDocument"("id", "currentVersionId");
CREATE INDEX "KnowledgeDocument_knowledgeBaseId_archivedAt_idx"
  ON "KnowledgeDocument"("knowledgeBaseId", "archivedAt");

CREATE UNIQUE INDEX "KnowledgeDocumentVersion_documentId_versionNumber_key"
  ON "KnowledgeDocumentVersion"("documentId", "versionNumber");
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_documentId_id_key"
  ON "KnowledgeDocumentVersion"("documentId", "id");
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_knowledgeBaseId_id_key"
  ON "KnowledgeDocumentVersion"("knowledgeBaseId", "id");
CREATE INDEX "KnowledgeDocumentVersion_knowledgeBaseId_ingestState_ingestNextAttemptAt_idx"
  ON "KnowledgeDocumentVersion"("knowledgeBaseId", "ingestState", "ingestNextAttemptAt");
CREATE INDEX "KnowledgeDocumentVersion_originalStorageKey_idx"
  ON "KnowledgeDocumentVersion"("originalStorageKey");
CREATE INDEX "KnowledgeDocumentVersion_normalizedTextStorageKey_idx"
  ON "KnowledgeDocumentVersion"("normalizedTextStorageKey");
CREATE INDEX "KnowledgeDocumentVersion_knowledgeBaseId_visibleFromRevision_visibleUntilRevision_idx"
  ON "KnowledgeDocumentVersion"("knowledgeBaseId", "visibleFromRevision", "visibleUntilRevision");

CREATE UNIQUE INDEX "KnowledgeChunk_indexGenerationId_documentVersionId_chunkIndex_key"
  ON "KnowledgeChunk"("indexGenerationId", "documentVersionId", "chunkIndex");
CREATE INDEX "KnowledgeChunk_documentVersionId_idx"
  ON "KnowledgeChunk"("documentVersionId");
CREATE INDEX "KnowledgeChunk_knowledgeBaseId_indexGenerationId_idx"
  ON "KnowledgeChunk"("knowledgeBaseId", "indexGenerationId");
CREATE INDEX "KnowledgeChunk_searchVector_gin_idx"
  ON "KnowledgeChunk" USING gin ("searchVector");
-- The dimension guard is repeated in each expression index predicate so a
-- query must choose one committed, index-backed vector profile.
CREATE INDEX "KnowledgeChunk_embedding_1024_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw (("embedding"::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024;
CREATE INDEX "KnowledgeChunk_embedding_1536_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw (("embedding"::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536;

CREATE UNIQUE INDEX "KnowledgeBasePublication_knowledgeBaseId_groupId_key"
  ON "KnowledgeBasePublication"("knowledgeBaseId", "groupId");
CREATE UNIQUE INDEX "KnowledgeBasePublication_installation_key"
  ON "KnowledgeBasePublication"("knowledgeBaseId") WHERE "scope" = 'installation';
CREATE INDEX "KnowledgeBasePublication_groupId_idx"
  ON "KnowledgeBasePublication"("groupId");
CREATE INDEX "KnowledgeBasePublication_knowledgeBaseId_scope_idx"
  ON "KnowledgeBasePublication"("knowledgeBaseId", "scope");

ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnowledgeIndexGeneration" ADD CONSTRAINT "KnowledgeIndexGeneration_knowledgeBaseId_fkey"
  FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnowledgeIndexGeneration" ADD CONSTRAINT "KnowledgeIndexGeneration_embeddingProviderModelId_fkey"
  FOREIGN KEY ("embeddingProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_activeIndexGeneration_fkey"
  FOREIGN KEY ("id", "activeIndexGenerationId")
  REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_knowledgeBaseId_fkey"
  FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentVersion" ADD CONSTRAINT "KnowledgeDocumentVersion_document_fkey"
  FOREIGN KEY ("knowledgeBaseId", "documentId")
  REFERENCES "KnowledgeDocument"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_currentVersion_fkey"
  FOREIGN KEY ("id", "currentVersionId")
  REFERENCES "KnowledgeDocumentVersion"("documentId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentVersion_fkey"
  FOREIGN KEY ("knowledgeBaseId", "documentVersionId")
  REFERENCES "KnowledgeDocumentVersion"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_indexGeneration_fkey"
  FOREIGN KEY ("knowledgeBaseId", "indexGenerationId")
  REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeBasePublication" ADD CONSTRAINT "KnowledgeBasePublication_knowledgeBaseId_fkey"
  FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnowledgeBasePublication" ADD CONSTRAINT "KnowledgeBasePublication_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnowledgeBasePublication" ADD CONSTRAINT "KnowledgeBasePublication_publishedByUserId_fkey"
  FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rollback guidance (destructive): stop every app/worker, back up Postgres and
-- private objects, drop the Knowledge foreign keys/tables in reverse order,
-- remove the three attach-point columns, then drop the three enum types.
-- Drop extension vector only when pg_depend proves no other relation uses it.
-- Document/version/chunk rows are accepted evidence; routine rollback must
-- restore the backup instead of pretending those rows can be reconstructed.
