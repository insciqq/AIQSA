-- Package C: durable context-dependency provenance plus a conservative,
-- owner-scoped entity/alias/support layer. Message dependencies retain both
-- a content hash and the immutable edit-snapshot timestamp; the current
-- product edit contract replaces user messages instead of mutating content.

CREATE TYPE "MemorySourceDependencyKind" AS ENUM (
  'COREFERENCE_ANTECEDENT',
  'CORRECTION_TARGET',
  'TEMPORAL_CONTEXT',
  'RELATION_CONTEXT'
);

CREATE TYPE "MemoryEntityState" AS ENUM ('ACTIVE', 'MERGED');
CREATE TYPE "MemoryEntityAliasSupportKind" AS ENUM ('EVIDENCE', 'FACT_VERSION');
CREATE TYPE "MemoryEntityLinkRole" AS ENUM ('SUBJECT', 'OBJECT', 'MENTION');

ALTER TABLE "MemoryFactVersion"
  ADD CONSTRAINT "MemoryFactVersion_vnext_v2_provenance_check" CHECK (
    "sourceMode" <> 'AUTOMATIC'::"MemoryFactSourceMode"
    OR "pipelineVersion" <> 'memory-fact-extraction-vnext-v2'
    OR (
      "ingestionFingerprint" IS NOT NULL
      AND "observedAt" IS NOT NULL
    )
  );

CREATE TABLE "MemoryFactVersionSourceDependency" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetFactVersionId" TEXT NOT NULL,
  "dependencyKind" "MemorySourceDependencyKind" NOT NULL,
  "sourceMessageId" TEXT,
  "sourceMessageContentHash" VARCHAR(128),
  "sourceMessageUpdatedAt" TIMESTAMP(3),
  "sourceFactVersionId" TEXT,
  "sourceProjectionVersion" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryFactVersionSourceDependency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryEntity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "canonicalKey" VARCHAR(256) NOT NULL,
  "entityType" VARCHAR(64) NOT NULL,
  "displayName" VARCHAR(256) NOT NULL,
  "state" "MemoryEntityState" NOT NULL DEFAULT 'ACTIVE',
  "mergedIntoId" TEXT,
  "languageCode" VARCHAR(35),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryEntity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryEntityAlias" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "normalizedAlias" VARCHAR(256) NOT NULL,
  "displayAlias" VARCHAR(256) NOT NULL,
  "languageCode" VARCHAR(35),
  "sourceKind" VARCHAR(32) NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryEntityAlias_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryEntityAliasSupport" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "aliasId" TEXT NOT NULL,
  "supportKind" "MemoryEntityAliasSupportKind" NOT NULL,
  "factVersionId" TEXT,
  "evidenceId" TEXT,
  "supportFingerprint" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryEntityAliasSupport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryFactVersionEntity" (
  "userId" TEXT NOT NULL,
  "factVersionId" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "role" "MemoryEntityLinkRole" NOT NULL,
  "mentionText" VARCHAR(256),
  "normalizedMention" VARCHAR(256),
  "confidence" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryFactVersionEntity_pkey"
    PRIMARY KEY ("factVersionId", "entityId", "role")
);

ALTER TABLE "MemoryFactVersionSourceDependency"
  ADD CONSTRAINT "MemoryFactVersionSourceDependency_shape_check" CHECK (
    (
      "sourceMessageId" IS NOT NULL
      AND "sourceMessageContentHash" ~ '^[a-f0-9]{64}$'
      AND "sourceMessageUpdatedAt" IS NOT NULL
      AND "sourceFactVersionId" IS NULL
      AND "sourceProjectionVersion" IS NOT NULL
    )
    OR (
      "sourceMessageId" IS NULL
      AND "sourceMessageContentHash" IS NULL
      AND "sourceMessageUpdatedAt" IS NULL
      AND "sourceFactVersionId" IS NOT NULL
      AND "sourceProjectionVersion" IS NULL
    )
  ),
  ADD CONSTRAINT "MemoryFactVersionSourceDependency_not_self_check" CHECK (
    "sourceFactVersionId" IS NULL
    OR "sourceFactVersionId" <> "targetFactVersionId"
  );

