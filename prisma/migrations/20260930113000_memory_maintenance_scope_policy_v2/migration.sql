-- Retain v1 decisions and immutable paid-execution evidence. A separate v2
-- checkpoint reviews only remaining live facts; no source or deleted fact is
-- recreated and no old execution is re-admitted.
ALTER TABLE "MemoryMaintenanceReview" DROP CONSTRAINT "MemoryMaintenanceReview_shape_check";
ALTER TABLE "MemoryMaintenanceReview" ADD CONSTRAINT "MemoryMaintenanceReview_shape_check" CHECK (
  "sourceSnapshotHash" ~ '^[a-f0-9]{64}$'
  AND "policyVersion" IN ('memory-maintenance-policy-v1', 'memory-maintenance-policy-v2')
  AND "disposition" IN ('PENDING', 'KEEP', 'REMOVED', 'REJECTED', 'STALE', 'UNKNOWN')
  AND ("usefulness" IS NULL OR "usefulness" IN ('DURABLE', 'ONGOING', 'EPISODIC'))
  AND (("disposition" = 'PENDING' AND "reviewedAt" IS NULL AND "usefulness" IS NULL)
    OR ("disposition" <> 'PENDING' AND "reviewedAt" IS NOT NULL))
  AND ("disposition" = 'KEEP' OR "usefulness" IS NULL)
);
UPDATE "UserMemorySettings" SET "maintenanceCursor" = NULL, "maintenanceScannedAt" = NULL;
