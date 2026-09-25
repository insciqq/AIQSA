import { toolObservationFixtureSql } from "./tool-observation-adoption";

export const TOOL_OBSERVATION_ROLLOUT_POLICY_MIGRATION = "20260924230000_tool_observation_rollout_policy";

export const toolObservationRolloutPolicyFixtureSql = toolObservationFixtureSql;

export const toolObservationRolloutPolicyProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ModelPolicy"
    WHERE id = 'installation' AND "toolObservationPolicy" = 'off')
    THEN RAISE EXCEPTION 'observation_rollout_policy_default_not_off'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "_ObservationUpgradeFixture" f
    JOIN "ModelRun" r ON r.id = 'observation-adoption-run'
    JOIN "ModelRunToolCall" c ON c.id = 'observation-adoption-call'
    WHERE f.run = to_jsonb(r) AND f.call = to_jsonb(c))
    THEN RAISE EXCEPTION 'observation_rollout_changed_historical_run'; END IF;
  UPDATE "ModelPolicy" SET "toolObservationPolicy" = 'v1' WHERE id = 'installation';
  IF NOT EXISTS (SELECT 1 FROM "ModelPolicy"
    WHERE id = 'installation' AND "toolObservationPolicy" = 'v1')
    THEN RAISE EXCEPTION 'observation_rollout_policy_v1_not_persisted'; END IF;
  BEGIN
    UPDATE "ModelPolicy" SET "toolObservationPolicy" = 'future' WHERE id = 'installation';
    RAISE EXCEPTION 'observation_rollout_policy_accepts_unknown';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
DROP TABLE "_ObservationUpgradeFixture";
`;
