-- H4 replaces strategy labels with a durable, recovery-safe execution DAG.
-- Existing runs remain untouched; only new strategy executions populate it.

ALTER TABLE "KnowledgeRun"
  ADD COLUMN "strategyStepEvidence" jsonb;

CREATE TABLE "KnowledgeStrategyExecution" (
  "id" text NOT NULL,
  "modelRunId" text NOT NULL,
  "retrievalSessionId" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "plannerVersion" integer NOT NULL,
  "strategy" varchar(32) NOT NULL,
  "state" varchar(16) NOT NULL DEFAULT 'planned',
  "executionRequest" jsonb,
  "planHash" char(64),
  "executionHash" char(64),
  "sourceSetHash" char(64),
  "expectedSourceCount" integer NOT NULL,
  "expectedPassageCount" integer NOT NULL,
  "processedSourceCount" integer NOT NULL DEFAULT 0,
  "processedPassageCount" integer NOT NULL DEFAULT 0,
  "includedPassageCount" integer NOT NULL DEFAULT 0,
  "dispatchedPassageCount" integer NOT NULL DEFAULT 0,
  "processedSetHash" char(64),
  "includedSetHash" char(64),
  "dispatchSetHash" char(64),
  "dispatchManifestHash" char(64),
  "coverageStatus" varchar(16),
  "coverageReceipt" jsonb,
  "coverageReceiptHash" char(64),
  "failureCode" varchar(64),
  "startedAt" timestamp(3),
  "settledAt" timestamp(3),
  "failedAt" timestamp(3),
  "ambiguousAt" timestamp(3),
  "cancelledAt" timestamp(3),
  "purgedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "KnowledgeStrategyExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeStrategyExecution_contract_check" CHECK ((
    "version" = 1
    AND "plannerVersion" BETWEEN 1 AND 256
    AND "strategy" IN (
      'full_context', 'comparison', 'exhaustive', 'corpus_summary', 'multi_hop'
    )
    AND "expectedSourceCount" BETWEEN 1 AND 999
    AND "expectedPassageCount" BETWEEN 0 AND 10000000
    AND "processedSourceCount" BETWEEN 0 AND "expectedSourceCount"
    AND "processedPassageCount" BETWEEN 0 AND "expectedPassageCount"
    AND "includedPassageCount" BETWEEN 0 AND "processedPassageCount"
    AND "dispatchedPassageCount" BETWEEN 0 AND "includedPassageCount"
    AND ("coverageStatus" IS NULL OR "coverageStatus" IN ('verified', 'partial', 'degraded'))
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$')
    AND (
      "purgedAt" IS NULL
      AND jsonb_typeof("executionRequest") = 'object'
      AND pg_column_size("executionRequest") <= 1048576
      AND knowledge_jsonb_has_exact_keys(
        "executionRequest",
        ARRAY[
          'config', 'executionId', 'modelRunId', 'planHash', 'plannerVersion',
          'sourceSet', 'sourceSetHash', 'strategy', 'version'
        ]::text[]
      )
      AND "executionRequest" -> 'version' = '1'::jsonb
      AND "executionRequest" ->> 'executionId' = "id"
      AND "executionRequest" ->> 'modelRunId' = "modelRunId"
      AND "executionRequest" ->> 'plannerVersion' = "plannerVersion"::text
      AND "executionRequest" ->> 'strategy' = "strategy"
      AND "executionRequest" ->> 'sourceSetHash' = "sourceSetHash"
      AND "executionRequest" ->> 'planHash' = "planHash"
      AND "planHash" ~ '^[0-9a-f]{64}$'
      AND "executionHash" ~ '^[0-9a-f]{64}$'
      AND "sourceSetHash" ~ '^[0-9a-f]{64}$'
      AND ("processedSetHash" IS NULL OR "processedSetHash" ~ '^[0-9a-f]{64}$')
      AND ("includedSetHash" IS NULL OR "includedSetHash" ~ '^[0-9a-f]{64}$')
      AND ("dispatchSetHash" IS NULL OR "dispatchSetHash" ~ '^[0-9a-f]{64}$')
      AND ("dispatchManifestHash" IS NULL OR "dispatchManifestHash" ~ '^[0-9a-f]{64}$')
      AND (
        ("coverageReceipt" IS NULL AND "coverageReceiptHash" IS NULL AND "coverageStatus" IS NULL)
        OR (
          jsonb_typeof("coverageReceipt") = 'object'
          AND pg_column_size("coverageReceipt") <= 262144
          AND knowledge_jsonb_has_exact_keys(
            "coverageReceipt",
            ARRAY[
              'dispatchExpectedItemCount', 'dispatchIncludedItemCount',
              'dispatchManifestHash', 'executionHash', 'executionId',
              'expectedItemsHash', 'includedItemsHash', 'observedSourceSetHash',
              'processedItemsHash', 'processedPassageCount', 'processedSourceCount',
              'reasonCodes', 'receiptHash', 'requiredStepCount', 'settledTargetCount',
              'sourceSetHash', 'status', 'strategy', 'terminalRequiredStepCount',
              'totalPassageCount', 'totalSourceCount', 'totalTargetCount', 'version'
            ]::text[]
          )
          AND "coverageReceipt" -> 'version' = '1'::jsonb
          AND "coverageReceiptHash" ~ '^[0-9a-f]{64}$'
          AND "coverageReceipt" ->> 'receiptHash' = "coverageReceiptHash"
          AND "coverageStatus" = "coverageReceipt" ->> 'status'
          AND "coverageReceipt" ->> 'executionId' = "id"
          AND "coverageReceipt" ->> 'executionHash' = "executionHash"
          AND "coverageReceipt" ->> 'strategy' = "strategy"
          AND "coverageReceipt" ->> 'sourceSetHash' = "sourceSetHash"
          AND "coverageReceipt" ->> 'totalSourceCount' = "expectedSourceCount"::text
          AND "coverageReceipt" ->> 'totalPassageCount' = "expectedPassageCount"::text
          AND "coverageReceipt" ->> 'processedSourceCount' = "processedSourceCount"::text
          AND "coverageReceipt" ->> 'processedPassageCount' = "processedPassageCount"::text
          AND "coverageReceipt" ->> 'dispatchExpectedItemCount' = "includedPassageCount"::text
          AND "coverageReceipt" ->> 'dispatchIncludedItemCount' = "dispatchedPassageCount"::text
          AND "coverageReceipt" ->> 'processedItemsHash' = "processedSetHash"
          AND "coverageReceipt" ->> 'expectedItemsHash' = "includedSetHash"
          AND "coverageReceipt" ->> 'includedItemsHash' = "dispatchSetHash"
          AND "coverageReceipt" ->> 'dispatchManifestHash' = "dispatchManifestHash"
        )
      )
      OR "purgedAt" >= "createdAt"
      AND "executionRequest" IS NULL
      AND "planHash" IS NULL
      AND "executionHash" IS NULL
      AND "sourceSetHash" IS NULL
      AND "processedSetHash" IS NULL
      AND "includedSetHash" IS NULL
      AND "dispatchSetHash" IS NULL
      AND "dispatchManifestHash" IS NULL
      AND "coverageReceipt" IS NULL
      AND "coverageReceiptHash" IS NULL
    )
  ) IS TRUE),
  CONSTRAINT "KnowledgeStrategyExecution_state_check" CHECK ((
    CASE "state"
      WHEN 'planned' THEN
        "startedAt" IS NULL AND "settledAt" IS NULL AND "failedAt" IS NULL
        AND "ambiguousAt" IS NULL AND "cancelledAt" IS NULL
        AND "failureCode" IS NULL AND "coverageReceipt" IS NULL
        AND "processedSourceCount" = 0 AND "processedPassageCount" = 0
        AND "includedPassageCount" = 0 AND "dispatchedPassageCount" = 0
      WHEN 'running' THEN
        "startedAt" >= "createdAt" AND "settledAt" IS NULL AND "failedAt" IS NULL
        AND "ambiguousAt" IS NULL AND "cancelledAt" IS NULL
        AND "failureCode" IS NULL AND "coverageReceipt" IS NULL
      WHEN 'settled' THEN
        "startedAt" >= "createdAt" AND "settledAt" >= "startedAt"
        AND "failedAt" IS NULL AND "ambiguousAt" IS NULL AND "cancelledAt" IS NULL
        AND "failureCode" IS NULL
        AND ("purgedAt" IS NOT NULL OR (
          "coverageStatus" = 'verified' AND "coverageReceipt" IS NOT NULL
        ))
      WHEN 'partial' THEN
        "startedAt" >= "createdAt" AND "settledAt" >= "startedAt"
        AND "failedAt" IS NULL AND "ambiguousAt" IS NULL AND "cancelledAt" IS NULL
        AND "coverageStatus" IN ('partial', 'degraded')
        AND ("purgedAt" IS NOT NULL OR "coverageReceipt" IS NOT NULL)
      WHEN 'failed' THEN
        "startedAt" >= "createdAt" AND "failedAt" >= "startedAt"
        AND "settledAt" IS NULL AND "ambiguousAt" IS NULL AND "cancelledAt" IS NULL
        AND ("purgedAt" IS NOT NULL OR "failureCode" IS NOT NULL)
      WHEN 'ambiguous' THEN
        "startedAt" >= "createdAt" AND "ambiguousAt" >= "startedAt"
        AND "settledAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
        AND ("purgedAt" IS NOT NULL OR "failureCode" IS NOT NULL)
      WHEN 'cancelled' THEN
        "cancelledAt" >= "createdAt" AND "settledAt" IS NULL
        AND "failedAt" IS NULL AND "ambiguousAt" IS NULL
      ELSE false
    END
  ) IS TRUE)
);

