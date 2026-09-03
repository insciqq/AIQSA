import type { PrismaClient } from "@prisma/client";
import {
  MEMORY_CONSUMER_PAGE_SIZE_MAX,
  MEMORY_CONSUMER_QUERY_MAX_LENGTH,
  type MemoryConsumerItem
} from "../../../contracts/memoryConsumer";
import {
  MEMORY_DECAY_POLICY_VERSION,
  MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
  applyMemoryDecay,
  fuseMemoryRetrievalCandidates,
  packMemoryPersonalContext,
  planMemoryRetrieval,
  type MemoryExpandedCandidate,
  type MemoryRankedCandidate,
  type MemoryRetrievalPlan
} from "../../../domain/memory/retrieval";
import { prisma } from "../../prisma";
import {
  MemoryConsumerServiceError,
  projectMemoryConsumerItem
} from "../consumer/service";
import {
  defaultMemoryConsumerRefService,
  type MemoryConsumerRefService
} from "../consumer/ref";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { isValidMemoryExecutionIdentifier } from "../execution/owner";
import { defaultExplicitMemoryService } from "../explicit/defaultExplicit";
import {
  ExplicitMemoryServiceError,
  type ExplicitMemoryService
} from "../explicit/service";
import {
  scheduleDirectMemoryFactAccessTouch,
  type DirectMemoryFactAccessTouchInput
} from "./decayTouch";
import {
  createPrismaLocalMemoryRetrievalRepository,
  type MemoryLocalRetrievalSnapshot,
  type PrismaLocalMemoryRetrievalRepository
} from "./localRepository";
import {
  atomicMemoryRerankResult,
  applyMemoryRelevance,
  memoryRelevanceCandidates
} from "./runAdmission";
import {
  MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
  MEMORY_SNAPSHOT_OPTIONAL_MAXIMUM_MS,
  abortableMemoryRead,
  createMemoryRetrievalDeadline,
  runBoundedMemoryRead,
  runOptionalMemoryUtility,
  type MemoryRetrievalDeadline
} from "./deadline";
import {
  createPrismaMemoryRunUtilityService,
  type MemoryRunQueryEmbeddingResult,
  type MemoryRunRerankResult,
  type MemoryRunUtilityService
} from "./runUtilities";
import {
  createPrismaMemoryVectorRepository,
  type MemoryVectorRepository
} from "./vector";
import { sanitizeMemoryUtilityText } from "./querySafety";

export const MEMORY_NATIVE_FACT_SEARCH_VERSION =
  "memory-native-fact-search-v1";

export type MemoryNativeFactSearchInput = Readonly<{
  limit: number;
  query: string;
  requestId: string;
  signal: AbortSignal;
}>;

export type MemoryNativeFactSearchResult = Readonly<{
  items: readonly MemoryConsumerItem[];
}>;

export type MemoryNativeFactSearchService = Readonly<{
  search(
    userId: string,
    input: MemoryNativeFactSearchInput
  ): Promise<MemoryNativeFactSearchResult>;
}>;

type NativeFactRepository = Pick<
  PrismaLocalMemoryRetrievalRepository,
  "expand" | "retrieve" | "snapshot"
>;

export type MemoryNativeFactSearchDependencies = Readonly<{
  clock?: () => Date;
  explicitService: Pick<ExplicitMemoryService, "get">;
  refs?: MemoryConsumerRefService;
  repository: NativeFactRepository;
  scheduleTouch?: (input: DirectMemoryFactAccessTouchInput) => void;
  utilities?: Pick<MemoryRunUtilityService, "embedQuery" | "rerank">;
  vectorRepository?: Pick<MemoryVectorRepository, "resolveActiveProfile">;
}>;

function failure(
  code: "memory_contract_invalid" | "memory_unavailable"
): never {
  throw new MemoryConsumerServiceError(code);
}

export function createMemoryNativeFactSearchPlan(
  query: string,
  now: Date
): MemoryRetrievalPlan {
  return planMemoryRetrieval({
    currentUserText: query,
    filters: { sourceKinds: ["FACT"] },
    mode: "TARGETED_CURRENT",
    now,
    temporalIntent: "ANY"
  });
}

