-- A cross-fact identity correction deliberately retracts the obsolete fact
-- container while retaining its immutable source version and evidence. Keep
-- that moved source admissible as dependency provenance; ordinary retractions
-- without a move target remain an immediate fail-closed fence.

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
        'FORGOTTEN'::"MemoryFactState"
      )
      AND (
        source_fact."state" <> 'RETRACTED'::"MemoryFactState"
        OR source_fact."movedToFactId" IS NOT NULL
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
