-- A synthesis fingerprint is durable apply identity, not an extraction
-- receipt. PATTERN rows therefore prove authority through their exact
-- depth-one relations rather than direct Message evidence.

ALTER TABLE "MemoryFactVersion"
  DROP CONSTRAINT "MemoryFactVersion_synthesis_shape_check";

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_synthesis_shape_check" CHECK (
    (
      "modality" = 'PATTERN'::"MemoryFactModality"
      AND "sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
      AND "directness" = 'INFERRED'::"MemoryDirectness"
      AND "pipelineVersion" = 'memory-synthesis-v2'
      AND "ingestionFingerprint" ~ '^[a-f0-9]{64}$'
      AND "synthesisDepth" = 1
      AND "synthesisGeneration" >= 0
      AND "synthesisSourceSetFingerprint" ~ '^[a-f0-9]{64}$'
      AND "coreEligible" = FALSE
      AND "coreSalience" = 'NONE'::"MemoryCoreSalience"
    )
    OR (
      "modality" <> 'PATTERN'::"MemoryFactModality"
      AND "synthesisDepth" = 0
      AND "synthesisGeneration" IS NULL
      AND "synthesisSourceSetFingerprint" IS NULL
    )
  );

CREATE OR REPLACE FUNCTION aiqsa_memory_assert_vnext_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  checked_user_id TEXT;
  checked_version_id TEXT;
BEGIN
  checked_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."userId" ELSE NEW."userId" END;
  IF TG_TABLE_NAME = 'MemoryFactVersion' THEN
    checked_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
  ELSE
    checked_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."factVersionId" ELSE NEW."factVersionId" END;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "MemoryFactVersion" AS version
    WHERE version."userId" = checked_user_id
      AND version."id" = checked_version_id
      AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
      AND version."ingestionFingerprint" IS NOT NULL
      AND version."contentPurgedAt" IS NULL
      AND version."state"::text NOT IN ('RETRACTED', 'FORGOTTEN')
      AND NOT (
        version."modality" = 'PATTERN'::"MemoryFactModality"
        AND version."directness" = 'INFERRED'::"MemoryDirectness"
        AND version."pipelineVersion" = 'memory-synthesis-v2'
        AND version."synthesisDepth" = 1
        AND version."synthesisSourceSetFingerprint" IS NOT NULL
      )
  ) AND NOT EXISTS (
    SELECT 1
    FROM "MemoryEvidence" AS evidence
    WHERE evidence."userId" = checked_user_id
      AND evidence."factVersionId" = checked_version_id
      AND evidence."evidenceFingerprint" IS NOT NULL
      AND evidence."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
      AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
      AND evidence."sourceRole" = 'user'
  ) THEN
    RAISE EXCEPTION 'vNext automatic versions require exact direct-user evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;
