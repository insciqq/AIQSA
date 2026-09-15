ALTER TABLE "UserMemorySettings"
  ALTER COLUMN "synthesisPolicyVersion" SET DEFAULT 'memory-synthesis-policy-v4';

-- Adopt subject-isolated synthesis without changing preferences or cadence.
UPDATE "UserMemorySettings"
SET "synthesisPolicyVersion" = 'memory-synthesis-policy-v4'
WHERE "synthesisPolicyVersion" = 'memory-synthesis-policy-v3';