CREATE TABLE "KnowledgeStrategyStep" (
  "id" text NOT NULL,
  "executionId" text NOT NULL,
  "modelRunId" text NOT NULL,
  "modelRunToolCallId" text,
  "sourceBindingId" text,
  "providerAttemptId" text,
  "ordinal" integer NOT NULL,
  "kind" varchar(32) NOT NULL,
  "phaseOrdinal" integer NOT NULL,
  "streamId" varchar(128),
  "pageOrdinal" integer NOT NULL,
  "targetOrdinal" integer,
  "required" boolean NOT NULL DEFAULT true,
  "state" varchar(16) NOT NULL DEFAULT 'pending',
  "materializationMode" varchar(32) NOT NULL,
  "templateHash" char(64),
  "materializedAt" timestamp(3),
  "idempotencyKey" varchar(128),
  "request" jsonb,
  "requestHash" char(64),
  "inputHash" char(64),
  "evidenceInputHash" char(64),
  "comparisonDimensionHash" char(64),
  "sourceSetHash" char(64),
  "cursor" jsonb,
  "cursorHash" char(64),
  "result" jsonb,
  "resultHash" char(64),
  "processedItemsHash" char(64),
  "processedSourceCount" integer NOT NULL DEFAULT 0,
  "processedPassageCount" integer NOT NULL DEFAULT 0,
  "includedPassageCount" integer NOT NULL DEFAULT 0,
  "attemptCount" integer NOT NULL DEFAULT 0,
  "stateVersion" integer NOT NULL DEFAULT 0,
  "irreversibleDispatch" boolean NOT NULL DEFAULT false,
  "leaseToken" varchar(128),
  "leaseExpiresAt" timestamp(3),
  "failureCode" varchar(64),
  "startedAt" timestamp(3),
  "ioStartedAt" timestamp(3),
  "settledAt" timestamp(3),
  "failedAt" timestamp(3),
  "ambiguousAt" timestamp(3),
  "cancelledAt" timestamp(3),
  "purgedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "KnowledgeStrategyStep_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeStrategyStep_contract_check" CHECK ((
    "ordinal" BETWEEN 0 AND 4095
    AND "kind" IN (
      'full_context_page', 'comparison_target', 'exhaustive_page',
      'corpus_summary_map', 'corpus_summary_reduce', 'multi_hop_root',
      'multi_hop_follow_up'
    )
    AND "phaseOrdinal" BETWEEN 0 AND 63
    AND "pageOrdinal" BETWEEN 0 AND 999999
    AND ("targetOrdinal" IS NULL OR "targetOrdinal" BETWEEN 0 AND 127)
    AND "processedSourceCount" BETWEEN 0 AND 999
    AND "processedPassageCount" BETWEEN 0 AND 10000000
    AND "includedPassageCount" BETWEEN 0 AND "processedPassageCount"
    AND "attemptCount" BETWEEN 0 AND 1000000
    AND "stateVersion" BETWEEN 0 AND 2147483647
    AND "materializationMode" IN (
      'complete', 'cursor_from_predecessor', 'evidence_from_prerequisites'
    )
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$')
    AND (
      "purgedAt" IS NULL
      AND "streamId" IS NOT NULL
      AND "streamId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND "idempotencyKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
      AND "templateHash" ~ '^[0-9a-f]{64}$'
      AND "idempotencyKey" = "templateHash"
      AND "inputHash" ~ '^[0-9a-f]{64}$'
      AND ("evidenceInputHash" IS NULL OR "evidenceInputHash" ~ '^[0-9a-f]{64}$')
      AND ("comparisonDimensionHash" IS NULL OR "comparisonDimensionHash" ~ '^[0-9a-f]{64}$')
      AND "sourceSetHash" ~ '^[0-9a-f]{64}$'
      AND (
        (
          "request" IS NULL AND "requestHash" IS NULL AND "materializedAt" IS NULL
          AND "state" = 'pending'
          AND "materializationMode" IN (
            'cursor_from_predecessor', 'evidence_from_prerequisites'
          )
        )
        OR (
          jsonb_typeof("request") = 'object'
          AND pg_column_size("request") <= 65536
          AND knowledge_jsonb_has_exact_keys(
            "request",
            ARRAY[
              'comparisonDimensionHash', 'cursor', 'evidenceInputHash', 'executionId',
              'inputHash', 'kind', 'ordinal', 'pageOrdinal', 'phaseOrdinal',
              'required', 'sourceBindingId', 'sourceSetHash', 'stepId', 'strategy',
              'streamId', 'targetOrdinal', 'version'
            ]::text[]
          )
          AND "request" -> 'version' = '1'::jsonb
          AND "request" ->> 'executionId' = "executionId"
          AND "request" ->> 'stepId' = "id"
          AND "request" ->> 'kind' = "kind"
          AND "request" ->> 'ordinal' = "ordinal"::text
          AND "request" ->> 'phaseOrdinal' = "phaseOrdinal"::text
          AND "request" ->> 'streamId' = "streamId"
          AND "request" ->> 'pageOrdinal' = "pageOrdinal"::text
          AND ("request" ->> 'sourceBindingId') IS NOT DISTINCT FROM "sourceBindingId"
          AND ("request" ->> 'targetOrdinal') IS NOT DISTINCT FROM "targetOrdinal"::text
          AND "request" -> 'required' = to_jsonb("required")
          AND "request" ->> 'inputHash' = "inputHash"
          AND ("request" ->> 'evidenceInputHash') IS NOT DISTINCT FROM "evidenceInputHash"
          AND ("request" ->> 'comparisonDimensionHash') IS NOT DISTINCT FROM "comparisonDimensionHash"
          AND "request" ->> 'sourceSetHash' = "sourceSetHash"
          AND "requestHash" ~ '^[0-9a-f]{64}$'
          AND "materializedAt" IS NOT NULL
        )
      )
      AND CASE "materializationMode"
        WHEN 'complete' THEN "request" IS NOT NULL
        WHEN 'cursor_from_predecessor' THEN
          "kind" IN (
            'full_context_page', 'comparison_target', 'exhaustive_page',
            'corpus_summary_map'
          )
          AND "pageOrdinal" > 0 AND "evidenceInputHash" IS NULL
          AND (
            "request" IS NULL OR "request" -> 'cursor' IS DISTINCT FROM 'null'::jsonb
          )
        WHEN 'evidence_from_prerequisites' THEN
          "kind" IN ('multi_hop_follow_up', 'corpus_summary_reduce')
          AND "pageOrdinal" = 0
          AND (
            "request" IS NULL OR "evidenceInputHash" IS NOT NULL
          )
        ELSE false
      END
      AND (
        ("cursor" IS NULL AND "cursorHash" IS NULL)
        OR (
          jsonb_typeof("cursor") = 'object'
          AND pg_column_size("cursor") <= 16384
          AND knowledge_jsonb_has_exact_keys(
            "cursor",
            ARRAY[
              'executionId', 'nextPassageOrdinal', 'pageOrdinal', 'previousItemHash',
              'sourceBindingId', 'sourceOrdinal', 'streamId', 'version'
            ]::text[]
          )
          AND "cursor" -> 'version' = '1'::jsonb
          AND "cursorHash" ~ '^[0-9a-f]{64}$'
        )
      )
      AND (
        ("result" IS NULL AND "resultHash" IS NULL AND "processedItemsHash" IS NULL)
        OR (
          jsonb_typeof("result") = 'object'
          AND pg_column_size("result") <= 262144
          AND knowledge_jsonb_has_exact_keys(
            "result",
            ARRAY[
              'cursorExhausted', 'executionId', 'lastItemHash', 'nextCursor',
              'processedItemCount', 'processedItemsHash', 'reasonCode', 'requestHash',
              'status', 'stepId', 'version'
            ]::text[]
          )
          AND "result" -> 'version' = '1'::jsonb
          AND "result" ->> 'executionId' = "executionId"
          AND "result" ->> 'stepId' = "id"
          AND "result" ->> 'requestHash' = "requestHash"
          AND "resultHash" ~ '^[0-9a-f]{64}$'
          AND "processedItemsHash" ~ '^[0-9a-f]{64}$'
          AND "processedItemsHash" = "result" ->> 'processedItemsHash'
          AND "result" ->> 'processedItemCount' ~ '^(0|[1-9][0-9]{0,7})$'
          AND "processedPassageCount" = ("result" ->> 'processedItemCount')::integer
          AND (
            ("result" -> 'nextCursor' = 'null'::jsonb AND "cursor" IS NULL AND "cursorHash" IS NULL)
            OR ("result" -> 'nextCursor' = "cursor" AND "cursorHash" ~ '^[0-9a-f]{64}$')
          )
        )
      )
      OR "purgedAt" >= "createdAt"
      AND "state" = 'purged'
      AND "modelRunToolCallId" IS NULL
      AND "sourceBindingId" IS NULL
      AND "providerAttemptId" IS NULL
      AND "streamId" IS NULL
      AND "templateHash" IS NULL AND "materializedAt" IS NULL
      AND "idempotencyKey" IS NULL
      AND "request" IS NULL AND "requestHash" IS NULL
      AND "inputHash" IS NULL AND "evidenceInputHash" IS NULL
      AND "comparisonDimensionHash" IS NULL AND "sourceSetHash" IS NULL
      AND "cursor" IS NULL AND "cursorHash" IS NULL
      AND "result" IS NULL AND "resultHash" IS NULL
      AND "processedItemsHash" IS NULL
      AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
      AND "failureCode" IS NULL
    )
  ) IS TRUE),
  CONSTRAINT "KnowledgeStrategyStep_state_check" CHECK ((
    CASE "state"
      WHEN 'pending' THEN
        NOT "irreversibleDispatch"
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        AND "ioStartedAt" IS NULL
        AND "settledAt" IS NULL AND "failedAt" IS NULL
        AND "ambiguousAt" IS NULL AND "cancelledAt" IS NULL
        AND "failureCode" IS NULL AND "result" IS NULL
        AND (
          ("attemptCount" = 0 AND "stateVersion" = 0 AND "startedAt" IS NULL)
          OR ("attemptCount" >= 1 AND "stateVersion" >= 2 AND "startedAt" >= "createdAt")
        )
      WHEN 'running' THEN
        "attemptCount" >= 1 AND "stateVersion" >= 1
        AND "request" IS NOT NULL AND "materializedAt" IS NOT NULL
        AND "leaseToken" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
        AND "startedAt" >= "createdAt" AND "leaseExpiresAt" > "startedAt"
        AND "settledAt" IS NULL AND "failedAt" IS NULL
        AND "ambiguousAt" IS NULL AND "cancelledAt" IS NULL
        AND "failureCode" IS NULL AND "result" IS NULL
        AND (
          (NOT "irreversibleDispatch" AND "ioStartedAt" IS NULL AND "providerAttemptId" IS NULL)
          OR ("irreversibleDispatch" AND "ioStartedAt" >= "startedAt")
        )
      WHEN 'settled' THEN
        "attemptCount" >= 1 AND "stateVersion" >= 2
        AND "startedAt" >= "createdAt"
        AND "settledAt" >= COALESCE("ioStartedAt", "startedAt")
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        AND "failedAt" IS NULL AND "ambiguousAt" IS NULL AND "cancelledAt" IS NULL
        AND "failureCode" IS NULL AND "result" IS NOT NULL
        AND "result" ->> 'status' IN ('succeeded', 'unavailable')
      WHEN 'failed' THEN
        "attemptCount" >= 1 AND "stateVersion" >= 2
        AND NOT "irreversibleDispatch" AND "startedAt" >= "createdAt"
        AND "failedAt" >= COALESCE("ioStartedAt", "startedAt")
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        AND "settledAt" IS NULL AND "ambiguousAt" IS NULL AND "cancelledAt" IS NULL
        AND "failureCode" IS NOT NULL AND "result" IS NOT NULL
        AND "result" ->> 'status' = 'failed'
      WHEN 'ambiguous' THEN
        "attemptCount" >= 1 AND "stateVersion" >= 3
        AND "irreversibleDispatch"
        AND "ioStartedAt" >= "startedAt" AND "ambiguousAt" >= "ioStartedAt"
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        AND "settledAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
        AND "failureCode" IS NOT NULL AND "result" IS NOT NULL
        AND "result" ->> 'status' = 'ambiguous'
      WHEN 'cancelled' THEN
        "cancelledAt" >= "createdAt"
        AND NOT "irreversibleDispatch" AND "ioStartedAt" IS NULL
        AND "providerAttemptId" IS NULL
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        AND "settledAt" IS NULL AND "failedAt" IS NULL AND "ambiguousAt" IS NULL
        AND "result" IS NOT NULL AND "result" ->> 'status' = 'cancelled'
      WHEN 'purged' THEN "purgedAt" >= "createdAt"
      ELSE false
    END
  ) IS TRUE)
);

