-- Memory profiles are append-only, source-grounded derivatives. An active
-- projection is accepted only with exact current-version contributors and a
-- succeeded, usage-backed MEMORY_PROFILE execution.
BEGIN;

CREATE TYPE "MemoryProfileProjectionState" AS ENUM ('ACTIVE', 'INVALIDATED');

CREATE TABLE "MemoryProfileProjection" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "memoryGeneration" INTEGER NOT NULL,
  "memoryRevision" INTEGER NOT NULL,
  "languageCode" VARCHAR(35) NOT NULL,
  "summary" TEXT,
  "safeContentHash" VARCHAR(128),
  "projectionVersion" VARCHAR(64) NOT NULL,
  "safetyClass" "MemorySensitivityClass" NOT NULL,
  "redactionState" "MemoryRedactionState" NOT NULL,
  "state" "MemoryProfileProjectionState" NOT NULL DEFAULT 'ACTIVE',
  "createdByExecutionId" TEXT NOT NULL,
  "inputHash" VARCHAR(128) NOT NULL,
  "outputHash" VARCHAR(128) NOT NULL,
  "sourceIdentitySnapshot" VARCHAR(128) NOT NULL,
  "safetyIdentitySnapshot" VARCHAR(128) NOT NULL,
  "suppressionIdentitySnapshot" VARCHAR(128) NOT NULL,
  "asOf" TIMESTAMP(3) NOT NULL,
  "plaintextPurgedAt" TIMESTAMP(3),
  "purgeReason" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MemoryProfileProjection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryProfileProjectionFact" (
  "userId" TEXT NOT NULL,
  "projectionId" TEXT NOT NULL,
  "factId" TEXT NOT NULL,
  "factVersionId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "factVersionContentHash" VARCHAR(128) NOT NULL,
  "sourceIdentitySnapshot" VARCHAR(128) NOT NULL,
  "safetyIdentitySnapshot" VARCHAR(128) NOT NULL,
  "suppressionIdentitySnapshot" VARCHAR(128) NOT NULL,

  CONSTRAINT "MemoryProfileProjectionFact_pkey"
    PRIMARY KEY ("projectionId", "ordinal")
);

CREATE UNIQUE INDEX "MemoryProfileProjection_userId_id_key"
  ON "MemoryProfileProjection"("userId", "id");
CREATE UNIQUE INDEX "MemoryProfileProjection_active_scope_language_key"
  ON "MemoryProfileProjection"("userId", "scopeId", "languageCode")
  WHERE "state" = 'ACTIVE';
CREATE INDEX "MemoryProfileProjection_userId_scopeId_state_languageCode_idx"
  ON "MemoryProfileProjection"("userId", "scopeId", "state", "languageCode");
CREATE INDEX "MemoryProfileProjection_userId_createdByExecutionId_idx"
  ON "MemoryProfileProjection"("userId", "createdByExecutionId");

CREATE UNIQUE INDEX "MemoryProfileProjectionFact_userId_projectionId_factVersionId_key"
  ON "MemoryProfileProjectionFact"("userId", "projectionId", "factVersionId");
CREATE INDEX "MemoryProfileProjectionFact_userId_factId_factVersionId_idx"
  ON "MemoryProfileProjectionFact"("userId", "factId", "factVersionId");

