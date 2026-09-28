import { Prisma, type MemoryJobState, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION
} from "../persistence/lexical";
import {
  createPrismaMemoryRebuildRepository,
  type MemoryGenerationRollbackResult,
  type MemoryRetrievalCutoverInventory
} from "../rebuild/repository";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from
  "../retrieval/vector";
import {
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  MEMORY_RECALL_ROUND_PROJECTION_VERSION
} from "../history/rounds";
import { MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION } from
  "../history/segments";
import { memoryOrphanShadowPredicate, memoryShadowCancelledByPausePredicate } from "../rebuild/lifecycle";
import { memoryShadowRebuildJobFingerprint } from "../rebuild/contract";

export const MEMORY_RETRIEVAL_CUTOVER_VERSION =
  "memory-vnext-retrieval-cutover-v1";

const nonterminalStates: readonly MemoryJobState[] = [
  "CLAIMED",
  "QUEUED",
  "RETRYABLE_FAILED",
  "WAITING_FOR_CONFIGURATION",
  "WAITING_FOR_EGRESS_CONSENT"
];

const TOOL_EVENT_TEXT_REPAIR_VERSION = "memory-tool-event-text-repair-v1";

function toolEventTextMismatch(userId: Prisma.Sql, generationId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "MemorySearchEntry" AS entry
    INNER JOIN "MemoryToolEvent" AS tool_event
      ON tool_event."userId" = entry."userId"
      AND tool_event."id" = entry."toolEventId"
    WHERE entry."userId" = ${userId}
      AND entry."indexGenerationId" = ${generationId}
      AND entry."itemType" = 'TOOL_EVENT'::"MemorySearchItemType"
      AND entry."normalizedSearchText" <> tool_event."normalizedSafeSearchText"
  )`;
}

function repairRequestIdentity(activeGenerationId: string) {
  return {
    activeGenerationId,
    domain: TOOL_EVENT_TEXT_REPAIR_VERSION,
    version: 1
  };
}

function failedToolEventRepairPredicate(): Prisma.Sql {
  // The JSON key order matches memorySha256's canonical request fingerprint.
  // Generation IDs are UUIDs, so interpolation cannot change JSON quoting.
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "MemoryIndexGeneration" AS repair
    INNER JOIN "MemoryJob" AS job
      ON job."userId" = repair."userId"
      AND job."kind" = 'REBUILD_INDEX'::"MemoryJobKind"
      AND job."idempotencyFingerprint" =
        'memory-shadow-rebuild-v2:r:' || repair.id || ':' ||
        encode(digest(
          '{"domain":"aiqsa.memory.shadow-rebuild-request","generationId":"' ||
          repair.id ||
          '","operation":"REBUILD_SEARCH_INDEX","requestIdentity":{"activeGenerationId":"' ||
          active.id || '","domain":"' || ${TOOL_EVENT_TEXT_REPAIR_VERSION} ||
          '","version":1},"version":"v1"}', 'sha256'), 'hex')
    WHERE repair."userId" = settings."userId"
      AND repair."sourceIndexGenerationId" = active.id
      AND repair.state IN (
        'FAILED'::"MemoryIndexGenerationState",
        'CANCELLED'::"MemoryIndexGenerationState"
      )
      AND NOT (${memoryShadowCancelledByPausePredicate(Prisma.sql`repair`)})
  )`;
}

export type MemoryRetrievalCutoverResult = Readonly<{
  generationId: string | null;
  inventory: MemoryRetrievalCutoverInventory;
  jobId: string | null;
  kind:
    | "already_current"
    | "blocked_failed"
    | "disabled"
    | "in_progress"
    | "queued"
    | "retry";
}>;

type ReconcileCandidate = Readonly<{ userId: string }>;

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100;
}

