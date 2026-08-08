-- Knowledge ingestion: generation-pinned document work, durable reindex sets,
-- normalized-object integrity, idempotent embedding usage, and conservative
-- payload retirement. All additions preserve the inert foundation rows.

ALTER TABLE "KnowledgeIndexGeneration"
  ADD COLUMN "sourceIndexGenerationId" TEXT,
  ADD COLUMN "sourceBaseVersion" INTEGER,
  ADD COLUMN "targetContentRevision" INTEGER,
  ADD COLUMN "lastErrorCode" VARCHAR(64);

-- A reindex generation captures both the source generation and the exact base
-- fences it is catching up to. Initial generations have no source tuple.
ALTER TABLE "KnowledgeIndexGeneration"
  ADD CONSTRAINT "KnowledgeIndexGeneration_reindex_source_check" CHECK (
    ("sourceIndexGenerationId" IS NULL
      AND "sourceBaseVersion" IS NULL
      AND "targetContentRevision" IS NULL)
    OR ("sourceIndexGenerationId" IS NOT NULL
      AND "sourceIndexGenerationId" <> "id"
      AND "sourceBaseVersion" >= 1
      AND "targetContentRevision" >= 0)
  );

ALTER TABLE "KnowledgeIndexGeneration"
  DROP CONSTRAINT "KnowledgeIndexGeneration_lifecycle_check";
UPDATE "KnowledgeIndexGeneration"
SET "lastErrorCode" = 'generation_failed'
WHERE "status" = 'failed' AND "lastErrorCode" IS NULL;
ALTER TABLE "KnowledgeIndexGeneration"
  ADD CONSTRAINT "KnowledgeIndexGeneration_lifecycle_check" CHECK (
    ("status" = 'building'
      AND "readyAt" IS NULL AND "activatedAt" IS NULL
      AND "retiredAt" IS NULL AND "failedAt" IS NULL
      AND "lastErrorCode" IS NULL)
    OR ("status" = 'ready'
      AND "readyAt" IS NOT NULL AND "activatedAt" IS NULL
      AND "retiredAt" IS NULL AND "failedAt" IS NULL
      AND "lastErrorCode" IS NULL)
    OR ("status" = 'active'
      AND "readyAt" IS NOT NULL AND "activatedAt" IS NOT NULL
      AND "retiredAt" IS NULL AND "failedAt" IS NULL
      AND "lastErrorCode" IS NULL)
    OR ("status" = 'retired'
      AND "readyAt" IS NOT NULL AND "activatedAt" IS NOT NULL
      AND "retiredAt" IS NOT NULL AND "failedAt" IS NULL
      AND "lastErrorCode" IS NULL)
    OR ("status" = 'failed'
      AND "activatedAt" IS NULL AND "retiredAt" IS NULL
      AND "failedAt" IS NOT NULL AND "lastErrorCode" IS NOT NULL)
  );

CREATE INDEX "KnowledgeIndexGeneration_sourceIndexGenerationId_idx"
  ON "KnowledgeIndexGeneration"("sourceIndexGenerationId");
CREATE UNIQUE INDEX "KnowledgeIndexGeneration_one_building_reindex_idx"
  ON "KnowledgeIndexGeneration"("knowledgeBaseId")
  WHERE "status" = 'building' AND "sourceIndexGenerationId" IS NOT NULL;

ALTER TABLE "KnowledgeIndexGeneration"
  ADD CONSTRAINT "KnowledgeIndexGeneration_source_fkey"
  FOREIGN KEY ("knowledgeBaseId", "sourceIndexGenerationId")
  REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeDocumentVersion"
  DROP CONSTRAINT "KnowledgeDocumentVersion_storage_key_check";
ALTER TABLE "KnowledgeDocumentVersion"
  ALTER COLUMN "originalStorageKey" DROP NOT NULL,
  ADD COLUMN "ingestGenerationId" TEXT,
  ADD COLUMN "normalizedTextByteSize" INTEGER,
  ADD COLUMN "normalizedTextChecksum" CHAR(64),
  ADD COLUMN "ingestChunkCount" INTEGER,
  ADD COLUMN "ingestEmbeddedChunkCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "payloadPurgedAt" TIMESTAMP(3);