ALTER TABLE "MemoryEntity"
  ADD CONSTRAINT "MemoryEntity_state_check" CHECK (
    ("state" = 'ACTIVE' AND "mergedIntoId" IS NULL)
    OR (
      "state" = 'MERGED'
      AND "mergedIntoId" IS NOT NULL
      AND "mergedIntoId" <> "id"
    )
  ),
  ADD CONSTRAINT "MemoryEntity_text_check" CHECK (
    length(btrim("canonicalKey")) > 0
    AND length(btrim("entityType")) > 0
    AND length(btrim("displayName")) > 0
  );

ALTER TABLE "MemoryEntityAlias"
  ADD CONSTRAINT "MemoryEntityAlias_value_check" CHECK (
    length(btrim("normalizedAlias")) > 0
    AND length(btrim("displayAlias")) > 0
    AND length(btrim("sourceKind")) > 0
    AND "confidence" >= 0.0 AND "confidence" <= 1.0
  );

ALTER TABLE "MemoryEntityAliasSupport"
  ADD CONSTRAINT "MemoryEntityAliasSupport_shape_check" CHECK (
    "supportFingerprint" ~ '^[a-f0-9]{64}$'
    AND (
      (
        "supportKind" = 'EVIDENCE'
        AND "evidenceId" IS NOT NULL
        AND "factVersionId" IS NULL
      )
      OR (
        "supportKind" = 'FACT_VERSION'
        AND "factVersionId" IS NOT NULL
        AND "evidenceId" IS NULL
      )
    )
  );

ALTER TABLE "MemoryFactVersionEntity"
  ADD CONSTRAINT "MemoryFactVersionEntity_value_check" CHECK (
    "confidence" >= 0.0 AND "confidence" <= 1.0
    AND ("mentionText" IS NULL OR length(btrim("mentionText")) > 0)
    AND ("normalizedMention" IS NULL OR length(btrim("normalizedMention")) > 0)
  );

CREATE UNIQUE INDEX "MemoryFactVersionSourceDependency_userId_id_key"
  ON "MemoryFactVersionSourceDependency"("userId", "id");
CREATE INDEX "MemoryFactVersionSourceDependency_userId_targetFactVersionI_idx"
  ON "MemoryFactVersionSourceDependency"("userId", "targetFactVersionId", "dependencyKind");
CREATE INDEX "MemoryFactVersionSourceDependency_userId_sourceMessageId_idx"
  ON "MemoryFactVersionSourceDependency"("userId", "sourceMessageId");
CREATE INDEX "MemoryFactVersionSourceDependency_userId_sourceFactVersionI_idx"
  ON "MemoryFactVersionSourceDependency"("userId", "sourceFactVersionId");
CREATE UNIQUE INDEX "MemoryFactVersionSourceDependency_message_unique"
  ON "MemoryFactVersionSourceDependency"(
    "userId", "targetFactVersionId", "dependencyKind", "sourceMessageId"
  ) WHERE "sourceMessageId" IS NOT NULL;
CREATE UNIQUE INDEX "MemoryFactVersionSourceDependency_version_unique"
  ON "MemoryFactVersionSourceDependency"(
    "userId", "targetFactVersionId", "dependencyKind", "sourceFactVersionId"
  ) WHERE "sourceFactVersionId" IS NOT NULL;

CREATE UNIQUE INDEX "MemoryEntity_userId_id_key"
  ON "MemoryEntity"("userId", "id");
CREATE UNIQUE INDEX "MemoryEntity_userId_canonicalKey_key"
  ON "MemoryEntity"("userId", "canonicalKey");
CREATE INDEX "MemoryEntity_userId_entityType_state_idx"
  ON "MemoryEntity"("userId", "entityType", "state");
CREATE INDEX "MemoryEntity_userId_mergedIntoId_idx"
  ON "MemoryEntity"("userId", "mergedIntoId");

CREATE UNIQUE INDEX "MemoryEntityAlias_userId_id_key"
  ON "MemoryEntityAlias"("userId", "id");
CREATE UNIQUE INDEX "MemoryEntityAlias_userId_entityId_normalizedAlias_key"
  ON "MemoryEntityAlias"("userId", "entityId", "normalizedAlias");
