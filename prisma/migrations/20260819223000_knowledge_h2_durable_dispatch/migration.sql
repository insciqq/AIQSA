-- Stage H2 is additive. Existing accepted runs and V1/V2 receipts remain
-- untouched; only new runtime writes populate these aggregates.

CREATE TYPE "KnowledgeBudgetReservationState" AS ENUM (
  'reserved',
  'dispatched',
  'settled',
  'released',
  'ambiguous',
  'expired'
);

CREATE TYPE "KnowledgeProviderAttemptState" AS ENUM (
  'reserved',
  'dispatched',
  'settled',
  'released',
  'ambiguous'
);

ALTER TABLE "KnowledgeRun"
  ADD COLUMN "budgetReservationId" text,
  ADD COLUMN "receiptVersion" integer,
  ADD CONSTRAINT "KnowledgeRun_receipt_version_check" CHECK ((
    ("receiptVersion" IS NULL AND "budgetReservationId" IS NULL)
    OR ("receiptVersion" = 2 AND "budgetReservationId" IS NOT NULL)
  ) IS TRUE);

ALTER TABLE "KnowledgeRunBinding"
  ADD COLUMN "profileBindingId" text;

CREATE TABLE "KnowledgeRunProfileBinding" (
  "id" text NOT NULL,
  "modelRunId" text NOT NULL,
  "ordinal" integer NOT NULL,
  "profileRevisionId" text NOT NULL,
  "vectorSpaceFingerprint" char(64) NOT NULL,
  "targetDimension" integer NOT NULL,
  "embeddingConnectionId" text NOT NULL,
  "embeddingProviderModelId" text NOT NULL,
  "embeddingCredentialId" text NOT NULL,
  "embeddingCredentialVersionId" text NOT NULL,
  "embeddingCredentialSource" "ProviderCredentialSource" NOT NULL,
  "embeddingExecutionSnapshot" jsonb NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeRunProfileBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeRunProfileBinding_bounds_check" CHECK (
    "ordinal" BETWEEN 0 AND 255
    AND "targetDimension" IN (1024, 1536)
    AND "vectorSpaceFingerprint" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("embeddingExecutionSnapshot") = 'object'
    AND pg_column_size("embeddingExecutionSnapshot") <= 65536
  )
);

CREATE TABLE "KnowledgeRunSourceBinding" (
  "id" text NOT NULL,
  "modelRunId" text NOT NULL,
  "profileBindingId" text NOT NULL,
  "sourceId" text,
  "sourceVersionId" text,
  "sourceArtifactId" text,
  "ordinal" integer NOT NULL,
  "sourceAlias" varchar(8) NOT NULL,
  "directSelected" boolean NOT NULL DEFAULT false,
  "selectionKind" varchar(32) NOT NULL,
  "readinessState" varchar(16) NOT NULL DEFAULT 'ready',
  "sourceNameSnapshot" varchar(1024),
  "fileNameSnapshot" varchar(1024),
  "sourceVersionNumber" integer NOT NULL,
  "accessProvenance" jsonb,
  "baseProvenance" jsonb,
  "tombstonedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeRunSourceBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeRunSourceBinding_contract_check" CHECK (
    "ordinal" BETWEEN 0 AND 998
    AND "sourceAlias" ~ '^S[1-9][0-9]{0,2}$'
    AND "sourceVersionNumber" >= 1
    AND "selectionKind" IN ('base', 'direct', 'all_my_knowledge', 'project', 'assistant')
    AND "readinessState" IN ('ready', 'deleted')
    AND (
      (
        "tombstonedAt" IS NULL
        AND "sourceId" IS NOT NULL
        AND "sourceVersionId" IS NOT NULL
        AND "sourceArtifactId" IS NOT NULL
      )
      OR (
        "tombstonedAt" IS NOT NULL
        AND "sourceId" IS NULL
        AND "sourceVersionId" IS NULL
        AND "sourceArtifactId" IS NULL
        AND "sourceNameSnapshot" IS NULL
        AND "fileNameSnapshot" IS NULL
        AND "accessProvenance" IS NULL
        AND "baseProvenance" IS NULL
        AND "readinessState" = 'deleted'
      )
    )
    AND ("accessProvenance" IS NULL OR (
      jsonb_typeof("accessProvenance") = 'object'
      AND pg_column_size("accessProvenance") <= 16384
    ))
    AND ("baseProvenance" IS NULL OR (
      jsonb_typeof("baseProvenance") = 'array'
      AND pg_column_size("baseProvenance") <= 32768
    ))
  )
);