ALTER TABLE "MemoryProfileProjection"
  ADD CONSTRAINT "MemoryProfileProjection_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryProfileProjection_scope_fkey"
    FOREIGN KEY ("userId", "scopeId")
    REFERENCES "MemoryScope"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryProfileProjection_execution_fkey"
    FOREIGN KEY ("userId", "createdByExecutionId")
    REFERENCES "MemoryExecutionBinding"("userId", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryProfileProjection_shape_check"
    CHECK (
      "memoryGeneration" >= 0
      AND "memoryRevision" >= 0
      AND "languageCode" IN ('ru', 'en')
      AND "projectionVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$'
      AND "inputHash" ~ '^[a-f0-9]{64}$'
      AND "outputHash" ~ '^[a-f0-9]{64}$'
      AND "sourceIdentitySnapshot" ~ '^[a-f0-9]{64}$'
      AND "safetyIdentitySnapshot" ~ '^[a-f0-9]{64}$'
      AND "suppressionIdentitySnapshot" ~ '^[a-f0-9]{64}$'
      AND "asOf" <= "createdAt"
      AND "updatedAt" >= "createdAt"
      AND (
        (
          "state" = 'ACTIVE'
          AND "summary" IS NOT NULL
          AND char_length("summary") BETWEEN 1 AND 4000
          AND "safeContentHash" ~ '^[a-f0-9]{64}$'
          AND "redactionState" IN ('NOT_NEEDED', 'REDACTED')
          AND "plaintextPurgedAt" IS NULL
          AND "purgeReason" IS NULL
        ) OR (
          "state" = 'INVALIDATED'
          AND (
            (
              "summary" IS NOT NULL
              AND char_length("summary") BETWEEN 1 AND 4000
              AND "safeContentHash" ~ '^[a-f0-9]{64}$'
              AND "redactionState" IN ('NOT_NEEDED', 'REDACTED')
              AND "plaintextPurgedAt" IS NULL
              AND "purgeReason" IS NULL
            ) OR (
              "summary" IS NULL
              AND "safeContentHash" IS NULL
              AND "redactionState" = 'EXCLUDED'
              AND "plaintextPurgedAt" IS NOT NULL
              AND "purgeReason" ~ '^[a-z][a-z0-9._-]{0,63}$'
            )
          )
        )
      )
    );

ALTER TABLE "MemoryProfileProjectionFact"
  ADD CONSTRAINT "MemoryProfileProjectionFact_projection_fkey"
    FOREIGN KEY ("userId", "projectionId")
    REFERENCES "MemoryProfileProjection"("userId", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryProfileProjectionFact_fact_fkey"
    FOREIGN KEY ("userId", "factId")
    REFERENCES "MemoryFact"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryProfileProjectionFact_version_fkey"
    FOREIGN KEY ("userId", "factId", "factVersionId")
    REFERENCES "MemoryFactVersion"("userId", "factId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryProfileProjectionFact_shape_check"
    CHECK (
      "ordinal" BETWEEN 0 AND 5
      AND "factVersionContentHash" ~ '^[a-f0-9]{64}$'
      AND "sourceIdentitySnapshot" ~ '^[a-f0-9]{64}$'
      AND "safetyIdentitySnapshot" ~ '^[a-f0-9]{64}$'
      AND "suppressionIdentitySnapshot" ~ '^[a-f0-9]{64}$'
    );

CREATE FUNCTION aiqsa_memory_profile_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $memory_profile_append_only_guard$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."scopeId" IS DISTINCT FROM OLD."scopeId"
    OR NEW."memoryGeneration" IS DISTINCT FROM OLD."memoryGeneration"
    OR NEW."memoryRevision" IS DISTINCT FROM OLD."memoryRevision"
    OR NEW."languageCode" IS DISTINCT FROM OLD."languageCode"
    OR NEW."projectionVersion" IS DISTINCT FROM OLD."projectionVersion"
    OR NEW."safetyClass" IS DISTINCT FROM OLD."safetyClass"
    OR NEW."createdByExecutionId" IS DISTINCT FROM OLD."createdByExecutionId"
    OR NEW."inputHash" IS DISTINCT FROM OLD."inputHash"
    OR NEW."outputHash" IS DISTINCT FROM OLD."outputHash"
    OR NEW."sourceIdentitySnapshot" IS DISTINCT FROM OLD."sourceIdentitySnapshot"
    OR NEW."safetyIdentitySnapshot" IS DISTINCT FROM OLD."safetyIdentitySnapshot"
    OR NEW."suppressionIdentitySnapshot" IS DISTINCT FROM OLD."suppressionIdentitySnapshot"
    OR NEW."asOf" IS DISTINCT FROM OLD."asOf"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."updatedAt" < OLD."updatedAt"
    OR OLD."state" = 'INVALIDATED'
      AND NEW."state" IS DISTINCT FROM OLD."state"
    OR OLD."state" = 'ACTIVE'
      AND NEW."state" NOT IN ('ACTIVE', 'INVALIDATED')
    OR OLD."plaintextPurgedAt" IS NOT NULL
      AND NEW."plaintextPurgedAt" IS DISTINCT FROM OLD."plaintextPurgedAt"
    OR OLD."purgeReason" IS NOT NULL
      AND NEW."purgeReason" IS DISTINCT FROM OLD."purgeReason"
    OR NEW."summary" IS NOT NULL
      AND NEW."summary" IS DISTINCT FROM OLD."summary"
    OR NEW."safeContentHash" IS NOT NULL
      AND NEW."safeContentHash" IS DISTINCT FROM OLD."safeContentHash"
    OR NEW."redactionState" IS DISTINCT FROM OLD."redactionState"
      AND NOT (
        NEW."redactionState" = 'EXCLUDED'
        AND NEW."plaintextPurgedAt" IS NOT NULL
        AND NEW."summary" IS NULL
        AND NEW."safeContentHash" IS NULL
      )
    OR NEW."summary" IS NULL
      AND (
        NEW."state" <> 'INVALIDATED'
        OR NEW."plaintextPurgedAt" IS NULL
        OR NEW."purgeReason" IS NULL
        OR NEW."safeContentHash" IS NOT NULL
      )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory profile is append-only except for invalidation and one-way purge';
  END IF;
  RETURN NEW;
END
$memory_profile_append_only_guard$;

CREATE TRIGGER "MemoryProfileProjection_append_only_guard"
BEFORE UPDATE ON "MemoryProfileProjection"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_profile_append_only_guard();

CREATE FUNCTION aiqsa_memory_profile_fact_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $memory_profile_fact_immutable_guard$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Memory profile contributor is immutable';
END
$memory_profile_fact_immutable_guard$;

CREATE TRIGGER "MemoryProfileProjectionFact_immutable_guard"
BEFORE UPDATE ON "MemoryProfileProjectionFact"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_profile_fact_immutable_guard();

CREATE FUNCTION aiqsa_memory_profile_authority_guard()
RETURNS trigger LANGUAGE plpgsql AS $memory_profile_authority_guard$
DECLARE
  profile "MemoryProfileProjection"%ROWTYPE;
  profile_id TEXT;
  profile_user_id TEXT;
  contributor_count INTEGER;
  first_ordinal INTEGER;
  last_ordinal INTEGER;
  grounded_summary TEXT;
BEGIN
  IF TG_TABLE_NAME = 'MemoryProfileProjection' THEN
    profile_id := COALESCE(NEW."id", OLD."id");
    profile_user_id := COALESCE(NEW."userId", OLD."userId");
  ELSE
    profile_id := COALESCE(NEW."projectionId", OLD."projectionId");
    profile_user_id := COALESCE(NEW."userId", OLD."userId");
  END IF;

  SELECT * INTO profile
  FROM "MemoryProfileProjection"
  WHERE "id" = profile_id AND "userId" = profile_user_id;

  IF NOT FOUND OR profile."state" <> 'ACTIVE' THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "MemoryExecutionBinding" AS binding
    INNER JOIN "UsageEvent" AS usage
      ON usage."userId" = binding."userId"
      AND usage."memoryExecutionBindingId" = binding."id"
    WHERE binding."userId" = profile."userId"
      AND binding."id" = profile."createdByExecutionId"
      AND binding."ownerType" = 'JOB'
      AND binding."logicalRole" = 'MEMORY_PROFILE'
      AND binding."state" = 'SUCCEEDED'
      AND binding."inputHash" = profile."inputHash"
      AND binding."acceptedOutputHash" = profile."outputHash"
      AND binding."relationsDetachedAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Active Memory profile requires exact succeeded usage-backed execution';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "UserMemorySettings" AS settings
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = settings."userId"
      AND scope."id" = profile."scopeId"
    WHERE settings."userId" = profile."userId"
      AND settings."useMemoryFacts"
      AND settings."memoryGeneration" = profile."memoryGeneration"
      AND settings."memoryRevision" = profile."memoryRevision"
      AND scope."state" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Active Memory profile requires current readable scope authority';
  END IF;

  SELECT count(*)::integer, min(contributor."ordinal"), max(contributor."ordinal"),
    string_agg(version."displayText", E'\n' ORDER BY contributor."ordinal")
  INTO contributor_count, first_ordinal, last_ordinal, grounded_summary
  FROM "MemoryProfileProjectionFact" AS contributor
  INNER JOIN "MemoryFactVersion" AS version
    ON version."userId" = contributor."userId"
    AND version."factId" = contributor."factId"
    AND version."id" = contributor."factVersionId"
  WHERE contributor."userId" = profile."userId"
    AND contributor."projectionId" = profile."id";

  IF contributor_count NOT BETWEEN 1 AND 6
    OR first_ordinal <> 0
    OR last_ordinal <> contributor_count - 1
    OR grounded_summary IS DISTINCT FROM profile."summary"
    OR profile."safetyClass" <> 'NORMAL'
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Active Memory profile summary must exactly match contiguous contributors';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "MemoryProfileProjectionFact" AS contributor
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = contributor."userId"
      AND fact."id" = contributor."factId"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = contributor."userId"
      AND version."factId" = contributor."factId"
      AND version."id" = contributor."factVersionId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = contributor."userId"
    LEFT JOIN "MemorySearchEntry" AS search
      ON search."userId" = contributor."userId"
      AND search."indexGenerationId" = settings."activeIndexGenerationId"
      AND search."factVersionId" = contributor."factVersionId"
    WHERE contributor."userId" = profile."userId"
      AND contributor."projectionId" = profile."id"
      AND (
        fact."scopeId" IS DISTINCT FROM profile."scopeId"
        OR fact."state" <> 'ACTIVE'
        OR fact."currentVersionId" IS DISTINCT FROM contributor."factVersionId"
        OR scope."state" <> 'ACTIVE'
        OR version."state" <> 'ACTIVE'
        OR version."systemTo" IS NOT NULL
        OR version."contentPurgedAt" IS NOT NULL
        OR version."displayText" IS NULL
        OR version."sensitivityClass" <> 'NORMAL'
        OR lower(split_part(version."languageCode", '-', 1))
          IS DISTINCT FROM profile."languageCode"
        OR search."id" IS NULL
        OR search."safeContentHash" IS DISTINCT FROM
          contributor."factVersionContentHash"
        OR search."sourceIdentitySnapshot" IS DISTINCT FROM
          contributor."sourceIdentitySnapshot"
        OR search."safetyIdentitySnapshot" IS DISTINCT FROM
          contributor."safetyIdentitySnapshot"
        OR search."suppressionIdentitySnapshot" IS DISTINCT FROM
          contributor."suppressionIdentitySnapshot"
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Active Memory profile contributor is stale, unsafe, or out of scope';
  END IF;

  RETURN NULL;
END
$memory_profile_authority_guard$;

CREATE CONSTRAINT TRIGGER "MemoryProfileProjection_authority_guard"
AFTER INSERT OR UPDATE ON "MemoryProfileProjection"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_profile_authority_guard();

CREATE CONSTRAINT TRIGGER "MemoryProfileProjectionFact_authority_guard"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryProfileProjectionFact"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_profile_authority_guard();

COMMIT;