CREATE INDEX "MemoryEntityAlias_userId_normalizedAlias_idx"
  ON "MemoryEntityAlias"("userId", "normalizedAlias");

CREATE UNIQUE INDEX "MemoryEntityAliasSupport_userId_id_key"
  ON "MemoryEntityAliasSupport"("userId", "id");
CREATE UNIQUE INDEX "MemoryEntityAliasSupport_userId_supportFingerprint_key"
  ON "MemoryEntityAliasSupport"("userId", "supportFingerprint");
CREATE INDEX "MemoryEntityAliasSupport_userId_aliasId_idx"
  ON "MemoryEntityAliasSupport"("userId", "aliasId");
CREATE INDEX "MemoryEntityAliasSupport_userId_factVersionId_idx"
  ON "MemoryEntityAliasSupport"("userId", "factVersionId");
CREATE INDEX "MemoryEntityAliasSupport_userId_evidenceId_idx"
  ON "MemoryEntityAliasSupport"("userId", "evidenceId");

CREATE INDEX "MemoryFactVersionEntity_userId_entityId_role_factVersionId_idx"
  ON "MemoryFactVersionEntity"("userId", "entityId", "role", "factVersionId");

ALTER TABLE "MemoryFactVersionSourceDependency"
  ADD CONSTRAINT "MemoryFactVersionSourceDependency_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryFactVersionSourceDependency_target_fkey"
    FOREIGN KEY ("userId", "targetFactVersionId")
    REFERENCES "MemoryFactVersion"("userId", "id")
    ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryFactVersionSourceDependency_source_version_fkey"
    FOREIGN KEY ("userId", "sourceFactVersionId")
    REFERENCES "MemoryFactVersion"("userId", "id")
    ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryEntity"
  ADD CONSTRAINT "MemoryEntity_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryEntity_merged_into_fkey"
    FOREIGN KEY ("userId", "mergedIntoId")
    REFERENCES "MemoryEntity"("userId", "id")
    ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "MemoryEntityAlias"
  ADD CONSTRAINT "MemoryEntityAlias_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryEntityAlias_entity_fkey"
    FOREIGN KEY ("userId", "entityId")
    REFERENCES "MemoryEntity"("userId", "id")
    ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryEntityAliasSupport"
  ADD CONSTRAINT "MemoryEntityAliasSupport_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryEntityAliasSupport_alias_fkey"
    FOREIGN KEY ("userId", "aliasId")
    REFERENCES "MemoryEntityAlias"("userId", "id")
    ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryEntityAliasSupport_version_fkey"
    FOREIGN KEY ("userId", "factVersionId")
    REFERENCES "MemoryFactVersion"("userId", "id")
    ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryEntityAliasSupport_evidence_fkey"
    FOREIGN KEY ("userId", "evidenceId")
    REFERENCES "MemoryEvidence"("userId", "id")
    ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE "MemoryFactVersionEntity"
  ADD CONSTRAINT "MemoryFactVersionEntity_user_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryFactVersionEntity_version_fkey"
    FOREIGN KEY ("userId", "factVersionId")
    REFERENCES "MemoryFactVersion"("userId", "id")
    ON UPDATE RESTRICT ON DELETE CASCADE,
  ADD CONSTRAINT "MemoryFactVersionEntity_entity_fkey"
    FOREIGN KEY ("userId", "entityId")
    REFERENCES "MemoryEntity"("userId", "id")
    ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION aiqsa_memory_message_dependency_valid(
  p_user_id TEXT,
  p_message_id TEXT,
  p_message_updated_at TIMESTAMP(3)
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM "Message" AS dependency_message
    INNER JOIN "Chat" AS dependency_chat
      ON dependency_chat."id" = dependency_message."chatId"
      AND dependency_chat."userId" = p_user_id
      AND dependency_chat."projectId" IS NULL
      AND dependency_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND dependency_chat."permanentDeletionAt" IS NULL
    WHERE dependency_message."id" = p_message_id
      AND dependency_message."role" = 'user'
      AND dependency_message."status" = 'complete'::"MessageStatus"
      AND dependency_message."updatedAt" = p_message_updated_at
      AND EXISTS (
        WITH RECURSIVE active_path AS (
          SELECT
            leaf."id",
            leaf."parentMessageId",
            ARRAY[leaf."id"]::TEXT[] AS visited,
            FALSE AS cycle
          FROM "Message" AS leaf
          WHERE leaf."chatId" = dependency_chat."id"
            AND leaf."id" = dependency_chat."activeLeafMessageId"

          UNION ALL

          SELECT
            parent."id",
            parent."parentMessageId",
            child.visited || parent."id",
            parent."id" = ANY(child.visited)
          FROM active_path AS child
          INNER JOIN "Message" AS parent
            ON parent."chatId" = dependency_chat."id"
            AND parent."id" = child."parentMessageId"
          WHERE NOT child.cycle
        )
        SELECT 1 FROM active_path
        WHERE active_path."id" = dependency_message."id"
          AND NOT active_path.cycle
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemorySuppression" AS suppression
        WHERE suppression."userId" = p_user_id
          AND suppression."scope" IN (
            'ALL'::"MemorySuppressionScope",
            'SOURCE_MESSAGE'::"MemorySuppressionScope"
          )
          AND (
            suppression."scope" = 'ALL'::"MemorySuppressionScope"
            OR (
              suppression."sourceChatId" = dependency_message."chatId"
              AND suppression."sourceMessageId" = dependency_message."id"
            )
          )
          AND (
            suppression."expiresAt" IS NULL
            OR suppression."expiresAt" > CURRENT_TIMESTAMP
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemorySourceBarrier" AS barrier
        WHERE barrier."userId" = p_user_id
          AND barrier."kind" IN (
            'AUTOMATIC_FACTS'::"MemorySourceBarrierKind",
            'ALL_REUSABLE'::"MemorySourceBarrierKind"
          )
          AND barrier."explicitOverrideAllowed" = FALSE
          AND dependency_message."createdAt" <= barrier."sourceCreatedAtCutoff"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryPauseInterval" AS pause_interval
        WHERE pause_interval."userId" = p_user_id
          AND pause_interval."scope" IN (
            'MASTER'::"MemoryPauseScope",
            'AUTOMATIC_LEARNING'::"MemoryPauseScope"
          )
          AND dependency_message."createdAt" >= pause_interval."pausedAt"
          AND (
            pause_interval."resumedAt" IS NULL
            OR dependency_message."createdAt" <= pause_interval."resumedAt"
          )
      )
  );
$function$;

CREATE OR REPLACE FUNCTION aiqsa_memory_dependency_source_version_valid(
  p_user_id TEXT,
  p_version_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM "MemoryFactVersion" AS source_version
    INNER JOIN "MemoryFact" AS source_fact
      ON source_fact."userId" = source_version."userId"
      AND source_fact."id" = source_version."factId"
      AND source_fact."state" NOT IN (
        'ORPHANED'::"MemoryFactState",
        'EXPIRED'::"MemoryFactState",
        'RETRACTED'::"MemoryFactState",
        'FORGOTTEN'::"MemoryFactState"
      )
    INNER JOIN "MemoryScope" AS source_scope
      ON source_scope."userId" = source_fact."userId"
      AND source_scope."id" = source_fact."scopeId"
      AND source_scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND source_scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
    WHERE source_version."userId" = p_user_id
      AND source_version."id" = p_version_id
      AND source_version."state" NOT IN (
        'ORPHANED'::"MemoryFactVersionState",
        'EXPIRED'::"MemoryFactVersionState",
        'RETRACTED'::"MemoryFactVersionState",
        'FORGOTTEN'::"MemoryFactVersionState"
      )
      AND source_version."directness" IN (
        'DIRECT'::"MemoryDirectness",
        'PARAPHRASED'::"MemoryDirectness"
      )
      AND source_version."contentPurgedAt" IS NULL
      AND source_version."displayText" IS NOT NULL
      AND source_version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND source_version."sensitivityClass" IN (
        'NORMAL'::"MemorySensitivityClass",
        'SENSITIVE'::"MemorySensitivityClass"
      )
      AND (
        source_version."expiresAt" IS NULL
        OR source_version."expiresAt" > CURRENT_TIMESTAMP
      )
      AND (
        source_version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        OR EXISTS (
          SELECT 1
          FROM "MemoryEvidence" AS source_support
          INNER JOIN "Message" AS support_message
            ON support_message."chatId" = source_support."chatId"
            AND support_message."id" = source_support."messageId"
          WHERE source_support."userId" = p_user_id
            AND source_support."factVersionId" = source_version."id"
            AND source_support."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
            AND source_support."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
            AND source_support."sourceRole" = 'user'
            AND aiqsa_memory_message_dependency_valid(
              p_user_id,
              support_message."id",
              support_message."updatedAt"
            )
        )
      )
  );
$function$;

CREATE OR REPLACE FUNCTION aiqsa_memory_fact_dependencies_valid(
  p_user_id TEXT,
  p_target_version_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  WITH RECURSIVE dependency_chain AS (
    SELECT
      dependency."id",
      dependency."targetFactVersionId",
      dependency."sourceMessageId",
      dependency."sourceMessageUpdatedAt",
      dependency."sourceFactVersionId",
      1 AS depth,
      ARRAY[p_target_version_id, dependency."sourceFactVersionId"]::TEXT[] AS visited,
      dependency."sourceFactVersionId" = p_target_version_id AS cycle
    FROM "MemoryFactVersionSourceDependency" AS dependency
    WHERE dependency."userId" = p_user_id
      AND dependency."targetFactVersionId" = p_target_version_id

    UNION ALL

    SELECT
      nested."id",
      nested."targetFactVersionId",
      nested."sourceMessageId",
      nested."sourceMessageUpdatedAt",
      nested."sourceFactVersionId",
      parent.depth + 1,
      parent.visited || nested."sourceFactVersionId",
      nested."sourceFactVersionId" = ANY(parent.visited)
    FROM dependency_chain AS parent
    INNER JOIN "MemoryFactVersionSourceDependency" AS nested
      ON nested."userId" = p_user_id
      AND nested."targetFactVersionId" = parent."sourceFactVersionId"
    WHERE parent."sourceFactVersionId" IS NOT NULL
      AND NOT parent.cycle
      AND parent.depth <= 2
  )
  SELECT NOT EXISTS (
    SELECT 1
    FROM dependency_chain AS dependency
    WHERE dependency.cycle
      OR dependency.depth > 2
      OR (
        dependency."sourceMessageId" IS NOT NULL
        AND NOT aiqsa_memory_message_dependency_valid(
          p_user_id,
          dependency."sourceMessageId",
          dependency."sourceMessageUpdatedAt"
        )
      )
      OR (
        dependency."sourceFactVersionId" IS NOT NULL
        AND NOT aiqsa_memory_dependency_source_version_valid(
          p_user_id,
          dependency."sourceFactVersionId"
        )
      )
  );
$function$;

CREATE OR REPLACE FUNCTION aiqsa_memory_dependency_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Memory source dependencies are immutable'
      USING ERRCODE = '23514';
  END IF;

  -- Serialize the small owner-scoped dependency graph so two concurrent raw
  -- inserts cannot each miss the other's uncommitted edge and form a cycle.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'aiqsa:memory-dependency:' || NEW."userId",
    0
  ));

  IF NEW."sourceMessageId" IS NOT NULL THEN
    IF NOT aiqsa_memory_message_dependency_valid(
      NEW."userId",
      NEW."sourceMessageId",
      NEW."sourceMessageUpdatedAt"
    ) THEN
      RAISE EXCEPTION 'Memory message dependency is not admissible'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT aiqsa_memory_dependency_source_version_valid(
      NEW."userId",
      NEW."sourceFactVersionId"
    ) THEN
      RAISE EXCEPTION 'Memory fact dependency is not admissible'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      WITH RECURSIVE source_chain AS (
        SELECT
          dependency."sourceFactVersionId",
          1 AS depth,
          ARRAY[NEW."targetFactVersionId", NEW."sourceFactVersionId"]::TEXT[] AS visited,
          dependency."sourceFactVersionId" = NEW."targetFactVersionId" AS cycle
        FROM "MemoryFactVersionSourceDependency" AS dependency
        WHERE dependency."userId" = NEW."userId"
          AND dependency."targetFactVersionId" = NEW."sourceFactVersionId"

        UNION ALL

        SELECT
          dependency."sourceFactVersionId",
          parent.depth + 1,
          parent.visited || dependency."sourceFactVersionId",
          dependency."sourceFactVersionId" = ANY(parent.visited)
        FROM source_chain AS parent
        INNER JOIN "MemoryFactVersionSourceDependency" AS dependency
          ON dependency."userId" = NEW."userId"
          AND dependency."targetFactVersionId" = parent."sourceFactVersionId"
        WHERE parent."sourceFactVersionId" IS NOT NULL
          AND NOT parent.cycle
          AND parent.depth <= 2
      )
      SELECT 1 FROM source_chain
      WHERE cycle OR depth >= 2
    ) THEN
      RAISE EXCEPTION 'Memory dependency graph is cyclic or exceeds depth two'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryFactVersionSourceDependency_guard"