CREATE TABLE "KnowledgeBudgetReservation" (
  "id" text NOT NULL,
  "modelRunId" text NOT NULL,
  "modelRunToolCallId" text NOT NULL,
  "operationOrdinal" integer NOT NULL,
  "phaseOrdinal" integer NOT NULL,
  "subqueryOrdinal" integer NOT NULL,
  "operation" varchar(32) NOT NULL,
  "policyVersion" integer NOT NULL,
  "idempotencyKey" varchar(128),
  "operationRequest" jsonb,
  "operationRequestHash" char(64),
  "state" "KnowledgeBudgetReservationState" NOT NULL DEFAULT 'reserved',
  "estimatedCandidates" integer NOT NULL,
  "estimatedRetrievedTokens" integer NOT NULL,
  "estimatedEmbeddingCalls" integer NOT NULL,
  "estimatedRerankerCalls" integer NOT NULL,
  "estimatedLatencyMs" integer NOT NULL,
  "estimatedCostMicros" integer NOT NULL,
  "estimatedValidationSlots" integer NOT NULL DEFAULT 0,
  "estimatedRepairSlots" integer NOT NULL DEFAULT 0,
  "actualCandidates" integer,
  "actualRetrievedTokens" integer,
  "actualEmbeddingCalls" integer,
  "actualRerankerCalls" integer,
  "actualLatencyMs" integer,
  "actualCostMicros" integer,
  "actualValidationSlots" integer,
  "actualRepairSlots" integer,
  "leaseToken" varchar(128),
  "leaseExpiresAt" timestamp(3),
  "dispatchAttemptKey" varchar(128),
  "receiptHash" char(64),
  "failureCode" varchar(128),
  "dispatchedAt" timestamp(3),
  "settledAt" timestamp(3),
  "releasedAt" timestamp(3),
  "ambiguousAt" timestamp(3),
  "expiredAt" timestamp(3),
  "purgedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "KnowledgeBudgetReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeBudgetReservation_request_check" CHECK (
    "operationOrdinal" BETWEEN 1 AND 256
    AND "phaseOrdinal" BETWEEN 0 AND 63
    AND "subqueryOrdinal" BETWEEN 0 AND 127
    AND "operation" IN (
      'automatic_search',
      'discover_sources',
      'find_exact',
      'read_source',
      'search_knowledge'
    )
    AND "policyVersion" >= 1
    AND ((
      (
        "purgedAt" IS NULL
        AND "idempotencyKey" IS NOT NULL
        AND "idempotencyKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
        AND "operationRequestHash" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("operationRequest") = 'object'
        AND pg_column_size("operationRequest") <= 65536
        AND ("operationRequest" ->> 'version') = '2'
        AND ("operationRequest" ->> 'reservationId') = "id"
        AND ("operationRequest" ->> 'idempotencyKey') = "idempotencyKey"
        AND ("operationRequest" ->> 'operation') = "operation"
        AND ("operationRequest" ->> 'phaseOrdinal') = "phaseOrdinal"::text
        AND ("operationRequest" ->> 'subqueryOrdinal') = "subqueryOrdinal"::text
      )
      OR (
        "purgedAt" IS NOT NULL
        AND "purgedAt" >= "createdAt"
        AND "idempotencyKey" IS NULL
        AND "operationRequest" IS NULL
        AND "operationRequestHash" IS NULL
        AND "leaseToken" IS NULL
        AND "leaseExpiresAt" IS NULL
        AND "dispatchAttemptKey" IS NULL
        AND "receiptHash" IS NULL
        AND "failureCode" IS NULL
      )
    )) IS TRUE
  ),
  CONSTRAINT "KnowledgeBudgetReservation_usage_check" CHECK (
    "estimatedCandidates" >= 0
    AND "estimatedRetrievedTokens" >= 0
    AND "estimatedEmbeddingCalls" >= 0
    AND "estimatedRerankerCalls" >= 0
    AND "estimatedLatencyMs" >= 0
    AND "estimatedCostMicros" >= 0
    AND "estimatedValidationSlots" >= 0
    AND "estimatedRepairSlots" >= 0
    AND ("actualCandidates" IS NULL OR "actualCandidates" >= 0)
    AND ("actualRetrievedTokens" IS NULL OR "actualRetrievedTokens" >= 0)
    AND ("actualEmbeddingCalls" IS NULL OR "actualEmbeddingCalls" >= 0)
    AND ("actualRerankerCalls" IS NULL OR "actualRerankerCalls" >= 0)
    AND ("actualLatencyMs" IS NULL OR "actualLatencyMs" >= 0)
    AND ("actualCostMicros" IS NULL OR "actualCostMicros" >= 0)
    AND ("actualValidationSlots" IS NULL OR "actualValidationSlots" >= 0)
    AND ("actualRepairSlots" IS NULL OR "actualRepairSlots" >= 0)
    AND ("receiptHash" IS NULL OR "receiptHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "KnowledgeBudgetReservation_state_check" CHECK ((
    CASE "state"
      WHEN 'reserved' THEN
        "dispatchedAt" IS NULL AND "settledAt" IS NULL AND "releasedAt" IS NULL
        AND "ambiguousAt" IS NULL AND "expiredAt" IS NULL
        AND "dispatchAttemptKey" IS NULL AND "receiptHash" IS NULL AND "failureCode" IS NULL
        AND "actualCandidates" IS NULL AND "actualRetrievedTokens" IS NULL
        AND "actualEmbeddingCalls" IS NULL AND "actualRerankerCalls" IS NULL
        AND "actualLatencyMs" IS NULL AND "actualCostMicros" IS NULL
        AND "actualValidationSlots" IS NULL AND "actualRepairSlots" IS NULL
        AND (
          "purgedAt" IS NOT NULL
          OR (
            "leaseToken" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
            AND "leaseExpiresAt" > "createdAt"
          )
        )
      WHEN 'dispatched' THEN
        "dispatchedAt" >= "createdAt"
        AND "settledAt" IS NULL AND "releasedAt" IS NULL
        AND "ambiguousAt" IS NULL AND "expiredAt" IS NULL
        AND "receiptHash" IS NULL AND "failureCode" IS NULL
        AND "actualCandidates" IS NULL AND "actualRetrievedTokens" IS NULL
        AND "actualEmbeddingCalls" IS NULL AND "actualRerankerCalls" IS NULL
        AND "actualLatencyMs" IS NULL AND "actualCostMicros" IS NULL
        AND "actualValidationSlots" IS NULL AND "actualRepairSlots" IS NULL
        AND (
          "purgedAt" IS NOT NULL
          OR (
            "dispatchAttemptKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
            AND "leaseToken" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
            AND "leaseExpiresAt" > "dispatchedAt"
          )
        )
      WHEN 'settled' THEN
        "dispatchedAt" >= "createdAt" AND "settledAt" >= "dispatchedAt"
        AND "releasedAt" IS NULL AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        AND "failureCode" IS NULL
        AND "ambiguousAt" IS NULL AND "expiredAt" IS NULL
        AND "actualCandidates" IS NOT NULL AND "actualRetrievedTokens" IS NOT NULL
        AND "actualEmbeddingCalls" IS NOT NULL AND "actualRerankerCalls" IS NOT NULL
        AND "actualLatencyMs" IS NOT NULL AND "actualCostMicros" IS NOT NULL
        AND "actualValidationSlots" IS NOT NULL AND "actualRepairSlots" IS NOT NULL
        AND (
          "purgedAt" IS NOT NULL
          OR (
            "dispatchAttemptKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
            AND "receiptHash" ~ '^[0-9a-f]{64}$'
          )
        )
      WHEN 'released' THEN
        "dispatchedAt" IS NULL AND "settledAt" IS NULL
        AND "releasedAt" IS NOT NULL AND "ambiguousAt" IS NULL AND "expiredAt" IS NULL
        AND "releasedAt" >= "createdAt"
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        AND "dispatchAttemptKey" IS NULL AND "receiptHash" IS NULL
        AND "actualCandidates" IS NULL AND "actualRetrievedTokens" IS NULL
        AND "actualEmbeddingCalls" IS NULL AND "actualRerankerCalls" IS NULL
        AND "actualLatencyMs" IS NULL AND "actualCostMicros" IS NULL
        AND "actualValidationSlots" IS NULL AND "actualRepairSlots" IS NULL
        AND (
          "purgedAt" IS NOT NULL
          OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$'
        )
      WHEN 'ambiguous' THEN
        "dispatchedAt" >= "createdAt" AND "ambiguousAt" >= "dispatchedAt"
        AND "settledAt" IS NULL AND "releasedAt" IS NULL AND "expiredAt" IS NULL
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL AND "receiptHash" IS NULL
        AND "actualCandidates" IS NULL AND "actualRetrievedTokens" IS NULL
        AND "actualEmbeddingCalls" IS NULL AND "actualRerankerCalls" IS NULL
        AND "actualLatencyMs" IS NULL AND "actualCostMicros" IS NULL
        AND "actualValidationSlots" IS NULL AND "actualRepairSlots" IS NULL
        AND (
          "purgedAt" IS NOT NULL
          OR (
            "dispatchAttemptKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
            AND "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$'
          )
        )
      WHEN 'expired' THEN
        "dispatchedAt" IS NULL AND "settledAt" IS NULL AND "releasedAt" IS NULL
        AND "ambiguousAt" IS NULL AND "expiredAt" >= "createdAt"
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        AND "dispatchAttemptKey" IS NULL AND "receiptHash" IS NULL
        AND "actualCandidates" IS NULL AND "actualRetrievedTokens" IS NULL
        AND "actualEmbeddingCalls" IS NULL AND "actualRerankerCalls" IS NULL
        AND "actualLatencyMs" IS NULL AND "actualCostMicros" IS NULL
        AND "actualValidationSlots" IS NULL AND "actualRepairSlots" IS NULL
        AND (
          "purgedAt" IS NOT NULL
          OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$'
        )
      ELSE false
    END
  ) IS TRUE)
);

