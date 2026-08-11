-- Add source-grounded automatic fact candidates without promoting any model
-- output into durable Memory facts. Direct USER evidence remains relational
-- authority; JSON payloads never authorize a source relation.
BEGIN;

CREATE TYPE "MemoryCandidateState" AS ENUM (
  'PENDING', 'DEFERRED', 'PROMOTED', 'REJECTED', 'STALE'
);

CREATE TABLE "MemoryCandidate" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "branchGeneration" INTEGER NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "sourceHash" VARCHAR(128) NOT NULL,
  "sourceProjectionHash" VARCHAR(128) NOT NULL,
  "sourceProjectionVersion" VARCHAR(64) NOT NULL,
  "createdByExecutionId" TEXT NOT NULL,
  "proposedCanonicalKey" VARCHAR(256),
  "proposedDisplayText" TEXT,
  "proposedValue" JSONB,
  "proposedCategory" VARCHAR(64),
  "proposedModality" "MemoryFactModality",
  "proposedScope" JSONB,
  "proposedValidFrom" TIMESTAMP(3),
  "proposedValidTo" TIMESTAMP(3),
  "rawTemporalExpression" VARCHAR(512),
  "sourceTimezone" VARCHAR(64),
  "temporalResolverVersion" VARCHAR(64),
  "temporalResolutionEvidence" JSONB,
  "proposedDirectness" "MemoryDirectness",
  "proposedSensitivity" "MemorySensitivityClass",
  "languageCode" VARCHAR(35),
  "importance" DOUBLE PRECISION,
  "confidence" DOUBLE PRECISION,
  "negated" BOOLEAN,
  "state" "MemoryCandidateState" NOT NULL DEFAULT 'PENDING',
  "reasonCode" VARCHAR(64),
  "pipelineVersion" VARCHAR(64) NOT NULL,
  "resolvedFactId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "contentPurgedAt" TIMESTAMP(3),

  CONSTRAINT "MemoryCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryCandidateMessage" (
  "userId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "startOffset" INTEGER NOT NULL,
  "endOffset" INTEGER NOT NULL,
  "sourceTextHash" VARCHAR(128) NOT NULL,

  CONSTRAINT "MemoryCandidateMessage_pkey" PRIMARY KEY ("candidateId", "messageId")
);

CREATE UNIQUE INDEX "MemoryJob_source_identity_key"
  ON "MemoryJob"(
    "userId", "id", "chatId", "branchGeneration", "sourceRevision", "sourceHash"
  );
CREATE UNIQUE INDEX "MemoryCandidate_userId_id_key"
  ON "MemoryCandidate"("userId", "id");
CREATE UNIQUE INDEX "MemoryCandidate_userId_chatId_id_key"
  ON "MemoryCandidate"("userId", "chatId", "id");
CREATE INDEX "MemoryCandidate_userId_jobId_idx"
  ON "MemoryCandidate"("userId", "jobId");
CREATE INDEX "MemoryCandidate_userId_chatId_state_branchGeneration_sourceRevision_idx"
  ON "MemoryCandidate"(
    "userId", "chatId", "state", "branchGeneration", "sourceRevision"
  );
CREATE INDEX "MemoryCandidate_userId_createdByExecutionId_idx"
  ON "MemoryCandidate"("userId", "createdByExecutionId");
CREATE INDEX "MemoryCandidate_userId_resolvedFactId_idx"
  ON "MemoryCandidate"("userId", "resolvedFactId");
CREATE UNIQUE INDEX "MemoryCandidateMessage_candidateId_ordinal_key"
  ON "MemoryCandidateMessage"("candidateId", "ordinal");
CREATE INDEX "MemoryCandidateMessage_userId_chatId_messageId_idx"
  ON "MemoryCandidateMessage"("userId", "chatId", "messageId");