CREATE TABLE "KnowledgeStrategyStepDependency" (
  "executionId" text NOT NULL,
  "stepId" text NOT NULL,
  "dependsOnStepId" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeStrategyStepDependency_pkey"
    PRIMARY KEY ("executionId", "stepId", "dependsOnStepId"),
  CONSTRAINT "KnowledgeStrategyStepDependency_no_self_check"
    CHECK ("stepId" <> "dependsOnStepId")
);

CREATE TABLE "KnowledgeStrategyMapOutput" (
  "id" text NOT NULL,
  "executionId" text NOT NULL,
  "modelRunId" text NOT NULL,
  "terminalStepId" text NOT NULL,
  "sourceBindingId" text,
  "sourceOrdinal" integer NOT NULL,
  "version" integer NOT NULL DEFAULT 2,
  "state" varchar(16) NOT NULL DEFAULT 'available',
  "output" jsonb,
  "receipt" jsonb,
  "mapInputHash" char(64),
  "outputHash" char(64),
  "receiptHash" char(64),
  "inputPageReceiptCount" integer NOT NULL,
  "inputPageReceiptsHash" char(64),
  "inputPassageCount" integer NOT NULL,
  "inputPassageItemsHash" char(64),
  "inputSectionCount" integer NOT NULL,
  "inputSectionHashesHash" char(64),
  "processedPassageCount" integer NOT NULL,
  "summaryItemCount" integer NOT NULL,
  "summaryItemsHash" char(64),
  "settledAt" timestamp(3) NOT NULL,
  "purgedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "KnowledgeStrategyMapOutput_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeStrategyMapOutput_contract_check" CHECK ((
    "version" = 2
    AND "sourceOrdinal" BETWEEN 0 AND 998
    AND "inputPageReceiptCount" BETWEEN 1 AND 4096
    AND "inputPassageCount" BETWEEN 1 AND 10000000
    AND "inputSectionCount" BETWEEN 1 AND 64
    AND "processedPassageCount" = "inputPassageCount"
    AND "summaryItemCount" = "inputSectionCount"
    AND (
      "state" = 'available'
      AND "purgedAt" IS NULL
      AND "sourceBindingId" IS NOT NULL
      AND jsonb_typeof("output") = 'object'
      AND pg_column_size("output") <= 4194304
      AND knowledge_jsonb_has_exact_keys(
        "output",
        ARRAY[
          'executionId', 'hierarchicalArtifactId', 'hierarchicalChecksum',
          'inputPageReceiptCount', 'inputPageReceiptsHash', 'inputPassageCount',
          'inputPassageItemsHash', 'inputSectionCount', 'inputSectionHashesHash',
          'mapInputHash', 'outputHash', 'processedPassageCount', 'sourceAlias',
          'sourceArtifactId', 'sourceBindingId', 'sourceId', 'sourceOrdinal',
          'sourceVersionId', 'sourceVersionNumber', 'summaries',
          'summaryItemCount', 'summaryItemsHash', 'terminalStepId', 'version'
        ]::text[]
      )
      AND "output" -> 'version' = '2'::jsonb
      AND "output" ->> 'executionId' = "executionId"
      AND "output" ->> 'terminalStepId' = "terminalStepId"
      AND "output" ->> 'sourceBindingId' = "sourceBindingId"
      AND "output" ->> 'sourceOrdinal' = "sourceOrdinal"::text
      AND "output" ->> 'mapInputHash' = "mapInputHash"
      AND "output" ->> 'outputHash' = "outputHash"
      AND "output" ->> 'inputPageReceiptCount' = "inputPageReceiptCount"::text
      AND "output" ->> 'inputPageReceiptsHash' = "inputPageReceiptsHash"
      AND "output" ->> 'inputPassageCount' = "inputPassageCount"::text
      AND "output" ->> 'inputPassageItemsHash' = "inputPassageItemsHash"
      AND "output" ->> 'inputSectionCount' = "inputSectionCount"::text
      AND "output" ->> 'inputSectionHashesHash' = "inputSectionHashesHash"
      AND "output" ->> 'processedPassageCount' = "processedPassageCount"::text
      AND "output" ->> 'summaryItemCount' = "summaryItemCount"::text
      AND "output" ->> 'summaryItemsHash' = "summaryItemsHash"
      AND jsonb_typeof("output" -> 'summaries') = 'array'
      AND jsonb_array_length("output" -> 'summaries') = "summaryItemCount"
      AND jsonb_typeof("receipt") = 'object'
      AND pg_column_size("receipt") <= 32768
      AND knowledge_jsonb_has_exact_keys(
        "receipt",
        ARRAY[
          'executionId', 'inputPageReceiptCount', 'inputPageReceiptsHash',
          'inputPassageCount', 'inputPassageItemsHash', 'inputSectionCount',
          'inputSectionHashesHash', 'mapInputHash', 'outputHash',
          'processedPassageCount', 'receiptHash', 'sourceBindingId',
          'sourceOrdinal', 'summaryItemCount', 'summaryItemsHash',
          'terminalStepId', 'version'
        ]::text[]
      )
      AND "receipt" -> 'version' = '2'::jsonb
      AND "receipt" ->> 'executionId' = "executionId"
      AND "receipt" ->> 'terminalStepId' = "terminalStepId"
      AND "receipt" ->> 'sourceBindingId' = "sourceBindingId"
      AND "receipt" ->> 'sourceOrdinal' = "sourceOrdinal"::text
      AND "receipt" ->> 'mapInputHash' = "mapInputHash"
      AND "receipt" ->> 'outputHash' = "outputHash"
      AND "receipt" ->> 'receiptHash' = "receiptHash"
      AND "receipt" ->> 'inputPageReceiptCount' = "inputPageReceiptCount"::text
      AND "receipt" ->> 'inputPageReceiptsHash' = "inputPageReceiptsHash"
      AND "receipt" ->> 'inputPassageCount' = "inputPassageCount"::text
      AND "receipt" ->> 'inputPassageItemsHash' = "inputPassageItemsHash"
      AND "receipt" ->> 'inputSectionCount' = "inputSectionCount"::text
      AND "receipt" ->> 'inputSectionHashesHash' = "inputSectionHashesHash"
      AND "receipt" ->> 'processedPassageCount' = "processedPassageCount"::text
      AND "receipt" ->> 'summaryItemCount' = "summaryItemCount"::text
      AND "receipt" ->> 'summaryItemsHash' = "summaryItemsHash"
      AND "mapInputHash" ~ '^[0-9a-f]{64}$'
      AND "outputHash" ~ '^[0-9a-f]{64}$'
      AND "receiptHash" ~ '^[0-9a-f]{64}$'
      AND "inputPageReceiptsHash" ~ '^[0-9a-f]{64}$'
      AND "inputPassageItemsHash" ~ '^[0-9a-f]{64}$'
      AND "inputSectionHashesHash" ~ '^[0-9a-f]{64}$'
      AND "summaryItemsHash" ~ '^[0-9a-f]{64}$'
      OR "state" = 'purged'
      AND "purgedAt" IS NOT NULL
      AND "sourceBindingId" IS NULL
      AND "output" IS NULL AND "receipt" IS NULL
      AND "mapInputHash" IS NULL AND "outputHash" IS NULL AND "receiptHash" IS NULL
      AND "inputPageReceiptsHash" IS NULL
      AND "inputPassageItemsHash" IS NULL
      AND "inputSectionHashesHash" IS NULL
      AND "summaryItemsHash" IS NULL
    )
  ) IS TRUE)
);

