-- Requirement review and evidence-bound correction use a new immutable
-- operation protocol; accepted earlier requests keep their exact contracts.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "KnowledgeProviderAttempt"
  DROP CONSTRAINT "KnowledgeProviderAttempt_answer_result_state_check",
  DROP CONSTRAINT "KnowledgeProviderAttempt_contract_check";

ALTER TABLE "KnowledgeProviderAttempt"
  ADD CONSTRAINT "KnowledgeProviderAttempt_contract_check" CHECK (
    "ordinal" BETWEEN 1 AND 256
    AND "roundIndex" BETWEEN 0 AND 255
    AND (
      "purpose" IN ('answer', 'tool_follow_up', 'citation_repair', 'answer_citation_retry')
      OR "purpose" IN ('knowledge_evidence_compose_v1', 'knowledge_evidence_review_v1', 'knowledge_evidence_compose_v2', 'knowledge_evidence_review_v2')
      OR "purpose" = 'knowledge_coverage_planner_v20'
      OR "purpose" ~ '^knowledge_coverage_auditor_v[12]$'
      OR "purpose" ~ '^knowledge_coverage_scope_v[3-7]$'
      OR "purpose" ~ '^knowledge_coverage_scope_completeness_v[12]$'
      OR "purpose" ~ '^knowledge_coverage_scope_closure_v[1-3]$'
      OR "purpose" ~ '^knowledge_answer_draft_v(?:[5-9]|1[01])$'
      OR "purpose" ~ '^knowledge_answer_draft(?:_supplement)?_v(?:1[2-9]|20|21)$'
      OR "purpose" = 'knowledge_answer_draft_supplement_v22'
      OR "purpose" ~ '^knowledge_grounded_selector_v[2-7]$'
      OR "purpose" ~ '^knowledge_grounded_selector(?:_final)?_v(?:[89]|1[0-9]|2[0-2])$'
    )
    AND "idempotencyKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
    AND "checkpointHash" ~ '^[0-9a-f]{64}$'
    AND "requestHash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("estimatedUsage") = 'object'
    AND pg_column_size("estimatedUsage") <= 16384
    AND ("actualUsage" IS NULL OR (
      jsonb_typeof("actualUsage") = 'object'
      AND pg_column_size("actualUsage") <= 16384
    ))
    AND ("providerResponseId" IS NULL OR (
      length("providerResponseId") BETWEEN 1 AND 1024
      AND "providerResponseId" !~ E'\\x00'
    ))
    AND (
      "purpose" IN ('answer', 'tool_follow_up', 'citation_repair', 'answer_citation_retry')
      AND "contractVersion" IS NULL
      AND "evidenceReceiptHash" IS NULL
      AND "acceptedRequest" IS NULL
      AND "acceptedResult" IS NULL
      AND "resultHash" IS NULL
      AND "resultAcceptedAt" IS NULL
      OR (
        "purpose" IN ('knowledge_evidence_compose_v1', 'knowledge_evidence_review_v1', 'knowledge_evidence_compose_v2', 'knowledge_evidence_review_v2')
        OR "purpose" = 'knowledge_coverage_planner_v20'
        OR "purpose" ~ '^knowledge_coverage_auditor_v[12]$'
        OR "purpose" ~ '^knowledge_coverage_scope_v[3-7]$'
        OR "purpose" ~ '^knowledge_coverage_scope_completeness_v[12]$'
        OR "purpose" ~ '^knowledge_coverage_scope_closure_v[1-3]$'
        OR "purpose" ~ '^knowledge_answer_draft_v(?:[5-9]|1[01])$'
        OR "purpose" ~ '^knowledge_answer_draft(?:_supplement)?_v(?:1[2-9]|20|21)$'
        OR "purpose" = 'knowledge_answer_draft_supplement_v22'
        OR "purpose" ~ '^knowledge_grounded_selector_v[2-7]$'
        OR "purpose" ~ '^knowledge_grounded_selector(?:_final)?_v(?:[89]|1[0-9]|2[0-2])$'
      )
      AND "contractVersion" = substring("purpose" from '_v([0-9]+)$')::integer
      AND "evidenceReceiptHash" ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof("acceptedRequest") = 'object'
      AND pg_column_size("acceptedRequest") <= 1048576
      AND (
        "acceptedResult" IS NULL
        AND "resultHash" IS NULL
        AND "resultAcceptedAt" IS NULL
        OR jsonb_typeof("acceptedResult") = 'object'
        AND pg_column_size("acceptedResult") <= 131072
        AND "resultHash" ~ '^[0-9a-f]{64}$'
        AND "resultAcceptedAt" IS NOT NULL
      )
    )
  );