ALTER TABLE "KnowledgeDocumentVersion"
  ADD CONSTRAINT "KnowledgeDocumentVersion_storage_key_check" CHECK (
    ("payloadPurgedAt" IS NULL
      AND char_length("originalStorageKey") BETWEEN 1 AND 1024
      AND ("normalizedTextStorageKey" IS NULL
        OR char_length("normalizedTextStorageKey") BETWEEN 1 AND 1024))
    OR ("payloadPurgedAt" IS NOT NULL
      AND "originalStorageKey" IS NULL
      AND "normalizedTextStorageKey" IS NULL
      AND "normalizedTextByteSize" IS NULL
      AND "normalizedTextChecksum" IS NULL)
  ),
  ADD CONSTRAINT "KnowledgeDocumentVersion_normalized_object_check" CHECK (
    ("normalizedTextByteSize" IS NULL AND "normalizedTextChecksum" IS NULL)
    OR ("normalizedTextStorageKey" IS NOT NULL
      AND "normalizedTextByteSize" > 0
      AND "normalizedTextChecksum" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "KnowledgeDocumentVersion_ingest_progress_check" CHECK (
    ("ingestChunkCount" IS NULL OR "ingestChunkCount" >= 0)
    AND "ingestEmbeddedChunkCount" >= 0
    AND ("ingestChunkCount" IS NULL
      OR "ingestEmbeddedChunkCount" <= "ingestChunkCount")
  );

CREATE INDEX "KnowledgeDocumentVersion_ingestGenerationId_idx"
  ON "KnowledgeDocumentVersion"("ingestGenerationId");
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_one_active_ingest_idx"
  ON "KnowledgeDocumentVersion"("documentId")
  WHERE "ingestState" IN ('queued', 'parsing', 'chunking', 'embedding');

ALTER TABLE "KnowledgeDocumentVersion"
  ADD CONSTRAINT "KnowledgeDocumentVersion_ingestGeneration_fkey"
  FOREIGN KEY ("knowledgeBaseId", "ingestGenerationId")
  REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Shadow generation work is a captured temporal set, not an in-memory loop.
-- Rows remain as inspectable completion evidence after activation.
CREATE TABLE "KnowledgeGenerationDocument" (
  "knowledgeBaseId" TEXT NOT NULL,
  "indexGenerationId" TEXT NOT NULL,
  "documentVersionId" TEXT NOT NULL,
  "state" "KnowledgeDocumentIngestState" NOT NULL DEFAULT 'queued',
  "errorCode" VARCHAR(64),
  "claimToken" VARCHAR(128),
  "claimedAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "chunkCount" INTEGER,
  "embeddedChunkCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeGenerationDocument_pkey"
    PRIMARY KEY ("indexGenerationId", "documentVersionId"),
  CONSTRAINT "KnowledgeGenerationDocument_state_check"
    CHECK ("state" IN ('queued', 'embedding', 'ready', 'failed')),
  CONSTRAINT "KnowledgeGenerationDocument_claim_check"
    CHECK (("claimToken" IS NULL) = ("claimedAt" IS NULL)),
  CONSTRAINT "KnowledgeGenerationDocument_attempt_check"
    CHECK ("attemptCount" >= 0),
  CONSTRAINT "KnowledgeGenerationDocument_progress_check" CHECK (
    ("chunkCount" IS NULL OR "chunkCount" >= 0)
    AND "embeddedChunkCount" >= 0
    AND ("chunkCount" IS NULL OR "embeddedChunkCount" <= "chunkCount")
  ),
  CONSTRAINT "KnowledgeGenerationDocument_error_check" CHECK (
    ("state" = 'failed' AND "errorCode" IS NOT NULL)
    OR ("state" <> 'failed' AND "errorCode" IS NULL)
  )
);

CREATE INDEX "KnowledgeGenerationDocument_state_nextAttemptAt_claimedAt_createdAt_idx"
  ON "KnowledgeGenerationDocument"("state", "nextAttemptAt", "claimedAt", "createdAt");
CREATE INDEX "KnowledgeGenerationDocument_knowledgeBaseId_documentVersionId_idx"
  ON "KnowledgeGenerationDocument"("knowledgeBaseId", "documentVersionId");

ALTER TABLE "KnowledgeGenerationDocument"
  ADD CONSTRAINT "KnowledgeGenerationDocument_generation_fkey"
  FOREIGN KEY ("knowledgeBaseId", "indexGenerationId")
  REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeGenerationDocument"
  ADD CONSTRAINT "KnowledgeGenerationDocument_version_fkey"
  FOREIGN KEY ("knowledgeBaseId", "documentVersionId")
  REFERENCES "KnowledgeDocumentVersion"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Knowledge embedding calls share the existing UsageEvent ledger. The exact
-- generation/version/batch tuple is both provenance and the idempotent commit
-- marker used after lease recovery; providerModelId is a deletion-independent
-- snapshot of the deployment identity.
ALTER TABLE "UsageEvent"
  ADD COLUMN "providerModelId" TEXT,
  ADD COLUMN "knowledgeBaseId" TEXT,
  ADD COLUMN "knowledgeIndexGenerationId" TEXT,
  ADD COLUMN "knowledgeDocumentVersionId" TEXT,
  ADD COLUMN "knowledgeBatchIndex" INTEGER;

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_knowledge_shape_check" CHECK (
    ("providerModelId" IS NULL
      AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL)
    OR ("providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NOT NULL
      AND "knowledgeIndexGenerationId" IS NOT NULL
      AND "knowledgeDocumentVersionId" IS NOT NULL
      AND "knowledgeBatchIndex" >= 0
      AND "modelRunId" IS NULL
      AND "chatId" IS NULL)
  );

CREATE UNIQUE INDEX "UsageEvent_knowledge_batch_key"
  ON "UsageEvent"(
    "knowledgeIndexGenerationId",
    "knowledgeDocumentVersionId",
    "knowledgeBatchIndex"
  );
CREATE INDEX "UsageEvent_knowledgeBaseId_createdAt_idx"
  ON "UsageEvent"("knowledgeBaseId", "createdAt");

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_knowledgeBaseId_fkey"
  FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_knowledgeIndexGeneration_fkey"
  FOREIGN KEY ("knowledgeBaseId", "knowledgeIndexGenerationId")
  REFERENCES "KnowledgeIndexGeneration"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_knowledgeDocumentVersion_fkey"
  FOREIGN KEY ("knowledgeBaseId", "knowledgeDocumentVersionId")
  REFERENCES "KnowledgeDocumentVersion"("knowledgeBaseId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Rollback guidance (destructive): stop app coordinators, back up Postgres and
-- private objects, drop the UsageEvent Knowledge FKs/index/check/columns, then
-- drop KnowledgeGenerationDocument, the version-generation FK and ingestion
-- columns, and the generation source FK/columns. Restore the prior storage-key
-- NOT NULL constraint only after proving no payloadPurgedAt row exists. Never
-- delete normalized/original objects merely to imitate a schema rollback.
