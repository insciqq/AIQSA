-- Durable structured-output callbacks execute before the binding switches from
-- RUNNING to SUCCEEDED, within the same transaction. Preserve immediate
-- immutable identity/owner checks and defer final receipt proof until commit.
CREATE OR REPLACE FUNCTION aiqsa_memory_maintenance_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
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
      AND binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType" AND binding."pipelineVersion" = 'memory-maintenance-v1'
      AND binding."ordinal" = NEW."ordinal" AND binding."inputHash" = NEW."inputHash";
  IF NOT FOUND THEN RAISE EXCEPTION 'Memory maintenance execution owner invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION aiqsa_memory_maintenance_execution_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "MemoryMaintenanceExecution" execution
    WHERE execution."userId" = NEW."userId" AND execution.id = NEW.id
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryExecutionBinding" binding
        WHERE binding."userId" = execution."userId" AND binding.id = execution."executionBindingId"
          AND binding."memoryJobId" = execution."memoryJobId" AND binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType"
          AND binding."logicalRole" = 'MEMORY_SYNTHESIZE' AND binding."pipelineVersion" = 'memory-maintenance-v1'
          AND binding."ordinal" = execution."ordinal" AND binding."inputHash" = execution."inputHash"
          AND binding."acceptedOutputHash" = execution."acceptedOutputHash" AND binding.state = 'SUCCEEDED'::"MemoryExecutionState"
      )
  ) THEN RAISE EXCEPTION 'Memory maintenance execution receipt invalid' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "MemoryMaintenanceExecution_receipt_guard"
  AFTER INSERT OR UPDATE ON "MemoryMaintenanceExecution"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_maintenance_execution_receipt_guard();