BEFORE INSERT OR UPDATE ON "MemoryFactVersionSourceDependency"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_dependency_guard();

CREATE OR REPLACE FUNCTION aiqsa_memory_entity_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'MemoryEntity' THEN
    IF TG_OP = 'UPDATE' THEN
      IF (
        NEW."userId", NEW."canonicalKey", NEW."entityType", NEW."displayName",
        NEW."languageCode", NEW."createdAt"
      ) IS DISTINCT FROM (
        OLD."userId", OLD."canonicalKey", OLD."entityType", OLD."displayName",
        OLD."languageCode", OLD."createdAt"
      ) THEN
        RAISE EXCEPTION 'Memory entity identity is immutable'
          USING ERRCODE = '23514';
      END IF;
      IF OLD."state" = 'MERGED'
         AND (NEW."state", NEW."mergedIntoId") IS DISTINCT FROM
           (OLD."state", OLD."mergedIntoId") THEN
        RAISE EXCEPTION 'Memory entity merge is immutable'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW."state" = 'MERGED' THEN
      IF NEW."mergedIntoId" = NEW."id" OR NOT EXISTS (
        SELECT 1 FROM "MemoryEntity" AS root
        WHERE root."userId" = NEW."userId"
          AND root."id" = NEW."mergedIntoId"
          AND root."state" = 'ACTIVE'
          AND root."mergedIntoId" IS NULL
      ) THEN
        RAISE EXCEPTION 'Memory entity merge target is cyclic or unavailable'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Memory entity provenance rows are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "MemoryEntity_guard"