CREATE TABLE "KnowledgeProviderAttempt" (
  "id" text NOT NULL,
  "modelRunId" text NOT NULL,
  "providerBindingKey" text NOT NULL DEFAULT 'answer',
  "ordinal" integer NOT NULL,
  "roundIndex" integer NOT NULL,
  "purpose" varchar(32) NOT NULL DEFAULT 'answer',
  "idempotencyKey" varchar(128) NOT NULL,
  "checkpointHash" char(64) NOT NULL,
  "requestHash" char(64) NOT NULL,
  "state" "KnowledgeProviderAttemptState" NOT NULL DEFAULT 'reserved',
  "estimatedUsage" jsonb NOT NULL,
  "actualUsage" jsonb,
  "providerResponseId" text,
  "leaseToken" varchar(128),
  "leaseExpiresAt" timestamp(3),
  "failureCode" varchar(128),
  "dispatchedAt" timestamp(3),
  "settledAt" timestamp(3),
  "releasedAt" timestamp(3),
  "ambiguousAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "KnowledgeProviderAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeProviderAttempt_contract_check" CHECK (
    "ordinal" BETWEEN 1 AND 256
    AND "roundIndex" BETWEEN 0 AND 255
    AND "purpose" IN ('answer', 'tool_follow_up', 'citation_repair', 'answer_citation_retry')
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
  ),
  CONSTRAINT "KnowledgeProviderAttempt_state_check" CHECK ((
    CASE "state"
      WHEN 'reserved' THEN
        "dispatchedAt" IS NULL AND "settledAt" IS NULL
        AND "releasedAt" IS NULL AND "ambiguousAt" IS NULL
        AND "actualUsage" IS NULL AND "providerResponseId" IS NULL
        AND "failureCode" IS NULL
        AND "leaseToken" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
        AND "leaseExpiresAt" > "createdAt"
      WHEN 'dispatched' THEN
        "dispatchedAt" >= "createdAt" AND "settledAt" IS NULL
        AND "releasedAt" IS NULL AND "ambiguousAt" IS NULL
        AND "actualUsage" IS NULL AND "failureCode" IS NULL
        AND "leaseToken" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
        AND "leaseExpiresAt" > "dispatchedAt"
      WHEN 'settled' THEN
        "dispatchedAt" >= "createdAt" AND "settledAt" >= "dispatchedAt"
        AND "releasedAt" IS NULL AND "ambiguousAt" IS NULL
        AND "actualUsage" IS NOT NULL AND "failureCode" IS NULL
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
      WHEN 'released' THEN
        "dispatchedAt" IS NULL AND "settledAt" IS NULL
        AND "releasedAt" >= "createdAt" AND "ambiguousAt" IS NULL
        AND "actualUsage" IS NULL AND "providerResponseId" IS NULL
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        AND "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$'
      WHEN 'ambiguous' THEN
        "dispatchedAt" >= "createdAt" AND "settledAt" IS NULL
        AND "releasedAt" IS NULL AND "ambiguousAt" >= "dispatchedAt"
        AND "actualUsage" IS NULL
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        AND "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$'
      ELSE false
    END
  ) IS TRUE)
);

