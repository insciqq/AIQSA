UPDATE "UserMemorySettings"
SET
  "synthesisPolicyVersion" = 'memory-synthesis-policy-v3',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "synthesisPolicyVersion" = 'memory-synthesis-policy-v2';
