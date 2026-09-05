BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "KnowledgeProviderAttempt"
  DROP CONSTRAINT "KnowledgeProviderAttempt_evidence_answer_snapshot_check",
  ADD CONSTRAINT "KnowledgeProviderAttempt_evidence_answer_snapshot_check" CHECK (
    "purpose" NOT IN ('knowledge_evidence_compose_v1', 'knowledge_evidence_review_v1')
    OR COALESCE("acceptedRequest" ->> 'version', '') = '41'
      AND COALESCE("acceptedRequest" ->> 'pipeline', '') = 'evidence_answer_review_v1'
      AND COALESCE("acceptedRequest" ->> 'operation', '') = "purpose"
      AND "providerBindingKey" = 'answer'
      AND (
        NOT ("acceptedRequest" ? 'workflowVersion') AND "ordinal" BETWEEN 1 AND 4
        OR COALESCE("acceptedRequest" -> 'workflowVersion' = '9'::jsonb, false) AND "ordinal" BETWEEN 1 AND 8
      )
  );

COMMIT;
