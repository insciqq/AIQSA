import { Prisma } from "@prisma/client";

/** Current work shared by operational status and recovery admission. Content
 * and provider payloads are never selected. Execution still reauthorizes its
 * exact source and accepted destination before dispatch and publication. */
export function currentMemoryJobsSql(now: Date): Prisma.Sql {
  return Prisma.sql`
    current_jobs AS (
        SELECT job.id, job."userId", job.kind, job.state, job."errorCode", job."createdAt",
          job."completedAt", job."progressAt", job."sourceMessageId", job."targetFactVersionId", job."chatId",
          job."activeLeafMessageId", job."branchGeneration", job."sourceRevision", job."sourceHash",
          job."memoryGenerationSnapshot", job."memoryRevisionSnapshot", job."pipelineVersion",
          job."idempotencyFingerprint", job."attemptCount", job."stage" AS "workStage",
          job."recoveryCount", job."lastRecoveryAt", job."recoveryErrorCode", job."nextAttemptAt",
          CASE
            WHEN job.kind IN ('EXTRACT_FACTS', 'CONSOLIDATE_CANDIDATE', 'VERIFY_CANDIDATE', 'RESOLVE_FACT_RELATIONS') THEN 'LEARNING'
            WHEN job.kind = 'INDEX_HISTORY' THEN 'HISTORY'
            WHEN job.kind IN ('EMBED_ITEMS', 'REBUILD_INDEX') THEN 'INDEXING'
            WHEN job.kind = 'SYNTHESIZE_MEMORIES' THEN 'SYNTHESIS'
            ELSE 'MAINTENANCE'
          END AS stage
        FROM "MemoryJob" AS job
        JOIN "UserMemorySettings" AS settings ON settings."userId" = job."userId"
          AND settings."memoryGeneration" = job."memoryGenerationSnapshot"
        JOIN "User" AS owner ON owner.id = job."userId" AND owner.status = 'active'::"UserStatus"
        LEFT JOIN "Chat" AS chat ON chat.id = job."chatId" AND chat."userId" = job."userId"
        LEFT JOIN "Message" AS source ON source.id = job."sourceMessageId" AND source."chatId" = chat.id
        WHERE job.state NOT IN ('CANCELLED', 'STALE') AND job."createdAt" <= ${now}
          AND (job.state = 'SUCCEEDED' OR job.kind NOT IN ('RECLASSIFY_FACTS', 'SYNTHESIZE_MEMORIES')
            OR job."memoryRevisionSnapshot" = settings."memoryRevision")
          AND CASE
            WHEN job.kind = 'INDEX_HISTORY' THEN settings."useMemoryFacts" AND settings."referenceChatHistory"
            WHEN job.kind IN ('EXTRACT_FACTS', 'CONSOLIDATE_CANDIDATE', 'VERIFY_CANDIDATE', 'RESOLVE_FACT_RELATIONS')
              THEN settings."useMemoryFacts" AND settings."learnAutomatically"
            WHEN job.kind = 'SYNTHESIZE_MEMORIES' THEN settings."useMemoryFacts" AND settings."synthesisEnabled"
            ELSE settings."useMemoryFacts"
          END
          AND (job."chatId" IS NULL OR (
            chat.id IS NOT NULL AND chat."projectId" IS NULL AND chat."permanentDeletionAt" IS NULL
            AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
            AND (job."branchGeneration" IS NULL OR job."branchGeneration" = chat."memoryBranchGeneration")
            AND (job."sourceRevision" IS NULL OR job."sourceRevision" = chat."memorySourceRevision")
            AND (job."activeLeafMessageId" IS NULL OR job."activeLeafMessageId" = chat."activeLeafMessageId")
            AND (job."sourceMessageId" IS NULL OR source.id IS NOT NULL)
          ))
          AND (job."targetFactVersionId" IS NULL OR EXISTS (
            SELECT 1 FROM "MemoryFactVersion" AS version
            JOIN "MemoryFact" AS fact ON fact.id = version."factId" AND fact."userId" = version."userId"
              AND fact."currentVersionId" = version.id AND fact.state = 'ACTIVE'::"MemoryFactState"
            JOIN "MemoryScope" AS scope ON scope.id = fact."scopeId" AND scope."userId" = fact."userId"
              AND scope.state = 'ACTIVE'::"MemoryScopeState" AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
            WHERE version.id = job."targetFactVersionId" AND version."userId" = job."userId"
              AND version.state = 'ACTIVE'::"MemoryFactVersionState"
          ))
          AND NOT EXISTS (
            SELECT 1 FROM "MemorySourceBarrier" AS barrier
            WHERE barrier."userId" = job."userId" AND NOT barrier."explicitOverrideAllowed"
              AND COALESCE(source."createdAt", job."createdAt") <= barrier."sourceCreatedAtCutoff"
              AND (barrier.kind = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
                OR (barrier.kind = 'HISTORY_INDEX'::"MemorySourceBarrierKind" AND job.kind = 'INDEX_HISTORY')
                OR (barrier.kind = 'AUTOMATIC_FACTS'::"MemorySourceBarrierKind"
                  AND job.kind IN ('EXTRACT_FACTS', 'CONSOLIDATE_CANDIDATE', 'VERIFY_CANDIDATE', 'RESOLVE_FACT_RELATIONS')))
          )
          AND NOT EXISTS (
            SELECT 1 FROM "MemoryPauseInterval" AS pause
            WHERE pause."userId" = job."userId"
              AND COALESCE(source."createdAt", job."createdAt") >= pause."pausedAt"
              AND (pause."resumedAt" IS NULL OR COALESCE(source."createdAt", job."createdAt") <= pause."resumedAt")
              AND (pause.scope = 'MASTER' OR (pause.scope = 'AUTOMATIC_LEARNING'
                AND job.kind IN ('EXTRACT_FACTS', 'CONSOLIDATE_CANDIDATE', 'VERIFY_CANDIDATE', 'RESOLVE_FACT_RELATIONS'))
                OR (pause.scope = 'SEARCH_HISTORY' AND job.kind = 'INDEX_HISTORY'))
          )
      )
  `;
}
