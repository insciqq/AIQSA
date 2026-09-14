import { Prisma, type PrismaClient } from "@prisma/client";
import {
  fuseMemoryRetrievalCandidates,
  MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
  planMemoryRetrieval
} from "../../../../domain/memory/retrieval";
import type { MemoryJobClaim } from "../../coordinator/types";
import {
  abortableMemoryRead,
  createMemoryRetrievalDeadline,
  MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
  MEMORY_SNAPSHOT_OPTIONAL_MAXIMUM_MS,
  runBoundedMemoryRead,
  runOptionalMemoryUtility
} from "../../retrieval/deadline";
import { createPrismaLocalMemoryRetrievalRepository } from "../../retrieval/localRepository";
import {
  createPrismaMemoryRunUtilityService,
  type MemoryRunQueryEmbeddingResult
} from "../../retrieval/runUtilities";
import { createPrismaMemoryVectorRepository } from "../../retrieval/vector";
import type { MemoryExecutionAuthorityDependencies } from "../../execution";
import {
  MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES,
  MEMORY_EXPLICIT_RELATION_RECENT_CANDIDATES,
  type MemoryExplicitRelationFact
} from "./explicitPolicy";

export function createPrismaMemoryExplicitRelationCandidateSearch(
  client: PrismaClient,
  authority: MemoryExecutionAuthorityDependencies
) {
  const repository = createPrismaLocalMemoryRetrievalRepository(client);
  const vectors = createPrismaMemoryVectorRepository(client);
  const utilities = createPrismaMemoryRunUtilityService(authority, client);
  return async (input: Readonly<{
    job: MemoryJobClaim;
    now: Date;
    signal: AbortSignal;
    source: MemoryExplicitRelationFact;
  }>): Promise<readonly string[]> => {
    input.signal.throwIfAborted();
    const { job, source, now } = input;
    // The small recent lane covers simultaneous saves and vector/index lag.
    // Every selected id is rejoined by explicitSnapshot before semantic use.
    const recent = await client.$queryRaw<Array<{ versionId: string }>>(Prisma.sql`
      SELECT version."id" AS "versionId"
      FROM "MemoryFact" AS fact
      JOIN "MemoryFactVersion" AS version
        ON version."userId" = fact."userId" AND version."id" = fact."currentVersionId"
          AND version."factId" = fact."id"
      WHERE fact."userId" = ${job.userId} AND fact."scopeId" = ${source.scopeId}
        AND fact."state" = 'ACTIVE'::"MemoryFactState"
        AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        AND version."id" <> ${source.versionId}
      ORDER BY fact."updatedAt" DESC, fact."id"
      LIMIT ${MEMORY_EXPLICIT_RELATION_RECENT_CANDIDATES}
    `);
    let ranked: string[] = [];
    const deadline = createMemoryRetrievalDeadline(input.signal);
    try {
      const plan = planMemoryRetrieval({
        currentUserText: source.statement,
        filters: { sourceKinds: ["FACT", "EVENT"] },
        mode: "TARGETED_CURRENT", now, temporalIntent: "ANY"
      });
      const base = { assistantId: null, chatId: null, now, plan, userId: job.userId } as const;
      const snapshot = await runBoundedMemoryRead(deadline, MEMORY_SNAPSHOT_OPTIONAL_MAXIMUM_MS,
        (signal) => abortableMemoryRead(repository.snapshot(base), signal));
      if (snapshot.status === "READY" && snapshot.useMemoryFacts &&
        snapshot.memoryGeneration === job.memoryGenerationSnapshot &&
        snapshot.chatId === null && !snapshot.referenceChatHistory) {
        let embedded: MemoryRunQueryEmbeddingResult | null = null;
        if (snapshot.indexMode === "HYBRID" && (job.attemptCount === 1 || job.attemptCount === 2)) {
          try {
            embedded = await runOptionalMemoryUtility(deadline, "QUERY_EMBED", async (signal) => {
              const active = await abortableMemoryRead(vectors.resolveActiveProfile(job.userId), signal);
              if (active.status !== "READY" || active.profile.generationId !== snapshot.activeGenerationId) {
                return { status: "UNAVAILABLE" as const, reason: "memory_vector_generation_stale" };
              }
              return utilities.embedQuery({
                jobAttemptCount: job.attemptCount as 1 | 2,
                owner: { memoryJobId: job.id, type: "JOB" },
                profile: active.profile, query: source.statement, signal, userId: job.userId
              });
            });
          } catch {
            input.signal.throwIfAborted();
          }
        }
        const result = await runBoundedMemoryRead(deadline, MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
          (signal) => repository.retrieve({
            ...base, settleSignal: signal, sourceSnapshot: snapshot,
            ...(embedded?.status === "READY" ? { vector: {
              minimumScore: MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
              profile: embedded.profile, vector: embedded.vector
            } } : {})
          }));
        if (result.snapshot.memoryGeneration === job.memoryGenerationSnapshot) {
          ranked = fuseMemoryRetrievalCandidates(plan, result.laneResults, now)
            .filter((candidate) => candidate.itemType === "FACT_VERSION" &&
              candidate.metadata.sourceMode === "EXPLICIT" && candidate.metadata.factId !== source.factId)
            .map(({ itemId }) => itemId);
        }
      }
    } catch {
      input.signal.throwIfAborted();
    } finally {
      deadline.dispose();
    }
    input.signal.throwIfAborted();
    const nativeLimit = MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES - MEMORY_EXPLICIT_RELATION_RECENT_CANDIDATES;
    return Object.freeze([...new Set([
      ...ranked.slice(0, nativeLimit), ...recent.map(({ versionId }) => versionId), ...ranked.slice(nativeLimit)
    ])].slice(0, MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES));
  };
}
