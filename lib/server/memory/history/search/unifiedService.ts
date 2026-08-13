import type { MemoryScopeType } from "../../../../contracts/memory";
import {
  MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
  fuseMemoryRetrievalCandidates,
  planMemoryRetrieval,
  type MemoryExpandedCandidate,
  type MemoryRankedCandidate,
  type MemoryRetrievalSourceKind
} from "../../../../domain/memory/retrieval";
import type { MemoryExecutionOwner } from "../../execution/owner";
import { memoryExplicitStatementContainsSecret } from "../../explicit/safety";
import {
  createPrismaLocalMemoryRetrievalRepository,
  type PrismaLocalMemoryRetrievalRepository
} from "../../retrieval/localRepository";
import {
  applyMemoryRelevance,
  memoryRelevanceCandidates
} from "../../retrieval/runAdmission";
import type {
  MemoryRunQueryEmbeddingResult,
  MemoryRunRerankResult,
  MemoryRunUtilityService
} from "../../retrieval/runUtilities";
import type {
  MemoryVectorProfileResolution,
  MemoryVectorRepository
} from "../../retrieval/vector";

export const MEMORY_UNIFIED_SEARCH_SERVICE_VERSION = "memory-unified-search-v1";
export const MEMORY_UNIFIED_SEARCH_MAX_RESULTS = 12;

export type MemoryUnifiedSearchScope = Readonly<{
  targetId: string | null;
  type: MemoryScopeType;
}>;

export type MemoryUnifiedSearchInput = Readonly<{
  from: Date | null;
  query: string;
  scope: MemoryUnifiedSearchScope | null;
  sourceKinds: readonly MemoryRetrievalSourceKind[];
  to: Date | null;
}>;

export type MemoryUnifiedSearchContext = Readonly<{
  assistantId: string | null;
  chatId: string;
  now: Date;
  owner: MemoryExecutionOwner;
  signal: AbortSignal;
  userId: string;
}>;

export type MemoryUnifiedSearchPublicResult = Readonly<{
  handle: string;
  occurredFrom: string | null;
  occurredTo: string | null;
  sourceChatId: string | null;
  sourceKind: MemoryRetrievalSourceKind;
  text: string;
}>;

export type MemoryUnifiedSearchPrivateResult = Readonly<{
  entryId: string | null;
  factId: string | null;
  handle: string;
  itemId: string;
  itemType: "FACT_VERSION" | "RECALL_CHUNK";
  laneRanks: MemoryRankedCandidate["laneRanks"];
  sourceChatId: string | null;
  sourceKind: MemoryRetrievalSourceKind;
}>;

export type MemoryUnifiedSearchResponse = Readonly<{
  executionBindingIds: readonly string[];
  indexing: Readonly<{
    candidateCount: number;
    degradationCode: string | null;
    lexicalState: "DEGRADED" | "DISABLED" | "FAILED" | "READY";
    relevanceState: "READY" | "SKIPPED" | "UNAVAILABLE";
    serviceVersion: string;
    vectorState: "DEGRADED" | "DISABLED" | "NOT_CONFIGURED" | "READY";
  }>;
  privateResults: readonly MemoryUnifiedSearchPrivateResult[];
  results: readonly MemoryUnifiedSearchPublicResult[];
}>;

export type MemoryUnifiedSearchService = Readonly<{
  search(
    context: MemoryUnifiedSearchContext,
    input: MemoryUnifiedSearchInput
  ): Promise<MemoryUnifiedSearchResponse>;
}>;

function sourceKind(candidate: MemoryRankedCandidate): MemoryRetrievalSourceKind {
  return candidate.itemType === "RECALL_CHUNK"
    ? "HISTORY"
    : candidate.metadata.modality === "EVENT" ? "EVENT" : "FACT";
}

function degradationCode(input: Readonly<{
  embedding: MemoryRunQueryEmbeddingResult | null;
  relevance: MemoryRunRerankResult | null;
  vectorProfile: MemoryVectorProfileResolution | null;
}>): string | null {
  if (input.relevance?.status === "UNAVAILABLE") return input.relevance.reason;
  if (input.embedding?.status === "UNAVAILABLE") return input.embedding.reason;
  if (input.vectorProfile?.status === "DEGRADED") return input.vectorProfile.reason;
  return null;
}

function relevanceState(
  result: MemoryRunRerankResult | null,
  candidateCount: number
): MemoryUnifiedSearchResponse["indexing"]["relevanceState"] {
  if (candidateCount === 0) return "SKIPPED";
  if (!result || result.status === "UNAVAILABLE") return "UNAVAILABLE";
  return "READY";
}

function projectionMap(expanded: readonly MemoryExpandedCandidate[]) {
  return new Map(expanded.map((item) => [`${item.itemType}:${item.itemId}`, item]));
}

