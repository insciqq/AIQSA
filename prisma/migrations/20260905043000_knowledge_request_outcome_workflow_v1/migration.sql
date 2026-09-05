-- Workflow 4 freezes request-outcome instructions while retaining workflow 3's
-- one structural Draft repair. Request-level idempotency remains unchanged.
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
    AND COALESCE("acceptedRequest" ->> 'workflowVersion', '') IN ('3', '4')
  );

ALTER TABLE "KnowledgeProviderAttempt"
  DROP CONSTRAINT "KnowledgeProviderAttempt_draft_repair_workflow_check";

ALTER TABLE "KnowledgeProviderAttempt"
  ADD CONSTRAINT "KnowledgeProviderAttempt_draft_repair_workflow_check" CHECK (
    "purpose" <> 'knowledge_answer_draft_v21'
    OR COALESCE("acceptedRequest" ->> 'workflowVersion', '') NOT IN ('3', '4')
    OR COALESCE("acceptedRequest" ->> 'version', '') = '40'
      AND "ordinal" IN (1, 2)
  );

COMMIT;
