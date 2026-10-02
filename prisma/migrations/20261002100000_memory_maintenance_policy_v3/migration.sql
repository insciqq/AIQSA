-- Policy v3 reviews every remaining automatic fact against the long-term
-- criterion. v1/v2 receipts and paid evidence stay; previous-release v2 writers
-- keep inserting job-bound rows without a reason during Compose replacement.
-- A blocked or unreviewable source is recorded content-free, without a job.
ALTER TABLE "MemoryMaintenanceReview" ADD COLUMN "reasonCode" VARCHAR(32);
ALTER TABLE "MemoryMaintenanceReview" ALTER COLUMN "memoryJobId" DROP NOT NULL;
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
  AND (("reasonCode" IS NOT NULL) = ("disposition" IN ('BLOCKED', 'UNREVIEWABLE')))
  AND ("memoryJobId" IS NOT NULL OR "disposition" IN ('BLOCKED', 'UNREVIEWABLE'))
);
ALTER TABLE "MemoryMaintenanceReview" ADD CONSTRAINT "MemoryMaintenanceReview_reason_check" CHECK (
  "reasonCode" IS NULL
  OR ("disposition" = 'BLOCKED'
    AND "reasonCode" IN ('pending_relation', 'evidence_without_offsets', 'source_changed'))
  OR ("disposition" = 'UNREVIEWABLE'
    AND "reasonCode" IN ('unreviewable_context', 'statement_too_long', 'evidence_not_current'))
);
UPDATE "UserMemorySettings" SET "maintenanceCursor" = NULL, "maintenanceScannedAt" = NULL;

-- A job-bound row keeps the former owner proof. Only the planner inserts a
-- job-free BLOCKED/UNREVIEWABLE row; a reason is set only on PENDING -> BLOCKED.
CREATE OR REPLACE FUNCTION aiqsa_memory_maintenance_review_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    (NEW.id, NEW."userId", NEW."factVersionId", NEW."memoryJobId", NEW."policyVersion", NEW."sourceSnapshotHash", NEW."evidenceThrough", NEW."createdAt")
      IS DISTINCT FROM
    (OLD.id, OLD."userId", OLD."factVersionId", OLD."memoryJobId", OLD."policyVersion", OLD."sourceSnapshotHash", OLD."evidenceThrough", OLD."createdAt")
    OR OLD.disposition <> 'PENDING'
    OR (NEW."reasonCode" IS NOT NULL AND NEW.disposition <> 'BLOCKED')
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

-- The fence covers the exact source spans of every version of the removed
-- fact. The reviewed version is still current, unpinned and entirely
-- automatic; the PENDING review proves the decision being committed.
CREATE OR REPLACE FUNCTION aiqsa_memory_maintenance_suppression_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Memory cleanup suppression is immutable' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM "MemoryMaintenanceReview" review
    JOIN "MemoryFactVersion" version ON version."userId" = review."userId" AND version.id = review."factVersionId"
    JOIN "MemoryFact" fact ON fact."userId" = version."userId" AND fact.id = version."factId"
    JOIN "MemoryFactVersion" lineage ON lineage."userId" = fact."userId" AND lineage."factId" = fact.id
    JOIN "MemoryEvidence" evidence ON evidence."userId" = lineage."userId" AND evidence."factVersionId" = lineage.id
    WHERE review."userId" = NEW."userId" AND review.id = NEW."memoryReviewId" AND review.disposition = 'PENDING'
      AND fact."currentVersionId" = version.id AND NOT fact.pinned
      AND NOT EXISTS (SELECT 1 FROM "MemoryFactVersion" other
        WHERE other."userId" = fact."userId" AND other."factId" = fact.id
          AND other."sourceMode" <> 'AUTOMATIC'::"MemoryFactSourceMode")
      AND evidence."sourceMessageContentHash" = NEW."sourceMessageContentHash" AND evidence."messageId" = NEW."sourceMessageId"
      AND evidence."sourceStartOffset" = NEW."sourceStartOffset" AND evidence."sourceEndOffset" = NEW."sourceEndOffset";
  IF NOT FOUND THEN RAISE EXCEPTION 'Memory cleanup suppression source invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$function$;

