CREATE TYPE "KnowledgeUploadTransport" AS ENUM ('PROXY', 'MULTIPART');
CREATE TYPE "KnowledgeUploadItemState" AS ENUM (
  'QUEUED',
  'UPLOADING',
  'STORED',
  'PROCESSING',
  'NEEDS_ATTENTION',
  'CANCELLED',
  'REUSED'
);

CREATE TABLE "KnowledgeUploadBatch" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "knowledgeBaseId" TEXT NOT NULL,
  "clientBatchId" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeUploadBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeUploadBatch_client_id_check" CHECK (
    "clientBatchId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  )
);

CREATE TABLE "KnowledgeUploadItem" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "clientFileId" VARCHAR(128) NOT NULL,
  "attemptNumber" INTEGER NOT NULL DEFAULT 1,
  "fileName" TEXT NOT NULL,
  "declaredMimeType" TEXT NOT NULL,
  "normalizedMimeType" TEXT NOT NULL,
  "declaredByteSize" INTEGER NOT NULL,
  "checksumHint" CHAR(64),
  "storageKey" TEXT,
  "transport" "KnowledgeUploadTransport" NOT NULL,
  "multipartUploadId" TEXT,
  "sessionExpiresAt" TIMESTAMP(3) NOT NULL,
  "state" "KnowledgeUploadItemState" NOT NULL DEFAULT 'QUEUED',
  "uploadedByteSize" INTEGER NOT NULL DEFAULT 0,
  "errorCode" VARCHAR(64),
  "sourceId" TEXT,
  "sourceVersionId" TEXT,
  "documentId" TEXT,
  "documentVersionId" TEXT,
  "settledAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeUploadItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeUploadItem_client_id_check" CHECK (
    "clientFileId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT "KnowledgeUploadItem_metadata_check" CHECK (
    "attemptNumber" > 0
    AND btrim("fileName") <> ''
    AND octet_length("fileName") <= 1024
    AND btrim("declaredMimeType") <> ''
    AND btrim("normalizedMimeType") <> ''
    AND "declaredByteSize" > 0
    AND "uploadedByteSize" >= 0
    AND "uploadedByteSize" <= "declaredByteSize"
    AND ("checksumHint" IS NULL OR btrim("checksumHint") ~ '^[0-9a-f]{64}$')
    AND ("errorCode" IS NULL OR "errorCode" ~ '^[a-z][a-z0-9_]{0,63}$')
  ),
  CONSTRAINT "KnowledgeUploadItem_transport_check" CHECK (
    ("transport" = 'PROXY' AND "multipartUploadId" IS NULL)
    OR
    ("transport" = 'MULTIPART' AND (
      ("state" IN ('QUEUED', 'UPLOADING', 'STORED', 'NEEDS_ATTENTION')
        AND "multipartUploadId" IS NOT NULL
        AND char_length("multipartUploadId") BETWEEN 1 AND 1024)
      OR
      ("state" IN ('PROCESSING', 'CANCELLED', 'REUSED') AND "multipartUploadId" IS NULL)
    ))
  ),
  CONSTRAINT "KnowledgeUploadItem_state_check" CHECK (
    (
      "state" IN ('QUEUED', 'UPLOADING', 'STORED', 'NEEDS_ATTENTION')
      AND "storageKey" IS NOT NULL
      AND "sourceId" IS NULL
      AND "sourceVersionId" IS NULL
      AND "documentId" IS NULL
      AND "documentVersionId" IS NULL
      AND "settledAt" IS NULL
      AND "cancelledAt" IS NULL
      AND (("state" = 'NEEDS_ATTENTION') = ("errorCode" IS NOT NULL))
    )
    OR
    (
      "state" = 'PROCESSING'
      AND "storageKey" IS NULL
      AND "sourceId" IS NOT NULL
      AND "sourceVersionId" IS NOT NULL
      AND "documentId" IS NOT NULL
      AND "documentVersionId" IS NOT NULL
      AND "settledAt" IS NOT NULL
      AND "cancelledAt" IS NULL
      AND "errorCode" IS NULL
    )
    OR
    (
      "state" = 'REUSED'
      AND "storageKey" IS NULL
      AND "sourceId" IS NOT NULL
      AND "sourceVersionId" IS NULL
      AND "documentId" IS NULL
      AND "documentVersionId" IS NULL
      AND "settledAt" IS NOT NULL
      AND "cancelledAt" IS NULL
      AND "errorCode" IS NULL
    )
    OR
    (
      "state" = 'CANCELLED'
      AND "storageKey" IS NULL
      AND "sourceId" IS NULL
      AND "sourceVersionId" IS NULL
      AND "documentId" IS NULL
      AND "documentVersionId" IS NULL
      AND "settledAt" IS NULL
      AND "cancelledAt" IS NOT NULL
      AND "errorCode" IS NULL
    )
  )
);

