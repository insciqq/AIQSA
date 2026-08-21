-- The Basic Production cutover has no runtime consumer for the H4 strategy
-- DAG. Evidence v2, dispatch manifests, provider attempts, and citations are
-- independent records and remain intact. Pure semantic-shadow data has no
-- accepted-answer or citation consumer after the cutover and is removed.

-- Retrieval limits are now fixed executable constants. No accepted answer,
-- evidence, manifest, citation, recovery, or deletion record references this
-- former mutable installation singleton.
DROP TABLE "KnowledgePolicy";

DROP TRIGGER IF EXISTS "KnowledgeRun_strategy_step_evidence_guard"
  ON "KnowledgeRun";
ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT IF EXISTS "KnowledgeRun_strategy_step_evidence_check",
  DROP CONSTRAINT "KnowledgeRun_evidence_shape_check",
  DROP CONSTRAINT "KnowledgeRun_limits_check",
  DROP CONSTRAINT "KnowledgeRun_outcome_shape_check";

DROP TRIGGER IF EXISTS "KnowledgeStrategyStepDependency_acyclic"
  ON "KnowledgeStrategyStepDependency";
DROP TRIGGER IF EXISTS "KnowledgeStrategyStepDependency_guard"
  ON "KnowledgeStrategyStepDependency";
DROP TRIGGER IF EXISTS "KnowledgeStrategyMapOutput_guard"
  ON "KnowledgeStrategyMapOutput";
DROP TRIGGER IF EXISTS "KnowledgeStrategyStep_guard"
  ON "KnowledgeStrategyStep";
DROP TRIGGER IF EXISTS "KnowledgeStrategyExecution_guard"
  ON "KnowledgeStrategyExecution";

DROP FUNCTION IF EXISTS aiqsa_guard_knowledge_strategy_step_evidence();
DROP FUNCTION IF EXISTS knowledge_strategy_step_evidence_valid(jsonb);
DROP FUNCTION IF EXISTS aiqsa_guard_knowledge_strategy_dag_cycle();
DROP FUNCTION IF EXISTS aiqsa_guard_knowledge_strategy_dependency();
DROP FUNCTION IF EXISTS aiqsa_guard_knowledge_strategy_map_output();
DROP FUNCTION IF EXISTS aiqsa_guard_knowledge_strategy_step();
DROP FUNCTION IF EXISTS aiqsa_guard_knowledge_strategy_execution();

ALTER TABLE "KnowledgeRun"
  DROP COLUMN "strategyStepEvidence";

-- Ranking is fixed RRF. Planner-era threshold/reranker/novelty stop fields
-- are neither evidence nor recovery state and receive no new writes.
ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_read_receipt_operation_check",
  DROP COLUMN "threshold",
  DROP COLUMN "stopReason",
  DROP COLUMN "rerankerBinding",
  DROP COLUMN "preRerankOrder",
  DROP COLUMN "postRerankOrder";

DROP TABLE "KnowledgeStrategyStepDependency";
DROP TABLE "KnowledgeStrategyMapOutput";
DROP TABLE "KnowledgeStrategyStep";
DROP TABLE "KnowledgeStrategyExecution";

-- Semantic shadow results are qualification-only data. Historical H6 rows are
-- verified before this cleanup migration; no current runtime or deletion
-- path depends on retaining the table after the cutover.
DROP TABLE IF EXISTS "KnowledgeSemanticShadowResult";