CREATE UNIQUE INDEX "KnowledgeStrategyExecution_modelRunId_key"
  ON "KnowledgeStrategyExecution" ("modelRunId");
CREATE UNIQUE INDEX "KnowledgeStrategyExecution_retrievalSessionId_key"
  ON "KnowledgeStrategyExecution" ("retrievalSessionId");
CREATE UNIQUE INDEX "KnowledgeStrategyExecution_modelRunId_id_key"
  ON "KnowledgeStrategyExecution" ("modelRunId", "id");
CREATE INDEX "KnowledgeStrategyExecution_state_updatedAt_idx"
  ON "KnowledgeStrategyExecution" ("state", "updatedAt");

CREATE UNIQUE INDEX "KnowledgeStrategyStep_modelRunToolCallId_key"
  ON "KnowledgeStrategyStep" ("modelRunToolCallId");
CREATE UNIQUE INDEX "KnowledgeStrategyStep_providerAttemptId_key"
  ON "KnowledgeStrategyStep" ("providerAttemptId");
CREATE UNIQUE INDEX "KnowledgeStrategyStep_executionId_id_key"
  ON "KnowledgeStrategyStep" ("executionId", "id");
CREATE UNIQUE INDEX "KnowledgeStrategyStep_executionId_ordinal_key"
  ON "KnowledgeStrategyStep" ("executionId", "ordinal");
CREATE UNIQUE INDEX "KnowledgeStrategyStep_executionId_idempotencyKey_key"
  ON "KnowledgeStrategyStep" ("executionId", "idempotencyKey");
CREATE UNIQUE INDEX "KnowledgeStrategyStep_executionId_modelRunToolCallId_key"
  ON "KnowledgeStrategyStep" ("executionId", "modelRunToolCallId");
CREATE UNIQUE INDEX "KnowledgeStrategyStep_modelRunId_modelRunToolCallId_key"
  ON "KnowledgeStrategyStep" ("modelRunId", "modelRunToolCallId");
CREATE UNIQUE INDEX "KnowledgeStrategyStep_source_page_key"
  ON "KnowledgeStrategyStep" (
    "executionId", "kind", "sourceBindingId", "phaseOrdinal", "pageOrdinal"
  );
CREATE INDEX "KnowledgeStrategyStep_executionId_state_leaseExpiresAt_idx"
  ON "KnowledgeStrategyStep" ("executionId", "state", "leaseExpiresAt");
CREATE INDEX "KnowledgeStrategyStep_sourceBindingId_idx"
  ON "KnowledgeStrategyStep" ("sourceBindingId");
CREATE INDEX "KnowledgeStrategyStep_providerAttemptId_idx"
  ON "KnowledgeStrategyStep" ("providerAttemptId");
CREATE INDEX "KnowledgeStrategyStepDependency_executionId_dependsOnStepId_idx"
  ON "KnowledgeStrategyStepDependency" ("executionId", "dependsOnStepId");
CREATE UNIQUE INDEX "KnowledgeStrategyMapOutput_terminalStepId_key"
  ON "KnowledgeStrategyMapOutput" ("terminalStepId");
CREATE UNIQUE INDEX "KnowledgeStrategyMapOutput_executionId_sourceOrdinal_key"
  ON "KnowledgeStrategyMapOutput" ("executionId", "sourceOrdinal");
CREATE UNIQUE INDEX "KnowledgeStrategyMapOutput_executionId_sourceBindingId_key"
  ON "KnowledgeStrategyMapOutput" ("executionId", "sourceBindingId");
CREATE UNIQUE INDEX "KnowledgeStrategyMapOutput_executionId_terminalStepId_key"
  ON "KnowledgeStrategyMapOutput" ("executionId", "terminalStepId");
CREATE INDEX "KnowledgeStrategyMapOutput_modelRunId_idx"
  ON "KnowledgeStrategyMapOutput" ("modelRunId");
CREATE INDEX "KnowledgeStrategyMapOutput_sourceBindingId_idx"
  ON "KnowledgeStrategyMapOutput" ("sourceBindingId");
CREATE INDEX "KnowledgeStrategyMapOutput_executionId_state_sourceOrdinal_idx"
  ON "KnowledgeStrategyMapOutput" ("executionId", "state", "sourceOrdinal");

