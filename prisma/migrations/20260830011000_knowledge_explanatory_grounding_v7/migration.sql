-- V7/V5 makes the explanation-coverage gate explicit enough for weaker answer
-- models. V6/V4 and earlier accepted operations remain immutable archaeology;
-- new runs mint only the V7/V5 pair.
DROP INDEX "KnowledgeProviderAttempt_modelRunId_purpose_key";

ALTER TABLE "KnowledgeProviderAttempt"
  DROP CONSTRAINT "KnowledgeProviderAttempt_answer_result_state_check",
  DROP CONSTRAINT "KnowledgeProviderAttempt_contract_check";

ALTER TABLE "KnowledgeProviderAttempt"
  ADD CONSTRAINT "KnowledgeProviderAttempt_contract_check" CHECK (
    "ordinal" BETWEEN 1 AND 256
    AND "roundIndex" BETWEEN 0 AND 255
    AND "purpose" IN (
      'answer',
      'tool_follow_up',
      'citation_repair',
      'answer_citation_retry',
      'knowledge_answer_draft_v5',
      'knowledge_grounded_selector_v2',
      'knowledge_grounded_selector_v3',
      'knowledge_answer_draft_v6',
      'knowledge_grounded_selector_v4',
      'knowledge_answer_draft_v7',
      'knowledge_grounded_selector_v5'
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
      OR ("purpose", "contractVersion") IN (
        ('knowledge_answer_draft_v5', 5),
        ('knowledge_grounded_selector_v2', 2),
        ('knowledge_grounded_selector_v3', 3),
        ('knowledge_answer_draft_v6', 6),
        ('knowledge_grounded_selector_v4', 4),
        ('knowledge_answer_draft_v7', 7),
        ('knowledge_grounded_selector_v5', 5)
      )
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
      WHEN "purpose" IN (
        'knowledge_answer_draft_v5',
        'knowledge_grounded_selector_v2',
        'knowledge_grounded_selector_v3',
        'knowledge_answer_draft_v6',
        'knowledge_grounded_selector_v4',
        'knowledge_answer_draft_v7',
        'knowledge_grounded_selector_v5'
      ) AND "state" = 'settled'
      THEN "acceptedResult" IS NOT NULL
        AND "resultHash" IS NOT NULL
        AND "resultAcceptedAt" BETWEEN "dispatchedAt" AND "settledAt"
      WHEN "purpose" IN (
        'knowledge_answer_draft_v5',
        'knowledge_grounded_selector_v2',
        'knowledge_grounded_selector_v3',
        'knowledge_answer_draft_v6',
        'knowledge_grounded_selector_v4',
        'knowledge_answer_draft_v7',
        'knowledge_grounded_selector_v5'
      )
      THEN "acceptedResult" IS NULL
        AND "resultHash" IS NULL
        AND "resultAcceptedAt" IS NULL
      ELSE true
    END
  );

CREATE UNIQUE INDEX "KnowledgeProviderAttempt_modelRunId_purpose_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "purpose")
  WHERE "purpose" IN (
    'knowledge_answer_draft_v5',
    'knowledge_grounded_selector_v2',
    'knowledge_grounded_selector_v3',
    'knowledge_answer_draft_v6',
    'knowledge_grounded_selector_v4',
    'knowledge_answer_draft_v7',
    'knowledge_grounded_selector_v5'
  );
