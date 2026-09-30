ALTER TABLE "MemoryFactVersion" ADD COLUMN "usefulness" VARCHAR(16);
ALTER TABLE "UserMemorySettings" ADD COLUMN "maintenanceCursor" TEXT, ADD COLUMN "maintenanceScannedAt" TIMESTAMP(3);
ALTER TABLE "MemoryFactVersion" ADD CONSTRAINT "MemoryFactVersion_usefulness_check"
  CHECK ("usefulness" IS NULL OR "usefulness" IN ('DURABLE', 'ONGOING', 'EPISODIC'));

CREATE TABLE "MemoryMaintenanceReview" (
  "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "factVersionId" TEXT NOT NULL,
  "memoryJobId" TEXT NOT NULL, "policyVersion" VARCHAR(64) NOT NULL,
  "sourceSnapshotHash" CHAR(64) NOT NULL, "evidenceThrough" TIMESTAMP(3) NOT NULL,
  "disposition" VARCHAR(16) NOT NULL DEFAULT 'PENDING', "usefulness" VARCHAR(16),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "MemoryMaintenanceReview_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "MemoryMaintenanceReview_version_fkey" FOREIGN KEY ("userId", "factVersionId") REFERENCES "MemoryFactVersion"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "MemoryMaintenanceReview_shape_check" CHECK (
    "sourceSnapshotHash" ~ '^[a-f0-9]{64}$' AND "policyVersion" = 'memory-maintenance-policy-v1'
    AND "disposition" IN ('PENDING', 'KEEP', 'REMOVED', 'REJECTED', 'STALE', 'UNKNOWN')
    AND ("usefulness" IS NULL OR "usefulness" IN ('DURABLE', 'ONGOING', 'EPISODIC'))
    AND (("disposition" = 'PENDING' AND "reviewedAt" IS NULL AND "usefulness" IS NULL)
      OR ("disposition" <> 'PENDING' AND "reviewedAt" IS NOT NULL))
    AND ("disposition" = 'KEEP' OR "usefulness" IS NULL)
  )
);
CREATE UNIQUE INDEX "MemoryMaintenanceReview_userId_id_key" ON "MemoryMaintenanceReview"("userId", "id");
CREATE UNIQUE INDEX "MemoryMaintenanceReview_source_key" ON "MemoryMaintenanceReview"("userId", "factVersionId", "policyVersion", "sourceSnapshotHash");
CREATE INDEX "MemoryMaintenanceReview_userId_memoryJobId_idx" ON "MemoryMaintenanceReview"("userId", "memoryJobId");
CREATE INDEX "MemoryMaintenanceReview_coverage_idx" ON "MemoryMaintenanceReview"("userId", "factVersionId", "policyVersion", "evidenceThrough");

CREATE TABLE "MemoryMaintenanceExecution" (
  "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "memoryJobId" TEXT NOT NULL,
  "executionBindingId" TEXT NOT NULL, "ordinal" INTEGER NOT NULL,
  "inputHash" CHAR(64) NOT NULL, "acceptedOutputHash" CHAR(64) NOT NULL, "acceptedOutput" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "appliedAt" TIMESTAMP(3),
  CONSTRAINT "MemoryMaintenanceExecution_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "MemoryMaintenanceExecution_job_fkey" FOREIGN KEY ("userId", "memoryJobId") REFERENCES "MemoryJob"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "MemoryMaintenanceExecution_binding_fkey" FOREIGN KEY ("userId", "executionBindingId") REFERENCES "MemoryExecutionBinding"("userId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MemoryMaintenanceExecution_shape_check" CHECK (
    "ordinal" IN (0, 1) AND "inputHash" ~ '^[a-f0-9]{64}$' AND "acceptedOutputHash" ~ '^[a-f0-9]{64}$'
    AND (("appliedAt" IS NULL AND jsonb_typeof("acceptedOutput") = 'object') OR ("appliedAt" IS NOT NULL AND "acceptedOutput" IS NULL))
  )
);
CREATE UNIQUE INDEX "MemoryMaintenanceExecution_userId_id_key" ON "MemoryMaintenanceExecution"("userId", "id");
CREATE UNIQUE INDEX "MemoryMaintenanceExecution_job_ordinal_key" ON "MemoryMaintenanceExecution"("userId", "memoryJobId", "ordinal");
CREATE UNIQUE INDEX "MemoryMaintenanceExecution_userId_executionBindingId_key" ON "MemoryMaintenanceExecution"("userId", "executionBindingId");

