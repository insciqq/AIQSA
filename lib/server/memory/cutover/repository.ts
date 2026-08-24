import { Prisma, type MemoryJobState, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
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

export const MEMORY_RETRIEVAL_CUTOVER_VERSION =
  "memory-vnext-retrieval-cutover-v1";

const nonterminalStates: readonly MemoryJobState[] = [
  "CLAIMED",
  "QUEUED",
  "RETRYABLE_FAILED",
  "WAITING_FOR_EGRESS_CONSENT"
];

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
    const inventory = await rebuild.inventory(userId, now);
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
    const failed = inventory.activeGenerationId
      ? await client.memoryIndexGeneration.findFirst({
          orderBy: [{ generation: "desc" }, { id: "desc" }],
          select: { id: true },
          where: {
            OR: [
              {
                indexMode: "HYBRID",
                retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
              },
              {
                indexMode: "LEXICAL_ONLY",
                retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION
              }
            ],
            sourceIndexGenerationId: inventory.activeGenerationId,
            state: { in: ["CANCELLED", "FAILED"] },
            userId
          }
        })
      : null;
    if (failed) {
      return {
        generationId: failed.id,
        inventory,
        jobId: null,
        kind: "blocked_failed"
      };
    }
    const admitted = await rebuild.admit(userId, {
      expectedMemoryRevision: settings.memoryRevision,
      expectedSettingsRevision: settings.settingsRevision,
      operation: "REBUILD_SEARCH_INDEX",
      requestIdentity: {
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
        WHERE settings."useMemoryFacts" = TRUE
          AND (
            active."id" IS NULL
            OR active."indexedThroughMemoryRevision" <> settings."memoryRevision"
            OR active."languageProfile" <> ${MEMORY_LEXICAL_LANGUAGE_PROFILE}
            OR active."normalizationVersion" <> ${MEMORY_LEXICAL_NORMALIZATION_VERSION}
            OR active."chunkingVersion" <> ${MEMORY_LEXICAL_CHUNKING_VERSION}
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
          )
          AND NOT EXISTS (
            SELECT 1 FROM "MemoryJob" AS running
            WHERE running."userId" = settings."userId"
              AND running."kind" = 'REBUILD_INDEX'::"MemoryJobKind"
              AND running."state" IN (
                'CLAIMED'::"MemoryJobState",
                'QUEUED'::"MemoryJobState",
                'RETRYABLE_FAILED'::"MemoryJobState",
                'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState"
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM "MemoryIndexGeneration" AS failed
            WHERE failed."userId" = settings."userId"
              AND failed."sourceIndexGenerationId" = active."id"
              AND failed."state" IN (
                'FAILED'::"MemoryIndexGenerationState",
                'CANCELLED'::"MemoryIndexGenerationState"
              )
              AND failed."retrievalPipelineVersion" = CASE failed."indexMode"
                WHEN 'HYBRID'::"MemoryIndexMode"
                  THEN ${MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION}
                ELSE ${MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION}
              END
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
