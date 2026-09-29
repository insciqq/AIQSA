-- This setting now bounds each explicit Memory search tool call. Retire the
-- admission setting's tuned values so all installations start at 30 seconds.
ALTER TABLE "ModelPolicy"
  RENAME COLUMN "memoryAdmissionTimeoutSeconds" TO "memorySearchTimeoutSeconds";

ALTER TABLE "ModelPolicy"
  DROP CONSTRAINT "ModelPolicy_memory_admission_timeout_check";

ALTER TABLE "ModelPolicy"
  ADD CONSTRAINT "ModelPolicy_memory_search_timeout_check" CHECK (
    "memorySearchTimeoutSeconds" BETWEEN 1 AND 120
  );

UPDATE "ModelPolicy"
SET "memorySearchTimeoutSeconds" = 30,
    "version" = "version" + 1,
    "updatedAt" = CURRENT_TIMESTAMP;
