-- Large collection runs freeze immutable Base snapshots at admission and
-- materialize Source bindings only for Sources actually disclosed by bounded
-- retrieval. Historical runs retain the eager strategy.
ALTER TABLE "KnowledgeRunScope"
  ADD COLUMN "sourceBindingStrategy" VARCHAR(24) NOT NULL DEFAULT 'eager_v1';

ALTER TABLE "KnowledgeRunScope"
  ADD CONSTRAINT "KnowledgeRunScope_source_binding_strategy_check"
  CHECK ("sourceBindingStrategy" IN ('eager_v1', 'disclosed_v1'));

-- Operation-request V3 can bind a broad search to exact immutable Base
-- snapshots instead of serializing every Source id. V2 remains decode/recovery
-- compatible for already accepted reservations.
ALTER TABLE "KnowledgeBudgetReservation"
  DROP CONSTRAINT "KnowledgeBudgetReservation_request_check";

ALTER TABLE "KnowledgeBudgetReservation"
  ADD CONSTRAINT "KnowledgeBudgetReservation_request_check" CHECK (
    "operationOrdinal" BETWEEN 1 AND 256
    AND "phaseOrdinal" BETWEEN 0 AND 63
    AND "subqueryOrdinal" BETWEEN 0 AND 127
    AND "operation" IN (
      'automatic_search',
      'discover_sources',
      'find_exact',
      'read_source',
      'search_knowledge',
      'structured_analysis',
      'visual_analysis'
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
        AND ("operationRequest" ->> 'version') IN ('2', '3')
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
  ) NOT VALID;

ALTER TABLE "KnowledgeBudgetReservation"
  VALIDATE CONSTRAINT "KnowledgeBudgetReservation_request_check";