CREATE TABLE "KnowledgeEvidenceDispatchManifest" (
  "id" text NOT NULL,
  "modelRunId" text NOT NULL,
  "retrievalSessionId" text NOT NULL,
  "providerAttemptId" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "packingVersion" varchar(64) NOT NULL,
  "promptFragmentVersion" varchar(64) NOT NULL,
  "profileRevisionIds" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "coverage" jsonb,
  "messageText" text,
  "messageHash" char(64),
  "totalBytes" integer NOT NULL,
  "totalTokens" integer NOT NULL,
  "itemCount" integer NOT NULL,
  "excludedCount" integer NOT NULL,
  "shortenedCount" integer NOT NULL,
  "sealedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "purgedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeEvidenceDispatchManifest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeEvidenceDispatchManifest_contract_check" CHECK (
    "version" = 1
    AND "totalBytes" >= 0
    AND "totalTokens" >= 0
    AND "itemCount" >= 0
    AND "excludedCount" >= 0
    AND "shortenedCount" BETWEEN 0 AND "itemCount"
    AND (
      (
        "purgedAt" IS NULL
        AND "messageText" IS NOT NULL
        AND "messageHash" ~ '^[0-9a-f]{64}$'
        AND octet_length("messageText") = "totalBytes"
      )
      OR (
        "purgedAt" IS NOT NULL
        AND "messageText" IS NULL
        AND "messageHash" IS NULL
        AND "coverage" IS NULL
        AND cardinality("profileRevisionIds") = 0
      )
    )
  )
);

