-- Snapshot V40 introduces immutable contribution selection, additive correction
-- Scope V7/Completeness V2 with pending requirements, and Closure V3. Existing purposes, rows, bounds and result-state fences remain.
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
        "purpose" = 'knowledge_coverage_planner_v20'
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
        "purpose" = 'knowledge_coverage_planner_v20'
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
        "purpose" = 'knowledge_coverage_planner_v20'
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

CREATE UNIQUE INDEX "KnowledgeProviderAttempt_contribution_supplement_v22_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "purpose")
  WHERE "purpose" = 'knowledge_answer_draft_supplement_v22';

CREATE UNIQUE INDEX "KnowledgeProviderAttempt_contribution_v22_request_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "purpose", "requestHash")
  WHERE "purpose" IN ('knowledge_grounded_selector_v22',
    'knowledge_grounded_selector_final_v22', 'knowledge_coverage_scope_closure_v3');

CREATE UNIQUE INDEX "KnowledgeProviderAttempt_scope_v7_request_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "purpose", "requestHash")
  WHERE "purpose" IN ('knowledge_coverage_scope_v7', 'knowledge_coverage_scope_completeness_v2');

-- Evidence V56 binds the final publication plan and its actual aggregate counts.
ALTER TABLE "KnowledgeGroundingResult"
  DROP CONSTRAINT "KnowledgeGroundingResult_evidence_version_check";

ALTER TABLE "KnowledgeGroundingResult"
  ADD CONSTRAINT "KnowledgeGroundingResult_evidence_version_check" CHECK (
    "version" = 5 AND "evidence" IS NULL
    OR "version" IN (7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56)
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
