import type { PrismaClient } from "@prisma/client";
import {
  MEMORY_CONTEXT_HARD_CAP_TOKENS,
  MEMORY_CONTEXT_TARGET_TOKENS,
  MEMORY_RETRIEVAL_PIPELINE_VERSION,
  MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
  fuseMemoryRetrievalCandidates,
  packMemoryPersonalContext,
  planMemoryRetrieval,
  type MemoryContextPack,
  type MemoryCoreCandidate,
  type MemoryExpandedCandidate,
  type MemoryRankedCandidate,
  type MemoryRetrievalPlan
} from "../../../domain/memory/retrieval";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import { prisma } from "../../prisma";
import type { NormalizedRunRequest } from "../../providers/types";
import type {
  MemoryPreparingAttemptResult,
  MemoryPreparingItemInput,
  MemoryPreparingSettingsSnapshot
} from "../../runs/preparingRun";
import { MemoryPreparingRunConflictError } from "../../runs/preparingRun";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import type { MemoryExecutionAuthorityDependencies } from "../execution";
import { memoryExplicitStatementContainsSecret } from "../explicit/safety";
import { memorySha256 } from "../persistence/lexical";
import {
  createPrismaLocalMemoryRetrievalRepository,
  type MemoryLocalRetrievalResult,
  type MemoryLocalRetrievalSnapshot,
  type PrismaLocalMemoryRetrievalRepository
} from "./localRepository";
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

export const MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION =
  "memory-run-retrieval-admission-v2";

export type MemoryRunRetrievalExpectedSnapshot = Readonly<{
  activeIndexGenerationId: string | null;
  assistantId: string | null;
  chatMemoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  folderId: string | null;
  memoryGeneration: number;
  memoryRevision: number;
  settings: MemoryPreparingSettingsSnapshot;
}>;

export type MemoryRunRetrievalInput = Readonly<{
  attemptId: string;
  chatId: string;
  expected: MemoryRunRetrievalExpectedSnapshot;
  normalizedRequest: NormalizedRunRequest;
  now: Date;
  signal?: AbortSignal;
  userId: string;
}>;

export type MemoryRunRetrievalService = Readonly<{
  retrieve(input: MemoryRunRetrievalInput): Promise<MemoryPreparingAttemptResult>;
}>;

export type MemoryRunRetrievalOptions = Readonly<{
  utilities?: MemoryRunUtilityService;
  vectorRepository?: Pick<MemoryVectorRepository, "resolveActiveProfile">;
}>;

type UtilityEvidence = Readonly<{
  reason: string | null;
  role: "MEMORY_QUERY_EMBED" | "MEMORY_RERANK";
  state: "READY" | "SKIPPED" | "UNAVAILABLE";
}>;

function boundedCurrentUserText(request: NormalizedRunRequest): string {
  return Array.from(textFromContentBlocks(request.content)).slice(0, 2_000).join("");
}

function baseBudget(
  reason: string,
  snapshot: MemoryRunRetrievalExpectedSnapshot,
  extras: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return {
    admissionVersion: MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION,
    hardCapTokens: MEMORY_CONTEXT_HARD_CAP_TOKENS,
    itemCount: 0,
    pipelineVersion: MEMORY_RETRIEVAL_PIPELINE_VERSION,
    reason,
    schemaVersion: 2,
    settingsRevision: snapshot.settings.settingsRevision,
    targetTokens: MEMORY_CONTEXT_TARGET_TOKENS,
    utilityEgressMode: "LOCAL_ONLY",
    ...extras
  };
}

function emptyAttempt(
  expected: MemoryRunRetrievalExpectedSnapshot,
  outcome: MemoryPreparingAttemptResult["outcome"],
  reason: string,
  querySnapshot: string | null = null,
  extras: Readonly<Record<string, unknown>> = {}
): MemoryPreparingAttemptResult {
  return {
    budgetSnapshot: baseBudget(reason, expected, extras),
    items: [],
    outcome,
    preparedContext: null,
    querySnapshot
  };
}