CREATE TABLE "KnowledgeEvidenceDispatchManifestItem" (
  "id" text NOT NULL,
  "manifestId" text NOT NULL,
  "ordinal" integer NOT NULL,
  "evidenceItemId" text,
  "handle" varchar(8),
  "sourceAlias" varchar(8),
  "sourceVersionId" text,
  "sourceArtifactId" text,
  "representation" varchar(16) NOT NULL,
  "safeMetadata" jsonb,
  "exactExcerpt" text,
  "renderedBlock" text,
  "excerptHash" char(64),
  "renderedBlockHash" char(64),
  "excerptBytes" integer NOT NULL,
  "renderedBytes" integer NOT NULL,
  "renderedTokens" integer NOT NULL,
  "contextBoundaries" jsonb,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeEvidenceDispatchManifestItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeEvidenceDispatchManifestItem_contract_check" CHECK (
    "ordinal" BETWEEN 0 AND 4095
    AND "representation" IN ('full', 'shortened', 'purged')
    AND "excerptBytes" >= 0
    AND "renderedBytes" >= 0
    AND "renderedTokens" >= 0
    AND (
      (
        "representation" IN ('full', 'shortened')
        AND "evidenceItemId" IS NOT NULL
        AND "handle" ~ '^K[1-9][0-9]{0,2}$'
        AND "sourceAlias" ~ '^S[1-9][0-9]{0,2}$'
        AND "sourceVersionId" IS NOT NULL
        AND "sourceArtifactId" IS NOT NULL
        AND "exactExcerpt" IS NOT NULL
        AND "renderedBlock" IS NOT NULL
        AND "excerptHash" ~ '^[0-9a-f]{64}$'
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
  )
);

CREATE TABLE "KnowledgeEvidenceDispatchManifestExclusion" (
  "id" text NOT NULL,
  "manifestId" text NOT NULL,
  "ordinal" integer NOT NULL,
  "evidenceItemId" text,
  "handle" varchar(8),
  "reason" varchar(32) NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeEvidenceDispatchManifestExclusion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeEvidenceDispatchManifestExclusion_contract_check" CHECK (
    "ordinal" BETWEEN 0 AND 4095
    AND "reason" IN ('budget', 'deduped', 'unavailable', 'purged')
    AND (
      (
        "reason" IN ('budget', 'deduped')
        AND "evidenceItemId" IS NOT NULL
        AND "handle" IS NOT NULL
        AND "handle" ~ '^K[1-9][0-9]{0,2}$'
      )
      OR (
        "reason" = 'unavailable'
        AND (
          ("evidenceItemId" IS NULL AND "handle" IS NULL)
          OR (
            "evidenceItemId" IS NOT NULL
            AND "handle" IS NOT NULL
            AND "handle" ~ '^K[1-9][0-9]{0,2}$'
          )
        )
      )
      OR ("reason" = 'purged' AND "evidenceItemId" IS NULL AND "handle" IS NULL)
    )
  )
);

CREATE TABLE "ProjectKnowledgeSourceBinding" (
  "projectId" text NOT NULL,
  "sourceId" text NOT NULL,
  "addedByUserId" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectKnowledgeSourceBinding_pkey" PRIMARY KEY ("projectId", "sourceId")
);

CREATE UNIQUE INDEX "KnowledgeRunProfileBinding_modelRunId_id_key"
  ON "KnowledgeRunProfileBinding" ("modelRunId", "id");
CREATE UNIQUE INDEX "KnowledgeRunProfileBinding_modelRunId_ordinal_key"
  ON "KnowledgeRunProfileBinding" ("modelRunId", "ordinal");
CREATE UNIQUE INDEX "KnowledgeRunProfileBinding_modelRunId_profileRevisionId_key"
  ON "KnowledgeRunProfileBinding" ("modelRunId", "profileRevisionId");
CREATE INDEX "KnowledgeRunProfileBinding_profileRevisionId_idx"
  ON "KnowledgeRunProfileBinding" ("profileRevisionId");
CREATE INDEX "KnowledgeRunProfileBinding_embedding_model_idx"
  ON "KnowledgeRunProfileBinding" ("embeddingConnectionId", "embeddingProviderModelId");
CREATE INDEX "KnowledgeRunProfileBinding_credential_version_idx"
  ON "KnowledgeRunProfileBinding" ("embeddingCredentialId", "embeddingCredentialVersionId");

CREATE UNIQUE INDEX "KnowledgeRunSourceBinding_source_key"
  ON "KnowledgeRunSourceBinding" ("modelRunId", "sourceId", "sourceVersionId", "sourceArtifactId");
CREATE UNIQUE INDEX "KnowledgeRunSourceBinding_modelRunId_ordinal_key"
  ON "KnowledgeRunSourceBinding" ("modelRunId", "ordinal");
CREATE UNIQUE INDEX "KnowledgeRunSourceBinding_modelRunId_sourceAlias_key"
  ON "KnowledgeRunSourceBinding" ("modelRunId", "sourceAlias");
CREATE INDEX "KnowledgeRunSourceBinding_profileBindingId_idx"
  ON "KnowledgeRunSourceBinding" ("profileBindingId");
CREATE INDEX "KnowledgeRunSourceBinding_sourceId_sourceVersionId_idx"
  ON "KnowledgeRunSourceBinding" ("sourceId", "sourceVersionId");
CREATE INDEX "KnowledgeRunSourceBinding_sourceArtifactId_idx"
  ON "KnowledgeRunSourceBinding" ("sourceArtifactId");

CREATE UNIQUE INDEX "KnowledgeBudgetReservation_modelRunToolCallId_key"
  ON "KnowledgeBudgetReservation" ("modelRunToolCallId");
CREATE UNIQUE INDEX "KnowledgeBudgetReservation_modelRunId_id_key"
  ON "KnowledgeBudgetReservation" ("modelRunId", "id");
