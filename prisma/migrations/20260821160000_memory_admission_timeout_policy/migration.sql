ALTER TABLE "ModelPolicy"
  ADD COLUMN "memoryAdmissionTimeoutSeconds" BIGINT NOT NULL DEFAULT 15;

ALTER TABLE "ModelPolicy"
  ADD CONSTRAINT "ModelPolicy_memory_admission_timeout_check"
  CHECK (
    "memoryAdmissionTimeoutSeconds" >= 1
    AND "memoryAdmissionTimeoutSeconds" <= 120
  );
