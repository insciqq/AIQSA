CREATE TYPE "KnowledgeSearchProjectionState" AS ENUM (
  'PENDING',
  'BUILDING',
  'READY',
  'RETRY_WAIT',
  'FAILED',
  'DELETING',
  'DELETED'
);

CREATE TABLE "KnowledgeSearchProjection" (
  "id" UUID NOT NULL,
  "indexArtifactId" TEXT NOT NULL,
  "backendKind" VARCHAR(32) NOT NULL,
  "mappingVersion" INTEGER NOT NULL,
  "projectionFingerprint" CHAR(64) NOT NULL,
  "state" "KnowledgeSearchProjectionState" NOT NULL DEFAULT 'PENDING',
  "expectedPassageCount" INTEGER NOT NULL,
  "indexedPassageCount" INTEGER NOT NULL DEFAULT 0,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "claimToken" VARCHAR(128),
  "leaseExpiresAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastErrorCode" VARCHAR(64),
  "startedAt" TIMESTAMP(3),
  "readyAt" TIMESTAMP(3),
  "deleteCompletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeSearchProjection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeSearchProjection_bounds_check" CHECK (
    "mappingVersion" >= 1
    AND "expectedPassageCount" >= 0
    AND "indexedPassageCount" >= 0
    AND "attemptCount" >= 0
    AND "projectionFingerprint" ~ '^[0-9a-f]{64}$'
    AND ("claimToken" IS NULL) = ("leaseExpiresAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "KnowledgeSearchProjection_indexArtifactId_key"
  ON "KnowledgeSearchProjection"("indexArtifactId");

CREATE INDEX "KnowledgeSearchProjection_queue_idx"
  ON "KnowledgeSearchProjection"("state", "nextAttemptAt", "leaseExpiresAt", "createdAt");

ALTER TABLE "KnowledgeSearchProjection"
  ADD CONSTRAINT "KnowledgeSearchProjection_indexArtifactId_fkey"
  FOREIGN KEY ("indexArtifactId")
  REFERENCES "KnowledgeHierarchicalIndexArtifact"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
