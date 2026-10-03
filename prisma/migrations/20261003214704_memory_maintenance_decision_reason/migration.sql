-- A settled maintenance decision keeps its closed, content-free reason: the
-- reviewer's removal reason on REMOVED and REJECTED, and unresolved_scope on a
-- keep that resolved contradictory labels. Removed facts are purged with their
-- text and evidence, so this reason is their only audit trail; no free text is
-- ever stored. Expand only: previous-release writers keep settling without a
-- reason during Compose replacement, and existing rows already satisfy the
-- wider checks.
ALTER TABLE "MemoryMaintenanceReview" DROP CONSTRAINT "MemoryMaintenanceReview_shape_check";
ALTER TABLE "MemoryMaintenanceReview" ADD CONSTRAINT "MemoryMaintenanceReview_shape_check" CHECK (
  "sourceSnapshotHash" ~ '^[a-f0-9]{64}$'
  AND "policyVersion" IN (
    'memory-maintenance-policy-v1', 'memory-maintenance-policy-v2', 'memory-maintenance-policy-v3'
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
ALTER TABLE "MemoryMaintenanceReview" DROP CONSTRAINT "MemoryMaintenanceReview_reason_check";
ALTER TABLE "MemoryMaintenanceReview" ADD CONSTRAINT "MemoryMaintenanceReview_reason_check" CHECK (
  "reasonCode" IS NULL
  OR ("disposition" = 'BLOCKED'
    AND "reasonCode" IN ('pending_relation', 'evidence_without_offsets', 'source_changed'))
  OR ("disposition" = 'UNREVIEWABLE'
    AND "reasonCode" IN ('unreviewable_context', 'statement_too_long', 'evidence_not_current'))
  OR ("disposition" IN ('REMOVED', 'REJECTED')
    AND "reasonCode" IN ('episode', 'short_term', 'not_distinctive', 'one_off_task_detail', 'context_dependent_fragment'))
  OR ("disposition" = 'KEEP' AND "usefulness" IS NULL AND "reasonCode" = 'unresolved_scope')
);

-- A job-bound row keeps the former owner proof. Only the planner inserts a
-- job-free BLOCKED/UNREVIEWABLE row; a reason is set only when a PENDING review
-- settles as BLOCKED, KEEP, REMOVED or REJECTED, never changed afterwards.
CREATE OR REPLACE FUNCTION aiqsa_memory_maintenance_review_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    (NEW.id, NEW."userId", NEW."factVersionId", NEW."memoryJobId", NEW."policyVersion", NEW."sourceSnapshotHash", NEW."evidenceThrough", NEW."createdAt")
      IS DISTINCT FROM
    (OLD.id, OLD."userId", OLD."factVersionId", OLD."memoryJobId", OLD."policyVersion", OLD."sourceSnapshotHash", OLD."evidenceThrough", OLD."createdAt")
    OR OLD.disposition <> 'PENDING'
    OR (NEW."reasonCode" IS NOT NULL AND NEW.disposition NOT IN ('BLOCKED', 'KEEP', 'REMOVED', 'REJECTED'))
  ) THEN RAISE EXCEPTION 'Memory maintenance review identity is immutable' USING ERRCODE = '23514'; END IF;
  IF NEW."memoryJobId" IS NULL THEN
    IF TG_OP <> 'INSERT' OR NEW.disposition NOT IN ('BLOCKED', 'UNREVIEWABLE') THEN
      RAISE EXCEPTION 'Memory maintenance review owner invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "MemoryJob" job WHERE job."userId" = NEW."userId" AND job.id = NEW."memoryJobId"
    AND job.kind = 'SYNTHESIZE_MEMORIES'::"MemoryJobKind" AND job."pipelineVersion" = 'memory-maintenance-v1';
  IF NOT FOUND THEN RAISE EXCEPTION 'Memory maintenance review owner invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$function$;