function sameSnapshot(
  left: MemoryLocalRetrievalSnapshot,
  right: MemoryLocalRetrievalSnapshot
): boolean {
  return left.activeGenerationId === right.activeGenerationId &&
    left.assistantId === right.assistantId &&
    left.chatId === right.chatId &&
    left.chatMemoryMode === right.chatMemoryMode &&
    left.contextualKeyPolicyVersion === right.contextualKeyPolicyVersion &&
    left.decayEnabled === right.decayEnabled &&
    left.decayPolicyVersion === right.decayPolicyVersion &&
    left.folderId === right.folderId &&
    left.historyAuthorityRevision === right.historyAuthorityRevision &&
    left.indexMode === right.indexMode &&
    left.memoryGeneration === right.memoryGeneration &&
    left.memoryRevision === right.memoryRevision &&
    left.reason === right.reason &&
    left.referenceChatHistory === right.referenceChatHistory &&
    left.repositoryVersion === right.repositoryVersion &&
    left.roundProjectionVersion === right.roundProjectionVersion &&
    left.roundSegmentProjectionVersion === right.roundSegmentProjectionVersion &&
    left.settingsRevision === right.settingsRevision &&
    left.status === right.status &&
    left.useMemoryFacts === right.useMemoryFacts &&
    left.userId === right.userId;
}

function directSnapshotReady(
  snapshot: MemoryLocalRetrievalSnapshot,
  userId: string
): boolean {
  return snapshot.userId === userId && snapshot.chatId === null &&
    snapshot.assistantId === null && snapshot.folderId === null &&
    snapshot.chatMemoryMode === "NORMAL" && !snapshot.referenceChatHistory &&
    snapshot.useMemoryFacts && snapshot.status === "READY" &&
    snapshot.activeGenerationId !== null && snapshot.indexMode !== null;
}

async function queryEmbedding(input: Readonly<{
  deadline: MemoryRetrievalDeadline;
  ownerId: string;
  plan: MemoryRetrievalPlan;
  service: MemoryNativeFactSearchDependencies;
  snapshot: MemoryLocalRetrievalSnapshot;
  userId: string;
}>): Promise<MemoryRunQueryEmbeddingResult | null> {
  if (input.snapshot.indexMode !== "HYBRID" ||
    !input.service.utilities || !input.service.vectorRepository) return null;
  try {
    return await runOptionalMemoryUtility(
      input.deadline,
      "QUERY_EMBED",
      async (utilitySignal) => {
        const profile = await abortableMemoryRead(
          input.service.vectorRepository!.resolveActiveProfile(input.userId),
          utilitySignal
        );
        if (profile.status !== "READY" ||
          profile.profile.generationId !== input.snapshot.activeGenerationId) {
          return {
            reason: "memory_vector_generation_stale",
            status: "UNAVAILABLE" as const
          };
        }
        return input.service.utilities!.embedQuery({
          owner: {
            inboundMcpRequestId: input.ownerId,
            type: "INBOUND_MCP_REQUEST"
          },
          profile: profile.profile,
          query: input.plan.originalSanitizedQuery,
          signal: utilitySignal,
          userId: input.userId
        });
      }
    );
  } catch {
    return { reason: "memory_query_embedding_unavailable", status: "UNAVAILABLE" };
  }
}

async function rerank(input: Readonly<{
  candidates: ReturnType<typeof memoryRelevanceCandidates>;
  deadline: MemoryRetrievalDeadline;
  ownerId: string;
  plan: MemoryRetrievalPlan;
  service: MemoryNativeFactSearchDependencies;
  userId: string;
}>): Promise<MemoryRunRerankResult | null> {
  if (input.candidates.length === 0 || !input.service.utilities) return null;
  try {
    return await runOptionalMemoryUtility(
      input.deadline,
      "RERANK",
      (utilitySignal) => input.service.utilities!.rerank({
        aggregationRequested: false,
        canRetry: input.deadline.canStartOptional,
        candidates: input.candidates.map(({
          candidate: _candidate,
          directUserTexts: _directUserTexts,
          ...candidate
        }) => candidate),
        owner: {
          inboundMcpRequestId: input.ownerId,
          type: "INBOUND_MCP_REQUEST"
        },
        profileRequested: false,
        query: input.plan.originalSanitizedQuery,
        retrievalMode: input.plan.mode,
        signal: utilitySignal,
        temporalIntent: input.plan.temporalIntent,
        userId: input.userId
      })
    );
  } catch {
    return { reason: "memory_relevance_unavailable", status: "UNAVAILABLE" };
  }
}