CREATE TABLE "MemoryMaintenanceSuppression" (
  "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "sourceMessageId" TEXT NOT NULL,
  "sourceMessageContentHash" VARCHAR(128) NOT NULL, "sourceStartOffset" INTEGER NOT NULL,
  "sourceEndOffset" INTEGER NOT NULL, "memoryReviewId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryMaintenanceSuppression_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "MemoryMaintenanceSuppression_shape_check" CHECK (
    "sourceMessageContentHash" ~ '^[a-f0-9]{64}$' AND "sourceStartOffset" >= 0 AND "sourceEndOffset" > "sourceStartOffset"
  )
);
CREATE UNIQUE INDEX "MemoryMaintenanceSuppression_userId_id_key" ON "MemoryMaintenanceSuppression"("userId", "id");
CREATE UNIQUE INDEX "MemoryMaintenanceSuppression_span_key" ON "MemoryMaintenanceSuppression"("userId", "sourceMessageId", "sourceMessageContentHash", "sourceStartOffset", "sourceEndOffset");
CREATE INDEX "MemoryMaintenanceSuppression_userId_sourceMessageId_idx" ON "MemoryMaintenanceSuppression"("userId", "sourceMessageId");

-- The fence outlives the review/job/version, and disappears only with its
-- owner. Insert proves exact review/evidence authority without a cascading FK.
CREATE FUNCTION aiqsa_memory_maintenance_suppression_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Memory cleanup suppression is immutable' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM "MemoryMaintenanceReview" review
    JOIN "MemoryEvidence" evidence ON evidence."userId" = review."userId" AND evidence."factVersionId" = review."factVersionId"
    JOIN "MemoryFactVersion" version ON version."userId" = review."userId" AND version.id = review."factVersionId"
    JOIN "MemoryFact" fact ON fact."userId" = version."userId" AND fact.id = version."factId"
    WHERE review."userId" = NEW."userId" AND review.id = NEW."memoryReviewId" AND review.disposition = 'PENDING'
      AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode" AND fact."currentVersionId" = version.id AND NOT fact.pinned
      AND evidence."sourceMessageContentHash" = NEW."sourceMessageContentHash" AND evidence."messageId" = NEW."sourceMessageId"
      AND evidence."sourceStartOffset" = NEW."sourceStartOffset" AND evidence."sourceEndOffset" = NEW."sourceEndOffset";
  IF NOT FOUND THEN RAISE EXCEPTION 'Memory cleanup suppression source invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "MemoryMaintenanceSuppression_guard" BEFORE INSERT OR UPDATE ON "MemoryMaintenanceSuppression"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_maintenance_suppression_guard();

CREATE FUNCTION aiqsa_memory_maintenance_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    (NEW."id", NEW."userId", NEW."memoryJobId", NEW."executionBindingId", NEW."ordinal", NEW."inputHash", NEW."acceptedOutputHash", NEW."createdAt")
      IS DISTINCT FROM
    (OLD."id", OLD."userId", OLD."memoryJobId", OLD."executionBindingId", OLD."ordinal", OLD."inputHash", OLD."acceptedOutputHash", OLD."createdAt")
    OR OLD."appliedAt" IS NOT NULL
    OR (NEW."appliedAt" IS NULL AND NEW."acceptedOutput" IS DISTINCT FROM OLD."acceptedOutput")
  ) THEN RAISE EXCEPTION 'Memory maintenance execution is immutable' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM "MemoryJob" job JOIN "MemoryExecutionBinding" binding
    ON binding."userId" = job."userId" AND binding."memoryJobId" = job.id
    WHERE job."userId" = NEW."userId" AND job.id = NEW."memoryJobId"
      AND job.kind = 'SYNTHESIZE_MEMORIES'::"MemoryJobKind" AND job."pipelineVersion" = 'memory-maintenance-v1'
      AND binding.id = NEW."executionBindingId" AND binding."logicalRole" = 'MEMORY_SYNTHESIZE'
      AND binding."ordinal" = NEW."ordinal" AND binding."inputHash" = NEW."inputHash"
      AND binding."acceptedOutputHash" = NEW."acceptedOutputHash" AND binding.state = 'SUCCEEDED'::"MemoryExecutionState";
  IF NOT FOUND THEN RAISE EXCEPTION 'Memory maintenance execution receipt invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "MemoryMaintenanceExecution_guard" BEFORE INSERT OR UPDATE ON "MemoryMaintenanceExecution"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_maintenance_execution_guard();

CREATE FUNCTION aiqsa_memory_maintenance_review_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    (NEW.id, NEW."userId", NEW."factVersionId", NEW."memoryJobId", NEW."policyVersion", NEW."sourceSnapshotHash", NEW."evidenceThrough", NEW."createdAt")
      IS DISTINCT FROM
    (OLD.id, OLD."userId", OLD."factVersionId", OLD."memoryJobId", OLD."policyVersion", OLD."sourceSnapshotHash", OLD."evidenceThrough", OLD."createdAt")
    OR OLD.disposition <> 'PENDING'
  ) THEN RAISE EXCEPTION 'Memory maintenance review identity is immutable' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM "MemoryJob" job WHERE job."userId" = NEW."userId" AND job.id = NEW."memoryJobId"
    AND job.kind = 'SYNTHESIZE_MEMORIES'::"MemoryJobKind" AND job."pipelineVersion" = 'memory-maintenance-v1';
  IF NOT FOUND THEN RAISE EXCEPTION 'Memory maintenance review owner invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "MemoryMaintenanceReview_guard" BEFORE INSERT OR UPDATE ON "MemoryMaintenanceReview"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_maintenance_review_guard();
