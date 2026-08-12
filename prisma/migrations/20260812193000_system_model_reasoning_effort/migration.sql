-- System utility reasoning is an explicit installation policy. Existing
-- installations retain provider-default reasoning until an administrator
-- chooses an advertised effort.

ALTER TABLE "SystemModelPolicy"
ADD COLUMN "reasoningEffort" VARCHAR(32);

ALTER TABLE "SystemModelPolicy"
ADD CONSTRAINT "SystemModelPolicy_reasoningEffort_check"
CHECK (
  "reasoningEffort" IS NULL OR (
    char_length("reasoningEffort") BETWEEN 1 AND 32 AND
    btrim("reasoningEffort") = "reasoningEffort" AND
    "reasoningEffort" !~ '[[:cntrl:]]'
  )
),
ADD CONSTRAINT "SystemModelPolicy_reasoning_target_check"
CHECK ("providerModelId" IS NOT NULL OR "reasoningEffort" IS NULL);
