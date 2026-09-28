ALTER TABLE "UserMemorySettings"
  ALTER COLUMN "synthesisPolicyVersion" SET DEFAULT 'memory-synthesis-policy-v5';

-- Preserve each owner's enable boundary and evaluation cadence.
UPDATE "UserMemorySettings"
SET "synthesisPolicyVersion" = 'memory-synthesis-policy-v5'
WHERE "synthesisPolicyVersion" = 'memory-synthesis-policy-v4';
