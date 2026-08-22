-- The retired-operation fence introduced while validating the Basic Knowledge
-- constraints was narrower than the permanent-deletion processor. In
-- particular, real historical successful analysis receipts preserve their
-- result count, optionally preserve valid citation handles, and source deletion
-- leaves already-admitted Base evidence unchanged. Keep INSERTs closed while
-- admitting only that content-nonexpanding purge transition.

CREATE OR REPLACE FUNCTION aiqsa_guard_knowledge_run_retired_operation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  expected_provider_text TEXT;
  old_result JSONB;
  provider_lines TEXT[] := ARRAY[]::TEXT[];
  result_handle TEXT;
  result_ordinal BIGINT;
  tombstoned_result JSONB;
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

    IF COALESCE(current_setting('aiqsa.knowledge_purge', true), '') <> 'on'
      OR NEW.operation <> OLD.operation
      OR NEW.query <> 'deleted_knowledge_resource'
      OR NEW."readReceipt" IS NOT NULL
      OR jsonb_typeof(OLD."baseEvidence") IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW."baseEvidence") IS DISTINCT FROM 'array'
      OR jsonb_array_length(NEW."baseEvidence") NOT BETWEEN 1
        AND jsonb_array_length(OLD."baseEvidence")
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW."baseEvidence") AS next_evidence(value)
        WHERE next_evidence.value <> '{"deleted":true}'::JSONB
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(OLD."baseEvidence") AS old_evidence(value)
            WHERE old_evidence.value = next_evidence.value
          )
      )
      OR jsonb_typeof(OLD.results) IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW.results) IS DISTINCT FROM 'array'
      OR jsonb_array_length(NEW.results) <> jsonb_array_length(OLD.results)
      OR (
        to_jsonb(NEW) - ARRAY[
          'query', 'baseEvidence', 'results', 'providerText', 'readReceipt', 'updatedAt'
        ]::TEXT[]
      ) <> (
        to_jsonb(OLD) - ARRAY[
          'query', 'baseEvidence', 'results', 'providerText', 'readReceipt', 'updatedAt'
        ]::TEXT[]
      )
    THEN
      RAISE EXCEPTION 'KnowledgeRun_read_receipt_operation_check';
    END IF;

    FOR tombstoned_result, result_ordinal IN
      SELECT result.value, result.ordinality
      FROM jsonb_array_elements(NEW.results)
        WITH ORDINALITY AS result(value, ordinality)
    LOOP
      old_result := OLD.results -> ((result_ordinal - 1)::INTEGER);

      IF tombstoned_result = '{"deleted":true}'::JSONB THEN
        CONTINUE;
      END IF;

      result_handle := tombstoned_result ->> 'handle';
      IF tombstoned_result IS DISTINCT FROM jsonb_build_object(
          'deleted', true,
          'handle', result_handle
        )
        OR result_handle IS DISTINCT FROM (old_result ->> 'handle')
        OR NOT (CASE
          WHEN result_handle ~ '^K[1-9][0-9]{0,3}$' THEN
            substring(result_handle FROM 2)::INTEGER <= 2048
          WHEN result_handle ~ '^K[1-9][0-9]{0,2}[.][1-9][0-9]?$' THEN
            split_part(substring(result_handle FROM 2), '.', 1)::INTEGER <= 256
            AND split_part(substring(result_handle FROM 2), '.', 2)::INTEGER <= 8
          ELSE false
        END)
      THEN
        RAISE EXCEPTION 'KnowledgeRun_read_receipt_operation_check';
      END IF;

      provider_lines := array_append(
        provider_lines,
        format('[%s] Deleted Knowledge source.', result_handle)
      );
    END LOOP;

    expected_provider_text := CASE cardinality(provider_lines)
      WHEN 0 THEN 'Knowledge citation evidence was deleted.'
      ELSE 'Knowledge passages:' || E'\n\n' || array_to_string(provider_lines, E'\n\n')
    END;
    IF NEW."providerText" IS DISTINCT FROM expected_provider_text THEN
      RAISE EXCEPTION 'KnowledgeRun_read_receipt_operation_check';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END
$function$;
