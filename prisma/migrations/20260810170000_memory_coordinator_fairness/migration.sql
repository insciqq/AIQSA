-- Extend the shared durable fairness cursor with independent Memory job and
-- deletion lanes. Keeping separate rows prevents utility work from delaying
-- privacy-critical deletion reconciliation while retaining owner round-robin
-- progress within each lane.
BEGIN;

ALTER TABLE "DocumentProcessingFairnessCursor"
  DROP CONSTRAINT "DocumentProcessingFairnessCursor_pipeline_check";

ALTER TABLE "DocumentProcessingFairnessCursor"
  ADD CONSTRAINT "DocumentProcessingFairnessCursor_pipeline_check"
  CHECK ("pipeline" IN ('attachment', 'knowledge', 'memory-job', 'memory-delete'));

INSERT INTO "DocumentProcessingFairnessCursor" (
  "pipeline", "lastGrantedOwnerUserId", "updatedAt"
) VALUES
  ('memory-job', NULL, CURRENT_TIMESTAMP),
  ('memory-delete', NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("pipeline") DO NOTHING;

-- Rollback guidance: stop Memory coordinators, delete only the two Memory
-- cursor rows, then restore the prior attachment/knowledge-only constraint.
-- MemoryJob and MemoryDeletionOutbox rows and leases remain intact.

COMMIT;