BEFORE INSERT OR UPDATE ON "MemoryEntity"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_entity_guard();

CREATE TRIGGER "MemoryEntityAlias_guard"
BEFORE UPDATE ON "MemoryEntityAlias"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_entity_guard();

CREATE TRIGGER "MemoryEntityAliasSupport_guard"
BEFORE UPDATE ON "MemoryEntityAliasSupport"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_entity_guard();

CREATE TRIGGER "MemoryFactVersionEntity_guard"
BEFORE UPDATE ON "MemoryFactVersionEntity"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_entity_guard();

CREATE OR REPLACE FUNCTION aiqsa_memory_alias_requires_support()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "MemoryEntityAlias" AS alias
    WHERE alias."userId" = NEW."userId" AND alias."id" = NEW."id"
  ) AND NOT EXISTS (
    SELECT 1 FROM "MemoryEntityAliasSupport" AS support
    WHERE support."userId" = NEW."userId" AND support."aliasId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'Memory entity alias requires durable support'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "MemoryEntityAlias_support_required"
AFTER INSERT OR UPDATE ON "MemoryEntityAlias"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_alias_requires_support();

CREATE OR REPLACE FUNCTION aiqsa_memory_delete_unsupported_alias()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM "MemoryEntityAlias" AS alias
  WHERE alias."userId" = OLD."userId"
    AND alias."id" = OLD."aliasId"
    AND NOT EXISTS (
      SELECT 1 FROM "MemoryEntityAliasSupport" AS support
      WHERE support."userId" = alias."userId"
        AND support."aliasId" = alias."id"
    );
  RETURN NULL;
END;
$function$;

CREATE TRIGGER "MemoryEntityAliasSupport_cleanup"
AFTER DELETE ON "MemoryEntityAliasSupport"
FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_delete_unsupported_alias();