CREATE TABLE "KnowledgeUploadPart" (
  "uploadItemId" TEXT NOT NULL,
  "partNumber" INTEGER NOT NULL,
  "byteOffset" INTEGER NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "etag" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeUploadPart_pkey" PRIMARY KEY ("uploadItemId", "partNumber"),
  CONSTRAINT "KnowledgeUploadPart_shape_check" CHECK (
    "partNumber" BETWEEN 1 AND 10000
    AND "byteOffset" >= 0
    AND "byteSize" > 0
    AND (("etag" IS NULL) = ("completedAt" IS NULL))
    AND ("etag" IS NULL OR char_length("etag") BETWEEN 1 AND 256)
  )
);

ALTER TABLE "AttachmentDeletionJob"
ADD COLUMN "multipartUploadId" TEXT;

CREATE UNIQUE INDEX "KnowledgeUploadBatch_ownerUserId_clientBatchId_key"
  ON "KnowledgeUploadBatch"("ownerUserId", "clientBatchId");
CREATE UNIQUE INDEX "KnowledgeUploadBatch_id_ownerUserId_key"
  ON "KnowledgeUploadBatch"("id", "ownerUserId");
CREATE INDEX "KnowledgeUploadBatch_knowledgeBaseId_updatedAt_id_idx"
  ON "KnowledgeUploadBatch"("knowledgeBaseId", "updatedAt", "id");
CREATE INDEX "KnowledgeUploadBatch_ownerUserId_updatedAt_id_idx"
  ON "KnowledgeUploadBatch"("ownerUserId", "updatedAt", "id");

CREATE UNIQUE INDEX "KnowledgeUploadItem_batchId_clientFileId_key"
  ON "KnowledgeUploadItem"("batchId", "clientFileId");
CREATE UNIQUE INDEX "KnowledgeUploadItem_batchId_id_key"
  ON "KnowledgeUploadItem"("batchId", "id");
CREATE INDEX "KnowledgeUploadItem_storageKey_idx" ON "KnowledgeUploadItem"("storageKey");
CREATE INDEX "KnowledgeUploadItem_sourceId_idx" ON "KnowledgeUploadItem"("sourceId");
CREATE INDEX "KnowledgeUploadItem_state_sessionExpiresAt_updatedAt_id_idx"
  ON "KnowledgeUploadItem"("state", "sessionExpiresAt", "updatedAt", "id");
CREATE INDEX "KnowledgeUploadPart_uploadItemId_completedAt_partNumber_idx"
  ON "KnowledgeUploadPart"("uploadItemId", "completedAt", "partNumber");

ALTER TABLE "KnowledgeUploadBatch"
  ADD CONSTRAINT "KnowledgeUploadBatch_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeUploadBatch"
  ADD CONSTRAINT "KnowledgeUploadBatch_base_owner_fkey"
  FOREIGN KEY ("knowledgeBaseId", "ownerUserId")
  REFERENCES "KnowledgeBase"("id", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeUploadItem"
  ADD CONSTRAINT "KnowledgeUploadItem_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "KnowledgeUploadBatch"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "KnowledgeUploadPart"
  ADD CONSTRAINT "KnowledgeUploadPart_uploadItemId_fkey"
  FOREIGN KEY ("uploadItemId") REFERENCES "KnowledgeUploadItem"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