-- The H6 validators existed only to qualify and guard the removed shadow
-- table. Remove their callable SQL surface as well; historical migrations
-- remain untouched for archaeology and upgrade ordering.
DROP FUNCTION IF EXISTS "guard_accepted_knowledge_semantic_shadow_result_write"();
DROP FUNCTION IF EXISTS "knowledge_semantic_profile_authorized_shadow_result_valid"(
  text, integer, text, text, text, integer, boolean, text, text[], jsonb,
  jsonb, text, timestamp without time zone, timestamp without time zone
);
DROP FUNCTION IF EXISTS "knowledge_semantic_validator_deployment_released"(jsonb);
DROP FUNCTION IF EXISTS "knowledge_semantic_validator_deployment_valid"(jsonb);
DROP FUNCTION IF EXISTS "knowledge_semantic_shadow_result_valid"(
  text, integer, text, text, text, integer, boolean, text, text[], jsonb,
  jsonb, text, timestamp without time zone, timestamp without time zone
);
DROP FUNCTION IF EXISTS "knowledge_semantic_zero_usage_valid"(jsonb);
DROP FUNCTION IF EXISTS "knowledge_semantic_count_record_valid"(
  jsonb, text[], integer, integer
);
DROP FUNCTION IF EXISTS "knowledge_semantic_string_array_valid"(
  jsonb, integer, integer, text
);
DROP FUNCTION IF EXISTS "knowledge_semantic_canonical_json"(jsonb);
DROP FUNCTION IF EXISTS "knowledge_semantic_profile_revision_ids_valid"(text[]);

-- Planner strategy and coverage snapshots are not evidence, citation, or
-- provider-attempt records. The focused request remains in originalIntent;
-- remove these obsolete current-write columns instead of dual-writing inert
-- planner shapes.
ALTER TABLE "KnowledgeRetrievalSession"
  DROP COLUMN "strategySnapshot",
  DROP COLUMN "coverageRequirements";

-- Structural answer settlement retains only exact status/outcome and hashes.
-- Planner-era claim/citation metrics and repair counters are not operational
-- evidence and have no current consumer.
ALTER TABLE "KnowledgeGroundingResult"
  DROP COLUMN "issues",
  DROP COLUMN "repairCount";

-- Current structural settlement accepts only the explicit answer states and
-- lowercase SHA-256 hashes. NOT VALID preserves any older accepted rows whose
-- historical outcome vocabulary predates the Basic contract while fencing all
-- new inserts and ordinary updates at the database boundary.
ALTER TABLE "KnowledgeGroundingResult"
  ADD CONSTRAINT "KnowledgeGroundingResult_basic_shape_check" CHECK (
    "outcome" IN ('answered', 'insufficient_evidence')
    AND btrim("originalAnswerHash") ~ '^[0-9a-f]{64}$'
    AND btrim("finalAnswerHash") ~ '^[0-9a-f]{64}$'
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_query_check",
  ALTER COLUMN "query" TYPE text;

-- Removing the H4 marker requires marker-free compatibility constraints.
-- They deliberately retain every historically accepted receipt shape; the
-- focused triggers below enforce 40/8/weighted_rrf_v2 for all new focused
-- checkpoints without rewriting immutable operation receipts. NOT VALID is
-- intentional: new writes are fenced while deployment never scans or rejects
-- an immutable historical receipt accepted by an older runtime.
ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_evidence_shape_check" CHECK (
    jsonb_typeof("baseEvidence") = 'array'
    AND jsonb_array_length("baseEvidence") BETWEEN 1 AND 3
    AND jsonb_typeof("results") = 'array'
    AND jsonb_array_length("results") <= 100
    AND jsonb_typeof("embeddingUsage") = 'array'
    AND jsonb_array_length("embeddingUsage") <= 3
    AND octet_length("providerText") BETWEEN 1 AND 49152
  ) NOT VALID,
  ADD CONSTRAINT "KnowledgeRun_limits_check" CHECK (
    "invocationOrdinal" BETWEEN 1 AND 256
    AND "candidateLimit" BETWEEN 1 AND 100
    AND "resultLimit" BETWEEN 1 AND 100
    AND "candidateLimit" >= "resultLimit"
    AND "candidateCount" >= 0
    AND "durationMs" >= 0
    AND CASE
      WHEN "operation" IN ('find_exact', 'discover_sources')
        THEN "fusion" = 'none'
      ELSE "fusion" IN ('rrf_k60', 'weighted_rrf_v2')
    END
  ) NOT VALID,
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
        jsonb_array_length("results") BETWEEN 1 AND "resultLimit"
      ELSE jsonb_array_length("results") = 0
    END
  ) NOT VALID,
  -- Historical analysis receipts remain decode-only, except that permanent
  -- deletion must still be able to replace their private request/receipt with
  -- the canonical value-free tombstone.
  ADD CONSTRAINT "KnowledgeRun_read_receipt_operation_check" CHECK (
    (
      "operation" NOT IN ('structured_analysis', 'visual_analysis')
      OR (
        "operation" IN ('structured_analysis', 'visual_analysis')
        AND "query" = 'deleted_knowledge_resource'
        AND "readReceipt" IS NULL
      )
    )
    AND (
      "readReceipt" IS NULL
      OR (CASE "operation"
        WHEN 'read_source' THEN
          knowledge_read_source_receipt_valid_v2("query", "readReceipt")
        WHEN 'find_exact' THEN (
          knowledge_exact_receipt_valid("query", "readReceipt")
          AND "candidateLimit" = ("readReceipt" ->> 'limit')::INTEGER
          AND "resultLimit" = ("readReceipt" ->> 'limit')::INTEGER
          AND "candidateCount" = jsonb_array_length("readReceipt" -> 'matches')
          AND jsonb_array_length("results") =
            jsonb_array_length("readReceipt" -> 'matches')
          AND "fusion" = 'none'
          AND "embeddingUsage" = '[]'::jsonb
        )
        WHEN 'discover_sources' THEN (
          knowledge_discovery_receipt_valid("query", "readReceipt")
          AND "candidateLimit" = ("readReceipt" ->> 'limit')::INTEGER
          AND "resultLimit" = ("readReceipt" ->> 'limit')::INTEGER
          AND "candidateCount" = jsonb_array_length("readReceipt" -> 'sources')
          AND "results" = '[]'::jsonb
          AND "fusion" = 'none'
          AND "embeddingUsage" = '[]'::jsonb
        )
        ELSE false
      END) IS TRUE
    )
  ) NOT VALID;

