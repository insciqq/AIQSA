-- Serialize only Attachment/Knowledge claim selection through independent,
-- durable owner cursors. The cursor deliberately has no User foreign key:
-- deleting the previously granted owner must not block deletion or reset the
-- circular lexicographic position for the remaining owners.
BEGIN;

CREATE TABLE "DocumentProcessingFairnessCursor" (
  "pipeline" VARCHAR(32) NOT NULL,
  "lastGrantedOwnerUserId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DocumentProcessingFairnessCursor_pkey" PRIMARY KEY ("pipeline"),
  CONSTRAINT "DocumentProcessingFairnessCursor_pipeline_check"
    CHECK ("pipeline" IN ('attachment', 'knowledge'))
);

-- Foundation rows make the first post-migration claim deterministic. Runtime
-- claims also repair a missing row before locking it, so adopted databases do
-- not require an operator repair if a cursor row was removed accidentally.
INSERT INTO "DocumentProcessingFairnessCursor" (
  "pipeline", "lastGrantedOwnerUserId", "updatedAt"
) VALUES
  ('attachment', NULL, CURRENT_TIMESTAMP),
  ('knowledge', NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("pipeline") DO NOTHING;

-- Rollback guidance (non-destructive to user content): stop document workers,
-- then drop only DocumentProcessingFairnessCursor. Queue rows and active
-- leases remain valid; the prior global-FIFO claim behavior resumes with the
-- older application version.

COMMIT;