function sameRetrievalSnapshot(
  actual: MemoryLocalRetrievalSnapshot,
  expected: MemoryRunRetrievalExpectedSnapshot
): boolean {
  return actual.activeGenerationId === expected.activeIndexGenerationId &&
    actual.chatMemoryMode === expected.chatMemoryMode &&
    actual.folderId === expected.folderId &&
    actual.memoryGeneration === expected.memoryGeneration &&
    actual.memoryRevision === expected.memoryRevision &&
    actual.referenceChatHistory === expected.settings.referenceChatHistory &&
    actual.useMemoryFacts === expected.settings.useMemoryFacts;
}

function assertStableSnapshot(
  actual: MemoryLocalRetrievalSnapshot,
  expected: MemoryRunRetrievalExpectedSnapshot
): void {
  if (!sameRetrievalSnapshot(actual, expected)) {
    throw new MemoryPreparingRunConflictError("memory_admission_settings_changed", true);
  }
}

function candidateMap(
  core: readonly MemoryCoreCandidate[],
  dynamic: readonly MemoryRankedCandidate[]
): ReadonlyMap<string, MemoryRankedCandidate> {
  return new Map([
    ...core.map(({ candidate }) => candidate),
    ...dynamic
  ].map((candidate) => [`${candidate.itemType}:${candidate.itemId}`, candidate]));
}

function attemptItems(
  pack: MemoryContextPack,
  core: readonly MemoryCoreCandidate[],
  dynamic: readonly MemoryRankedCandidate[]
): readonly MemoryPreparingItemInput[] {
  const candidates = candidateMap(core, dynamic);
  return pack.items.map((packed): MemoryPreparingItemInput => {
    const candidate = candidates.get(`${packed.itemType}:${packed.itemId}`);
    if (!candidate) throw new Error("memory_retrieval_pack_identity_invalid");
    const base = {
      exactItemId: packed.itemId,
      exactSafeText: packed.exactSafeText,
      featureSnapshot: {
        ...candidate.featureSnapshot,
        finalScore: candidate.finalScore,
        projectionKind: packed.projectionKind,
        rrfScore: candidate.rrfScore,
        supportingItemId: packed.supportingItemId,
        temporalReason: packed.temporalReason,
        tier: packed.tier
      },
      finalScore: candidate.finalScore,
      laneRanks: candidate.laneRanks,
      projectionKind: packed.projectionKind,
      selectionReason: candidate.selectionReason,
      supportingItemId: packed.supportingItemId
    } as const;
    return packed.itemType === "FACT_VERSION"
      ? { ...base, factVersionId: packed.itemId, itemType: "FACT_VERSION" }
      : { ...base, itemType: "RECALL_CHUNK", recallChunkId: packed.itemId };
  });
}

function planEvidence(plan: MemoryRetrievalPlan): Readonly<Record<string, unknown>> {
  return {
    filterFrom: plan.filters.from?.toISOString() ?? null,
    filterScopeTargetId: plan.filters.scopeTargetId,
    filterScopeType: plan.filters.scopeType,
    filterSourceKinds: plan.filters.sourceKinds,
    filterTo: plan.filters.to?.toISOString() ?? null,
    lexicalAvailable: plan.lexicalQuery !== null,
    plannerVersion: plan.plannerVersion,
    queryPresent: plan.queryPresent
  };
}

function utilityEvidence(
  role: UtilityEvidence["role"],
  result: MemoryRunQueryEmbeddingResult | MemoryRunRerankResult | null
): UtilityEvidence {
  if (!result) return { reason: null, role, state: "SKIPPED" };
  return result.status === "READY"
    ? { reason: null, role, state: "READY" }
    : { reason: result.reason, role, state: "UNAVAILABLE" };
}

