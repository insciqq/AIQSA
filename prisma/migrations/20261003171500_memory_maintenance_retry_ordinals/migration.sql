-- Each attempt of a maintenance call, including an in-call validation retry,
-- settles under its own binding and receipt ordinal: reviews 0, 2, 4 and
-- verifications 1, 3, 5. The receipt guards still require the binding of the
-- same ordinal. Previous-release writers keep writing only 0 and 1 during
-- Compose replacement; existing rows already satisfy the wider check.
ALTER TABLE "MemoryMaintenanceExecution"
  DROP CONSTRAINT "MemoryMaintenanceExecution_shape_check",
  ADD CONSTRAINT "MemoryMaintenanceExecution_shape_check" CHECK (
    "ordinal" IN (0, 1, 2, 3, 4, 5) AND "inputHash" ~ '^[a-f0-9]{64}$' AND "acceptedOutputHash" ~ '^[a-f0-9]{64}$'
    AND (("appliedAt" IS NULL AND jsonb_typeof("acceptedOutput") = 'object') OR ("appliedAt" IS NOT NULL AND "acceptedOutput" IS NULL))
  );