export function createPrismaMemoryRetrievalCutoverRepository(
  client: PrismaClient = prisma
) {
  const rebuild = createPrismaMemoryRebuildRepository(client);

  async function ensure(
    userId: string,
    now = new Date()
  ): Promise<MemoryRetrievalCutoverResult> {
    await rebuild.reconcileShadows(userId);
    let inventory = await rebuild.inventory(userId, now);
    if (!inventory.ready) {
      const promotion = await rebuild.promoteCompatibleActiveGeneration(
        userId,
        now
      );
      if (promotion.kind === "promoted") {
        inventory = await rebuild.inventory(userId, now);
      }
    }
    if (inventory.ready) {
      return {
        generationId: inventory.activeGenerationId,
        inventory,
        jobId: null,
        kind: "already_current"
      };
    }
    const settings = await client.userMemorySettings.findUnique({
      select: {
        memoryRevision: true,
        settingsRevision: true,
        useMemoryFacts: true
      },
      where: { userId }
    });
    if (!settings?.useMemoryFacts) {
      return {
        generationId: inventory.activeGenerationId,
        inventory,
        jobId: null,
        kind: "disabled"
      };
    }
    const running = await client.memoryJob.findFirst({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
      where: {
        kind: "REBUILD_INDEX",
        state: { in: [...nonterminalStates] },
        userId
      }
    });
    if (running) {
      return {
        generationId: inventory.activeGenerationId,
        inventory,
        jobId: running.id,
        kind: "in_progress"
      };
    }
    const repairNeeded = inventory.activeGenerationId
      ? (await client.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
          SELECT ${toolEventTextMismatch(
            Prisma.sql`${userId}`,
            Prisma.sql`${inventory.activeGenerationId}`
          )} AS present
        `))[0]?.present === true
      : false;
    const failed = inventory.activeGenerationId
      ? await client.$queryRaw<Array<{ id: string; idempotencyFingerprint: string | null }>>(Prisma.sql`
          SELECT failed.id, job."idempotencyFingerprint" FROM "MemoryIndexGeneration" failed
          LEFT JOIN "MemoryJob" job
            ON job."userId" = failed."userId"
            AND job."kind" = 'REBUILD_INDEX'::"MemoryJobKind"
            AND job."idempotencyFingerprint" LIKE
              ('memory-shadow-rebuild-v2:r:' || failed.id || ':%')
          WHERE failed."userId" = ${userId}
            AND failed."sourceIndexGenerationId" = ${inventory.activeGenerationId}
            AND failed.state IN ('CANCELLED', 'FAILED')
            AND failed."retrievalPipelineVersion" = CASE failed."indexMode"
              WHEN 'HYBRID' THEN ${MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION}
              ELSE ${MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION} END
            AND NOT (${memoryShadowCancelledByPausePredicate(Prisma.sql`failed`)})
          ORDER BY failed.generation DESC, failed.id DESC
        `)
      : [];
    const repairAttemptFailed = repairNeeded && inventory.activeGenerationId !== null &&
      failed.some((row) => row.idempotencyFingerprint ===
        memoryShadowRebuildJobFingerprint({
          generationId: row.id,
          operation: "REBUILD_SEARCH_INDEX",
          requestIdentity: repairRequestIdentity(inventory.activeGenerationId!)
        }));
    if (failed.length > 0 && (!repairNeeded || repairAttemptFailed)) {
      return {
        generationId: failed[0]!.id,
        inventory,
        jobId: null,
        kind: "blocked_failed"
      };
    }
    const admitted = await rebuild.admit(userId, {
      expectedMemoryRevision: settings.memoryRevision,
      expectedSettingsRevision: settings.settingsRevision,
      operation: "REBUILD_SEARCH_INDEX",
      requestIdentity: repairNeeded && inventory.activeGenerationId
        ? repairRequestIdentity(inventory.activeGenerationId)
        : {
            activeGenerationId: inventory.activeGenerationId,
            domain: MEMORY_RETRIEVAL_CUTOVER_VERSION,
            eligibleIdentityFingerprint: inventory.eligibleIdentityFingerprint,
            memoryRevision: inventory.memoryRevision,
            version: 1
          }
    });
    if (admitted.kind === "ok") {
      return {
        generationId: inventory.activeGenerationId,
        inventory,
        jobId: admitted.jobId,
        kind: "queued"
      };
    }
    if (admitted.kind === "in_progress") {
      const raced = await client.memoryJob.findFirst({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
        where: {
          kind: "REBUILD_INDEX",
          state: { in: [...nonterminalStates] },
          userId
        }
      });
      return {
        generationId: inventory.activeGenerationId,
        inventory,
        jobId: raced?.id ?? null,
        kind: "in_progress"
      };
    }
    return {
      generationId: inventory.activeGenerationId,
      inventory,
      jobId: null,
      kind: "retry"
    };
  }

  return Object.freeze({
    ensure,

    inventory(userId: string, now = new Date()) {
      return rebuild.inventory(userId, now);
    },

    async reconcile(input: Readonly<{
      limit?: number;
      now?: Date;
    }> = {}): Promise<readonly MemoryRetrievalCutoverResult[]> {
      const limit = input.limit ?? 25;
      if (!validLimit(limit)) throw new Error("memory_cutover_limit_invalid");
      const candidates = await client.$queryRaw<ReconcileCandidate[]>(Prisma.sql`
        SELECT settings."userId"
        FROM "UserMemorySettings" AS settings
        INNER JOIN "User" AS owner
          ON owner."id" = settings."userId" AND owner."status" = 'active'::"UserStatus"
        LEFT JOIN "MemoryIndexGeneration" AS active
          ON active."userId" = settings."userId"
          AND active."id" = settings."activeIndexGenerationId"
          AND active."state" = 'ACTIVE'::"MemoryIndexGenerationState"
        WHERE EXISTS (
          SELECT 1 FROM "MemoryIndexGeneration" shadow
          WHERE shadow."userId" = settings."userId"
            AND ${memoryOrphanShadowPredicate(Prisma.sql`shadow`)}
        ) OR (settings."useMemoryFacts" = TRUE
          AND (
            active."id" IS NULL
            OR active."indexedThroughMemoryRevision" <> settings."memoryRevision"
            OR EXISTS (
              SELECT 1 FROM "MemoryPauseInterval" AS pause
              WHERE pause."userId" = settings."userId"
                AND (
                  pause."scope" = 'MASTER'::"MemoryPauseScope"
                  OR (settings."referenceChatHistory" = TRUE
                    AND pause."scope" = 'SEARCH_HISTORY'::"MemoryPauseScope")
                )
                AND pause."resumedAt" > COALESCE(active."activatedAt", active."createdAt")
            )
            OR active."languageProfile" <> ${MEMORY_LEXICAL_ANALYSIS_PROFILE}
            OR active."normalizationVersion" <> ${MEMORY_LEXICAL_NORMALIZATION_VERSION}
            OR active."chunkingVersion" <> ${MEMORY_LEXICAL_CHUNKING_VERSION}
            OR active."contextualKeyPolicyVersion" IS DISTINCT FROM
              ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
            OR active."roundProjectionVersion" IS DISTINCT FROM
              ${MEMORY_RECALL_ROUND_PROJECTION_VERSION}
            OR active."roundSegmentProjectionVersion" IS DISTINCT FROM
              ${MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION}
            OR active."embeddingProviderModelId" IS DISTINCT FROM
              CASE active."indexMode"
                WHEN 'HYBRID'::"MemoryIndexMode" THEN settings."embeddingProviderModelId"
                ELSE NULL
              END
            OR active."retrievalPipelineVersion" <> CASE active."indexMode"
              WHEN 'HYBRID'::"MemoryIndexMode"
                THEN ${MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION}
              ELSE ${MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION}
            END
            OR ${toolEventTextMismatch(
              Prisma.sql`settings."userId"`, Prisma.sql`active."id"`
            )}
          )
          AND NOT EXISTS (
            SELECT 1 FROM "MemoryJob" AS running
            WHERE running."userId" = settings."userId"
              AND running."kind" = 'REBUILD_INDEX'::"MemoryJobKind"
              AND running."state" IN (
                'CLAIMED'::"MemoryJobState",
                'QUEUED'::"MemoryJobState",
                'RETRYABLE_FAILED'::"MemoryJobState",
                'WAITING_FOR_CONFIGURATION'::"MemoryJobState",
                'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState"
              )
          )
          AND (NOT EXISTS (
            SELECT 1 FROM "MemoryIndexGeneration" AS failed
            WHERE failed."userId" = settings."userId"
              AND failed."sourceIndexGenerationId" = active."id"
              AND failed."state" IN (
                'FAILED'::"MemoryIndexGenerationState",
                'CANCELLED'::"MemoryIndexGenerationState"
              )
              AND NOT (${memoryShadowCancelledByPausePredicate(Prisma.sql`failed`)})
              AND failed."retrievalPipelineVersion" = CASE failed."indexMode"
                WHEN 'HYBRID'::"MemoryIndexMode"
                  THEN ${MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION}
                ELSE ${MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION}
              END
          ) OR ${toolEventTextMismatch(
            Prisma.sql`settings."userId"`, Prisma.sql`active."id"`
          )})
          AND NOT (${failedToolEventRepairPredicate()})
        )
        ORDER BY settings."userId"
        LIMIT ${limit}
      `);
      const results: MemoryRetrievalCutoverResult[] = [];
      for (const candidate of candidates) {
        results.push(await ensure(candidate.userId, input.now ?? new Date()));
      }
      return results;
    },

    rollback(
      userId: string,
      targetGenerationId: string,
      input: Readonly<{
        expectedMemoryRevision: number;
        expectedSettingsRevision: number;
        now?: Date;
      }>
    ): Promise<MemoryGenerationRollbackResult> {
      return rebuild.rollbackGeneration(userId, targetGenerationId, input);
    }
  });
}

export type MemoryRetrievalCutoverRepository = ReturnType<
  typeof createPrismaMemoryRetrievalCutoverRepository
>;
