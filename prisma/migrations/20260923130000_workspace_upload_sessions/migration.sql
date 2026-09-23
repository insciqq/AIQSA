CREATE TABLE "AttachmentUpload" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "projectId" TEXT,
  "projectScoped" BOOLEAN NOT NULL DEFAULT false,
  "idempotencyKey" VARCHAR(64) NOT NULL,
  "fileName" VARCHAR(512) NOT NULL,
  "mimeType" VARCHAR(255) NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'uploading',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "claimToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "errorCode" VARCHAR(64),
  "attachmentId" TEXT,
  "cleanedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AttachmentUpload_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AttachmentUpload_size_check" CHECK ("byteSize" BETWEEN 1 AND 536870912),
  CONSTRAINT "AttachmentUpload_state_check" CHECK ("state" IN ('uploading', 'verifying', 'completed', 'cancelled', 'expired', 'failed')),
  CONSTRAINT "AttachmentUpload_scope_check" CHECK ("projectScoped" OR "projectId" IS NULL),
  CONSTRAINT "AttachmentUpload_claim_check" CHECK (("claimToken" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CONSTRAINT "AttachmentUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT "AttachmentUpload_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT "AttachmentUpload_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "AttachmentUpload_userId_idempotencyKey_key" ON "AttachmentUpload"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "AttachmentUpload_attachmentId_key" ON "AttachmentUpload"("attachmentId");
CREATE INDEX "AttachmentUpload_state_nextAttemptAt_idx" ON "AttachmentUpload"("state", "nextAttemptAt");
CREATE INDEX "AttachmentUpload_expiresAt_idx" ON "AttachmentUpload"("expiresAt");
CREATE INDEX "AttachmentUpload_projectId_idx" ON "AttachmentUpload"("projectId");

CREATE TABLE "AttachmentUploadObject" (
  "id" TEXT NOT NULL,
  "uploadId" TEXT NOT NULL,
  "partNumber" INTEGER,
  "storageKey" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "checksum" CHAR(64),
  "ready" BOOLEAN NOT NULL DEFAULT false,
  "claimToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AttachmentUploadObject_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AttachmentUploadObject_size_check" CHECK ("byteSize" BETWEEN 1 AND 536870912),
  CONSTRAINT "AttachmentUploadObject_part_check" CHECK ("partNumber" IS NULL OR ("partNumber" BETWEEN 1 AND 64 AND "byteSize" <= 8388608 AND "checksum" ~ '^[a-f0-9]{64}$')),
  CONSTRAINT "AttachmentUploadObject_claim_check" CHECK (("claimToken" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CONSTRAINT "AttachmentUploadObject_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "AttachmentUpload"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "AttachmentUploadObject_storageKey_key" ON "AttachmentUploadObject"("storageKey");
CREATE UNIQUE INDEX "AttachmentUploadObject_uploadId_partNumber_key" ON "AttachmentUploadObject"("uploadId", "partNumber");
