-- Automatic fact extraction reads a long source message in pages and continues
-- a full observation packet on a later page instead of capping the source.
--
-- 1. Every provider observation keeps its content-free receipt, including
--    observations beyond one packet (rejected as overflow or outside the page),
--    up to the decoder's bounded packet of 64.
-- 2. A continuation page owns its own semantic-adjudication call. Page 0 keeps
--    the one call per source message shared with relation resolution; a later
--    page's reservation carries no message key and is bound to its page job,
--    whose idempotency fingerprint proves the page and source message.

ALTER TABLE "MemoryFactExtractionCandidateReceipt"
  DROP CONSTRAINT "MemoryFactExtractionCandidateReceipt_shape_check";

ALTER TABLE "MemoryFactExtractionCandidateReceipt"
  ADD CONSTRAINT "MemoryFactExtractionCandidateReceipt_shape_check" CHECK (
    "candidateOrdinal" BETWEEN 0 AND 63
    AND "candidateFingerprint" ~ '^[a-f0-9]{64}$'
    AND ("reasonCode" IS NULL OR
      "reasonCode" ~ '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$')
    AND (
      (
        "outcome" = 'PENDING'::"MemoryFactExtractionCandidateOutcome"
        AND "reasonCode" IS NULL
        AND "resultingFactId" IS NULL
        AND "resultingFactVersionId" IS NULL
        AND "resultingEvidenceId" IS NULL
      )
      OR (
        "outcome" = ANY (ARRAY[
          'APPLIED', 'REPLAY', 'REINFORCED', 'MERGED', 'SUPERSEDED'
        ]::"MemoryFactExtractionCandidateOutcome"[])
        AND "reasonCode" IS NULL
        AND "resultingFactId" IS NOT NULL
        AND "resultingFactVersionId" IS NOT NULL
        AND "resultingEvidenceId" IS NOT NULL
      )
      OR (
        "outcome" = ANY (ARRAY[
          'REJECTED', 'STALE', 'RETRYABLE_FAILED'
        ]::"MemoryFactExtractionCandidateOutcome"[])
        AND "reasonCode" IS NOT NULL
        AND "resultingFactId" IS NULL
        AND "resultingFactVersionId" IS NULL
        AND "resultingEvidenceId" IS NULL
      )
    )
  );

ALTER TABLE "MemoryAuxiliarySemanticCall"
  DROP CONSTRAINT "MemoryAuxiliarySemanticCall_source_kind_check";

ALTER TABLE "MemoryAuxiliarySemanticCall"
  ADD CONSTRAINT "MemoryAuxiliarySemanticCall_source_kind_check" CHECK (
    (
      "purpose" = 'EXPLICIT_FACT_EQUIVALENCE'
      AND "sourceMessageId" IS NULL AND "targetFactVersionId" IS NOT NULL
    ) OR (
      "purpose" <> 'EXPLICIT_FACT_EQUIVALENCE'
      AND "sourceMessageId" IS NOT NULL AND "targetFactVersionId" IS NULL
    ) OR (
      "purpose" = 'FACT_EXTRACTION_ADJUDICATION'
      AND "sourceMessageId" IS NULL AND "targetFactVersionId" IS NULL
    )
  );

-- The owner check admits a message-less reservation only for a continuation
-- page job of automatic extraction. Patch the live definition in place, as
-- earlier extraction guard migrations do, so admitted pipelines are retained.
DO $migration$
DECLARE
  function_definition text;
  patched_definition text;
BEGIN
  function_definition := pg_get_functiondef(
    'aiqsa_memory_auxiliary_semantic_call_guard()'::regprocedure
  );
  IF position('extract-facts:vnext:p' IN function_definition) = 0 THEN
    patched_definition := replace(
      function_definition,
      'AND job."sourceMessageId" = NEW."sourceMessageId";',
      'AND (job."sourceMessageId" = NEW."sourceMessageId" OR (' ||
        'NEW."sourceMessageId" IS NULL AND job."sourceMessageId" IS NOT NULL ' ||
        'AND job."idempotencyFingerprint" ~ ' ||
        '''^extract-facts:vnext:p[1-9][0-9]{0,2}\.[1-9][0-9]{0,9}:[a-f0-9]{64}$''));'
    );
    IF patched_definition = function_definition THEN
      RAISE EXCEPTION 'Memory auxiliary semantic call guard page extension failed';
    END IF;
    EXECUTE patched_definition;
  END IF;
END;
$migration$;