ALTER TABLE "MemoryCandidate"
  ADD CONSTRAINT "MemoryCandidate_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidate_chat_fkey"
    FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidate_job_source_fkey"
    FOREIGN KEY (
      "userId", "jobId", "chatId", "branchGeneration", "sourceRevision", "sourceHash"
    ) REFERENCES "MemoryJob"(
      "userId", "id", "chatId", "branchGeneration", "sourceRevision", "sourceHash"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidate_execution_fkey"
    FOREIGN KEY ("userId", "createdByExecutionId")
    REFERENCES "MemoryExecutionBinding"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidate_resolved_fact_fkey"
    FOREIGN KEY ("userId", "resolvedFactId")
    REFERENCES "MemoryFact"("userId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidate_shape_check"
    CHECK (
      "id" ~ '^[a-f0-9]{64}$'
      AND "branchGeneration" >= 0
      AND "sourceRevision" >= 0
      AND "sourceHash" ~ '^[a-f0-9]{64}$'
      AND "sourceProjectionHash" ~ '^[a-f0-9]{64}$'
      AND "sourceProjectionVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND "pipelineVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
      AND ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Za-z0-9._-]{1,64}$')
      AND (
        "contentPurgedAt" IS NULL
        OR (
          "state" IN ('PROMOTED', 'REJECTED', 'STALE')
          AND num_nonnulls(
            "proposedCanonicalKey", "proposedDisplayText", "proposedValue",
            "proposedCategory", "proposedModality", "proposedScope",
            "proposedValidFrom", "proposedValidTo", "rawTemporalExpression",
            "sourceTimezone", "temporalResolverVersion",
            "temporalResolutionEvidence", "proposedDirectness",
            "proposedSensitivity", "languageCode", "importance", "confidence",
            "negated"
          ) = 0
        )
      )
      AND (
        "contentPurgedAt" IS NOT NULL
        OR (
          num_nonnulls(
            "proposedCanonicalKey", "proposedDisplayText", "proposedValue",
            "proposedCategory", "proposedModality", "proposedScope",
            "sourceTimezone", "proposedDirectness", "proposedSensitivity",
            "languageCode", "importance", "confidence", "negated"
          ) = 13
          AND char_length("proposedCanonicalKey") BETWEEN 1 AND 256
          AND "proposedCanonicalKey" ~ '^[a-z0-9][a-z0-9._:-]{0,255}$'
          AND char_length("proposedDisplayText") BETWEEN 1 AND 2000
          AND char_length("proposedCategory") BETWEEN 1 AND 64
          AND "proposedCategory" ~ '^[A-Za-z0-9._-]{1,64}$'
          AND pg_column_size("proposedValue") <= 8192
          AND jsonb_typeof("proposedScope") = 'object'
          AND pg_column_size("proposedScope") <= 2048
          AND "proposedScope" ? 'type'
          AND "proposedScope" ? 'target_id'
          AND ("proposedScope" ->> 'type') IN ('GLOBAL_USER', 'FOLDER', 'ASSISTANT', 'CHAT')
          AND ("proposedScope" - ARRAY['type', 'target_id']::text[]) = '{}'::jsonb
          AND (
            (
              "proposedScope" ->> 'type' = 'GLOBAL_USER'
              AND COALESCE("proposedScope" ->> 'target_id', '') = ''
            ) OR (
              "proposedScope" ->> 'type' <> 'GLOBAL_USER'
              AND char_length(COALESCE("proposedScope" ->> 'target_id', '')) BETWEEN 1 AND 256
              AND COALESCE("proposedScope" ->> 'target_id', '') !~ '\\s'
            )
          )
          AND ("proposedValidFrom" IS NULL OR "proposedValidTo" IS NULL OR "proposedValidTo" >= "proposedValidFrom")
          AND ("rawTemporalExpression" IS NULL OR char_length("rawTemporalExpression") BETWEEN 1 AND 512)
          AND "sourceTimezone" ~ '^[A-Za-z0-9_+./-]{1,64}$'
          AND (
            num_nonnulls("temporalResolverVersion", "temporalResolutionEvidence") = 0
            OR (
              num_nonnulls("temporalResolverVersion", "temporalResolutionEvidence") = 2
              AND "temporalResolverVersion" ~ '^[A-Za-z0-9._-]{1,64}$'
              AND jsonb_typeof("temporalResolutionEvidence") = 'object'
              AND pg_column_size("temporalResolutionEvidence") <= 4096
            )
          )
          AND "proposedDirectness" = 'DIRECT'
          AND "proposedSensitivity" = 'NORMAL'
          AND "languageCode" ~ '^(mixed|und|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)$'
          AND "importance" BETWEEN 0 AND 1
          AND "confidence" BETWEEN 0 AND 1
        )
      )
      AND (
        (
          "state" = 'PENDING' AND "reasonCode" IS NULL
          AND "resolvedAt" IS NULL AND "resolvedFactId" IS NULL
          AND "contentPurgedAt" IS NULL
        ) OR (
          "state" = 'DEFERRED' AND "reasonCode" IS NOT NULL
          AND "resolvedAt" IS NULL AND "resolvedFactId" IS NULL
          AND "contentPurgedAt" IS NULL
        ) OR (
          "state" = 'PROMOTED' AND "resolvedAt" IS NOT NULL
          AND "resolvedFactId" IS NOT NULL
        ) OR (
          "state" IN ('REJECTED', 'STALE') AND "reasonCode" IS NOT NULL
          AND "resolvedAt" IS NOT NULL AND "resolvedFactId" IS NULL
        )
      )
    );

ALTER TABLE "MemoryCandidateMessage"
  ADD CONSTRAINT "MemoryCandidateMessage_candidate_fkey"
    FOREIGN KEY ("userId", "chatId", "candidateId")
    REFERENCES "MemoryCandidate"("userId", "chatId", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidateMessage_message_fkey"
    FOREIGN KEY ("chatId", "messageId")
    REFERENCES "Message"("chatId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "MemoryCandidateMessage_shape_check"
    CHECK (
      "ordinal" >= 0 AND "ordinal" <= 23
      AND "startOffset" >= 0
      AND "endOffset" > "startOffset"
      AND "endOffset" <= 16000
      AND "sourceTextHash" ~ '^[a-f0-9]{64}$'
    );

CREATE FUNCTION aiqsa_memory_candidate_authority_trigger() RETURNS trigger
LANGUAGE plpgsql AS $memory_candidate_authority$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "MemoryJob" AS job
    INNER JOIN "MemoryExecutionBinding" AS execution
      ON execution."userId" = job."userId"
      AND execution."memoryJobId" = job."id"
    WHERE job."userId" = NEW."userId"
      AND job."id" = NEW."jobId"
      AND job."chatId" = NEW."chatId"
      AND job."branchGeneration" = NEW."branchGeneration"
      AND job."sourceRevision" = NEW."sourceRevision"
      AND job."sourceHash" = NEW."sourceHash"
      AND job."kind" = 'EXTRACT_FACTS'
      AND job."pipelineVersion" = NEW."pipelineVersion"
      AND execution."id" = NEW."createdByExecutionId"
      AND execution."ownerType" = 'JOB'
      AND execution."logicalRole" = 'MEMORY_FACT_EXTRACT'
      AND execution."state" = 'SUCCEEDED'
      AND execution."acceptedOutputHash" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate requires its exact succeeded fact-extraction authority';
  END IF;
  RETURN NEW;
END
$memory_candidate_authority$;

CREATE TRIGGER "MemoryCandidate_authority_trigger"
BEFORE INSERT OR UPDATE OF
  "userId", "jobId", "chatId", "branchGeneration", "sourceRevision",
  "sourceHash", "createdByExecutionId", "pipelineVersion"
ON "MemoryCandidate"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_authority_trigger();

CREATE FUNCTION aiqsa_memory_candidate_message_authority_trigger() RETURNS trigger
LANGUAGE plpgsql AS $memory_candidate_message_authority$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "MemoryCandidate" AS candidate
    INNER JOIN "Message" AS message
      ON message."chatId" = candidate."chatId"
    WHERE candidate."userId" = NEW."userId"
      AND candidate."id" = NEW."candidateId"
      AND candidate."chatId" = NEW."chatId"
      AND message."id" = NEW."messageId"
      AND message."role" = 'user'
      AND message."status" = 'complete'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Memory candidate evidence requires an exact settled direct USER message';
  END IF;
  RETURN NEW;
END
$memory_candidate_message_authority$;

CREATE TRIGGER "MemoryCandidateMessage_authority_trigger"
BEFORE INSERT OR UPDATE OF "userId", "candidateId", "chatId", "messageId"
ON "MemoryCandidateMessage"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_message_authority_trigger();

CREATE FUNCTION aiqsa_memory_assert_candidate_has_evidence(p_candidate_id text)
RETURNS void LANGUAGE plpgsql AS $memory_candidate_evidence$
DECLARE
  candidate_state "MemoryCandidateState";
  purged_at timestamp(3);
BEGIN
  SELECT "state", "contentPurgedAt" INTO candidate_state, purged_at
  FROM "MemoryCandidate" WHERE "id" = p_candidate_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF candidate_state IN ('PENDING', 'DEFERRED') AND purged_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM "MemoryCandidateMessage"
    WHERE "candidateId" = p_candidate_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Active Memory candidate requires direct USER evidence';
  END IF;
END
$memory_candidate_evidence$;

CREATE FUNCTION aiqsa_memory_candidate_evidence_trigger() RETURNS trigger
LANGUAGE plpgsql AS $memory_candidate_evidence_trigger$
BEGIN
  IF TG_TABLE_NAME = 'MemoryCandidate' THEN
    PERFORM aiqsa_memory_assert_candidate_has_evidence(NEW."id");
  ELSE
    IF TG_OP <> 'INSERT' THEN
      PERFORM aiqsa_memory_assert_candidate_has_evidence(OLD."candidateId");
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM aiqsa_memory_assert_candidate_has_evidence(NEW."candidateId");
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$memory_candidate_evidence_trigger$;

CREATE CONSTRAINT TRIGGER "MemoryCandidate_evidence_trigger"
AFTER INSERT OR UPDATE OF "state", "contentPurgedAt"
ON "MemoryCandidate" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_evidence_trigger();
CREATE CONSTRAINT TRIGGER "MemoryCandidateMessage_evidence_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryCandidateMessage"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_candidate_evidence_trigger();

CREATE FUNCTION aiqsa_memory_protect_candidate_message_trigger() RETURNS trigger
LANGUAGE plpgsql AS $memory_protect_candidate_message$
BEGIN
  IF (NEW."role" <> 'user' OR NEW."status" <> 'complete') AND EXISTS (
    SELECT 1 FROM "MemoryCandidateMessage"
    WHERE "chatId" = OLD."chatId" AND "messageId" = OLD."id"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A Memory candidate source must remain a settled direct USER message';
  END IF;
  RETURN NEW;
END
$memory_protect_candidate_message$;

CREATE TRIGGER "Message_memory_candidate_authority_trigger"
BEFORE UPDATE OF "role", "status" ON "Message"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_protect_candidate_message_trigger();

CREATE FUNCTION aiqsa_memory_protect_candidate_execution_trigger() RETURNS trigger
LANGUAGE plpgsql AS $memory_protect_candidate_execution$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "MemoryCandidate"
    WHERE "userId" = OLD."userId" AND "createdByExecutionId" = OLD."id"
  ) AND (
    NEW."ownerType" <> 'JOB'
    OR NEW."logicalRole" <> 'MEMORY_FACT_EXTRACT'
    OR NEW."state" <> 'SUCCEEDED'
    OR NEW."acceptedOutputHash" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A Memory candidate extraction authority is immutable';
  END IF;
  RETURN NEW;
END
$memory_protect_candidate_execution$;

CREATE TRIGGER "MemoryExecutionBinding_candidate_authority_trigger"
BEFORE UPDATE OF
  "ownerType", "logicalRole", "state", "acceptedOutputHash", "relationsDetachedAt"
ON "MemoryExecutionBinding"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_protect_candidate_execution_trigger();

CREATE FUNCTION aiqsa_memory_protect_candidate_job_trigger() RETURNS trigger
LANGUAGE plpgsql AS $memory_protect_candidate_job$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "MemoryCandidate"
    WHERE "userId" = OLD."userId" AND "jobId" = OLD."id"
  ) AND (
    NEW."kind" <> 'EXTRACT_FACTS'
    OR NEW."pipelineVersion" <> OLD."pipelineVersion"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A Memory candidate source job authority is immutable';
  END IF;
  RETURN NEW;
END
$memory_protect_candidate_job$;

CREATE TRIGGER "MemoryJob_candidate_authority_trigger"
BEFORE UPDATE OF "kind", "pipelineVersion" ON "MemoryJob"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_protect_candidate_job_trigger();

COMMIT;
