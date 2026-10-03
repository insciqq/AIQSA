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
import { memoryAutomaticEquivalenceUnprotectedPredicate } from "../../persistence/explicitEquivalence";
import {
  isMemoryExplicitRelationPipelineVersion,
  MEMORY_EXPLICIT_RELATION_EQUAL_TEXT_CANDIDATES,
  MEMORY_EXPLICIT_RELATION_EQUAL_TEXT_SCAN,
  MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES,
  MEMORY_EXPLICIT_RELATION_RECENT_CANDIDATES,
  MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION,
  memoryEquivalenceTextKey,
  type MemoryExplicitRelationFact,
  type MemoryExplicitRelationSourceMode
} from "./explicitPolicy";

/** Which candidates a source may be compared with: v1 compares explicit saves;
 * v2 adds automatic facts to an explicit source, while an automatic source is
 * compared with explicit saves only. */
export function memoryExplicitRelationCandidateModes(
  pipelineVersion: string,
  sourceMode: MemoryExplicitRelationSourceMode
): ReadonlySet<MemoryExplicitRelationSourceMode> {
  if (!isMemoryExplicitRelationPipelineVersion(pipelineVersion)) {
    return new Set<MemoryExplicitRelationSourceMode>();
  }
  return new Set<MemoryExplicitRelationSourceMode>(
    pipelineVersion === MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION || sourceMode === "AUTOMATIC"
      ? ["EXPLICIT"] : ["EXPLICIT", "AUTOMATIC"]
  );
}

/** Bounded lane order: equal-text twins first, then the strongest ranked
 * candidates, the recent explicit lane for simultaneous saves and index lag,
 * and the remaining ranked candidates. Every id is rejoined before use. */
export function selectMemoryExplicitRelationCandidateIds(lanes: Readonly<{
  equal: readonly string[];
  ranked: readonly string[];
  recent: readonly string[];
}>): readonly string[] {
  const nativeLimit = MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES - MEMORY_EXPLICIT_RELATION_RECENT_CANDIDATES;
  return Object.freeze([...new Set([
    ...lanes.equal.slice(0, MEMORY_EXPLICIT_RELATION_EQUAL_TEXT_CANDIDATES),
    ...lanes.ranked.slice(0, nativeLimit),
    ...lanes.recent,
    ...lanes.ranked.slice(nativeLimit)
  ])].slice(0, MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES));
}

type EqualTextRow = Readonly<{ normalizedSearchText: string; versionId: string }>;

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
    const modes = memoryExplicitRelationCandidateModes(job.pipelineVersion, source.sourceMode);
    if (modes.size === 0) return Object.freeze([]);
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
    let equal: string[] = [];
    if (job.pipelineVersion !== MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION) {
      // Equal normalized text, ignoring punctuation and symbols, needs no
      // index: a twin is found even when ranked retrieval is unavailable.
      const twins = await client.$queryRaw<EqualTextRow[]>(Prisma.sql`
        SELECT version."id" AS "versionId", version."normalizedSearchText"
        FROM "MemoryFact" AS fact
        JOIN "MemoryFactVersion" AS version
          ON version."userId" = fact."userId" AND version."id" = fact."currentVersionId"
            AND version."factId" = fact."id"
        WHERE fact."userId" = ${job.userId} AND fact."scopeId" = ${source.scopeId}
          AND fact."state" = 'ACTIVE'::"MemoryFactState" AND fact."id" <> ${source.factId}
          AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
          AND version."normalizedSearchText" IS NOT NULL
          AND version."sourceMode"::text IN (${Prisma.join([...modes])})
          AND (version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
            OR ${memoryAutomaticEquivalenceUnprotectedPredicate()})
        ORDER BY fact."updatedAt" DESC, fact."id"
        LIMIT ${MEMORY_EXPLICIT_RELATION_EQUAL_TEXT_SCAN}
      `);
      const key = memoryEquivalenceTextKey(source.statement);
      equal = key.length === 0 ? [] : twins
        .filter(({ normalizedSearchText }) => memoryEquivalenceTextKey(normalizedSearchText) === key)
        .map(({ versionId }) => versionId);
    }
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
              candidate.metadata.sourceMode !== null && modes.has(candidate.metadata.sourceMode) &&
              candidate.metadata.factId !== source.factId)
            .map(({ itemId }) => itemId);
        }
      }
    } catch {
      input.signal.throwIfAborted();
    } finally {
      deadline.dispose();
    }
    input.signal.throwIfAborted();
    return selectMemoryExplicitRelationCandidateIds({
      equal, ranked, recent: recent.map(({ versionId }) => versionId)
    });
  };
}
