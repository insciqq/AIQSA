-- Policy v4 reviews every automatic fact once more and then again on a bounded
-- cadence: a settled keep, or a removal the verifier rejected, covers its
-- version only until its re-review. Earlier rows stay as history and never
-- cover a v4 review. Expand only: previous-release writers keep writing v3 rows
-- during Compose replacement, and this check still admits them with the
-- closed reasons of 20261003214704.
ALTER TABLE "MemoryMaintenanceReview" DROP CONSTRAINT "MemoryMaintenanceReview_shape_check";
ALTER TABLE "MemoryMaintenanceReview" ADD CONSTRAINT "MemoryMaintenanceReview_shape_check" CHECK (
  "sourceSnapshotHash" ~ '^[a-f0-9]{64}$'
  AND "policyVersion" IN (
    'memory-maintenance-policy-v1', 'memory-maintenance-policy-v2', 'memory-maintenance-policy-v3',
    'memory-maintenance-policy-v4'
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
-- Every owner's first v4 pass starts from its first version, owners in order.
UPDATE "UserMemorySettings" SET "maintenanceCursor" = NULL, "maintenanceScannedAt" = NULL;