function rejoinedCandidates(
  candidates: readonly MemoryRankedCandidate[],
  expanded: readonly MemoryExpandedCandidate[]
): readonly MemoryRankedCandidate[] {
  const identities = new Set(expanded.map((item) =>
    `${item.itemType}:${item.itemId}`));
  return candidates.filter((candidate) =>
    candidate.itemType === "FACT_VERSION" &&
    candidate.metadata.factId !== null &&
    identities.has(`${candidate.itemType}:${candidate.itemId}`));
}

export function createMemoryNativeFactSearchService(
  dependencies: MemoryNativeFactSearchDependencies
): MemoryNativeFactSearchService {
  const clock = dependencies.clock ?? (() => new Date());
  const refs = dependencies.refs ?? defaultMemoryConsumerRefService;

  return Object.freeze({
    async search(userId, input) {
      if (
        !isValidMemoryExecutionIdentifier(userId) ||
        !isValidMemoryExecutionIdentifier(input.requestId) ||
        typeof input.query !== "string" || input.query.trim() !== input.query ||
        input.query.length < 1 ||
        input.query.length > MEMORY_CONSUMER_QUERY_MAX_LENGTH ||
        !Number.isSafeInteger(input.limit) || input.limit < 1 ||
        input.limit > MEMORY_CONSUMER_PAGE_SIZE_MAX ||
        !input.signal || typeof input.signal.aborted !== "boolean"
      ) return failure("memory_contract_invalid");

      const now = clock();
      const safeQuery = sanitizeMemoryUtilityText(input.query);
      if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
        !safeQuery.eligible || !safeQuery.safeText) {
        return failure("memory_contract_invalid");
      }
      const plan = createMemoryNativeFactSearchPlan(safeQuery.safeText, now);
      const deadline = createMemoryRetrievalDeadline(input.signal);

      try {
        const snapshotInput = {
          assistantId: null,
          chatId: null,
          now,
          plan,
          userId
        } as const;
        const snapshot = await runBoundedMemoryRead(
          deadline,
          MEMORY_SNAPSHOT_OPTIONAL_MAXIMUM_MS,
          (snapshotSignal) => abortableMemoryRead(
            dependencies.repository.snapshot(snapshotInput),
            snapshotSignal
          )
        );
        if (!directSnapshotReady(snapshot, userId)) {
          return failure("memory_unavailable");
        }
        const embedded = await queryEmbedding({
          deadline,
          ownerId: input.requestId,
          plan,
          service: dependencies,
          snapshot,
          userId
        });
        const local = await runBoundedMemoryRead(
          deadline,
          MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
          (retrievalSignal) => dependencies.repository.retrieve({
            ...snapshotInput,
            settleSignal: retrievalSignal,
            sourceSnapshot: snapshot,
            ...(embedded?.status === "READY"
              ? { vector: {
                  minimumScore: MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
                  profile: embedded.profile,
                  vector: embedded.vector
                } }
              : {})
          })
        );
        if (!sameSnapshot(snapshot, local.snapshot)) {
          return failure("memory_unavailable");
        }
        const fused = fuseMemoryRetrievalCandidates(plan, local.laneResults, now)
          .filter((candidate) => candidate.itemType === "FACT_VERSION" &&
            candidate.metadata.factId !== null);
        if (fused.length === 0) return Object.freeze({ items: Object.freeze([]) });

        const firstExpansion = await runBoundedMemoryRead(
          deadline,
          MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
          (expansionSignal) => abortableMemoryRead(
            dependencies.repository.expand(snapshot, plan, fused),
            expansionSignal
          )
        );
        const relevanceInput = memoryRelevanceCandidates(
          fused,
          firstExpansion,
          { aggregationRequested: false, recencyRequested: false, temporalIntent: "ANY" }
        );
        const reranked = atomicMemoryRerankResult(
          relevanceInput,
          await rerank({
            candidates: relevanceInput,
            deadline,
            ownerId: input.requestId,
            plan,
            service: dependencies,
            userId
          })
        );
        if (deadline.expired()) return failure("memory_unavailable");
        const relevant = applyMemoryRelevance(relevanceInput, reranked, plan);
        const finalExpansion = relevant.length > 0
          ? await runBoundedMemoryRead(
              deadline,
              MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
              (rejoinSignal) => abortableMemoryRead(
                dependencies.repository.expand(snapshot, plan, relevant),
                rejoinSignal
              )
            )
          : [];
        const authoritative = rejoinedCandidates(relevant, finalExpansion);
        const ordered = applyMemoryDecay(authoritative, {
          enabled: snapshot.decayEnabled,
          mode: plan.mode,
          now,
          policyVersion: snapshot.decayPolicyVersion
        });
        const orderedKeys = new Set(ordered.map((candidate) =>
          `${candidate.itemType}:${candidate.itemId}`));
        const pack = packMemoryPersonalContext({
          expanded: finalExpansion.filter((item) =>
            orderedKeys.has(`${item.itemType}:${item.itemId}`)),
          plan,
          ranked: ordered
        });
        const candidateByVersion = new Map(ordered.map((candidate) => [
          candidate.itemId,
          candidate
        ]));
        const selected = pack.items.flatMap((item) => {
          const candidate = item.itemType === "FACT_VERSION"
            ? candidateByVersion.get(item.itemId)
            : undefined;
          return candidate?.metadata.factId
            ? [{ factId: candidate.metadata.factId, factVersionId: candidate.itemId }]
            : [];
        }).slice(0, input.limit);

        const finalSnapshot = await runBoundedMemoryRead(
          deadline,
          MEMORY_SNAPSHOT_OPTIONAL_MAXIMUM_MS,
          (snapshotSignal) => abortableMemoryRead(
            dependencies.repository.snapshot(snapshotInput),
            snapshotSignal
          )
        );
        if (!directSnapshotReady(finalSnapshot, userId) ||
          !sameSnapshot(snapshot, finalSnapshot)) {
          return failure("memory_unavailable");
        }

        const projected = (await runBoundedMemoryRead(
          deadline,
          MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
          (projectionSignal) => abortableMemoryRead(
            Promise.all(selected.map(async (identity) => {
              try {
                const detail = await dependencies.explicitService.get(
                  userId,
                  identity.factId
                );
                const versionId = detail.memory.currentVersionId ??
                  detail.memory.actionVersionId;
                if (detail.memory.factState !== "ACTIVE" ||
                  versionId !== identity.factVersionId) return null;
                return {
                  identity,
                  item: projectMemoryConsumerItem(refs, userId, detail.memory, now)
                };
              } catch (error) {
                if (error instanceof ExplicitMemoryServiceError &&
                  error.code === "memory_not_found") return null;
                throw error;
              }
            })),
            projectionSignal
          )
        )).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        if (snapshot.decayEnabled &&
          snapshot.decayPolicyVersion === MEMORY_DECAY_POLICY_VERSION &&
          projected.length > 0) {
          dependencies.scheduleTouch?.({
            facts: projected.map(({ identity }) => identity),
            now,
            userId
          });
        }
        return Object.freeze({
          items: Object.freeze(projected.map(({ item }) => item))
        });
      } catch (error) {
        if (error instanceof MemoryConsumerServiceError) throw error;
        return failure("memory_unavailable");
      } finally {
        deadline.dispose();
      }
    }
  });
}

export function createPrismaMemoryNativeFactSearchService(
  client: PrismaClient = prisma
): MemoryNativeFactSearchService {
  return createMemoryNativeFactSearchService({
    explicitService: defaultExplicitMemoryService,
    refs: defaultMemoryConsumerRefService,
    repository: createPrismaLocalMemoryRetrievalRepository(client),
    scheduleTouch: (input) => scheduleDirectMemoryFactAccessTouch(client, input),
    utilities: createPrismaMemoryRunUtilityService(
      defaultMemoryExecutionAuthority,
      client
    ),
    vectorRepository: createPrismaMemoryVectorRepository(client)
  });
}
