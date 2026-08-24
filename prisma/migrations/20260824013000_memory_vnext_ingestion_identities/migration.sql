-- Bind every new vNext automatic observation to immutable exact-message
-- provenance. Existing preliminary vNext rows remain nullable and therefore
-- explicitly unverified until a later audited backfill/cutover.

ALTER TABLE "MemoryFactVersion"
  ADD COLUMN "ingestionFingerprint" VARCHAR(128);

ALTER TABLE "MemoryEvidence"
  ADD COLUMN "sourceStartOffset" INTEGER,
  ADD COLUMN "sourceEndOffset" INTEGER,
  ADD COLUMN "sourceMessageContentHash" VARCHAR(128),
  ADD COLUMN "evidenceFingerprint" VARCHAR(128);

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_ingestion_fingerprint_check" CHECK (
    "ingestionFingerprint" IS NULL
    OR "ingestionFingerprint"::text ~ '^[a-f0-9]{64}$'::text
  );

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

CREATE UNIQUE INDEX "MemoryFactVersion_ingestion_fingerprint_idx"
  ON "MemoryFactVersion"("userId", "ingestionFingerprint")
  WHERE "ingestionFingerprint" IS NOT NULL;

CREATE UNIQUE INDEX "MemoryEvidence_evidence_fingerprint_idx"
  ON "MemoryEvidence"("userId", "evidenceFingerprint")
  WHERE "evidenceFingerprint" IS NOT NULL;

CREATE OR REPLACE FUNCTION aiqsa_memory_vnext_provenance_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'MemoryFactVersion' THEN
    IF TG_OP = 'UPDATE'
       AND OLD."ingestionFingerprint" IS NOT NULL
       AND NEW."ingestionFingerprint" IS DISTINCT FROM OLD."ingestionFingerprint" THEN
      RAISE EXCEPTION 'MemoryFactVersion.ingestionFingerprint is immutable once assigned'
        USING ERRCODE = '23514';
    END IF;

    IF NEW."ingestionFingerprint" IS NOT NULL
       AND (
         NEW."sourceMode" <> 'AUTOMATIC'::"MemoryFactSourceMode"
         OR NEW."observedAt" IS NULL
       ) THEN
      RAISE EXCEPTION 'MemoryFactVersion ingestion provenance requires an observed automatic source'
        USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT'
       AND NEW."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
       AND NEW."pipelineVersion" = 'memory-fact-extraction-vnext-v1'
       AND NEW."ingestionFingerprint" IS NULL THEN
      RAISE EXCEPTION 'new vNext automatic versions require an ingestion fingerprint'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE'
       AND OLD."evidenceFingerprint" IS NOT NULL
       AND (
         NEW."userId",
         NEW."factVersionId",
         NEW."stance",
         NEW."sourceType",
         NEW."chatId",
         NEW."messageId",
         NEW."branchGeneration",
         NEW."sourceRole",
         NEW."sourceStartOffset",
         NEW."sourceEndOffset",
         NEW."sourceMessageContentHash",
         NEW."evidenceFingerprint",
         NEW."safeExcerpt",
         NEW."safeSourceHash",
         NEW."sourceProjectionVersion",
         NEW."observedAt"
       ) IS DISTINCT FROM (
         OLD."userId",
         OLD."factVersionId",
         OLD."stance",
         OLD."sourceType",
         OLD."chatId",
         OLD."messageId",
         OLD."branchGeneration",
         OLD."sourceRole",
         OLD."sourceStartOffset",
         OLD."sourceEndOffset",
         OLD."sourceMessageContentHash",
         OLD."evidenceFingerprint",
         OLD."safeExcerpt",
         OLD."safeSourceHash",
         OLD."sourceProjectionVersion",
         OLD."observedAt"
       ) THEN
      RAISE EXCEPTION 'MemoryEvidence exact provenance is immutable once assigned'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS "MemoryFactVersion_vnext_provenance_guard"
ON "MemoryFactVersion";

CREATE TRIGGER "MemoryFactVersion_vnext_provenance_guard"
BEFORE INSERT OR UPDATE OF
  "ingestionFingerprint", "sourceMode", "observedAt", "pipelineVersion"
ON "MemoryFactVersion"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_vnext_provenance_guard();

DROP TRIGGER IF EXISTS "MemoryEvidence_vnext_provenance_guard"
ON "MemoryEvidence";

CREATE TRIGGER "MemoryEvidence_vnext_provenance_guard"
BEFORE UPDATE OF
  "userId", "factVersionId", "stance", "sourceType", "chatId", "messageId",
  "branchGeneration", "sourceRole", "sourceStartOffset", "sourceEndOffset",
  "sourceMessageContentHash", "evidenceFingerprint", "safeExcerpt",
  "safeSourceHash", "sourceProjectionVersion", "observedAt"
ON "MemoryEvidence"
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_vnext_provenance_guard();

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

DROP TRIGGER IF EXISTS "MemoryFactVersion_vnext_evidence_assert"
ON "MemoryFactVersion";

CREATE CONSTRAINT TRIGGER "MemoryFactVersion_vnext_evidence_assert"
AFTER INSERT OR UPDATE OF
  "ingestionFingerprint", "sourceMode", "contentPurgedAt"
ON "MemoryFactVersion"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_assert_vnext_evidence();

DROP TRIGGER IF EXISTS "MemoryEvidence_vnext_evidence_assert"
ON "MemoryEvidence";

CREATE CONSTRAINT TRIGGER "MemoryEvidence_vnext_evidence_assert"
AFTER INSERT OR UPDATE OR DELETE
ON "MemoryEvidence"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION aiqsa_memory_assert_vnext_evidence();
