-- Workflow 3 may replace a structurally rejected primary Draft once, before
-- Scope, inside the existing eight-operation budget. Historical workflows keep
-- their single-Draft guard; every Draft keeps request-level idempotency.
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
    AND COALESCE("acceptedRequest" ->> 'version', '') = '40'
    AND COALESCE("acceptedRequest" ->> 'workflowVersion', '') = '3'
  );

CREATE UNIQUE INDEX "KnowledgeProviderAttempt_v21_draft_request_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "purpose", "requestHash")
  WHERE "purpose" = 'knowledge_answer_draft_v21';

ALTER TABLE "KnowledgeProviderAttempt"
  ADD CONSTRAINT "KnowledgeProviderAttempt_draft_repair_workflow_check" CHECK (
    "purpose" <> 'knowledge_answer_draft_v21'
    OR COALESCE("acceptedRequest" ->> 'workflowVersion', '') <> '3'
    OR COALESCE("acceptedRequest" ->> 'version', '') = '40'
      AND "ordinal" IN (1, 2)
  );

COMMIT;