function utilityUsedExternal(
  result: MemoryRunQueryEmbeddingResult | MemoryRunRerankResult | null
): boolean {
  return Boolean(result && "bindingId" in result && result.bindingId);
}

export type MemoryRelevanceCandidate = Readonly<{
  candidate: MemoryRankedCandidate;
  handle: string;
  occurredFrom: string | null;
  occurredTo: string | null;
  sourceKind: "EVENT" | "FACT" | "HISTORY";
  text: string;
}>;

export function memoryRelevanceCandidates(
  ranked: readonly MemoryRankedCandidate[],
  expanded: readonly MemoryExpandedCandidate[]
): readonly MemoryRelevanceCandidate[] {
  const projections = new Map(expanded.map((candidate) => [
    `${candidate.itemType}:${candidate.itemId}`,
    candidate
  ]));
  return ranked.flatMap((candidate) => {
    const projection = projections.get(`${candidate.itemType}:${candidate.itemId}`);
    if (!projection) return [];
    const sourceKind = candidate.itemType === "RECALL_CHUNK"
      ? "HISTORY" as const
      : candidate.metadata.modality === "EVENT" ? "EVENT" as const : "FACT" as const;
    return [{
      candidate,
      handle: "",
      occurredFrom: (projection.occurredFrom ?? candidate.metadata.validFrom ??
        candidate.metadata.systemFrom)?.toISOString() ?? null,
      occurredTo: (projection.occurredTo ?? candidate.metadata.validTo)?.toISOString() ?? null,
      sourceKind,
      text: projection.safeText
    }];
  }).slice(0, 24).map((entry, index) => ({ ...entry, handle: `c${index}` }));
}

export function applyMemoryRelevance(
  candidates: readonly MemoryRelevanceCandidate[],
  result: MemoryRunRerankResult | null
): readonly MemoryRankedCandidate[] {
  if (!result || result.status !== "READY") return [];
  const byHandle = new Map(candidates.map((entry) => [entry.handle, entry.candidate]));
  return result.relevantHandles.flatMap((handle) => {
    const candidate = byHandle.get(handle);
    if (!candidate) return [];
    const reason = `${candidate.selectionReason}+semantic_relevance`;
    return [{
      ...candidate,
      selectionReason: reason.length <= 128 ? reason : "semantic_relevance"
    }];
  });
}

function degradationFor(
  result: MemoryLocalRetrievalResult,
  relevance: MemoryRunRerankResult | null,
  hadDynamicCandidates: boolean
): string | null {
  if (hadDynamicCandidates && relevance?.status === "UNAVAILABLE") {
    return "memory_relevance_unavailable";
  }
  if (result.lexicalState === "FAILED") return "memory_fts_unavailable";
  if (result.lexicalState === "DEGRADED") return "memory_fts_partial_unavailable";
  if (result.vectorState === "DEGRADED") return "memory_vector_unavailable";
  if (result.snapshot.indexMode === "HYBRID" && result.vectorState === "NOT_CONFIGURED") {
    return "memory_query_embedding_unavailable";
  }
  if (!result.snapshot.indexMode && result.snapshot.reason === "memory_index_unavailable") {
    return "memory_index_unavailable";
  }
  return null;
}

