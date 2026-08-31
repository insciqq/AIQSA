-- V21 Scope V5 maps each bounded evidence unit to sparse positive answer atoms.
-- The server validates the complete unit-key set and provenance, derives the
-- negative complement deterministically, and Selector V20 consumes the result.
DROP INDEX "KnowledgeProviderAttempt_modelRunId_purpose_key";

ALTER TABLE "KnowledgeProviderAttempt"
  DROP CONSTRAINT "KnowledgeProviderAttempt_answer_result_state_check",
  DROP CONSTRAINT "KnowledgeProviderAttempt_contract_check";

ALTER TABLE "KnowledgeProviderAttempt"
  ADD CONSTRAINT "KnowledgeProviderAttempt_contract_check" CHECK (
    "ordinal" BETWEEN 1 AND 256
    AND "roundIndex" BETWEEN 0 AND 255
    AND (
      "purpose" IN ('answer', 'tool_follow_up', 'citation_repair', 'answer_citation_retry')
      OR "purpose" = 'knowledge_coverage_planner_v20'
      OR "purpose" ~ '^knowledge_coverage_auditor_v[12]$'
      OR "purpose" ~ '^knowledge_coverage_scope_v[3-5]$'
      OR "purpose" ~ '^knowledge_answer_draft_v(?:[5-9]|1[01])$'
      OR "purpose" ~ '^knowledge_answer_draft(?:_supplement)?_v(?:1[2-9]|20|21)$'
      OR "purpose" ~ '^knowledge_grounded_selector_v[2-7]$'
      OR "purpose" ~ '^knowledge_grounded_selector(?:_final)?_v(?:[89]|1[0-9]|20)$'
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
        "purpose" = 'knowledge_coverage_planner_v20'
        OR "purpose" ~ '^knowledge_coverage_auditor_v[12]$'
        OR "purpose" ~ '^knowledge_coverage_scope_v[3-5]$'
        OR "purpose" ~ '^knowledge_answer_draft_v(?:[5-9]|1[01])$'
        OR "purpose" ~ '^knowledge_answer_draft(?:_supplement)?_v(?:1[2-9]|20|21)$'
        OR "purpose" ~ '^knowledge_grounded_selector_v[2-7]$'
        OR "purpose" ~ '^knowledge_grounded_selector(?:_final)?_v(?:[89]|1[0-9]|20)$'
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
        "purpose" = 'knowledge_coverage_planner_v20'
        OR "purpose" ~ '^knowledge_coverage_auditor_v[12]$'
        OR "purpose" ~ '^knowledge_coverage_scope_v[3-5]$'
        OR "purpose" ~ '^knowledge_answer_draft_v(?:[5-9]|1[01])$'
        OR "purpose" ~ '^knowledge_answer_draft(?:_supplement)?_v(?:1[2-9]|20|21)$'
        OR "purpose" ~ '^knowledge_grounded_selector_v[2-7]$'
        OR "purpose" ~ '^knowledge_grounded_selector(?:_final)?_v(?:[89]|1[0-9]|20)$'
      ) AND "state" = 'settled'
      THEN "acceptedResult" IS NOT NULL
        AND "resultHash" IS NOT NULL
        AND "resultAcceptedAt" BETWEEN "dispatchedAt" AND "settledAt"
      WHEN (
        "purpose" = 'knowledge_coverage_planner_v20'
        OR "purpose" ~ '^knowledge_coverage_auditor_v[12]$'
        OR "purpose" ~ '^knowledge_coverage_scope_v[3-5]$'
        OR "purpose" ~ '^knowledge_answer_draft_v(?:[5-9]|1[01])$'
        OR "purpose" ~ '^knowledge_answer_draft(?:_supplement)?_v(?:1[2-9]|20|21)$'
        OR "purpose" ~ '^knowledge_grounded_selector_v[2-7]$'
        OR "purpose" ~ '^knowledge_grounded_selector(?:_final)?_v(?:[89]|1[0-9]|20)$'
      )
      THEN "acceptedResult" IS NULL
        AND "resultHash" IS NULL
        AND "resultAcceptedAt" IS NULL
      ELSE true
    END
  );

CREATE UNIQUE INDEX "KnowledgeProviderAttempt_modelRunId_purpose_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "purpose")
  WHERE "purpose" = 'knowledge_coverage_planner_v20'
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
    OR "purpose" ~ '^knowledge_grounded_selector(?:_final)?_v(?:[89]|1[0-6])$';

CREATE UNIQUE INDEX "KnowledgeProviderAttempt_v21_scope_v5_request_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "purpose", "requestHash")
  WHERE "purpose" = 'knowledge_coverage_scope_v5';

CREATE UNIQUE INDEX "KnowledgeProviderAttempt_v21_selector_v20_request_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "purpose", "requestHash")
  WHERE "purpose" = 'knowledge_grounded_selector_v20';

ALTER TABLE "KnowledgeGroundingResult"
  DROP CONSTRAINT "KnowledgeGroundingResult_evidence_version_check";

ALTER TABLE "KnowledgeGroundingResult"
  ADD CONSTRAINT "KnowledgeGroundingResult_evidence_version_check" CHECK (
    "version" = 5 AND "evidence" IS NULL
    OR "version" IN (7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21)
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
