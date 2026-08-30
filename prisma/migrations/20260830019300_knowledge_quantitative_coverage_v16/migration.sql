-- V16/V12 makes quantitative comparison coverage independently scoped to
-- the exact request while retaining the bounded correction and validation-
-- repair shapes. Historical purposes remain accepted for exact recovery; new
-- runs record Grounding Evidence V12.
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
      'knowledge_grounded_selector_v5',
      'knowledge_answer_draft_v8',
      'knowledge_answer_draft_v9',
      'knowledge_grounded_selector_v6',
      'knowledge_answer_draft_v10',
      'knowledge_grounded_selector_v7',
      'knowledge_answer_draft_v11',
      'knowledge_answer_draft_v12',
      'knowledge_answer_draft_supplement_v12',
      'knowledge_grounded_selector_v8',
      'knowledge_grounded_selector_final_v8',
      'knowledge_answer_draft_v13',
      'knowledge_answer_draft_supplement_v13',
      'knowledge_grounded_selector_v9',
      'knowledge_grounded_selector_final_v9',
      'knowledge_answer_draft_v14',
      'knowledge_answer_draft_supplement_v14',
      'knowledge_grounded_selector_v10',
      'knowledge_grounded_selector_final_v10',
      'knowledge_answer_draft_v15',
      'knowledge_answer_draft_supplement_v15',
      'knowledge_grounded_selector_v11',
      'knowledge_grounded_selector_final_v11',
      'knowledge_answer_draft_v16',
      'knowledge_answer_draft_supplement_v16',
      'knowledge_grounded_selector_v12',
      'knowledge_grounded_selector_final_v12'
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
        ('knowledge_grounded_selector_v5', 5),
        ('knowledge_answer_draft_v8', 8),
        ('knowledge_answer_draft_v9', 9),
        ('knowledge_grounded_selector_v6', 6),
        ('knowledge_answer_draft_v10', 10),
        ('knowledge_grounded_selector_v7', 7),
        ('knowledge_answer_draft_v11', 11),
        ('knowledge_answer_draft_v12', 12),
        ('knowledge_answer_draft_supplement_v12', 12),
        ('knowledge_grounded_selector_v8', 8),
        ('knowledge_grounded_selector_final_v8', 8),
        ('knowledge_answer_draft_v13', 13),
        ('knowledge_answer_draft_supplement_v13', 13),
        ('knowledge_grounded_selector_v9', 9),
        ('knowledge_grounded_selector_final_v9', 9),
        ('knowledge_answer_draft_v14', 14),
        ('knowledge_answer_draft_supplement_v14', 14),
        ('knowledge_grounded_selector_v10', 10),
        ('knowledge_grounded_selector_final_v10', 10),
        ('knowledge_answer_draft_v15', 15),
        ('knowledge_answer_draft_supplement_v15', 15),
        ('knowledge_grounded_selector_v11', 11),
        ('knowledge_grounded_selector_final_v11', 11),
        ('knowledge_answer_draft_v16', 16),
        ('knowledge_answer_draft_supplement_v16', 16),
        ('knowledge_grounded_selector_v12', 12),
        ('knowledge_grounded_selector_final_v12', 12)
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
        'knowledge_grounded_selector_v5',
        'knowledge_answer_draft_v8',
        'knowledge_answer_draft_v9',
        'knowledge_grounded_selector_v6',
        'knowledge_answer_draft_v10',
        'knowledge_grounded_selector_v7',
        'knowledge_answer_draft_v11',
        'knowledge_answer_draft_v12',
        'knowledge_answer_draft_supplement_v12',
        'knowledge_grounded_selector_v8',
        'knowledge_grounded_selector_final_v8',
        'knowledge_answer_draft_v13',
        'knowledge_answer_draft_supplement_v13',
        'knowledge_grounded_selector_v9',
        'knowledge_grounded_selector_final_v9',
        'knowledge_answer_draft_v14',
        'knowledge_answer_draft_supplement_v14',
        'knowledge_grounded_selector_v10',
        'knowledge_grounded_selector_final_v10',
        'knowledge_answer_draft_v15',
        'knowledge_answer_draft_supplement_v15',
        'knowledge_grounded_selector_v11',
        'knowledge_grounded_selector_final_v11',
        'knowledge_answer_draft_v16',
        'knowledge_answer_draft_supplement_v16',
        'knowledge_grounded_selector_v12',
        'knowledge_grounded_selector_final_v12'
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
        'knowledge_grounded_selector_v5',
        'knowledge_answer_draft_v8',
        'knowledge_answer_draft_v9',
        'knowledge_grounded_selector_v6',
        'knowledge_answer_draft_v10',
        'knowledge_grounded_selector_v7',
        'knowledge_answer_draft_v11',
        'knowledge_answer_draft_v12',
        'knowledge_answer_draft_supplement_v12',
        'knowledge_grounded_selector_v8',
        'knowledge_grounded_selector_final_v8',
        'knowledge_answer_draft_v13',
        'knowledge_answer_draft_supplement_v13',
        'knowledge_grounded_selector_v9',
        'knowledge_grounded_selector_final_v9',
        'knowledge_answer_draft_v14',
        'knowledge_answer_draft_supplement_v14',
        'knowledge_grounded_selector_v10',
        'knowledge_grounded_selector_final_v10',
        'knowledge_answer_draft_v15',
        'knowledge_answer_draft_supplement_v15',
        'knowledge_grounded_selector_v11',
        'knowledge_grounded_selector_final_v11',
        'knowledge_answer_draft_v16',
        'knowledge_answer_draft_supplement_v16',
        'knowledge_grounded_selector_v12',
        'knowledge_grounded_selector_final_v12'
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
    'knowledge_grounded_selector_v5',
    'knowledge_answer_draft_v8',
    'knowledge_answer_draft_v9',
    'knowledge_grounded_selector_v6',
    'knowledge_answer_draft_v10',
    'knowledge_grounded_selector_v7',
    'knowledge_answer_draft_v11',
    'knowledge_answer_draft_v12',
    'knowledge_answer_draft_supplement_v12',
    'knowledge_grounded_selector_v8',
    'knowledge_grounded_selector_final_v8',
    'knowledge_answer_draft_v13',
    'knowledge_answer_draft_supplement_v13',
    'knowledge_grounded_selector_v9',
    'knowledge_grounded_selector_final_v9',
    'knowledge_answer_draft_v14',
    'knowledge_answer_draft_supplement_v14',
    'knowledge_grounded_selector_v10',
    'knowledge_grounded_selector_final_v10',
    'knowledge_answer_draft_v15',
    'knowledge_answer_draft_supplement_v15',
    'knowledge_grounded_selector_v11',
    'knowledge_grounded_selector_final_v11',
    'knowledge_answer_draft_v16',
    'knowledge_answer_draft_supplement_v16',
    'knowledge_grounded_selector_v12',
    'knowledge_grounded_selector_final_v12'
  );

ALTER TABLE "KnowledgeGroundingResult"
  DROP CONSTRAINT "KnowledgeGroundingResult_evidence_version_check";

ALTER TABLE "KnowledgeGroundingResult"
  ADD CONSTRAINT "KnowledgeGroundingResult_evidence_version_check" CHECK (
    "version" = 5 AND "evidence" IS NULL
    OR "version" IN (7, 8, 9, 10, 11, 12)
      AND jsonb_typeof("evidence") = 'object'
      AND pg_column_size("evidence") <= 65536
      AND ("evidence" ->> 'version')::integer = "version"
  );