ALTER TABLE "KnowledgeStrategyExecution"
  ADD CONSTRAINT "KnowledgeStrategyExecution_modelRunId_fkey"
    FOREIGN KEY ("modelRunId") REFERENCES "ModelRun" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeStrategyExecution_retrievalSessionId_fkey"
    FOREIGN KEY ("retrievalSessionId") REFERENCES "KnowledgeRetrievalSession" ("id")
    ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeStrategyStep"
  ADD CONSTRAINT "KnowledgeStrategyStep_execution_fkey"
    FOREIGN KEY ("modelRunId", "executionId")
    REFERENCES "KnowledgeStrategyExecution" ("modelRunId", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeStrategyStep_modelRunId_fkey"
    FOREIGN KEY ("modelRunId") REFERENCES "ModelRun" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeStrategyStep_toolCall_fkey"
    FOREIGN KEY ("modelRunId", "modelRunToolCallId")
    REFERENCES "ModelRunToolCall" ("modelRunId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeStrategyStep_providerAttemptId_fkey"
    FOREIGN KEY ("providerAttemptId") REFERENCES "KnowledgeProviderAttempt" ("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeStrategyStep_sourceBindingId_fkey"
    FOREIGN KEY ("sourceBindingId") REFERENCES "KnowledgeRunSourceBinding" ("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeStrategyStepDependency"
  ADD CONSTRAINT "KnowledgeStrategyStepDependency_step_fkey"
    FOREIGN KEY ("executionId", "stepId")
    REFERENCES "KnowledgeStrategyStep" ("executionId", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeStrategyStepDependency_dependsOn_fkey"
    FOREIGN KEY ("executionId", "dependsOnStepId")
    REFERENCES "KnowledgeStrategyStep" ("executionId", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeStrategyMapOutput"
  ADD CONSTRAINT "KnowledgeStrategyMapOutput_execution_fkey"
    FOREIGN KEY ("modelRunId", "executionId")
    REFERENCES "KnowledgeStrategyExecution" ("modelRunId", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeStrategyMapOutput_terminalStep_fkey"
    FOREIGN KEY ("executionId", "terminalStepId")
    REFERENCES "KnowledgeStrategyStep" ("executionId", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeStrategyMapOutput_sourceBindingId_fkey"
    FOREIGN KEY ("sourceBindingId") REFERENCES "KnowledgeRunSourceBinding" ("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION aiqsa_guard_knowledge_strategy_map_output()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  execution_record "KnowledgeStrategyExecution"%ROWTYPE;
  step_record "KnowledgeStrategyStep"%ROWTYPE;
  source_record "KnowledgeRunSourceBinding"%ROWTYPE;
  source_step_count integer;
  source_processed_count bigint;
  purge_enabled boolean := COALESCE(
    current_setting('aiqsa.knowledge_purge', true) = 'on',
    false
  );
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF purge_enabled OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'knowledge_strategy_map_output_delete_forbidden';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."executionId" IS DISTINCT FROM OLD."executionId"
      OR NEW."modelRunId" IS DISTINCT FROM OLD."modelRunId"
      OR NEW."terminalStepId" IS DISTINCT FROM OLD."terminalStepId"
      OR NEW."sourceOrdinal" IS DISTINCT FROM OLD."sourceOrdinal"
      OR NEW."version" IS DISTINCT FROM OLD."version"
      OR NEW."inputPageReceiptCount" IS DISTINCT FROM OLD."inputPageReceiptCount"
      OR NEW."inputPassageCount" IS DISTINCT FROM OLD."inputPassageCount"
      OR NEW."inputSectionCount" IS DISTINCT FROM OLD."inputSectionCount"
      OR NEW."processedPassageCount" IS DISTINCT FROM OLD."processedPassageCount"
      OR NEW."summaryItemCount" IS DISTINCT FROM OLD."summaryItemCount"
      OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    THEN
      RAISE EXCEPTION 'knowledge_strategy_map_output_identity_immutable';
    END IF;
    IF NOT purge_enabled OR OLD."state" <> 'available' OR NEW."state" <> 'purged'
      OR OLD."purgedAt" IS NOT NULL OR NEW."purgedAt" IS NULL
    THEN
      RAISE EXCEPTION 'knowledge_strategy_map_output_immutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO execution_record
  FROM "KnowledgeStrategyExecution"
  WHERE "id" = NEW."executionId";
  IF execution_record."modelRunId" IS DISTINCT FROM NEW."modelRunId"
    OR execution_record."strategy" IS DISTINCT FROM 'corpus_summary'
    OR execution_record."state" IS DISTINCT FROM 'running'
    OR execution_record."purgedAt" IS NOT NULL
  THEN
    RAISE EXCEPTION 'knowledge_strategy_map_output_execution_mismatch';
  END IF;

  SELECT * INTO step_record
  FROM "KnowledgeStrategyStep"
  WHERE "executionId" = NEW."executionId"
    AND "id" = NEW."terminalStepId";
  IF step_record."modelRunId" IS DISTINCT FROM NEW."modelRunId"
    OR step_record."kind" IS DISTINCT FROM 'corpus_summary_map'
    OR step_record."state" IS DISTINCT FROM 'settled'
    OR step_record."sourceBindingId" IS DISTINCT FROM NEW."sourceBindingId"
    OR step_record."result" ->> 'status' IS DISTINCT FROM 'succeeded'
    OR step_record."result" -> 'cursorExhausted' IS DISTINCT FROM 'true'::jsonb
    OR step_record."result" -> 'nextCursor' IS DISTINCT FROM 'null'::jsonb
    OR step_record."settledAt" IS DISTINCT FROM NEW."settledAt"
  THEN
    RAISE EXCEPTION 'knowledge_strategy_map_output_terminal_step_mismatch';
  END IF;

  SELECT * INTO source_record
  FROM "KnowledgeRunSourceBinding"
  WHERE "id" = NEW."sourceBindingId";
  IF source_record."modelRunId" IS DISTINCT FROM NEW."modelRunId"
    OR source_record."ordinal" IS DISTINCT FROM NEW."sourceOrdinal"
    OR source_record."readinessState" IS DISTINCT FROM 'ready'
    OR source_record."tombstonedAt" IS NOT NULL
    OR source_record."sourceAlias" IS DISTINCT FROM NEW."output" ->> 'sourceAlias'
    OR source_record."sourceId" IS DISTINCT FROM NEW."output" ->> 'sourceId'
    OR source_record."sourceVersionId" IS DISTINCT FROM NEW."output" ->> 'sourceVersionId'
    OR source_record."sourceArtifactId" IS DISTINCT FROM NEW."output" ->> 'sourceArtifactId'
    OR source_record."sourceVersionNumber"::text IS DISTINCT FROM
      NEW."output" ->> 'sourceVersionNumber'
  THEN
    RAISE EXCEPTION 'knowledge_strategy_map_output_source_mismatch';
  END IF;

  SELECT count(*), COALESCE(sum("processedPassageCount"), 0)
  INTO source_step_count, source_processed_count
  FROM "KnowledgeStrategyStep"
  WHERE "executionId" = NEW."executionId"
    AND "kind" = 'corpus_summary_map'
    AND "sourceBindingId" = NEW."sourceBindingId"
    AND "state" = 'settled'
    AND "result" ->> 'status' = 'succeeded';
  IF source_step_count IS DISTINCT FROM NEW."inputPageReceiptCount"
    OR source_step_count IS DISTINCT FROM step_record."pageOrdinal" + 1
    OR source_processed_count IS DISTINCT FROM NEW."inputPassageCount"::bigint
    OR EXISTS (
      SELECT 1 FROM "KnowledgeStrategyStep"
      WHERE "executionId" = NEW."executionId"
        AND "kind" = 'corpus_summary_map'
        AND "sourceBindingId" = NEW."sourceBindingId"
        AND (
          "pageOrdinal" > step_record."pageOrdinal"
          OR "state" <> 'settled'
          OR "result" ->> 'status' <> 'succeeded'
        )
    )
  THEN
    RAISE EXCEPTION 'knowledge_strategy_map_output_page_closure_mismatch';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "KnowledgeStrategyMapOutput_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeStrategyMapOutput"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_strategy_map_output();

CREATE FUNCTION aiqsa_guard_knowledge_strategy_execution()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  session_run_id text;
  purge_enabled boolean := COALESCE(
    current_setting('aiqsa.knowledge_purge', true) = 'on',
    false
  );
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF purge_enabled OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'knowledge_strategy_execution_delete_forbidden';
  END IF;
  SELECT "modelRunId" INTO session_run_id
  FROM "KnowledgeRetrievalSession"
  WHERE "id" = NEW."retrievalSessionId";
  IF session_run_id IS DISTINCT FROM NEW."modelRunId" THEN
    RAISE EXCEPTION 'knowledge_strategy_execution_scope_mismatch';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."modelRunId" IS DISTINCT FROM OLD."modelRunId"
      OR NEW."retrievalSessionId" IS DISTINCT FROM OLD."retrievalSessionId"
      OR NEW."version" IS DISTINCT FROM OLD."version"
      OR NEW."plannerVersion" IS DISTINCT FROM OLD."plannerVersion"
      OR NEW."strategy" IS DISTINCT FROM OLD."strategy"
      OR NEW."expectedSourceCount" IS DISTINCT FROM OLD."expectedSourceCount"
      OR NEW."expectedPassageCount" IS DISTINCT FROM OLD."expectedPassageCount"
    THEN
      RAISE EXCEPTION 'knowledge_strategy_execution_identity_immutable';
    END IF;
    IF NOT purge_enabled AND (
      NEW."executionRequest" IS DISTINCT FROM OLD."executionRequest"
      OR NEW."planHash" IS DISTINCT FROM OLD."planHash"
      OR NEW."executionHash" IS DISTINCT FROM OLD."executionHash"
      OR NEW."sourceSetHash" IS DISTINCT FROM OLD."sourceSetHash"
      OR NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt"
    ) THEN
      RAISE EXCEPTION 'knowledge_strategy_execution_plan_immutable';
    END IF;
    IF NEW."processedSourceCount" < OLD."processedSourceCount"
      OR NEW."processedPassageCount" < OLD."processedPassageCount"
      OR NEW."includedPassageCount" < OLD."includedPassageCount"
      OR NEW."dispatchedPassageCount" < OLD."dispatchedPassageCount"
    THEN
      RAISE EXCEPTION 'knowledge_strategy_execution_coverage_not_monotonic';
    END IF;
    IF NOT purge_enabled AND (
      NEW."processedPassageCount" = OLD."processedPassageCount"
      AND OLD."processedSetHash" IS NOT NULL
      AND NEW."processedSetHash" IS DISTINCT FROM OLD."processedSetHash"
      OR NEW."includedPassageCount" = OLD."includedPassageCount"
      AND OLD."includedSetHash" IS NOT NULL
      AND NEW."includedSetHash" IS DISTINCT FROM OLD."includedSetHash"
      OR NEW."dispatchedPassageCount" = OLD."dispatchedPassageCount"
      AND OLD."dispatchSetHash" IS NOT NULL
      AND NEW."dispatchSetHash" IS DISTINCT FROM OLD."dispatchSetHash"
    ) THEN
      RAISE EXCEPTION 'knowledge_strategy_execution_coverage_hash_rewrite';
    END IF;
    IF NOT purge_enabled AND OLD."state" IN (
      'settled', 'partial', 'failed', 'ambiguous', 'cancelled'
    ) AND to_jsonb(NEW) - 'updatedAt' IS DISTINCT FROM to_jsonb(OLD) - 'updatedAt' THEN
      RAISE EXCEPTION 'knowledge_strategy_execution_terminal_immutable';
    END IF;
    IF NOT purge_enabled AND NOT (
      CASE OLD."state"
        WHEN 'planned' THEN NEW."state" IN ('planned', 'running', 'cancelled')
        WHEN 'running' THEN NEW."state" IN (
          'running', 'settled', 'partial', 'failed', 'ambiguous', 'cancelled'
        )
        ELSE NEW."state" = OLD."state"
      END
    ) THEN
      RAISE EXCEPTION 'knowledge_strategy_execution_transition_invalid';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "KnowledgeStrategyExecution_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeStrategyExecution"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_strategy_execution();

CREATE FUNCTION aiqsa_guard_knowledge_strategy_step()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  execution_record "KnowledgeStrategyExecution"%ROWTYPE;
  execution_state text;
  linked_run_id text;
  purge_enabled boolean := COALESCE(
    current_setting('aiqsa.knowledge_purge', true) = 'on',
    false
  );
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "state" INTO execution_state
    FROM "KnowledgeStrategyExecution"
    WHERE "id" = OLD."executionId";
    IF execution_state IS NULL OR purge_enabled OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    IF execution_state <> 'planned' THEN
      RAISE EXCEPTION 'knowledge_strategy_step_plan_frozen';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO execution_record
  FROM "KnowledgeStrategyExecution"
  WHERE "id" = NEW."executionId";
  IF execution_record."modelRunId" IS DISTINCT FROM NEW."modelRunId" THEN
    RAISE EXCEPTION 'knowledge_strategy_step_execution_scope_mismatch';
  END IF;
  IF NEW."purgedAt" IS NULL AND NEW."sourceSetHash" IS DISTINCT FROM execution_record."sourceSetHash" THEN
    RAISE EXCEPTION 'knowledge_strategy_step_source_set_mismatch';
  END IF;
  IF NEW."request" IS NOT NULL
    AND NEW."request" ->> 'strategy' IS DISTINCT FROM execution_record."strategy"
  THEN
    RAISE EXCEPTION 'knowledge_strategy_step_strategy_mismatch';
  END IF;
  IF NEW."sourceBindingId" IS NOT NULL THEN
    SELECT "modelRunId" INTO linked_run_id
    FROM "KnowledgeRunSourceBinding" WHERE "id" = NEW."sourceBindingId";
    IF linked_run_id IS DISTINCT FROM NEW."modelRunId" THEN
      RAISE EXCEPTION 'knowledge_strategy_step_source_scope_mismatch';
    END IF;
  END IF;
  IF NEW."providerAttemptId" IS NOT NULL THEN
    SELECT "modelRunId" INTO linked_run_id
    FROM "KnowledgeProviderAttempt" WHERE "id" = NEW."providerAttemptId";
    IF linked_run_id IS DISTINCT FROM NEW."modelRunId" THEN
      RAISE EXCEPTION 'knowledge_strategy_step_provider_scope_mismatch';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND execution_record."state" <> 'planned' THEN
    RAISE EXCEPTION 'knowledge_strategy_step_plan_frozen';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."modelRunToolCallId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "KnowledgeRun"
    WHERE "modelRunId" = NEW."modelRunId"
      AND "modelRunToolCallId" = NEW."modelRunToolCallId"
  ) THEN
    RAISE EXCEPTION 'knowledge_strategy_step_tool_call_already_receipted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."executionId" IS DISTINCT FROM OLD."executionId"
      OR NEW."modelRunId" IS DISTINCT FROM OLD."modelRunId"
      OR NEW."ordinal" IS DISTINCT FROM OLD."ordinal"
      OR NEW."kind" IS DISTINCT FROM OLD."kind"
      OR NEW."phaseOrdinal" IS DISTINCT FROM OLD."phaseOrdinal"
      OR NEW."pageOrdinal" IS DISTINCT FROM OLD."pageOrdinal"
      OR NEW."targetOrdinal" IS DISTINCT FROM OLD."targetOrdinal"
      OR NEW."required" IS DISTINCT FROM OLD."required"
      OR NEW."materializationMode" IS DISTINCT FROM OLD."materializationMode"
    THEN
      RAISE EXCEPTION 'knowledge_strategy_step_identity_immutable';
    END IF;
    IF NOT purge_enabled AND (
      NEW."streamId" IS DISTINCT FROM OLD."streamId"
      OR NEW."sourceBindingId" IS DISTINCT FROM OLD."sourceBindingId"
      OR NEW."modelRunToolCallId" IS DISTINCT FROM OLD."modelRunToolCallId"
      OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
      OR NEW."templateHash" IS DISTINCT FROM OLD."templateHash"
      OR NEW."inputHash" IS DISTINCT FROM OLD."inputHash"
      OR NEW."comparisonDimensionHash" IS DISTINCT FROM OLD."comparisonDimensionHash"
      OR NEW."sourceSetHash" IS DISTINCT FROM OLD."sourceSetHash"
      OR NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt"
    ) THEN
      RAISE EXCEPTION 'knowledge_strategy_step_plan_immutable';
    END IF;
    IF NOT purge_enabled AND (
      NEW."request" IS DISTINCT FROM OLD."request"
      OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
      OR NEW."evidenceInputHash" IS DISTINCT FROM OLD."evidenceInputHash"
      OR NEW."materializedAt" IS DISTINCT FROM OLD."materializedAt"
    ) AND NOT (
      OLD."state" = 'pending' AND NEW."state" = 'pending'
      AND OLD."request" IS NULL AND OLD."requestHash" IS NULL
      AND OLD."materializedAt" IS NULL
      AND NEW."request" IS NOT NULL AND NEW."requestHash" IS NOT NULL
      AND NEW."materializedAt" IS NOT NULL
      AND execution_record."state" = 'running'
      AND OLD."materializationMode" IN (
        'cursor_from_predecessor', 'evidence_from_prerequisites'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "KnowledgeStrategyStepDependency" AS dependency
        JOIN "KnowledgeStrategyStep" AS prerequisite
          ON prerequisite."executionId" = dependency."executionId"
          AND prerequisite."id" = dependency."dependsOnStepId"
        WHERE dependency."executionId" = OLD."executionId"
          AND dependency."stepId" = OLD."id"
          AND (
            prerequisite."state" <> 'settled'
            OR prerequisite."result" ->> 'status' <> 'succeeded'
          )
      )
      AND CASE OLD."materializationMode"
        WHEN 'cursor_from_predecessor' THEN
          NEW."evidenceInputHash" IS NOT DISTINCT FROM OLD."evidenceInputHash"
          AND 1 = (
            SELECT count(*)
            FROM "KnowledgeStrategyStepDependency" AS dependency
            JOIN "KnowledgeStrategyStep" AS prerequisite
              ON prerequisite."executionId" = dependency."executionId"
              AND prerequisite."id" = dependency."dependsOnStepId"
            WHERE dependency."executionId" = OLD."executionId"
              AND dependency."stepId" = OLD."id"
              AND prerequisite."streamId" = OLD."streamId"
              AND prerequisite."pageOrdinal" = OLD."pageOrdinal" - 1
              AND prerequisite."state" = 'settled'
              AND prerequisite."result" ->> 'status' = 'succeeded'
              AND prerequisite."result" -> 'nextCursor' IS DISTINCT FROM 'null'::jsonb
          )
        WHEN 'evidence_from_prerequisites' THEN
          OLD."evidenceInputHash" IS NULL AND NEW."evidenceInputHash" IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM "KnowledgeStrategyStepDependency" AS dependency
            WHERE dependency."executionId" = OLD."executionId"
              AND dependency."stepId" = OLD."id"
          )
        ELSE false
      END
    ) THEN
      RAISE EXCEPTION 'knowledge_strategy_step_materialization_invalid';
    END IF;
    IF NOT purge_enabled
      AND OLD."kind" = 'corpus_summary_reduce'
      AND OLD."request" IS NULL
      AND NEW."request" IS NOT NULL
      AND (
        (SELECT count(*) FROM "KnowledgeStrategyStepDependency" AS dependency
          WHERE dependency."executionId" = OLD."executionId"
            AND dependency."stepId" = OLD."id")
          <> execution_record."expectedSourceCount"
        OR (SELECT count(*) FROM "KnowledgeStrategyMapOutput" AS map_output
          WHERE map_output."executionId" = OLD."executionId"
            AND map_output."state" = 'available'
            AND map_output."purgedAt" IS NULL)
          <> execution_record."expectedSourceCount"
        OR EXISTS (
          SELECT 1
          FROM "KnowledgeStrategyStepDependency" AS dependency
          LEFT JOIN "KnowledgeStrategyMapOutput" AS map_output
            ON map_output."executionId" = dependency."executionId"
            AND map_output."terminalStepId" = dependency."dependsOnStepId"
            AND map_output."state" = 'available'
            AND map_output."purgedAt" IS NULL
          WHERE dependency."executionId" = OLD."executionId"
            AND dependency."stepId" = OLD."id"
            AND map_output."id" IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM "KnowledgeStrategyMapOutput" AS map_output
          LEFT JOIN "KnowledgeStrategyStepDependency" AS dependency
            ON dependency."executionId" = map_output."executionId"
            AND dependency."stepId" = OLD."id"
            AND dependency."dependsOnStepId" = map_output."terminalStepId"
          WHERE map_output."executionId" = OLD."executionId"
            AND map_output."state" = 'available'
            AND map_output."purgedAt" IS NULL
            AND dependency."stepId" IS NULL
        )
      )
    THEN
      RAISE EXCEPTION 'knowledge_strategy_reduce_map_outputs_incomplete';
    END IF;
    IF NEW."processedSourceCount" < OLD."processedSourceCount"
      OR NEW."processedPassageCount" < OLD."processedPassageCount"
      OR NEW."includedPassageCount" < OLD."includedPassageCount"
      OR NEW."attemptCount" < OLD."attemptCount"
      OR NEW."stateVersion" < OLD."stateVersion"
    THEN
      RAISE EXCEPTION 'knowledge_strategy_step_progress_not_monotonic';
    END IF;
    IF NOT purge_enabled AND OLD."irreversibleDispatch" AND NOT NEW."irreversibleDispatch" THEN
      RAISE EXCEPTION 'knowledge_strategy_step_dispatch_not_reversible';
    END IF;
    IF NOT purge_enabled AND (
      NEW."state" IS DISTINCT FROM OLD."state"
      OR NEW."leaseToken" IS DISTINCT FROM OLD."leaseToken"
      OR NEW."leaseExpiresAt" IS DISTINCT FROM OLD."leaseExpiresAt"
      OR NEW."irreversibleDispatch" IS DISTINCT FROM OLD."irreversibleDispatch"
      OR NEW."failureCode" IS DISTINCT FROM OLD."failureCode"
      OR NEW."resultHash" IS DISTINCT FROM OLD."resultHash"
    ) AND NEW."stateVersion" <> OLD."stateVersion" + 1 THEN
      RAISE EXCEPTION 'knowledge_strategy_step_state_version_invalid';
    END IF;
    IF NOT purge_enabled AND OLD."providerAttemptId" IS NOT NULL
      AND NEW."providerAttemptId" IS DISTINCT FROM OLD."providerAttemptId"
    THEN
      RAISE EXCEPTION 'knowledge_strategy_step_provider_immutable';
    END IF;
    IF NOT purge_enabled AND NEW."cursor" IS DISTINCT FROM OLD."cursor"
      AND OLD."state" <> 'running'
    THEN
      RAISE EXCEPTION 'knowledge_strategy_step_cursor_not_claimed';
    END IF;
    IF NOT purge_enabled AND OLD."state" IN (
      'settled', 'failed', 'ambiguous', 'cancelled', 'purged'
    ) AND to_jsonb(NEW) - 'updatedAt' IS DISTINCT FROM to_jsonb(OLD) - 'updatedAt' THEN
      RAISE EXCEPTION 'knowledge_strategy_step_terminal_immutable';
    END IF;
    IF NOT purge_enabled AND NOT (
      CASE OLD."state"
        WHEN 'pending' THEN NEW."state" IN ('pending', 'running', 'cancelled')
        WHEN 'running' THEN NEW."state" IN (
          'pending', 'running', 'settled', 'failed', 'ambiguous', 'cancelled'
        )
        ELSE NEW."state" = OLD."state"
      END
    ) THEN
      RAISE EXCEPTION 'knowledge_strategy_step_transition_invalid';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "KnowledgeStrategyStep_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeStrategyStep"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_strategy_step();

CREATE FUNCTION aiqsa_guard_knowledge_strategy_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  execution_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    SELECT "state" INTO execution_state FROM "KnowledgeStrategyExecution"
    WHERE "id" = OLD."executionId";
    IF execution_state IS NULL OR current_setting('aiqsa.knowledge_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    IF execution_state <> 'planned' THEN
      RAISE EXCEPTION 'knowledge_strategy_dependency_plan_frozen';
    END IF;
    RETURN OLD;
  END IF;
  SELECT "state" INTO execution_state FROM "KnowledgeStrategyExecution"
  WHERE "id" = NEW."executionId";
  IF execution_state <> 'planned' THEN
    RAISE EXCEPTION 'knowledge_strategy_dependency_plan_frozen';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "KnowledgeStrategyStepDependency_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeStrategyStepDependency"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_strategy_dependency();

CREATE FUNCTION aiqsa_guard_knowledge_strategy_dag_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  cycle_found boolean;
BEGIN
  WITH RECURSIVE prerequisites("stepId") AS (
    SELECT dependency."dependsOnStepId"
    FROM "KnowledgeStrategyStepDependency" AS dependency
    WHERE dependency."executionId" = NEW."executionId"
      AND dependency."stepId" = NEW."dependsOnStepId"
    UNION
    SELECT dependency."dependsOnStepId"
    FROM "KnowledgeStrategyStepDependency" AS dependency
    JOIN prerequisites ON prerequisites."stepId" = dependency."stepId"
    WHERE dependency."executionId" = NEW."executionId"
  )
  SELECT EXISTS(
    SELECT 1 FROM prerequisites WHERE "stepId" = NEW."stepId"
  ) INTO cycle_found;
  IF cycle_found THEN
    RAISE EXCEPTION 'knowledge_strategy_dependency_cycle';
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "KnowledgeStrategyStepDependency_acyclic"
AFTER INSERT OR UPDATE ON "KnowledgeStrategyStepDependency"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_strategy_dag_cycle();

CREATE FUNCTION knowledge_strategy_step_evidence_valid(receipt jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT
    knowledge_jsonb_has_exact_keys(
      receipt,
      ARRAY[
        'executionId', 'kind', 'ordinal', 'requestHash', 'resultHash', 'stepId', 'version'
      ]::text[]
    )
    AND pg_column_size(receipt) <= 4096
    AND receipt -> 'version' IS NOT DISTINCT FROM '1'::jsonb
    AND jsonb_typeof(receipt -> 'executionId') IS NOT DISTINCT FROM 'string'
    AND receipt ->> 'executionId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND jsonb_typeof(receipt -> 'stepId') IS NOT DISTINCT FROM 'string'
    AND receipt ->> 'stepId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND jsonb_typeof(receipt -> 'kind') IS NOT DISTINCT FROM 'string'
    AND receipt ->> 'kind' IN (
      'full_context_page', 'comparison_target', 'exhaustive_page',
      'corpus_summary_map', 'corpus_summary_reduce', 'multi_hop_root',
      'multi_hop_follow_up'
    )
    AND jsonb_typeof(receipt -> 'ordinal') IS NOT DISTINCT FROM 'number'
    AND receipt ->> 'ordinal' ~ '^(0|[1-9][0-9]{0,3})$'
    AND (receipt ->> 'ordinal')::integer BETWEEN 0 AND 4095
    AND jsonb_typeof(receipt -> 'requestHash') IS NOT DISTINCT FROM 'string'
    AND receipt ->> 'requestHash' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(receipt -> 'resultHash') IS NOT DISTINCT FROM 'string'
    AND receipt ->> 'resultHash' ~ '^[0-9a-f]{64}$'
$function$;

CREATE FUNCTION aiqsa_guard_knowledge_strategy_step_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  linked_step_exists boolean;
  marker_matches boolean;
BEGIN
  IF NEW."strategyStepEvidence" IS NULL THEN
    SELECT EXISTS(
      SELECT 1 FROM "KnowledgeStrategyStep" AS step
      WHERE step."modelRunId" = NEW."modelRunId"
        AND step."modelRunToolCallId" = NEW."modelRunToolCallId"
    ) INTO linked_step_exists;
    IF linked_step_exists THEN
      RAISE EXCEPTION 'knowledge_strategy_step_evidence_missing';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT knowledge_strategy_step_evidence_valid(NEW."strategyStepEvidence") THEN
    RAISE EXCEPTION 'knowledge_strategy_step_evidence_invalid';
  END IF;
  SELECT EXISTS(
    SELECT 1
    FROM "KnowledgeStrategyStep" AS step
    JOIN "KnowledgeStrategyExecution" AS execution
      ON execution."id" = step."executionId"
      AND execution."modelRunId" = step."modelRunId"
    WHERE execution."id" = NEW."strategyStepEvidence" ->> 'executionId'
      AND execution."modelRunId" = NEW."modelRunId"
      AND step."id" = NEW."strategyStepEvidence" ->> 'stepId'
      AND step."modelRunToolCallId" = NEW."modelRunToolCallId"
      AND step."state" = 'settled'
      AND step."ordinal" = (NEW."strategyStepEvidence" ->> 'ordinal')::integer
      AND step."kind" = NEW."strategyStepEvidence" ->> 'kind'
      AND step."requestHash" = NEW."strategyStepEvidence" ->> 'requestHash'
      AND step."resultHash" = NEW."strategyStepEvidence" ->> 'resultHash'
  ) INTO marker_matches;
  IF NOT marker_matches THEN
    RAISE EXCEPTION 'knowledge_strategy_step_evidence_mismatch';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "KnowledgeRun_strategy_step_evidence_guard"
BEFORE INSERT OR UPDATE OF "modelRunId", "modelRunToolCallId", "strategyStepEvidence"
ON "KnowledgeRun"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_strategy_step_evidence();

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_strategy_step_evidence_check" CHECK (
    (
      "strategyStepEvidence" IS NULL
      OR knowledge_strategy_step_evidence_valid("strategyStepEvidence")
    ) IS TRUE
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_strategy_step_evidence_check";

-- A strategy-bound exhaustive scan or corpus-summary reduce may persist up to
-- 100 complete Source-bound evidence rows in one atomic Knowledge receipt.
-- Ordinary automatic retrieval remains capped at eight. Permanent purge clears
-- the marker and normalizes the receipt limits in the same transaction.
ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_evidence_shape_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_evidence_shape_check" CHECK (
    jsonb_typeof("baseEvidence") = 'array'
    AND jsonb_array_length("baseEvidence") BETWEEN 1 AND 3
    AND jsonb_typeof("results") = 'array'
    AND jsonb_array_length("results") <= CASE
      WHEN "operation" IN ('find_exact', 'discover_sources')
        OR "strategyStepEvidence" ->> 'kind' IN (
          'exhaustive_page', 'corpus_summary_reduce'
        )
        THEN 100
      ELSE 8
    END
    AND jsonb_typeof("embeddingUsage") = 'array'
    AND jsonb_array_length("embeddingUsage") <= 3
    AND octet_length("providerText") BETWEEN 1 AND 49152
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_evidence_shape_check";

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_limits_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_limits_check" CHECK (
    "invocationOrdinal" BETWEEN 1 AND 256
    AND "candidateLimit" BETWEEN 1 AND 100
    AND "resultLimit" BETWEEN 1 AND CASE
      WHEN "operation" IN ('find_exact', 'discover_sources')
        OR "strategyStepEvidence" ->> 'kind' IN (
          'exhaustive_page', 'corpus_summary_reduce'
        )
        THEN 100
      ELSE 8
    END
    AND "candidateLimit" >= "resultLimit"
    AND "candidateCount" >= 0
    AND "threshold" BETWEEN 0::double precision AND 1::double precision
    AND CASE
      WHEN "operation" IN ('find_exact', 'discover_sources')
        THEN "fusion" = 'none' AND "threshold" = 0
      ELSE "fusion" IN ('rrf_k60', 'weighted_rrf_v2')
    END
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_limits_check";

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_outcome_shape_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_outcome_shape_check" CHECK (
    CASE
      WHEN "operation" = 'discover_sources' THEN
        jsonb_array_length("results") = 0
        AND CASE "outcome"
          WHEN 'complete' THEN "candidateCount" > 0
          WHEN 'zero_above_threshold' THEN "candidateCount" = 0
          ELSE true
        END
      WHEN "operation" = 'find_exact' THEN
        CASE "outcome"
          WHEN 'complete' THEN
            "candidateCount" > 0
            AND jsonb_array_length("results") BETWEEN 1 AND "resultLimit"
          ELSE jsonb_array_length("results") = 0
        END
      WHEN "outcome" = 'complete' THEN
        jsonb_array_length("results") BETWEEN 1 AND CASE
          WHEN "strategyStepEvidence" ->> 'kind' IN (
            'exhaustive_page', 'corpus_summary_reduce'
          )
            THEN "resultLimit"
          ELSE 8
        END
      ELSE jsonb_array_length("results") = 0
    END
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_outcome_shape_check";

-- H2 originally constrained frozen dispatch handles to three decimal digits,
-- while the canonical Evidence Package contract permits K1..K2048. Keep the
-- database boundary aligned with the strict application decoder so large,
-- otherwise-valid packages remain replayable without admitting K2049+.
ALTER TABLE "KnowledgeEvidenceDispatchManifestItem"
  DROP CONSTRAINT "KnowledgeEvidenceDispatchManifestItem_contract_check";

ALTER TABLE "KnowledgeEvidenceDispatchManifestItem"
  ADD CONSTRAINT "KnowledgeEvidenceDispatchManifestItem_contract_check" CHECK (
    "ordinal" BETWEEN 0 AND 4095
    AND "representation" IN ('full', 'shortened', 'purged')
    AND "excerptBytes" >= 0
    AND "renderedBytes" >= 0
    AND "renderedTokens" >= 0
    AND (
      (
        "representation" IN ('full', 'shortened')
        AND "evidenceItemId" IS NOT NULL
        AND "handle" IS NOT NULL
        AND "handle" ~ '^K[1-9][0-9]{0,3}$'
        AND substring("handle" FROM 2)::integer BETWEEN 1 AND 2048
        AND "sourceAlias" IS NOT NULL
        AND "sourceAlias" ~ '^S[1-9][0-9]{0,2}$'
        AND "sourceVersionId" IS NOT NULL
        AND "sourceArtifactId" IS NOT NULL
        AND "exactExcerpt" IS NOT NULL
        AND "renderedBlock" IS NOT NULL
        AND "excerptHash" IS NOT NULL
        AND "excerptHash" ~ '^[0-9a-f]{64}$'
        AND "renderedBlockHash" IS NOT NULL
        AND "renderedBlockHash" ~ '^[0-9a-f]{64}$'
        AND octet_length("exactExcerpt") = "excerptBytes"
        AND octet_length("renderedBlock") = "renderedBytes"
      )
      OR (
        "representation" = 'purged'
        AND "evidenceItemId" IS NULL
        AND "handle" IS NULL
        AND "sourceAlias" IS NULL
        AND "sourceVersionId" IS NULL
        AND "sourceArtifactId" IS NULL
        AND "safeMetadata" IS NULL
        AND "exactExcerpt" IS NULL
        AND "renderedBlock" IS NULL
        AND "excerptHash" IS NULL
        AND "renderedBlockHash" IS NULL
        AND "contextBoundaries" IS NULL
      )
    )
  ) NOT VALID;

ALTER TABLE "KnowledgeEvidenceDispatchManifestItem"
  VALIDATE CONSTRAINT "KnowledgeEvidenceDispatchManifestItem_contract_check";

ALTER TABLE "KnowledgeEvidenceDispatchManifestExclusion"
  DROP CONSTRAINT "KnowledgeEvidenceDispatchManifestExclusion_contract_check";

ALTER TABLE "KnowledgeEvidenceDispatchManifestExclusion"
  ADD CONSTRAINT "KnowledgeEvidenceDispatchManifestExclusion_contract_check" CHECK (
    "ordinal" BETWEEN 0 AND 4095
    AND "reason" IN ('budget', 'deduped', 'unavailable', 'purged')
    AND (
      (
        "reason" IN ('budget', 'deduped')
        AND "evidenceItemId" IS NOT NULL
        AND "handle" IS NOT NULL
        AND "handle" ~ '^K[1-9][0-9]{0,3}$'
        AND substring("handle" FROM 2)::integer BETWEEN 1 AND 2048
      )
      OR (
        "reason" = 'unavailable'
        AND (
          ("evidenceItemId" IS NULL AND "handle" IS NULL)
          OR (
            "evidenceItemId" IS NOT NULL
            AND "handle" IS NOT NULL
            AND "handle" ~ '^K[1-9][0-9]{0,3}$'
            AND substring("handle" FROM 2)::integer BETWEEN 1 AND 2048
          )
        )
      )
      OR ("reason" = 'purged' AND "evidenceItemId" IS NULL AND "handle" IS NULL)
    )
  ) NOT VALID;

ALTER TABLE "KnowledgeEvidenceDispatchManifestExclusion"
  VALIDATE CONSTRAINT "KnowledgeEvidenceDispatchManifestExclusion_contract_check";
