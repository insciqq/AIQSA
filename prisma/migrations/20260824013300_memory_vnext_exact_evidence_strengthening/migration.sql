-- Exact-message evidence is not exact unless both owning source identifiers
-- are present. Also recheck the deferred evidence invariant whenever a
-- previously retracted vNext version is made semantically live again.

ALTER TABLE "MemoryEvidence"
  DROP CONSTRAINT "MemoryEvidence_exact_provenance_check";

ALTER TABLE "MemoryEvidence"
  ADD CONSTRAINT "MemoryEvidence_exact_provenance_check" CHECK (
    (
      "evidenceFingerprint" IS NULL
      AND num_nonnulls(
        "sourceStartOffset",
        "sourceEndOffset",
        "sourceMessageContentHash"
      ) = 0
    )
    OR (
      "evidenceFingerprint" IS NOT NULL
      AND "chatId" IS NOT NULL
      AND "messageId" IS NOT NULL
      AND num_nonnulls(
        "sourceStartOffset",
        "sourceEndOffset",
        "sourceMessageContentHash"
      ) = 3
      AND "evidenceFingerprint"::text ~ '^[a-f0-9]{64}$'::text
      AND "sourceMessageContentHash"::text ~ '^[a-f0-9]{64}$'::text
      AND "safeSourceHash" = "sourceMessageContentHash"
      AND "sourceStartOffset" >= 0
      AND "sourceEndOffset" > "sourceStartOffset"
      AND "sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
      AND "stance" = 'SUPPORTS'::"MemoryEvidenceStance"
      AND "sourceRole" = 'user'
    )
  );

DROP TRIGGER IF EXISTS "MemoryFactVersion_vnext_evidence_assert"
ON "MemoryFactVersion";

CREATE CONSTRAINT TRIGGER "MemoryFactVersion_vnext_evidence_assert"
AFTER INSERT OR UPDATE OF
  "ingestionFingerprint", "sourceMode", "contentPurgedAt", "state"
ON "MemoryFactVersion"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_assert_vnext_evidence();
