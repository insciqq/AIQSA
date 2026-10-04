-- Since 20261003090000_remove_local_mcp_sources no release writes the
-- resolving/preparing_runtime activation stages, and this release no longer
-- reads them. Jobs an older release left in them restart from the beginning,
-- as the worker already restarts a reclaimed stale lease; it revalidates the
-- draft before it connects. Leases and timestamps stay, so lease staleness is
-- unchanged.
--
-- Expand only: the previous release still names these enum values in its
-- activation filters and still selects "workloadToken" during Compose
-- replacement, so the column and the enum values are dropped by a later release.
UPDATE "McpActivationJob" SET "stage" = 'queued'
WHERE "stage" IN ('resolving', 'preparing_runtime');
