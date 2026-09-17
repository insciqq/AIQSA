-- Forward-only recovery staging. Historical hash-only bindings remain valid;
-- no payload can be reconstructed from their hashes.
CREATE TABLE "MemoryHistoryExecution" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memoryJobId" TEXT NOT NULL,
  "executionBindingId" TEXT NOT NULL,
  "inputHash" VARCHAR(128) NOT NULL,
  "acceptedOutputHash" VARCHAR(128) NOT NULL,
  "acceptedOutput" JSONB,
  "recoverableUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "clearedAt" TIMESTAMP(3),
  CONSTRAINT "MemoryHistoryExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryHistoryExecution_user_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT "MemoryHistoryExecution_job_fkey" FOREIGN KEY ("userId", "memoryJobId")
    REFERENCES "MemoryJob"("userId", "id") ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT "MemoryHistoryExecution_binding_fkey" FOREIGN KEY ("userId", "executionBindingId")
    REFERENCES "MemoryExecutionBinding"("userId", "id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "MemoryHistoryExecution_shape_check" CHECK (
    "inputHash" ~ '^[a-f0-9]{64}$' AND "acceptedOutputHash" ~ '^[a-f0-9]{64}$'
    AND "recoverableUntil" >= "createdAt"
    AND (("clearedAt" IS NULL AND "acceptedOutput" IS NOT NULL
      AND jsonb_typeof("acceptedOutput") IN ('object', 'array'))
      OR ("clearedAt" IS NOT NULL AND "clearedAt" >= "createdAt" AND "acceptedOutput" IS NULL))
  )
);
CREATE UNIQUE INDEX "MemoryHistoryExecution_userId_id_key"
  ON "MemoryHistoryExecution"("userId", "id");
CREATE UNIQUE INDEX "MemoryHistoryExecution_userId_executionBindingId_key"
  ON "MemoryHistoryExecution"("userId", "executionBindingId");
CREATE INDEX "MemoryHistoryExecution_userId_memoryJobId_inputHash_idx"
  ON "MemoryHistoryExecution"("userId", "memoryJobId", "inputHash");
CREATE INDEX "MemoryHistoryExecution_userId_clearedAt_recoverableUntil_idx"
  ON "MemoryHistoryExecution"("userId", "clearedAt", "recoverableUntil");
CREATE INDEX "MemoryHistoryExecution_clearedAt_recoverableUntil_id_idx"
  ON "MemoryHistoryExecution"("clearedAt", "recoverableUntil", "id");

CREATE FUNCTION aiqsa_memory_history_execution_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."userId", NEW."memoryJobId", NEW."executionBindingId",
        NEW."inputHash", NEW."acceptedOutputHash", NEW."recoverableUntil", NEW."createdAt")
      IS DISTINCT FROM
       (OLD."id", OLD."userId", OLD."memoryJobId", OLD."executionBindingId",
        OLD."inputHash", OLD."acceptedOutputHash", OLD."recoverableUntil", OLD."createdAt")
      OR (NEW."acceptedOutput" IS NOT NULL AND
        NEW."acceptedOutput" IS DISTINCT FROM OLD."acceptedOutput")
      OR (OLD."clearedAt" IS NOT NULL AND NEW."clearedAt" IS DISTINCT FROM OLD."clearedAt")
    THEN
      RAISE EXCEPTION 'Memory history recovery identity and result are immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "MemoryExecutionBinding" binding
  JOIN "MemoryJob" job ON job."userId" = binding."userId" AND job.id = binding."memoryJobId"
  WHERE binding."userId" = NEW."userId" AND binding.id = NEW."executionBindingId"
    AND job.id = NEW."memoryJobId" AND job.kind = 'INDEX_HISTORY'
    AND binding."ownerType" = 'JOB' AND binding."logicalRole" = 'MEMORY_HISTORY_CLASSIFY'
    AND binding."inputHash" = NEW."inputHash"
    AND (binding.state = 'RUNNING' AND binding."acceptedOutputHash" IS NULL
      OR binding.state = 'SUCCEEDED' AND binding."acceptedOutputHash" = NEW."acceptedOutputHash");
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Memory history recovery binding is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "MemoryHistoryExecution_guard"
BEFORE INSERT OR UPDATE ON "MemoryHistoryExecution"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_history_execution_guard();
