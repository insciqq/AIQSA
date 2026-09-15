-- A forgotten source remains unavailable to history and new extraction.
-- Only exact, independently supported evidence retained by the forget
-- transaction may continue to attest a different existing fact.
ALTER TABLE "MemorySuppression"
  ADD COLUMN "preservedEvidenceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "MemorySuppression"
  ADD CONSTRAINT "MemorySuppression_preserved_evidence_check" CHECK (
    cardinality("preservedEvidenceIds") <= 256
    AND array_position("preservedEvidenceIds", NULL) IS NULL
    AND (cardinality("preservedEvidenceIds") = 0
      OR "scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope")
  );

CREATE FUNCTION aiqsa_memory_preserved_source_evidence_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(NEW."preservedEvidenceIds") AS preserved(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM "MemoryEvidence" AS evidence
      WHERE evidence."id" = preserved.id AND evidence."userId" = NEW."userId"
        AND evidence."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
        AND evidence."sourceRole" = 'user'
        AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
        AND evidence."chatId" = NEW."sourceChatId"
        AND evidence."messageId" = NEW."sourceMessageId"
        AND evidence."branchGeneration" = NEW."sourceBranchGeneration"
        AND evidence."evidenceFingerprint" IS NOT NULL
        AND evidence."sourceStartOffset" IS NOT NULL
        AND evidence."sourceEndOffset" IS NOT NULL
        AND evidence."sourceMessageContentHash" = evidence."safeSourceHash"
    )
  ) THEN
    RAISE EXCEPTION 'Preserved Memory evidence requires the exact owned source'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemorySuppression_preserved_source_guard"
BEFORE INSERT OR UPDATE OF "preservedEvidenceIds", "userId", "sourceChatId",
  "sourceMessageId", "sourceBranchGeneration" ON "MemorySuppression"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_preserved_source_evidence_guard();
