import {
  Prisma,
  type MemoryDeletionState,
  type MemoryJobState,
  type PrismaClient,
  type UserMemorySettings
} from "@prisma/client";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../../memory/history/chunking";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "../../memory/history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../../memory/history/sourceProjection";
import {
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  MEMORY_RECALL_ROUND_PROJECTION_VERSION
} from "../../memory/history/rounds";
import { memoryPersonalFactEvidencePredicate } from "../../memory/persistence/eligibility";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION
} from "../../memory/persistence/lexical";
import { memoryCanonicalGlobalScopePredicate } from "../../memory/persistence/scopes";
import { memoryOrphanShadowPredicate } from "../../memory/rebuild/lifecycle";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../../memory/retrieval/vector";
import {
  ADMIN_MEMORY_WORKER_PROGRESS_STALE_MS,
  type AdminMemoryRebuildCandidate,
  type AdminMemoryStatusRepository
} from "./statusService";

import { readAdminMemoryProcessing } from "./processingRepository";
import { currentMemoryJobsSql } from "../../memory/coordinator/currentJobs";
import { readMemoryRecoveryStatus } from "../../memory/coordinator/recoveryStatus";
import type { AdminMemoryStatus } from "../../../contracts/adminMemory";

const ACTIVE_JOB_STATES = Object.freeze([
  "QUEUED",
  "WAITING_FOR_CONFIGURATION",
  "WAITING_FOR_EGRESS_CONSENT",
  "CLAIMED",
  "RETRYABLE_FAILED"
] as const satisfies readonly MemoryJobState[]);

const ACTIVE_DELETION_STATES = Object.freeze([
  "PENDING",
  "RUNNING",
  "RETRY_WAIT",
  "BLOCKED_REQUIRES_ADMIN"
] as const satisfies readonly MemoryDeletionState[]);

type StartRebuild = (candidate: AdminMemoryRebuildCandidate) => Promise<void>;

type StaleChunkOwner = Readonly<{ userId: string }>;
type HeartbeatRow = Readonly<{ lastSeenAt: Date; ready: boolean }>;
type ActivityRow = Readonly<{
  hasStalledClaims: boolean;
  lastProgressAt: Date | null;
  lastSuccessfulJobAt: Date | null;
  activeStages: AdminMemoryStatus["worker"]["activeStages"];
}>;
type QueueRow = Readonly<{
  inProgress: bigint;
  oldestQueuedAt: Date | null;
  waiting: bigint;
}>;

function boundedLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Configured model";
  const candidate = trimmed.slice(0, 200);
  return /[\uD800-\uDBFF]$/u.test(candidate) ? candidate.slice(0, -1) : candidate;
}

function generationConfigurationCurrent(generation: Readonly<{
  chunkingVersion: string;
  contextualKeyPolicyVersion: string | null;
  embeddingProviderModelId: string | null;
  indexMode: "HYBRID" | "LEXICAL_ONLY";
  languageProfile: string;
  normalizationVersion: string;
  retrievalPipelineVersion: string;
  roundProjectionVersion: string | null;
  state: string;
}>, embeddingProviderModelId: string | null): boolean {
  if (
    generation.state !== "ACTIVE" ||
    generation.chunkingVersion !== MEMORY_LEXICAL_CHUNKING_VERSION ||
    generation.contextualKeyPolicyVersion !== MEMORY_CONTEXTUAL_KEY_POLICY_VERSION ||
    generation.languageProfile !== MEMORY_LEXICAL_ANALYSIS_PROFILE ||
    generation.normalizationVersion !== MEMORY_LEXICAL_NORMALIZATION_VERSION ||
    generation.roundProjectionVersion !== MEMORY_RECALL_ROUND_PROJECTION_VERSION
  ) {
    return false;
  }
  if (generation.indexMode === "HYBRID") {
    return generation.retrievalPipelineVersion === MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION &&
      generation.embeddingProviderModelId === embeddingProviderModelId;
  }
  return embeddingProviderModelId === null &&
    generation.embeddingProviderModelId === null &&
    generation.retrievalPipelineVersion === MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION;
}