CREATE UNIQUE INDEX "KnowledgeBudgetReservation_modelRunId_modelRunToolCallId_key"
  ON "KnowledgeBudgetReservation" ("modelRunId", "modelRunToolCallId");
CREATE UNIQUE INDEX "KnowledgeBudgetReservation_modelRunId_modelRunToolCallId_id_key"
  ON "KnowledgeBudgetReservation" ("modelRunId", "modelRunToolCallId", "id");
CREATE UNIQUE INDEX "KnowledgeBudgetReservation_modelRunId_operationOrdinal_key"
  ON "KnowledgeBudgetReservation" ("modelRunId", "operationOrdinal");
CREATE UNIQUE INDEX "KnowledgeBudgetReservation_modelRunId_idempotencyKey_key"
  ON "KnowledgeBudgetReservation" ("modelRunId", "idempotencyKey");
CREATE INDEX "KnowledgeBudgetReservation_modelRunId_state_idx"
  ON "KnowledgeBudgetReservation" ("modelRunId", "state");
CREATE INDEX "KnowledgeBudgetReservation_state_leaseExpiresAt_idx"
  ON "KnowledgeBudgetReservation" ("state", "leaseExpiresAt");

CREATE UNIQUE INDEX "KnowledgeProviderAttempt_modelRunId_id_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "id");
CREATE UNIQUE INDEX "KnowledgeProviderAttempt_modelRunId_ordinal_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "ordinal");
CREATE UNIQUE INDEX "KnowledgeProviderAttempt_modelRunId_idempotencyKey_key"
  ON "KnowledgeProviderAttempt" ("modelRunId", "idempotencyKey");
CREATE INDEX "KnowledgeProviderAttempt_modelRunId_state_idx"
  ON "KnowledgeProviderAttempt" ("modelRunId", "state");
CREATE INDEX "KnowledgeProviderAttempt_state_leaseExpiresAt_idx"
  ON "KnowledgeProviderAttempt" ("state", "leaseExpiresAt");

CREATE UNIQUE INDEX "KnowledgeEvidenceDispatchManifest_providerAttemptId_key"
  ON "KnowledgeEvidenceDispatchManifest" ("providerAttemptId");
CREATE UNIQUE INDEX "KnowledgeEvidenceDispatchManifest_modelRunId_id_key"
  ON "KnowledgeEvidenceDispatchManifest" ("modelRunId", "id");
CREATE UNIQUE INDEX "KnowledgeEvidenceDispatchManifest_modelRunId_providerAttemp_key"
  ON "KnowledgeEvidenceDispatchManifest" ("modelRunId", "providerAttemptId");
CREATE INDEX "KnowledgeEvidenceDispatchManifest_modelRunId_createdAt_idx"
  ON "KnowledgeEvidenceDispatchManifest" ("modelRunId", "createdAt");
CREATE INDEX "KnowledgeEvidenceDispatchManifest_retrievalSessionId_idx"
  ON "KnowledgeEvidenceDispatchManifest" ("retrievalSessionId");

CREATE UNIQUE INDEX "KnowledgeEvidenceDispatchManifestItem_manifestId_ordinal_key"
  ON "KnowledgeEvidenceDispatchManifestItem" ("manifestId", "ordinal");
CREATE UNIQUE INDEX "KnowledgeEvidenceDispatchManifestItem_manifestId_evidenceIt_key"
  ON "KnowledgeEvidenceDispatchManifestItem" ("manifestId", "evidenceItemId");
CREATE INDEX "KnowledgeEvidenceDispatchManifestItem_evidenceItemId_idx"
  ON "KnowledgeEvidenceDispatchManifestItem" ("evidenceItemId");

CREATE UNIQUE INDEX "KnowledgeEvidenceDispatchManifestExclusion_manifestId_ordin_key"
  ON "KnowledgeEvidenceDispatchManifestExclusion" ("manifestId", "ordinal");
CREATE INDEX "KnowledgeEvidenceDispatchManifestExclusion_evidenceItemId_idx"
  ON "KnowledgeEvidenceDispatchManifestExclusion" ("evidenceItemId");

CREATE INDEX "ProjectKnowledgeSourceBinding_addedByUserId_idx"
  ON "ProjectKnowledgeSourceBinding" ("addedByUserId");
CREATE INDEX "ProjectKnowledgeSourceBinding_sourceId_idx"
  ON "ProjectKnowledgeSourceBinding" ("sourceId");

CREATE UNIQUE INDEX "KnowledgeRun_budgetReservationId_key"
  ON "KnowledgeRun" ("budgetReservationId");
CREATE UNIQUE INDEX "KnowledgeRun_modelRunId_budgetReservationId_key"
  ON "KnowledgeRun" ("modelRunId", "budgetReservationId");
CREATE UNIQUE INDEX "KnowledgeRun_modelRunId_modelRunToolCallId_budgetReservatio_key"
  ON "KnowledgeRun" ("modelRunId", "modelRunToolCallId", "budgetReservationId");
