-- Put the immutable tenant key directly on each physical document-work row.
-- Backfill precedes NOT NULL and every denormalized value is then proved by a
-- composite foreign key to its owning aggregate; application code cannot move
-- queued work to another owner independently of that aggregate.
BEGIN;

ALTER TABLE "AttachmentProcessingJob"
  ADD COLUMN "ownerUserId" TEXT;

UPDATE "AttachmentProcessingJob" AS job
SET "ownerUserId" = attachment."userId"
FROM "Attachment" AS attachment
WHERE attachment."id" = job."attachmentId";

ALTER TABLE "KnowledgeDocumentVersion"
  ADD COLUMN "ownerUserId" TEXT;

UPDATE "KnowledgeDocumentVersion" AS version
SET "ownerUserId" = base."ownerUserId"
FROM "KnowledgeBase" AS base
WHERE base."id" = version."knowledgeBaseId";

ALTER TABLE "KnowledgeGenerationDocument"
  ADD COLUMN "ownerUserId" TEXT;

UPDATE "KnowledgeGenerationDocument" AS work
SET "ownerUserId" = base."ownerUserId"
FROM "KnowledgeBase" AS base
WHERE base."id" = work."knowledgeBaseId";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AttachmentProcessingJob" WHERE "ownerUserId" IS NULL) THEN
    RAISE EXCEPTION 'attachment processing owner backfill incomplete';
  END IF;
  IF EXISTS (SELECT 1 FROM "KnowledgeDocumentVersion" WHERE "ownerUserId" IS NULL) THEN
    RAISE EXCEPTION 'knowledge document owner backfill incomplete';
  END IF;
  IF EXISTS (SELECT 1 FROM "KnowledgeGenerationDocument" WHERE "ownerUserId" IS NULL) THEN
    RAISE EXCEPTION 'knowledge reindex owner backfill incomplete';
  END IF;
END $$;

ALTER TABLE "AttachmentProcessingJob"
  ALTER COLUMN "ownerUserId" SET NOT NULL;
ALTER TABLE "KnowledgeDocumentVersion"
  ALTER COLUMN "ownerUserId" SET NOT NULL;
ALTER TABLE "KnowledgeGenerationDocument"
  ALTER COLUMN "ownerUserId" SET NOT NULL;

CREATE UNIQUE INDEX "Attachment_id_userId_key"
  ON "Attachment"("id", "userId");
CREATE UNIQUE INDEX "KnowledgeBase_id_ownerUserId_key"
  ON "KnowledgeBase"("id", "ownerUserId");
CREATE UNIQUE INDEX "AttachmentProcessingJob_attachmentId_ownerUserId_key"
  ON "AttachmentProcessingJob"("attachmentId", "ownerUserId");

ALTER TABLE "AttachmentProcessingJob"
  DROP CONSTRAINT "AttachmentProcessingJob_attachmentId_fkey";
ALTER TABLE "AttachmentProcessingJob"
  ADD CONSTRAINT "AttachmentProcessingJob_attachment_owner_fkey"
  FOREIGN KEY ("attachmentId", "ownerUserId")
  REFERENCES "Attachment"("id", "userId")
  ON DELETE CASCADE ON UPDATE RESTRICT
  NOT VALID;
ALTER TABLE "AttachmentProcessingJob"
  VALIDATE CONSTRAINT "AttachmentProcessingJob_attachment_owner_fkey";

ALTER TABLE "KnowledgeDocumentVersion"
  ADD CONSTRAINT "KnowledgeDocumentVersion_knowledgeBase_owner_fkey"
  FOREIGN KEY ("knowledgeBaseId", "ownerUserId")
  REFERENCES "KnowledgeBase"("id", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT
  NOT VALID;
ALTER TABLE "KnowledgeDocumentVersion"
  VALIDATE CONSTRAINT "KnowledgeDocumentVersion_knowledgeBase_owner_fkey";

ALTER TABLE "KnowledgeGenerationDocument"
  ADD CONSTRAINT "KnowledgeGenerationDocument_knowledgeBase_owner_fkey"
  FOREIGN KEY ("knowledgeBaseId", "ownerUserId")
  REFERENCES "KnowledgeBase"("id", "ownerUserId")
  ON DELETE RESTRICT ON UPDATE RESTRICT
  NOT VALID;
ALTER TABLE "KnowledgeGenerationDocument"
  VALIDATE CONSTRAINT "KnowledgeGenerationDocument_knowledgeBase_owner_fkey";

-- Steady-state rotation uses owner-key ranges and takes only the first due row
-- from each physical queue. The Attachment due-first sibling retains its
-- one-time empty-cursor global-oldest path. Prisma owns the two ordinary
-- Attachment indexes below. The two Knowledge indexes are raw
-- partial indexes because Prisma 6 cannot represent an index predicate; keeping
-- terminal historical Knowledge rows out of queue indexes is required for the
-- steady-state bound and the migration contract verifies their exact predicates.
CREATE INDEX "AttachmentProcessingJob_owner_due_idx"
  ON "AttachmentProcessingJob"("ownerUserId", "nextAttemptAt", "createdAt", "id");
CREATE INDEX "AttachmentProcessingJob_due_owner_idx"
  ON "AttachmentProcessingJob"("nextAttemptAt", "createdAt", "ownerUserId", "id");

CREATE INDEX "KnowledgeDocumentVersion_owner_due_active_idx"
  ON "KnowledgeDocumentVersion"("ownerUserId", "ingestNextAttemptAt", "createdAt", "id")
  WHERE "ingestGenerationId" IS NOT NULL
    AND "ingestState" IN ('queued', 'parsing', 'chunking', 'embedding');

CREATE INDEX "KnowledgeGenerationDocument_owner_due_active_idx"
  ON "KnowledgeGenerationDocument"(
    "ownerUserId", "nextAttemptAt", "createdAt", "indexGenerationId", "documentVersionId"
  )
  WHERE "state" IN ('queued', 'embedding');

-- Rollback guidance: stop document workers, deploy the preceding application,
-- drop the four owner/due indexes and three composite owner
-- foreign keys, restore AttachmentProcessingJob_attachmentId_fkey, then drop
-- the three ownerUserId columns and the three composite unique indexes. Queue
-- payloads and active leases themselves require no rewrite.

COMMIT;