ALTER TABLE "KnowledgeProviderAttempt"
  ADD CONSTRAINT "KnowledgeProviderAttempt_answer_result_state_check" CHECK (
    CASE
      WHEN (
        "purpose" IN ('knowledge_evidence_compose_v1', 'knowledge_evidence_review_v1', 'knowledge_evidence_compose_v2', 'knowledge_evidence_review_v2')
        OR "purpose" = 'knowledge_coverage_planner_v20'
        OR "purpose" ~ '^knowledge_coverage_auditor_v[12]$'
        OR "purpose" ~ '^knowledge_coverage_scope_v[3-7]$'
        OR "purpose" ~ '^knowledge_coverage_scope_completeness_v[12]$'
        OR "purpose" ~ '^knowledge_coverage_scope_closure_v[1-3]$'
        OR "purpose" ~ '^knowledge_answer_draft_v(?:[5-9]|1[01])$'
        OR "purpose" ~ '^knowledge_answer_draft(?:_supplement)?_v(?:1[2-9]|20|21)$'
        OR "purpose" = 'knowledge_answer_draft_supplement_v22'
        OR "purpose" ~ '^knowledge_grounded_selector_v[2-7]$'
        OR "purpose" ~ '^knowledge_grounded_selector(?:_final)?_v(?:[89]|1[0-9]|2[0-2])$'
      ) AND "state" = 'settled'
      THEN "acceptedResult" IS NOT NULL
        AND "resultHash" IS NOT NULL
        AND "resultAcceptedAt" BETWEEN "dispatchedAt" AND "settledAt"
      WHEN (
        "purpose" IN ('knowledge_evidence_compose_v1', 'knowledge_evidence_review_v1', 'knowledge_evidence_compose_v2', 'knowledge_evidence_review_v2')
        OR "purpose" = 'knowledge_coverage_planner_v20'
        OR "purpose" ~ '^knowledge_coverage_auditor_v[12]$'
        OR "purpose" ~ '^knowledge_coverage_scope_v[3-7]$'
        OR "purpose" ~ '^knowledge_coverage_scope_completeness_v[12]$'
        OR "purpose" ~ '^knowledge_coverage_scope_closure_v[1-3]$'
        OR "purpose" ~ '^knowledge_answer_draft_v(?:[5-9]|1[01])$'
        OR "purpose" ~ '^knowledge_answer_draft(?:_supplement)?_v(?:1[2-9]|20|21)$'
        OR "purpose" = 'knowledge_answer_draft_supplement_v22'
        OR "purpose" ~ '^knowledge_grounded_selector_v[2-7]$'
        OR "purpose" ~ '^knowledge_grounded_selector(?:_final)?_v(?:[89]|1[0-9]|2[0-2])$'
      )
      THEN "acceptedResult" IS NULL
        AND "resultHash" IS NULL
        AND "resultAcceptedAt" IS NULL
      ELSE true
    END
  );

CREATE UNIQUE INDEX "KnowledgeProviderAttempt_evidence_answer_v2_request_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "purpose", "requestHash")
  WHERE "purpose" IN ('knowledge_evidence_compose_v2', 'knowledge_evidence_review_v2');

ALTER TABLE "KnowledgeProviderAttempt"
  ADD CONSTRAINT "KnowledgeProviderAttempt_evidence_answer_v2_snapshot_check" CHECK (
    "purpose" NOT IN ('knowledge_evidence_compose_v2', 'knowledge_evidence_review_v2')
    OR COALESCE("acceptedRequest" ->> 'version', '') = '42'
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
    OR "version" IN (7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58)
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