CREATE INDEX "KnowledgeRun_budgetReservationId_idx"
  ON "KnowledgeRun" ("budgetReservationId");
CREATE INDEX "KnowledgeRunBinding_profileBindingId_idx"
  ON "KnowledgeRunBinding" ("profileBindingId");

ALTER TABLE "KnowledgeRunProfileBinding"
  ADD CONSTRAINT "KnowledgeRunProfileBinding_modelRunId_fkey"
    FOREIGN KEY ("modelRunId") REFERENCES "ModelRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeRunProfileBinding_profileRevisionId_fkey"
    FOREIGN KEY ("profileRevisionId") REFERENCES "KnowledgeIndexProfileRevision" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeRunProfileBinding_credential_fkey"
    FOREIGN KEY ("embeddingConnectionId", "embeddingCredentialId") REFERENCES "ProviderCredential" ("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeRunProfileBinding_credentialVersion_fkey"
    FOREIGN KEY ("embeddingCredentialId", "embeddingCredentialVersionId") REFERENCES "ProviderCredentialVersion" ("credentialId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeRunProfileBinding_embeddingModel_fkey"
    FOREIGN KEY ("embeddingConnectionId", "embeddingProviderModelId") REFERENCES "ProviderModel" ("connectionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeRunSourceBinding"
  ADD CONSTRAINT "KnowledgeRunSourceBinding_modelRunId_fkey"
    FOREIGN KEY ("modelRunId") REFERENCES "ModelRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeRunSourceBinding_profile_fkey"
    FOREIGN KEY ("modelRunId", "profileBindingId") REFERENCES "KnowledgeRunProfileBinding" ("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeRunSourceBinding_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeRunSourceBinding_version_fkey"
    FOREIGN KEY ("sourceId", "sourceVersionId") REFERENCES "KnowledgeSourceVersion" ("sourceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeRunSourceBinding_artifact_fkey"
    FOREIGN KEY ("sourceVersionId", "sourceArtifactId") REFERENCES "KnowledgeSourceIndexArtifact" ("sourceVersionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeBudgetReservation"
  ADD CONSTRAINT "KnowledgeBudgetReservation_modelRunId_fkey"
    FOREIGN KEY ("modelRunId") REFERENCES "ModelRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeBudgetReservation_toolCall_fkey"
    FOREIGN KEY ("modelRunId", "modelRunToolCallId") REFERENCES "ModelRunToolCall" ("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeProviderAttempt"
  ADD CONSTRAINT "KnowledgeProviderAttempt_modelRunId_fkey"
    FOREIGN KEY ("modelRunId") REFERENCES "ModelRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeProviderAttempt_providerBinding_fkey"
    FOREIGN KEY ("modelRunId", "providerBindingKey") REFERENCES "ProviderRunBinding" ("modelRunId", "bindingKey") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeEvidenceDispatchManifest"
  ADD CONSTRAINT "KnowledgeEvidenceDispatchManifest_modelRunId_fkey"
    FOREIGN KEY ("modelRunId") REFERENCES "ModelRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeEvidenceDispatchManifest_retrievalSessionId_fkey"
    FOREIGN KEY ("retrievalSessionId") REFERENCES "KnowledgeRetrievalSession" ("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeEvidenceDispatchManifest_attempt_fkey"
    FOREIGN KEY ("modelRunId", "providerAttemptId") REFERENCES "KnowledgeProviderAttempt" ("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeEvidenceDispatchManifestItem"
  ADD CONSTRAINT "KnowledgeEvidenceDispatchManifestItem_manifestId_fkey"
    FOREIGN KEY ("manifestId") REFERENCES "KnowledgeEvidenceDispatchManifest" ("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeEvidenceDispatchManifestItem_evidenceItemId_fkey"
    FOREIGN KEY ("evidenceItemId") REFERENCES "KnowledgeEvidenceItem" ("id") ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeEvidenceDispatchManifestExclusion"
  ADD CONSTRAINT "KnowledgeEvidenceDispatchManifestExclusion_manifestId_fkey"
    FOREIGN KEY ("manifestId") REFERENCES "KnowledgeEvidenceDispatchManifest" ("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "KnowledgeEvidenceDispatchManifestExclusion_evidenceItemId_fkey"
    FOREIGN KEY ("evidenceItemId") REFERENCES "KnowledgeEvidenceItem" ("id") ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE "ProjectKnowledgeSourceBinding"
  ADD CONSTRAINT "ProjectKnowledgeSourceBinding_addedByUserId_fkey"
    FOREIGN KEY ("addedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectKnowledgeSourceBinding_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectKnowledgeSourceBinding_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "KnowledgeRunBinding"
  ADD CONSTRAINT "KnowledgeRunBinding_profile_fkey"
    FOREIGN KEY ("modelRunId", "profileBindingId") REFERENCES "KnowledgeRunProfileBinding" ("modelRunId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_budgetReservation_fkey"
    FOREIGN KEY ("modelRunId", "modelRunToolCallId", "budgetReservationId") REFERENCES "KnowledgeBudgetReservation" ("modelRunId", "modelRunToolCallId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION aiqsa_guard_knowledge_run_budget_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."receiptVersion" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "KnowledgeBudgetReservation" AS reservation
    WHERE reservation."id" = NEW."budgetReservationId"
      AND reservation."modelRunId" = NEW."modelRunId"
      AND reservation."modelRunToolCallId" = NEW."modelRunToolCallId"
      AND reservation."operationOrdinal" = NEW."invocationOrdinal"
      AND reservation."operation" = NEW."operation"
      AND reservation."state" = 'settled'
      AND reservation."receiptHash" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'knowledge_run_budget_receipt_unsettled';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "KnowledgeRun_budget_receipt_settled"
AFTER INSERT OR UPDATE OF
  "receiptVersion", "budgetReservationId", "modelRunId", "modelRunToolCallId",
  "invocationOrdinal", "operation"
ON "KnowledgeRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_run_budget_receipt();

CREATE OR REPLACE FUNCTION aiqsa_guard_knowledge_dispatch_manifest()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_state "KnowledgeProviderAttemptState";
  attempt_id text;
  evidence_retrieval_session_id text;
  manifest_id text;
  manifest_model_run_id text;
  manifest_retrieval_session_id text;
  model_run_exists boolean;
  session_model_run_id text;
BEGIN
  IF TG_TABLE_NAME = 'KnowledgeEvidenceDispatchManifest' THEN
    IF TG_OP = 'DELETE' THEN
      attempt_id := OLD."providerAttemptId";
      manifest_model_run_id := OLD."modelRunId";
      manifest_retrieval_session_id := OLD."retrievalSessionId";
    ELSE
      attempt_id := NEW."providerAttemptId";
      manifest_model_run_id := NEW."modelRunId";
      manifest_retrieval_session_id := NEW."retrievalSessionId";
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      manifest_id := OLD."manifestId";
    ELSE
      manifest_id := NEW."manifestId";
    END IF;
    SELECT
      manifest."providerAttemptId",
      manifest."modelRunId",
      manifest."retrievalSessionId"
      INTO attempt_id, manifest_model_run_id, manifest_retrieval_session_id
    FROM "KnowledgeEvidenceDispatchManifest" AS manifest
    WHERE manifest."id" = manifest_id;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF TG_TABLE_NAME = 'KnowledgeEvidenceDispatchManifest' THEN
      SELECT session."modelRunId"
        INTO session_model_run_id
      FROM "KnowledgeRetrievalSession" AS session
      WHERE session."id" = NEW."retrievalSessionId";

      IF session_model_run_id IS DISTINCT FROM NEW."modelRunId" THEN
        RAISE EXCEPTION 'knowledge_dispatch_manifest_scope_mismatch';
      END IF;
    ELSIF NEW."evidenceItemId" IS NOT NULL THEN
      SELECT evidence."retrievalSessionId"
        INTO evidence_retrieval_session_id
      FROM "KnowledgeEvidenceItem" AS evidence
      WHERE evidence."id" = NEW."evidenceItemId";

      IF evidence_retrieval_session_id IS DISTINCT FROM manifest_retrieval_session_id THEN
        RAISE EXCEPTION 'knowledge_dispatch_manifest_evidence_scope_mismatch';
      END IF;
    END IF;
  END IF;

  SELECT attempt."state"
    INTO attempt_state
  FROM "KnowledgeProviderAttempt" AS attempt
  WHERE attempt."id" = attempt_id;

  IF TG_OP = 'DELETE'
    AND current_setting('aiqsa.knowledge_purge', true) IS DISTINCT FROM 'on'
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM "ModelRun" AS model_run
      WHERE model_run."id" = manifest_model_run_id
    ) INTO model_run_exists;

    -- FK cascades run after their parent row is gone. They may remove immutable
    -- audit containers, while a direct delete of a live run's manifest remains
    -- blocked unless it uses the explicit Knowledge purge capability.
    IF attempt_state IS NULL OR NOT model_run_exists THEN
      RETURN OLD;
    END IF;
  END IF;

  IF attempt_state IS DISTINCT FROM 'reserved'
    AND current_setting('aiqsa.knowledge_purge', true) IS DISTINCT FROM 'on'
  THEN
    RAISE EXCEPTION 'knowledge_dispatch_manifest_immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KnowledgeEvidenceDispatchManifest_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeEvidenceDispatchManifest"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_dispatch_manifest();

CREATE TRIGGER "KnowledgeEvidenceDispatchManifestItem_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeEvidenceDispatchManifestItem"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_dispatch_manifest();

CREATE TRIGGER "KnowledgeEvidenceDispatchManifestExclusion_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "KnowledgeEvidenceDispatchManifestExclusion"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_dispatch_manifest();

-- Rollback boundary: old binaries may ignore the additive tables before any
-- H2-only direct Source is accepted. After H2 writes exist, rollback requires
-- draining writers and retaining these tables for forward recovery; do not
-- delete or rewrite historical receipts during rollback.