-- A source fact forgotten only by governed maintenance: no owner action ever
-- touched it and its latest job FORGET is the automatic cleanup. Its plaintext
-- and evidence are purged; it no longer fences facts that used it as a hint.
CREATE FUNCTION aiqsa_memory_dependency_source_auto_cleaned(
  p_user_id TEXT,
  p_version_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM "MemoryFactVersion" AS source_version
    INNER JOIN "MemoryFact" AS source_fact
      ON source_fact."userId" = source_version."userId"
      AND source_fact."id" = source_version."factId"
      AND source_fact."state" = 'FORGOTTEN'::"MemoryFactState"
    WHERE source_version."userId" = p_user_id
      AND source_version."id" = p_version_id
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryEvent" AS owner_event
        WHERE owner_event."userId" = source_fact."userId"
          AND owner_event."factId" = source_fact."id"
          AND owner_event."actorType" = 'USER'::"MemoryActorType"
      )
      AND (
        SELECT forget_event."metadata"->>'reasonCode'
        FROM "MemoryEvent" AS forget_event
        WHERE forget_event."userId" = source_fact."userId"
          AND forget_event."factId" = source_fact."id"
          AND forget_event."actorType" = 'JOB'::"MemoryActorType"
          AND forget_event."operation" = 'FORGET'::"MemoryEventOperation"
        ORDER BY forget_event."createdAt" DESC, forget_event."id" DESC
        LIMIT 1
      ) = 'automatic_transient_cleanup'
  );
$function$;

-- Read authority of dependent facts. A source fact cleaned by maintenance
-- stays a valid extraction hint; the chain stops there. Writes keep checking
-- the direct source with aiqsa_memory_dependency_source_version_valid.
CREATE OR REPLACE FUNCTION aiqsa_memory_fact_dependencies_valid(
  p_user_id TEXT,
  p_target_version_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  WITH RECURSIVE dependency_chain AS (
    SELECT
      dependency."id",
      dependency."targetFactVersionId",
      dependency."sourceMessageId",
      dependency."sourceMessageUpdatedAt",
      dependency."sourceFactVersionId",
      1 AS depth,
      ARRAY[p_target_version_id, dependency."sourceFactVersionId"]::TEXT[] AS visited,
      dependency."sourceFactVersionId" = p_target_version_id AS cycle,
      (
        dependency."sourceFactVersionId" IS NOT NULL
        AND aiqsa_memory_dependency_source_auto_cleaned(p_user_id, dependency."sourceFactVersionId")
      ) AS cleaned
    FROM "MemoryFactVersionSourceDependency" AS dependency
    WHERE dependency."userId" = p_user_id
      AND dependency."targetFactVersionId" = p_target_version_id

    UNION ALL

    SELECT
      nested."id",
      nested."targetFactVersionId",
      nested."sourceMessageId",
      nested."sourceMessageUpdatedAt",
      nested."sourceFactVersionId",
      parent.depth + 1,
      parent.visited || nested."sourceFactVersionId",
      nested."sourceFactVersionId" = ANY(parent.visited),
      (
        nested."sourceFactVersionId" IS NOT NULL
        AND aiqsa_memory_dependency_source_auto_cleaned(p_user_id, nested."sourceFactVersionId")
      )
    FROM dependency_chain AS parent
    INNER JOIN "MemoryFactVersionSourceDependency" AS nested
      ON nested."userId" = p_user_id
      AND nested."targetFactVersionId" = parent."sourceFactVersionId"
    WHERE parent."sourceFactVersionId" IS NOT NULL
      AND NOT parent.cycle
      AND NOT parent.cleaned
      AND parent.depth <= 2
  )
  SELECT NOT EXISTS (
    SELECT 1
    FROM dependency_chain AS dependency
    WHERE dependency.cycle
      OR dependency.depth > 2
      OR (
        dependency."sourceMessageId" IS NOT NULL
        AND NOT aiqsa_memory_message_dependency_valid(
          p_user_id,
          dependency."sourceMessageId",
          dependency."sourceMessageUpdatedAt"
        )
      )
      OR (
        dependency."sourceFactVersionId" IS NOT NULL
        AND NOT dependency.cleaned
        AND NOT aiqsa_memory_dependency_source_version_valid(
          p_user_id,
          dependency."sourceFactVersionId"
        )
      )
  );
$function$;