export function createMemoryRunRetrievalService(
  repository: PrismaLocalMemoryRetrievalRepository =
    createPrismaLocalMemoryRetrievalRepository(),
  options: MemoryRunRetrievalOptions = {}
): MemoryRunRetrievalService {
  return Object.freeze({
    async retrieve(input) {
      const signal = input.signal ?? new AbortController().signal;
      if (input.expected.chatMemoryMode === "TEMPORARY") {
        return emptyAttempt(input.expected, "DISABLED", "temporary_chat");
      }
      const currentUserText = boundedCurrentUserText(input.normalizedRequest);
      const plan = planMemoryRetrieval({ currentUserText, now: input.now });
      const querySecret = memoryExplicitStatementContainsSecret(plan.normalizedQuery);

      let snapshot: MemoryLocalRetrievalSnapshot;
      try {
        snapshot = await repository.snapshot({
          assistantId: input.expected.assistantId,
          chatId: input.chatId,
          now: input.now,
          plan,
          userId: input.userId
        });
      } catch (error) {
        return emptyAttempt(input.expected, "FAILED_SAFE", "memory_snapshot_unavailable", null, {
          failureClass: error instanceof Error ? error.name : "unknown",
          plan: planEvidence(plan)
        });
      }
      if (input.expected.assistantId !== null && snapshot.assistantId === null) {
        return emptyAttempt(input.expected, "DISABLED", "assistant_memory_grant_missing");
      }
      assertStableSnapshot(snapshot, input.expected);
      if (snapshot.status === "DISABLED") {
        return emptyAttempt(input.expected, "DISABLED", snapshot.reason);
      }

      let queryEmbedding: MemoryRunQueryEmbeddingResult | null = null;
      if (plan.queryPresent && !querySecret && snapshot.indexMode === "HYBRID") {
        if (options.utilities && options.vectorRepository) {
          const profile = await options.vectorRepository.resolveActiveProfile(input.userId)
            .catch(() => ({ reason: "memory_vector_unavailable" as const,
              status: "DEGRADED" as const }));
          if (profile.status === "READY" && profile.profile.generationId === snapshot.activeGenerationId) {
            queryEmbedding = await options.utilities.embedQuery({
              attemptId: input.attemptId,
              profile: profile.profile,
              query: plan.normalizedQuery,
              signal,
              userId: input.userId
            }).catch(() => ({ reason: "memory_query_embedding_unavailable",
              status: "UNAVAILABLE" as const }));
          } else {
            queryEmbedding = { reason: profile.status === "DEGRADED" ? profile.reason
              : "memory_vector_generation_stale", status: "UNAVAILABLE" };
          }
        } else {
          queryEmbedding = { reason: "memory_query_embedding_unavailable", status: "UNAVAILABLE" };
        }
      }

      let local: MemoryLocalRetrievalResult;
      try {
        local = await repository.retrieve({
          assistantId: input.expected.assistantId,
          chatId: input.chatId,
          now: input.now,
          plan,
          userId: input.userId,
          ...(queryEmbedding?.status === "READY" ? { vector: {
            minimumScore: MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
            profile: queryEmbedding.profile,
            vector: queryEmbedding.vector
          } } : {})
        });
      } catch (error) {
        return emptyAttempt(input.expected, "FAILED_SAFE", "memory_local_retrieval_failed",
          querySecret || !plan.queryPresent ? null : plan.normalizedQuery, {
            failureClass: error instanceof Error ? error.name : "unknown",
            plan: planEvidence(plan),
            queryHash: querySecret ? memorySha256(plan.normalizedQuery) : null,
            utilityExecutions: [utilityEvidence("MEMORY_QUERY_EMBED", queryEmbedding)]
          });
      }
      assertStableSnapshot(local.snapshot, input.expected);

      const fused = fuseMemoryRetrievalCandidates(plan, local.laneResults, input.now);
      const coreKeys = new Set(local.core.map(({ candidate }) =>
        `${candidate.itemType}:${candidate.itemId}`));
      const dynamicFused = fused.filter((candidate) =>
        !coreKeys.has(`${candidate.itemType}:${candidate.itemId}`));
      let expanded: readonly MemoryExpandedCandidate[] = [];
      if (dynamicFused.length > 0) {
        try {
          expanded = await repository.expand(local.snapshot, plan, dynamicFused);
        } catch {
          expanded = [];
        }
      }
      // Recognizable credential-shaped input still reaches every owner-local
      // candidate lane. It must not cross the provider boundary, including the
      // relevance stage.
      const relevanceInput = querySecret ? [] : memoryRelevanceCandidates(dynamicFused, expanded);
      let relevance: MemoryRunRerankResult | null = null;
      if (relevanceInput.length > 0) {
        relevance = options.utilities
          ? await options.utilities.rerank({
              attemptId: input.attemptId,
              candidates: relevanceInput.map(({ candidate: _candidate, ...candidate }) => candidate),
              query: plan.normalizedQuery,
              signal,
              userId: input.userId
            }).catch(() => ({ reason: "memory_relevance_unavailable",
              status: "UNAVAILABLE" as const }))
          : { reason: "memory_relevance_unavailable", status: "UNAVAILABLE" };
      }
      const dynamic = applyMemoryRelevance(relevanceInput, relevance);
      const selectedKeys = new Set(dynamic.map((candidate) => `${candidate.itemType}:${candidate.itemId}`));
      const dynamicExpanded = expanded.filter((candidate) =>
        selectedKeys.has(`${candidate.itemType}:${candidate.itemId}`));
      const pack = packMemoryPersonalContext({
        core: local.core,
        expanded: dynamicExpanded,
        plan,
        ranked: dynamic
      });
      const degradationCode = degradationFor(local, relevance, dynamicFused.length > 0);
      const utilityExecutions = [
        utilityEvidence("MEMORY_QUERY_EMBED", queryEmbedding),
        utilityEvidence("MEMORY_RERANK", relevance)
      ];
      const externalUtilityUsed = utilityUsedExternal(queryEmbedding) || utilityUsedExternal(relevance);
      const commonEvidence = {
        candidateCount: pack.candidateCount,
        coreCount: local.core.length,
        laneCount: local.laneResults.length,
        lexicalFailures: local.lexicalFailures,
        lexicalState: local.lexicalState,
        omissionCounts: pack.omissionCounts,
        plan: planEvidence(plan),
        utilityEgressMode: externalUtilityUsed ? "CONSENTED_EXTERNAL" : "LOCAL_ONLY",
        utilityExecutions,
        vectorEvidence: local.vectorEvidence,
        vectorState: local.vectorState
      } as const;
      if (!pack.text || pack.items.length === 0) {
        return emptyAttempt(input.expected,
          querySecret ? "FAILED_SAFE" : "EMPTY",
          querySecret ? "query_secret_blocked" : degradationCode ?? "no_relevant_memory",
          querySecret || !plan.queryPresent ? null : plan.normalizedQuery,
          { ...commonEvidence, ...(querySecret ? { queryHash: memorySha256(plan.normalizedQuery) } : {}) });
      }
      const items = attemptItems(pack, local.core, dynamic);
      return {
        budgetSnapshot: {
          admissionVersion: MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION,
          ...commonEvidence,
          hardCapTokens: pack.hardCapTokens,
          itemCount: items.length,
          packedTokens: pack.approxTokens,
          packerVersion: pack.packerVersion,
          pipelineVersion: MEMORY_RETRIEVAL_PIPELINE_VERSION,
          schemaVersion: 2,
          settingsRevision: input.expected.settings.settingsRevision,
          targetTokens: pack.targetTokens
        },
        ...(degradationCode ? { degradationCode } : {}),
        items,
        outcome: degradationCode ? "DEGRADED" : "USED",
        preparedContext: { approxTokens: pack.approxTokens, text: pack.text },
        ...(querySecret ? { queryHash: memorySha256(plan.normalizedQuery) } : {}),
        querySnapshot: querySecret || !plan.queryPresent ? null : plan.normalizedQuery
      };
    }
  });
}

export function createPrismaMemoryRunRetrievalService(
  client: PrismaClient = prisma,
  options: Readonly<{ authority?: MemoryExecutionAuthorityDependencies }> = {}
): MemoryRunRetrievalService {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  return createMemoryRunRetrievalService(
    createPrismaLocalMemoryRetrievalRepository(client),
    {
      utilities: createPrismaMemoryRunUtilityService(authority, client),
      vectorRepository: createPrismaMemoryVectorRepository(client)
    }
  );
}
