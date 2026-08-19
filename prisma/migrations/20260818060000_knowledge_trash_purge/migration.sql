CREATE TYPE "KnowledgeDeletionTargetType" AS ENUM ('SOURCE', 'BASE');
CREATE TYPE "KnowledgeDeletionState" AS ENUM (
  'PENDING',
  'RUNNING',
  'RETRY_WAIT',
  'BLOCKED_REQUIRES_ADMIN',
  'SUCCEEDED'
);
CREATE TYPE "KnowledgeDeletionObjectDisposition" AS ENUM ('PENDING', 'DELETED', 'RETAINED');

ALTER TABLE "KnowledgeBase"
  ADD COLUMN "trashedAt" TIMESTAMP(3),
  ADD COLUMN "deletionRequestedAt" TIMESTAMP(3),
  ADD CONSTRAINT "KnowledgeBase_deletion_lifecycle_check" CHECK (
    "deletionRequestedAt" IS NULL OR "trashedAt" IS NOT NULL
  );

ALTER TABLE "KnowledgeSource"
  ADD COLUMN "trashedAt" TIMESTAMP(3),
  ADD COLUMN "deletionRequestedAt" TIMESTAMP(3),
  ADD CONSTRAINT "KnowledgeSource_deletion_lifecycle_check" CHECK (
    "deletionRequestedAt" IS NULL OR "trashedAt" IS NOT NULL
  );

DROP INDEX "KnowledgeBase_ownerUserId_archivedAt_idx";
CREATE INDEX "KnowledgeBase_ownerUserId_trashedAt_archivedAt_idx"
  ON "KnowledgeBase"("ownerUserId", "trashedAt", "archivedAt");
CREATE INDEX "KnowledgeBase_trashedAt_deletionRequestedAt_id_idx"
  ON "KnowledgeBase"("trashedAt", "deletionRequestedAt", "id");

DROP INDEX "KnowledgeSource_ownerUserId_name_idx";
CREATE INDEX "KnowledgeSource_ownerUserId_trashedAt_name_idx"
  ON "KnowledgeSource"("ownerUserId", "trashedAt", "name");
CREATE INDEX "KnowledgeSource_trashedAt_deletionRequestedAt_id_idx"
  ON "KnowledgeSource"("trashedAt", "deletionRequestedAt", "id");

CREATE TABLE "KnowledgeDeletionJob" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "targetType" "KnowledgeDeletionTargetType" NOT NULL,
  "targetId" TEXT NOT NULL,
  "state" "KnowledgeDeletionState" NOT NULL DEFAULT 'PENDING',
  "manifestVersion" INTEGER NOT NULL DEFAULT 1,
  "claimToken" TEXT,
  "claimedAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeDeletionJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeDeletionJob_target_check" CHECK (
    btrim("ownerUserId") <> '' AND btrim("targetId") <> ''
  ),
  CONSTRAINT "KnowledgeDeletionJob_manifest_check" CHECK ("manifestVersion" = 1),
  CONSTRAINT "KnowledgeDeletionJob_attempt_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "KnowledgeDeletionJob_claim_check" CHECK (
    ("state" = 'RUNNING' AND "claimToken" IS NOT NULL AND
      "claimedAt" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) OR
    ("state" <> 'RUNNING' AND "claimToken" IS NULL AND
      "claimedAt" IS NULL AND "leaseExpiresAt" IS NULL)
  ),
  CONSTRAINT "KnowledgeDeletionJob_completion_check" CHECK (
    ("state" = 'SUCCEEDED' AND "completedAt" IS NOT NULL) OR
    ("state" <> 'SUCCEEDED' AND "completedAt" IS NULL)
  )
);

CREATE TABLE "KnowledgeDeletionObject" (
  "knowledgeDeletionJobId" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "disposition" "KnowledgeDeletionObjectDisposition" NOT NULL DEFAULT 'PENDING',
  "settledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "KnowledgeDeletionObject_pkey"
    PRIMARY KEY ("knowledgeDeletionJobId", "storageKey"),
  CONSTRAINT "KnowledgeDeletionObject_storageKey_check" CHECK (btrim("storageKey") <> ''),
  CONSTRAINT "KnowledgeDeletionObject_settlement_check" CHECK (
    ("disposition" = 'PENDING' AND "settledAt" IS NULL) OR
    ("disposition" <> 'PENDING' AND "settledAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "KnowledgeDeletionJob_targetType_targetId_key"
  ON "KnowledgeDeletionJob"("targetType", "targetId");
CREATE INDEX "KnowledgeDeletionJob_state_nextAttemptAt_leaseExpiresAt_cre_idx"
  ON "KnowledgeDeletionJob"("state", "nextAttemptAt", "leaseExpiresAt", "createdAt", "id");
CREATE INDEX "KnowledgeDeletionJob_ownerUserId_state_createdAt_id_idx"
  ON "KnowledgeDeletionJob"("ownerUserId", "state", "createdAt", "id");
CREATE INDEX "KnowledgeDeletionObject_storageKey_disposition_idx"
  ON "KnowledgeDeletionObject"("storageKey", "disposition");

ALTER TABLE "KnowledgeDeletionObject"
  ADD CONSTRAINT "KnowledgeDeletionObject_knowledgeDeletionJobId_fkey"
  FOREIGN KEY ("knowledgeDeletionJobId") REFERENCES "KnowledgeDeletionJob"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "preventKnowledgeSourceVersionMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('aiqsa.knowledge_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'knowledge_source_version_immutable' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION "enforceKnowledgeBaseSourceHistory"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('aiqsa.knowledge_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'knowledge_base_source_history_immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."knowledgeBaseId" <> NEW."knowledgeBaseId" OR
     OLD."sourceId" <> NEW."sourceId" OR
     OLD."ownerUserId" <> NEW."ownerUserId" OR
     OLD."createdAt" <> NEW."createdAt" THEN
    RAISE EXCEPTION 'knowledge_base_source_identity_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "preventKnowledgeV1MappingMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('aiqsa.knowledge_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'knowledge_v1_source_mapping_immutable' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION "preventReadyKnowledgeSourceArtifactMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('aiqsa.knowledge_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF OLD."state" = 'ready' THEN
    RAISE EXCEPTION 'knowledge_source_artifact_ready_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION "preventKnowledgeBaseSnapshotMutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('aiqsa.knowledge_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'knowledge_base_snapshot_immutable' USING ERRCODE = '55000';
END;
$$;
