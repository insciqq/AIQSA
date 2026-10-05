-- Policy v5 reviews every unprotected automatic fact once more under the
-- task-local rules of maintenance prompt v6, then again on the unchanged
-- re-review cadence. Earlier rows stay as history and never cover a v5
-- review. Expand only: previous-release writers keep writing v4 rows during
-- Compose replacement, and this check still admits them with the closed
-- reasons of 20261004093000. Only this table is locked here: the cursor reset
-- runs in 20261006120001, its own transaction, because a previous-release
-- planner holds an owner's settings row lock while it scans reviews, and one
-- transaction taking both locks could deadlock against it.
ALTER TABLE "MemoryMaintenanceReview" DROP CONSTRAINT "MemoryMaintenanceReview_shape_check";
ALTER TABLE "MemoryMaintenanceReview" ADD CONSTRAINT "MemoryMaintenanceReview_shape_check" CHECK (
  "sourceSnapshotHash" ~ '^[a-f0-9]{64}$'
  AND "policyVersion" IN (
    'memory-maintenance-policy-v1', 'memory-maintenance-policy-v2', 'memory-maintenance-policy-v3',
    'memory-maintenance-policy-v4', 'memory-maintenance-policy-v5'
  )
  AND "disposition" IN (
    'PENDING', 'KEEP', 'REMOVED', 'REJECTED', 'STALE', 'UNKNOWN', 'BLOCKED', 'UNREVIEWABLE'
  )
  AND ("usefulness" IS NULL OR "usefulness" IN ('DURABLE', 'ONGOING', 'EPISODIC'))
  AND (("disposition" = 'PENDING' AND "reviewedAt" IS NULL AND "usefulness" IS NULL)
    OR ("disposition" <> 'PENDING' AND "reviewedAt" IS NOT NULL))
  AND ("disposition" = 'KEEP' OR "usefulness" IS NULL)
  AND ("reasonCode" IS NOT NULL OR "disposition" NOT IN ('BLOCKED', 'UNREVIEWABLE'))
  AND ("memoryJobId" IS NOT NULL OR "disposition" IN ('BLOCKED', 'UNREVIEWABLE'))
);
