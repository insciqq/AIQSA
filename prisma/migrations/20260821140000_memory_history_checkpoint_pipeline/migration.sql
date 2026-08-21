ALTER TABLE "ChatMemoryCheckpoint"
ADD COLUMN "pipelineVersion" VARCHAR(64) NOT NULL
DEFAULT 'memory-history-index-v1';

-- Every pre-migration READY checkpoint was produced before the current
-- semantic history-safety stage. Keep it explicitly stale instead of
-- pretending it satisfies the new projection contract.
ALTER TABLE "ChatMemoryCheckpoint"
ALTER COLUMN "pipelineVersion" SET DEFAULT 'memory-history-index-v3';

ALTER TABLE "ChatMemoryCheckpoint"
ADD CONSTRAINT "ChatMemoryCheckpoint_pipeline_version_check"
CHECK ("pipelineVersion" ~ '^[A-Za-z0-9._-]{1,64}$');
