ALTER TABLE "ModelPolicy"
  ADD COLUMN "toolObservationPolicy" VARCHAR(8) NOT NULL DEFAULT 'off';

ALTER TABLE "ModelPolicy"
  ADD CONSTRAINT "ModelPolicy_tool_observation_policy_check"
  CHECK ("toolObservationPolicy" IN ('off', 'v1'));