export function createMemoryUnifiedSearchService(input: Readonly<{
  repository?: PrismaLocalMemoryRetrievalRepository;
  utilities: MemoryRunUtilityService;
  vectorRepository: Pick<MemoryVectorRepository, "resolveActiveProfile">;
}>): MemoryUnifiedSearchService {
  const repository = input.repository ?? createPrismaLocalMemoryRetrievalRepository();
  return Object.freeze({
    async search(context, request) {
      const plan = planMemoryRetrieval({
        currentUserText: request.query,
        filters: {
          from: request.from,
          scopeTargetId: request.scope?.targetId ?? null,
          scopeType: request.scope?.type ?? null,
          sourceKinds: request.sourceKinds,
          to: request.to
        },
        now: context.now
      });
      if (!plan.queryPresent) throw new Error("memory_contract_invalid");

      const querySecret = memoryExplicitStatementContainsSecret(plan.normalizedQuery);
      let vectorProfile: MemoryVectorProfileResolution | null = null;
      let embedding: MemoryRunQueryEmbeddingResult | null = null;
      if (!querySecret) {
        try {
          vectorProfile = await input.vectorRepository.resolveActiveProfile(context.userId);
          if (vectorProfile.status === "READY") {
            embedding = await input.utilities.embedQuery({
              owner: context.owner,
              profile: vectorProfile.profile,
              query: plan.normalizedQuery,
              signal: context.signal,
              userId: context.userId
            });
          }
        } catch {
          vectorProfile = {
            reason: "memory_vector_unavailable",
            status: "DEGRADED"
          };
        }
      }

      const local = await repository.retrieve({
        assistantId: context.assistantId,
        chatId: context.chatId,
        now: context.now,
        plan,
        userId: context.userId,
        ...(embedding?.status === "READY"
          ? {
              vector: {
                minimumScore: MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
                profile: embedding.profile,
                vector: embedding.vector
              }
            }
          : {})
      });
      const fused = fuseMemoryRetrievalCandidates(plan, local.laneResults, context.now);
      const expanded = fused.length > 0
        ? await repository.expand(local.snapshot, plan, fused)
        : [];
      const relevanceInput = querySecret ? [] : memoryRelevanceCandidates(fused, expanded);
      let relevance: MemoryRunRerankResult | null = null;
      if (relevanceInput.length > 0) {
        try {
          relevance = await input.utilities.rerank({
            candidates: relevanceInput.map(({ handle, occurredFrom, occurredTo, sourceKind, text }) =>
              ({ handle, occurredFrom, occurredTo, sourceKind, text })),
            owner: context.owner,
            query: plan.normalizedQuery,
            signal: context.signal,
            userId: context.userId
          });
        } catch {
          relevance = { reason: "memory_relevance_unavailable", status: "UNAVAILABLE" };
        }
      }

      // Unlike silent prefetch, an explicit answer-model search may expose the
      // bounded RRF candidates when relevance is unavailable. They remain
      // untrusted data and the receipt retains their exact identities.
      const selected = relevance?.status === "READY"
        ? applyMemoryRelevance(relevanceInput, relevance)
        : fused;
      const projections = projectionMap(expanded);
      const rows = selected.flatMap((candidate) => {
        const projection = projections.get(`${candidate.itemType}:${candidate.itemId}`);
        return projection ? [{ candidate, projection }] : [];
      }).slice(0, MEMORY_UNIFIED_SEARCH_MAX_RESULTS);
      const results = rows.map(({ candidate, projection }, index) => ({
        handle: `m${index}`,
        occurredFrom: (projection.occurredFrom ?? candidate.metadata.validFrom ??
          candidate.metadata.systemFrom)?.toISOString() ?? null,
        occurredTo: (projection.occurredTo ?? candidate.metadata.validTo)?.toISOString() ?? null,
        sourceChatId: projection.sourceChatId ?? candidate.metadata.sourceChatId,
        sourceKind: sourceKind(candidate),
        text: projection.safeText
      }));
      const privateResults = rows.map(({ candidate, projection }, index) => ({
        entryId: candidate.entryId,
        factId: candidate.metadata.factId,
        handle: `m${index}`,
        itemId: candidate.itemId,
        itemType: candidate.itemType as "FACT_VERSION" | "RECALL_CHUNK",
        laneRanks: candidate.laneRanks,
        sourceChatId: projection.sourceChatId ?? candidate.metadata.sourceChatId,
        sourceKind: sourceKind(candidate)
      }));
      return {
        executionBindingIds: [embedding, relevance].flatMap((result) =>
          result && "bindingId" in result && result.bindingId ? [result.bindingId] : []),
        indexing: {
          candidateCount: fused.length,
          degradationCode: querySecret
            ? "memory_external_query_processing_blocked"
            : degradationCode({ embedding, relevance, vectorProfile }),
          lexicalState: local.lexicalState,
          relevanceState: relevanceState(relevance, relevanceInput.length),
          serviceVersion: MEMORY_UNIFIED_SEARCH_SERVICE_VERSION,
          vectorState: local.vectorState
        },
        privateResults,
        results
      };
    }
  });
}
