-- The Basic Knowledge cutover added these constraints as NOT VALID to fence
-- concurrent writes without scanning retained receipts in the same migration.
-- Two of those fences deliberately excluded decode-only structured/visual
-- receipts that an older runtime had already accepted. Preserve those rows,
-- keep new retired-operation writes closed with transition guards, and make
-- the repository's no-unvalidated-constraints integrity contract true.

CREATE FUNCTION aiqsa_guard_knowledge_run_retired_operation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
    AND NEW.operation IN ('structured_analysis', 'visual_analysis')
  THEN
    RAISE EXCEPTION 'KnowledgeRun_read_receipt_operation_check';
  END IF;

  IF TG_OP = 'UPDATE'
    AND (
      OLD.operation IN ('structured_analysis', 'visual_analysis')
      OR NEW.operation IN ('structured_analysis', 'visual_analysis')
    )
  THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN
      RETURN NEW;
    END IF;

    IF COALESCE(current_setting('aiqsa.knowledge_purge', true), '') = 'on'
      AND NEW.operation = OLD.operation
      AND NEW.query = 'deleted_knowledge_resource'
      AND NEW."readReceipt" IS NULL
      AND NEW."baseEvidence" = '[{"deleted":true}]'::jsonb
      AND (
        (
          NEW.operation = 'visual_analysis'
          AND NEW.results = '[{"deleted":true}]'::jsonb
        )
        OR (
          NEW.operation = 'structured_analysis'
          AND NEW.results = '[]'::jsonb
        )
      )
      AND NEW."providerText" = 'Knowledge citation evidence was deleted.'
      AND (
        to_jsonb(NEW) - ARRAY[
          'query', 'baseEvidence', 'results', 'providerText', 'readReceipt', 'updatedAt'
        ]::text[]
      ) = (
        to_jsonb(OLD) - ARRAY[
          'query', 'baseEvidence', 'results', 'providerText', 'readReceipt', 'updatedAt'
        ]::text[]
      )
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'KnowledgeRun_read_receipt_operation_check';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER "KnowledgeRun_retired_operation_guard"
BEFORE INSERT OR UPDATE ON "KnowledgeRun"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_run_retired_operation();

CREATE FUNCTION aiqsa_guard_knowledge_budget_retired_operation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
    AND NEW.operation IN ('structured_analysis', 'visual_analysis')
  THEN
    RAISE EXCEPTION 'KnowledgeBudgetReservation_basic_operation_check';
  END IF;

  IF TG_OP = 'UPDATE'
    AND (
      OLD.operation IN ('structured_analysis', 'visual_analysis')
      OR NEW.operation IN ('structured_analysis', 'visual_analysis')
    )
  THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN
      RETURN NEW;
    END IF;

    IF COALESCE(current_setting('aiqsa.knowledge_purge', true), '') = 'on'
      AND NEW.operation = OLD.operation
      AND NEW."purgedAt" IS NOT NULL
      AND NEW."purgedAt" >= NEW."createdAt"
      AND NEW."idempotencyKey" IS NULL
      AND NEW."operationRequest" IS NULL
      AND NEW."operationRequestHash" IS NULL
      AND NEW."leaseToken" IS NULL
      AND NEW."leaseExpiresAt" IS NULL
      AND NEW."dispatchAttemptKey" IS NULL
      AND NEW."receiptHash" IS NULL
      AND NEW."failureCode" IS NULL
      AND (
        to_jsonb(NEW) - ARRAY[
          'dispatchAttemptKey', 'failureCode', 'idempotencyKey', 'leaseExpiresAt',
          'leaseToken', 'operationRequest', 'operationRequestHash', 'purgedAt',
          'receiptHash', 'updatedAt'
        ]::text[]
      ) = (
        to_jsonb(OLD) - ARRAY[
          'dispatchAttemptKey', 'failureCode', 'idempotencyKey', 'leaseExpiresAt',
          'leaseToken', 'operationRequest', 'operationRequestHash', 'purgedAt',
          'receiptHash', 'updatedAt'
        ]::text[]
      )
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'KnowledgeBudgetReservation_basic_operation_check';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER "KnowledgeBudgetReservation_retired_operation_guard"
BEFORE INSERT OR UPDATE ON "KnowledgeBudgetReservation"
FOR EACH ROW EXECUTE FUNCTION aiqsa_guard_knowledge_budget_retired_operation();

-- The validated checks describe both retained historical rows and their only
-- allowed mutation: an explicit, content-free purge tombstone. The guards
-- above distinguish those retained rows from new writes.
ALTER TABLE "KnowledgeBudgetReservation"
  DROP CONSTRAINT "KnowledgeBudgetReservation_basic_operation_check",
  ADD CONSTRAINT "KnowledgeBudgetReservation_basic_operation_check" CHECK (
    operation NOT IN ('structured_analysis', 'visual_analysis')
    OR (
      operation IN ('structured_analysis', 'visual_analysis')
      AND (
        "purgedAt" IS NULL
        OR (
          "purgedAt" >= "createdAt"
          AND "idempotencyKey" IS NULL
          AND "operationRequest" IS NULL
          AND "operationRequestHash" IS NULL
          AND "leaseToken" IS NULL
          AND "leaseExpiresAt" IS NULL
          AND "dispatchAttemptKey" IS NULL
          AND "receiptHash" IS NULL
          AND "failureCode" IS NULL
        )
      )
    )
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_read_receipt_operation_check",
  ADD CONSTRAINT "KnowledgeRun_read_receipt_operation_check" CHECK (
    (
      operation IN ('structured_analysis', 'visual_analysis')
      AND (
        query <> 'deleted_knowledge_resource'
        OR "readReceipt" IS NULL
      )
    )
    OR (
      operation NOT IN ('structured_analysis', 'visual_analysis')
      AND (
        "readReceipt" IS NULL
        OR (CASE operation
          WHEN 'read_source' THEN
            knowledge_read_source_receipt_valid_v2(query, "readReceipt")
          WHEN 'find_exact' THEN (
            knowledge_exact_receipt_valid(query, "readReceipt")
            AND "candidateLimit" = ("readReceipt" ->> 'limit')::integer
            AND "resultLimit" = ("readReceipt" ->> 'limit')::integer
            AND "candidateCount" = jsonb_array_length("readReceipt" -> 'matches')
            AND jsonb_array_length(results) =
              jsonb_array_length("readReceipt" -> 'matches')
            AND fusion = 'none'
            AND "embeddingUsage" = '[]'::jsonb
          )
          WHEN 'discover_sources' THEN (
            knowledge_discovery_receipt_valid(query, "readReceipt")
            AND "candidateLimit" = ("readReceipt" ->> 'limit')::integer
            AND "resultLimit" = ("readReceipt" ->> 'limit')::integer
            AND "candidateCount" = jsonb_array_length("readReceipt" -> 'sources')
            AND results = '[]'::jsonb
            AND fusion = 'none'
            AND "embeddingUsage" = '[]'::jsonb
          )
          ELSE false
        END) IS TRUE
      )
    )
  ) NOT VALID;

ALTER TABLE "KnowledgeBudgetReservation"
  VALIDATE CONSTRAINT "KnowledgeBudgetReservation_basic_operation_check";

ALTER TABLE "KnowledgeGroundingResult"
  VALIDATE CONSTRAINT "KnowledgeGroundingResult_basic_shape_check";

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_budgetReservation_fkey";

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_evidence_shape_check";

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_limits_check";

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_outcome_shape_check";

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_read_receipt_operation_check";