-- Reservation rows remain the concurrency/idempotency/side-effect checkpoint.
-- Planner-era reranker, semantic-validation, and repair counters never affect
-- replay safety, accepted evidence, citations, or deletion, so remove them
-- instead of keeping permanent zero-valued current writes.
ALTER TABLE "KnowledgeBudgetReservation"
  DROP CONSTRAINT "KnowledgeBudgetReservation_usage_check",
  DROP CONSTRAINT "KnowledgeBudgetReservation_state_check",
  DROP COLUMN "estimatedRerankerCalls",
  DROP COLUMN "estimatedValidationSlots",
  DROP COLUMN "estimatedRepairSlots",
  DROP COLUMN "actualRerankerCalls",
  DROP COLUMN "actualValidationSlots",
  DROP COLUMN "actualRepairSlots",
  ADD CONSTRAINT "KnowledgeBudgetReservation_usage_check" CHECK (
    "estimatedCandidates" >= 0
    AND "estimatedRetrievedTokens" >= 0
    AND "estimatedEmbeddingCalls" >= 0
    AND "estimatedLatencyMs" >= 0
    AND "estimatedCostMicros" >= 0
    AND ("actualCandidates" IS NULL OR "actualCandidates" >= 0)
    AND ("actualRetrievedTokens" IS NULL OR "actualRetrievedTokens" >= 0)
    AND ("actualEmbeddingCalls" IS NULL OR "actualEmbeddingCalls" >= 0)
    AND ("actualLatencyMs" IS NULL OR "actualLatencyMs" >= 0)
    AND ("actualCostMicros" IS NULL OR "actualCostMicros" >= 0)
    AND ("receiptHash" IS NULL OR "receiptHash" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "KnowledgeBudgetReservation_state_check" CHECK ((
    CASE "state"
      WHEN 'reserved' THEN
        "dispatchedAt" IS NULL AND "settledAt" IS NULL AND "releasedAt" IS NULL
        AND "ambiguousAt" IS NULL AND "expiredAt" IS NULL
        AND "dispatchAttemptKey" IS NULL AND "receiptHash" IS NULL
        AND "failureCode" IS NULL
        AND "actualCandidates" IS NULL AND "actualRetrievedTokens" IS NULL
        AND "actualEmbeddingCalls" IS NULL AND "actualLatencyMs" IS NULL
        AND "actualCostMicros" IS NULL
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
        AND "actualEmbeddingCalls" IS NULL AND "actualLatencyMs" IS NULL
        AND "actualCostMicros" IS NULL
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
        AND "releasedAt" IS NULL AND "leaseToken" IS NULL
        AND "leaseExpiresAt" IS NULL AND "failureCode" IS NULL
        AND "ambiguousAt" IS NULL AND "expiredAt" IS NULL
        AND "actualCandidates" IS NOT NULL AND "actualRetrievedTokens" IS NOT NULL
        AND "actualEmbeddingCalls" IS NOT NULL AND "actualLatencyMs" IS NOT NULL
        AND "actualCostMicros" IS NOT NULL
        AND (
          "purgedAt" IS NOT NULL
          OR (
            "dispatchAttemptKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$'
            AND "receiptHash" ~ '^[0-9a-f]{64}$'
          )
        )
      WHEN 'released' THEN
        "dispatchedAt" IS NULL AND "settledAt" IS NULL
        AND "releasedAt" IS NOT NULL AND "ambiguousAt" IS NULL
        AND "expiredAt" IS NULL AND "releasedAt" >= "createdAt"
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        AND "dispatchAttemptKey" IS NULL AND "receiptHash" IS NULL
        AND "actualCandidates" IS NULL AND "actualRetrievedTokens" IS NULL
        AND "actualEmbeddingCalls" IS NULL AND "actualLatencyMs" IS NULL
        AND "actualCostMicros" IS NULL
        AND (
          "purgedAt" IS NOT NULL
          OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$'
        )
      WHEN 'ambiguous' THEN
        "dispatchedAt" >= "createdAt" AND "ambiguousAt" >= "dispatchedAt"
        AND "settledAt" IS NULL AND "releasedAt" IS NULL AND "expiredAt" IS NULL
        AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL AND "receiptHash" IS NULL
        AND "actualCandidates" IS NULL AND "actualRetrievedTokens" IS NULL
        AND "actualEmbeddingCalls" IS NULL AND "actualLatencyMs" IS NULL
        AND "actualCostMicros" IS NULL
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
        AND "actualEmbeddingCalls" IS NULL AND "actualLatencyMs" IS NULL
        AND "actualCostMicros" IS NULL
        AND (
          "purgedAt" IS NOT NULL
          OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$'
        )
      ELSE false
    END
  ) IS TRUE),
  -- Grandfathered analysis reservations may only cross the Basic fence while
  -- becoming the exact content-free tombstone accepted by request_check.
  ADD CONSTRAINT "KnowledgeBudgetReservation_basic_operation_check" CHECK (
    "operation" NOT IN ('structured_analysis', 'visual_analysis')
    OR (
      "operation" IN ('structured_analysis', 'visual_analysis')
      AND "purgedAt" IS NOT NULL
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
  ) NOT VALID;

-- Some pre-production installations carried the earlier two-column
-- reservation FK and lost the deferred settlement trigger during iterative
-- schema work. Re-establish the exact receipt identity without rewriting
-- accepted rows: NOT VALID preserves historical data while fencing every new
-- write, and the deferred trigger permits receipt + settlement in one
-- transaction.
CREATE UNIQUE INDEX IF NOT EXISTS
  "KnowledgeBudgetReservation_modelRunId_modelRunToolCallId_id_key"
ON "KnowledgeBudgetReservation" ("modelRunId", "modelRunToolCallId", id);

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT IF EXISTS "KnowledgeRun_budgetReservation_fkey",
  ADD CONSTRAINT "KnowledgeRun_budgetReservation_fkey"
    FOREIGN KEY ("modelRunId", "modelRunToolCallId", "budgetReservationId")
    REFERENCES "KnowledgeBudgetReservation" ("modelRunId", "modelRunToolCallId", id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
    NOT VALID;

DROP TRIGGER IF EXISTS "KnowledgeRun_budget_receipt_settled" ON "KnowledgeRun";
DROP FUNCTION IF EXISTS aiqsa_guard_knowledge_run_budget_receipt();

CREATE FUNCTION aiqsa_guard_knowledge_run_budget_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."receiptVersion" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "KnowledgeBudgetReservation" AS reservation
    WHERE reservation.id = NEW."budgetReservationId"
      AND reservation."modelRunId" = NEW."modelRunId"
      AND reservation."modelRunToolCallId" = NEW."modelRunToolCallId"
      AND reservation."operationOrdinal" = NEW."invocationOrdinal"
      AND reservation.operation = NEW.operation
      AND reservation.state = 'settled'
      AND reservation."receiptHash" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'knowledge_run_budget_receipt_unsettled';
  END IF;

  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER "KnowledgeRun_budget_receipt_settled"
AFTER INSERT OR UPDATE OF
  "receiptVersion", "budgetReservationId", "modelRunId", "modelRunToolCallId",
  "invocationOrdinal", operation
ON "KnowledgeRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_run_budget_receipt();

-- The focused operation is an internal server-side checkpoint, not a
-- provider-visible tool. Legacy receipts and the exact/read/discover
-- primitives keep their historical shapes; every new focused checkpoint is
-- pinned to the Basic request constants.
CREATE FUNCTION aiqsa_guard_knowledge_basic_focused_run()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  checkpoint_name text;
BEGIN
  SELECT tool_call."toolName"
  INTO checkpoint_name
  FROM "ModelRunToolCall" AS tool_call
  WHERE tool_call."modelRunId" = NEW."modelRunId"
    AND tool_call.id = NEW."modelRunToolCallId";

  IF checkpoint_name = 'knowledge_focused_v1' AND (
    NEW.operation IS DISTINCT FROM 'automatic_search'
    OR NEW.outcome NOT IN ('complete', 'base_empty', 'base_indexing')
    OR char_length(btrim(NEW.query, E' \n')) NOT BETWEEN 1 AND 3000
    OR translate(NEW.query, chr(10), '') ~ '[[:cntrl:]]'
    OR NEW."candidateLimit" IS DISTINCT FROM 40
    OR NEW."resultLimit" IS DISTINCT FROM 8
    OR NEW.fusion IS DISTINCT FROM 'weighted_rrf_v2'
  ) THEN
    RAISE EXCEPTION 'knowledge_basic_focused_run_contract_invalid';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION aiqsa_guard_knowledge_basic_focused_tool_call()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."toolName" = 'knowledge_focused_v1' AND EXISTS (
    SELECT 1
    FROM "KnowledgeRun" AS knowledge_run
    WHERE knowledge_run."modelRunId" = NEW."modelRunId"
      AND knowledge_run."modelRunToolCallId" = NEW.id
      AND (
        knowledge_run.operation IS DISTINCT FROM 'automatic_search'
        OR knowledge_run.outcome NOT IN ('complete', 'base_empty', 'base_indexing')
        OR char_length(btrim(knowledge_run.query, E' \n')) NOT BETWEEN 1 AND 3000
        OR translate(knowledge_run.query, chr(10), '') ~ '[[:cntrl:]]'
        OR knowledge_run."candidateLimit" IS DISTINCT FROM 40
        OR knowledge_run."resultLimit" IS DISTINCT FROM 8
        OR knowledge_run.fusion IS DISTINCT FROM 'weighted_rrf_v2'
      )
  ) THEN
    RAISE EXCEPTION 'knowledge_basic_focused_run_contract_invalid';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "KnowledgeRun_basic_focused_guard"
BEFORE INSERT OR UPDATE OF
  "modelRunId", "modelRunToolCallId", operation, outcome, query, "candidateLimit",
  "resultLimit", fusion
ON "KnowledgeRun"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_basic_focused_run();

CREATE TRIGGER "ModelRunToolCall_basic_focused_guard"
BEFORE INSERT OR UPDATE OF id, "modelRunId", "toolName"
ON "ModelRunToolCall"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_basic_focused_tool_call();