export function createPrismaAdminMemoryStatusRepository(
  client: PrismaClient,
  startRebuild: StartRebuild,
  recoverEligible?: (input: Readonly<{ limit: number; now: Date }>) => Promise<number>
): AdminMemoryStatusRepository {
  return Object.freeze({
    async read(now) {
      const settings = await client.$queryRaw<Array<Pick<UserMemorySettings,
        | "activeIndexGenerationId" | "embeddingProviderModelId"
        | "memoryRevision" | "settingsRevision" | "userId"
      >>>(Prisma.sql`
        SELECT settings."activeIndexGenerationId", settings."embeddingProviderModelId",
          settings."memoryRevision", settings."settingsRevision", settings."userId"
        FROM "UserMemorySettings" AS settings
        INNER JOIN "User" AS owner ON owner.id = settings."userId"
          AND owner.status = 'active'::"UserStatus"
        WHERE settings."referenceChatHistory" OR settings."useMemoryFacts"
        ORDER BY settings."userId" ASC
      `);
      const ownerIds = settings.map(({ userId }) => userId);
      const generationIds = settings.flatMap(({ activeIndexGenerationId }) =>
        activeIndexGenerationId ? [activeIndexGenerationId] : []);
      const [
        modelPolicy,
        memoryPolicy,
        generations,
        rebuildingRows,
        shadowGenerationRows,
        historyReindexingRows,
        pendingClassificationRows,
        staleChunkOwners,
        queue,
        processing,
        heartbeat,
        activity,
        recovery
      ] = await Promise.all([
        client.modelPolicy.findUnique({
          select: {
            memoryAdmissionTimeoutSeconds: true,
            version: true
          },
          where: { id: "installation" }
        }),
        client.memoryUtilityModelPolicy.findUnique({
          select: { providerModelId: true },
          where: { id: "installation" }
        }),
        generationIds.length === 0
          ? Promise.resolve([])
          : client.memoryIndexGeneration.findMany({
              select: {
                chunkingVersion: true,
                contextualKeyPolicyVersion: true,
                embeddingProviderModelId: true,
                generation: true,
                id: true,
                indexMode: true,
                languageProfile: true,
                normalizationVersion: true,
                retrievalPipelineVersion: true,
                roundProjectionVersion: true,
                state: true,
                userId: true
              },
              where: { id: { in: generationIds } }
            }),
        ownerIds.length === 0
          ? Promise.resolve([])
          : client.memoryJob.findMany({
              distinct: ["userId"],
              select: { userId: true },
              where: {
                kind: "REBUILD_INDEX",
                state: { in: [...ACTIVE_JOB_STATES] },
                userId: { in: ownerIds }
              }
            }),
        ownerIds.length === 0
          ? Promise.resolve([])
          : client.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
              SELECT DISTINCT shadow."userId" FROM "MemoryIndexGeneration" shadow
              WHERE shadow."userId" IN (${Prisma.join(ownerIds)})
                AND shadow.state IN ('BUILDING', 'CATCHING_UP', 'READY')
                AND NOT (${memoryOrphanShadowPredicate(Prisma.sql`shadow`)})
            `),
        ownerIds.length === 0
          ? Promise.resolve([])
          : client.memoryJob.findMany({
              distinct: ["userId"],
              select: { userId: true },
              where: {
                kind: "INDEX_HISTORY",
                pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
                state: { in: [...ACTIVE_JOB_STATES] },
                userId: { in: ownerIds }
              }
            }),
        ownerIds.length === 0
          ? Promise.resolve([])
          : client.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
              SELECT DISTINCT version."userId"
              FROM "MemoryFactVersion" AS version
              INNER JOIN "MemoryFact" AS fact
                ON fact."userId" = version."userId"
                AND fact."id" = version."factId"
                AND fact."state" = 'ACTIVE'::"MemoryFactState"
                AND fact."currentVersionId" = version."id"
              INNER JOIN "MemoryScope" AS scope
                ON scope."userId" = fact."userId"
                AND scope."id" = fact."scopeId"
                AND scope."state" = 'ACTIVE'::"MemoryScopeState"
              WHERE version."userId" IN (${Prisma.join(ownerIds)})
                AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
                AND version."safetyClassificationState" =
                  'PENDING'::"MemorySafetyClassificationState"
                AND ${memoryCanonicalGlobalScopePredicate()}
                AND ${memoryPersonalFactEvidencePredicate(Prisma.sql`version."userId"`)}
            `),
        ownerIds.length === 0
          ? Promise.resolve([] as StaleChunkOwner[])
          : client.$queryRaw<StaleChunkOwner[]>(Prisma.sql`
              SELECT DISTINCT stale_history."userId"
              FROM (
                SELECT checkpoint."userId"
                FROM "ChatMemoryCheckpoint" AS checkpoint
                INNER JOIN "Chat" AS chat
                  ON chat."userId" = checkpoint."userId"
                  AND chat."id" = checkpoint."chatId"
                INNER JOIN "Message" AS leaf
                  ON leaf."chatId" = chat."id"
                  AND leaf."id" = chat."activeLeafMessageId"
                  AND leaf."role" = 'assistant'
                  AND leaf."status" = 'complete'::"MessageStatus"
                WHERE checkpoint."userId" IN (${Prisma.join(ownerIds)})
                  AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
                  AND checkpoint."pipelineVersion" <>
                    ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
                  AND checkpoint."activeLeafMessageId" = chat."activeLeafMessageId"
                  AND checkpoint."branchGeneration" = chat."memoryBranchGeneration"
                  AND checkpoint."sourceRevision" = chat."memorySourceRevision"
                  AND checkpoint."lastIndexedMessageId" = chat."activeLeafMessageId"
                  AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
                  AND chat."projectId" IS NULL
                  AND leaf."createdAt" > COALESCE((
                    SELECT MAX(barrier."sourceCreatedAtCutoff")
                    FROM "MemorySourceBarrier" AS barrier
                    WHERE barrier."userId" = chat."userId"
                      AND barrier."explicitOverrideAllowed" = FALSE
                      AND barrier."kind" IN (
                        'ALL_REUSABLE'::"MemorySourceBarrierKind",
                        'HISTORY_INDEX'::"MemorySourceBarrierKind"
                      )
                  ), TO_TIMESTAMP(0))

                UNION ALL

                SELECT entry."userId"
                FROM "MemorySearchEntry" AS entry
                INNER JOIN "MemoryRecallChunk" AS chunk
                  ON chunk."userId" = entry."userId"
                  AND chunk."id" = entry."recallChunkId"
                INNER JOIN "UserMemorySettings" AS settings
                  ON settings."userId" = entry."userId"
                  AND settings."activeIndexGenerationId" = entry."indexGenerationId"
                INNER JOIN "Chat" AS chat
                  ON chat."userId" = chunk."userId"
                  AND chat."id" = chunk."chatId"
                  AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
                  AND chat."projectId" IS NULL
                  AND chat."memoryBranchGeneration" = chunk."branchGeneration"
                  AND chat."memorySourceRevision" = chunk."sourceRevisionAtCreation"
                INNER JOIN "Message" AS leaf
                  ON leaf."chatId" = chat."id"
                  AND leaf."id" = chat."activeLeafMessageId"
                  AND leaf."role" = 'assistant'
                  AND leaf."status" = 'complete'::"MessageStatus"
                WHERE entry."userId" IN (${Prisma.join(ownerIds)})
                  AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
                  AND (
                    chunk."chunkingVersion" <> ${MEMORY_HISTORY_CHUNKING_VERSION}
                    OR chunk."sourceProjectionVersion" <>
                      ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
                  )
                  AND leaf."createdAt" > COALESCE((
                    SELECT MAX(barrier."sourceCreatedAtCutoff")
                    FROM "MemorySourceBarrier" AS barrier
                    WHERE barrier."userId" = chat."userId"
                      AND barrier."explicitOverrideAllowed" = FALSE
                      AND barrier."kind" IN (
                        'ALL_REUSABLE'::"MemorySourceBarrierKind",
                        'HISTORY_INDEX'::"MemorySourceBarrierKind"
                      )
                  ), TO_TIMESTAMP(0))
              ) AS stale_history
            `),
        // One statement keeps counts and waiting age on the same snapshot while
        // workers claim/settle jobs. Private job identities never leave the DB.
        client.$queryRaw<QueueRow[]>(Prisma.sql`
          WITH ${currentMemoryJobsSql(now)}
          SELECT
            COUNT(*) FILTER (WHERE work."inProgress") AS "inProgress",
            COUNT(*) FILTER (WHERE NOT work."inProgress") AS "waiting",
            MIN(work."createdAt") FILTER (WHERE NOT work."inProgress") AS "oldestQueuedAt"
          FROM (
            SELECT "state" = 'CLAIMED'::"MemoryJobState" AS "inProgress", "createdAt"
            FROM current_jobs
            WHERE "state" IN (${Prisma.join(ACTIVE_JOB_STATES.map((state) => Prisma.sql`${state}::"MemoryJobState"`))})
            UNION ALL
            SELECT "state" = 'RUNNING'::"MemoryDeletionState" AS "inProgress", "createdAt"
            FROM "MemoryDeletionOutbox"
            WHERE "state" IN (${Prisma.join(ACTIVE_DELETION_STATES.map((state) => Prisma.sql`${state}::"MemoryDeletionState"`))})
          ) AS work
        `).then((rows) => {
          if (!rows[0]) throw new Error("memory_admin_status_queue_invalid");
          return rows[0];
        }),
        readAdminMemoryProcessing(client, now),
        client.$queryRaw<HeartbeatRow[]>(Prisma.sql`
          SELECT "lastSeenAt", ready
          FROM "MemoryWorkerHeartbeat"
          WHERE "id" = 'installation'
          LIMIT 1
        `).then((rows) => rows[0] ?? null),
        client.$queryRaw<ActivityRow[]>(Prisma.sql`
          WITH ${currentMemoryJobsSql(now)}
          SELECT MAX("progressAt") AS "lastProgressAt",
            MAX("completedAt") FILTER (WHERE succeeded) AS "lastSuccessfulJobAt",
            COALESCE(bool_or(active AND COALESCE("progressAt", "createdAt") <=
              ${new Date(now.getTime() - ADMIN_MEMORY_WORKER_PROGRESS_STALE_MS)}), false) AS "hasStalledClaims",
            COALESCE(array_agg(DISTINCT stage) FILTER (WHERE active), ARRAY[]::text[]) AS "activeStages"
          FROM (
            SELECT "progressAt", "createdAt", "completedAt", state = 'SUCCEEDED'::"MemoryJobState" AS succeeded,
              stage, state = 'CLAIMED'::"MemoryJobState" AS active
            FROM current_jobs
            UNION ALL
            SELECT "progressAt", "createdAt", "completedAt", state = 'SUCCEEDED'::"MemoryDeletionState" AS succeeded,
              'DELETION' AS stage, state = 'RUNNING'::"MemoryDeletionState" AS active
            FROM "MemoryDeletionOutbox"
          ) AS work
        `).then((rows) => {
          if (!rows[0]) throw new Error("memory_admin_status_activity_invalid");
          return rows[0];
        }),
        readMemoryRecoveryStatus(client, now)
      ]);
      if (!modelPolicy) throw new Error("installation_model_policy_missing");
      const admissionTimeoutSeconds = Number(modelPolicy.memoryAdmissionTimeoutSeconds);
      if (!Number.isSafeInteger(admissionTimeoutSeconds)) {
        throw new Error("installation_memory_admission_timeout_invalid");
      }

      const selectedModelIds = [...new Set([
        ...(memoryPolicy?.providerModelId ? [memoryPolicy.providerModelId] : []),
        ...settings.flatMap(({ embeddingProviderModelId }) =>
          embeddingProviderModelId ? [embeddingProviderModelId] : [])
      ])];
      const modelRows = selectedModelIds.length === 0
        ? []
        : await client.providerModel.findMany({
            orderBy: [
              { connection: { displayName: "asc" } },
              { displayName: "asc" },
              { id: "asc" }
            ],
            select: {
              connection: { select: { displayName: true } },
              displayName: true,
              id: true
            },
            where: { id: { in: selectedModelIds } }
          });
      const configuredTargets = [...new Map(modelRows.map((row) => {
        const target = {
          model: boundedLabel(row.displayName),
          provider: boundedLabel(row.connection.displayName)
        };
        return [`${target.provider}\u0000${target.model}`, target] as const;
      })).values()].slice(0, 64);

      const generationById = new Map(generations.map((row) => [row.id, row]));
      const pendingOwners = new Set(pendingClassificationRows.map(({ userId }) => userId));
      const staleOwners = new Set(staleChunkOwners.map(({ userId }) => userId));
      const rebuildingOwners = new Set([
        ...rebuildingRows.map(({ userId }) => userId),
        ...shadowGenerationRows.map(({ userId }) => userId),
        ...historyReindexingRows.flatMap(({ userId }) =>
          staleOwners.has(userId) ? [userId] : [])
      ]);
      let requiresRebuild = false;
      const rebuildCandidates: AdminMemoryRebuildCandidate[] = [];
      for (const owner of settings) {
        const active = owner.activeIndexGenerationId
          ? generationById.get(owner.activeIndexGenerationId) ?? null
          : null;
        const configurationStale = !active ||
          !generationConfigurationCurrent(active, owner.embeddingProviderModelId);
        const historyStale = staleOwners.has(owner.userId);
        const required = configurationStale || historyStale;
        if (!required) continue;
        requiresRebuild = true;
        if (pendingOwners.has(owner.userId) || rebuildingOwners.has(owner.userId)) continue;
        const needsEmbedding = Boolean(owner.embeddingProviderModelId) && (
          !active ||
          active.indexMode !== "HYBRID" ||
          active.embeddingProviderModelId !== owner.embeddingProviderModelId
        );
        rebuildCandidates.push({
          embeddingDeploymentId: needsEmbedding ? owner.embeddingProviderModelId : null,
          expectedMemoryRevision: owner.memoryRevision,
          expectedSettingsRevision: owner.settingsRevision,
          operation: configurationStale
            ? needsEmbedding ? "REEMBED" : "REBUILD_SEARCH_INDEX"
            : "REINDEX_HISTORY",
          userId: owner.userId
        });
      }
      return Object.freeze({
        admissionTimeout: Object.freeze({
          seconds: admissionTimeoutSeconds,
          version: modelPolicy.version
        }),
        processing,
        recovery,
        configuredTargets: Object.freeze(configuredTargets),
        index: Object.freeze({
          activeGenerations: Object.freeze(generations.map(({ generation }) => generation)),
          ownerCount: settings.length,
          preparing: pendingOwners.size > 0,
          rebuildCandidates: Object.freeze(rebuildCandidates),
          rebuilding: rebuildingOwners.size > 0,
          requiresRebuild
        }),
        inProgressCount: Number(queue.inProgress),
        oldestQueuedAt: queue.oldestQueuedAt,
        queueLength: Number(queue.waiting),
        workerLastSeenAt: heartbeat?.lastSeenAt ?? null,
        workerReady: heartbeat?.ready ?? false,
        workerHasStalledClaims: activity.hasStalledClaims,
        workerLastProgressAt: activity.lastProgressAt,
        workerLastSuccessfulJobAt: activity.lastSuccessfulJobAt,
        workerActiveStages: activity.activeStages
      });
    },

    startRebuild,

    ...(recoverEligible ? { recoverEligible } : {}),

    async updateAdmissionTimeout(input) {
      const result = await client.modelPolicy.updateMany({
        data: {
          memoryAdmissionTimeoutSeconds: BigInt(input.seconds),
          updatedByUserId: input.userId,
          version: { increment: 1 }
        },
        where: {
          id: "installation",
          version: input.expectedVersion
        }
      });
      return result.count === 1;
    }
  });
}
