-- Preserve retained main and benchmark protocol receipts without rewriting them.
-- Earlier benchmark migrations may already be recorded as applied; refresh the
-- final version fences here so new protocol numbers work after either history.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP INDEX "KnowledgeProviderAttempt_modelRunId_purpose_key";

CREATE UNIQUE INDEX "KnowledgeProviderAttempt_modelRunId_purpose_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "purpose")
  WHERE (
    "purpose" = 'knowledge_coverage_planner_v20'
    OR "purpose" IN (
      'knowledge_answer_draft_v21',
      'knowledge_answer_draft_supplement_v21',
      'knowledge_grounded_selector_final_v17',
      'knowledge_grounded_selector_final_v18',
      'knowledge_grounded_selector_final_v19',
      'knowledge_grounded_selector_final_v20'
    )
    OR "purpose" ~ '^knowledge_answer_draft_v(?:[5-9]|1[01])$'
    OR "purpose" ~ '^knowledge_answer_draft(?:_supplement)?_v(?:1[2-9]|20)$'
    OR "purpose" ~ '^knowledge_grounded_selector_v[2-7]$'
    OR "purpose" ~ '^knowledge_grounded_selector(?:_final)?_v(?:[89]|1[0-6])$'
  ) AND NOT (
    "purpose" = 'knowledge_answer_draft_v21'
    AND COALESCE("acceptedRequest" ->> 'version', '') IN ('40', '42')
    AND COALESCE("acceptedRequest" ->> 'pipeline', '') = 'scope_v7_pending_v1_occurrence_atoms_v3_contributions_v1_additive_correction_v2_publication_plan_v1'
    AND COALESCE("acceptedRequest" ->> 'workflowVersion', '') IN ('3', '4', '5', '6', '7')
  );

ALTER TABLE "KnowledgeProviderAttempt"
  DROP CONSTRAINT "KnowledgeProviderAttempt_draft_repair_workflow_check";

ALTER TABLE "KnowledgeProviderAttempt"
  ADD CONSTRAINT "KnowledgeProviderAttempt_draft_repair_workflow_check" CHECK (
    "purpose" <> 'knowledge_answer_draft_v21'
    OR COALESCE("acceptedRequest" ->> 'workflowVersion', '') NOT IN ('3', '4', '5', '6', '7')
    OR COALESCE("acceptedRequest" ->> 'version', '') IN ('40', '42')
      AND COALESCE("acceptedRequest" ->> 'pipeline', '') = 'scope_v7_pending_v1_occurrence_atoms_v3_contributions_v1_additive_correction_v2_publication_plan_v1'
      AND "ordinal" IN (1, 2)
  );

ALTER TABLE "KnowledgeProviderAttempt"
  DROP CONSTRAINT "KnowledgeProviderAttempt_evidence_answer_snapshot_check",
  ADD CONSTRAINT "KnowledgeProviderAttempt_evidence_answer_snapshot_check" CHECK (
    "purpose" NOT IN ('knowledge_evidence_compose_v1', 'knowledge_evidence_review_v1')
    OR COALESCE("acceptedRequest" ->> 'version', '') IN ('41', '43')
      AND COALESCE("acceptedRequest" ->> 'pipeline', '') = 'evidence_answer_review_v1'
      AND COALESCE("acceptedRequest" ->> 'operation', '') = "purpose"
      AND "providerBindingKey" = 'answer'
      AND (
        NOT ("acceptedRequest" ? 'workflowVersion') AND "ordinal" BETWEEN 1 AND 4
        OR COALESCE("acceptedRequest" -> 'workflowVersion' IN ('9'::jsonb, '10'::jsonb), false)
          AND "ordinal" BETWEEN 1 AND 8
      )
  );

ALTER TABLE "KnowledgeProviderAttempt"
  DROP CONSTRAINT "KnowledgeProviderAttempt_evidence_answer_v2_snapshot_check",
  ADD CONSTRAINT "KnowledgeProviderAttempt_evidence_answer_v2_snapshot_check" CHECK (
    "purpose" NOT IN ('knowledge_evidence_compose_v2', 'knowledge_evidence_review_v2')
    OR COALESCE("acceptedRequest" ->> 'version', '') IN ('42', '44')
      AND COALESCE("acceptedRequest" ->> 'pipeline', '') = 'evidence_answer_review_v2'
      AND COALESCE("acceptedRequest" ->> 'operation', '') = "purpose"
      AND COALESCE("acceptedRequest" -> 'workflowVersion' = '11'::jsonb, false)
      AND "providerBindingKey" = 'answer'
      AND "ordinal" BETWEEN 1 AND 8
  );

ALTER TABLE "KnowledgeGroundingResult"
  DROP CONSTRAINT "KnowledgeGroundingResult_evidence_version_check";

ALTER TABLE "KnowledgeGroundingResult"
  ADD CONSTRAINT "KnowledgeGroundingResult_evidence_version_check" CHECK (
    "version" = 5 AND "evidence" IS NULL
    OR "version" IN (7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60)
      AND "evidence" IS NOT NULL
      AND jsonb_typeof("evidence") = 'object'
      AND pg_column_size("evidence") <= 65536
      AND ("evidence" ->> 'version')::integer = "version"
    OR "version" = 13 AND (
      "evidence" IS NULL
      OR jsonb_typeof("evidence") = 'object'
        AND pg_column_size("evidence") <= 65536
        AND ("evidence" ->> 'version')::integer = 13
    )
  );

COMMIT;
