import type { PrismaClient } from "@prisma/client";
import {
  MEMORY_CONTEXT_HARD_CAP_TOKENS,
  MEMORY_CONTEXT_TARGET_TOKENS,
  MEMORY_RETRIEVAL_PIPELINE_VERSION,
  MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE,
  fuseMemoryRetrievalCandidates,
  packMemoryPersonalContext,
  planMemoryRetrieval,
  type MemoryContextPack,
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
import { MEMORY_PHASE7_CAPABILITY_POLICY } from "../capabilityPolicy";
import { memoryExplicitStatementContainsSecret } from "../explicit/safety";
import {
  memorySha256,
  normalizeMemorySearchText,
  normalizeMemorySearchTextYo
} from "../persistence/lexical";
import {
  createPrismaLocalMemoryRetrievalRepository,
  type MemoryLocalRetrievalResult,
  type MemoryLocalRetrievalSnapshot,
  type PrismaLocalMemoryRetrievalRepository
} from "./localRepository";
import {
  createPrismaMemoryRunUtilityService,
  type MemoryRunQueryEmbeddingResult,
  type MemoryRunQueryExpansionResult,
  type MemoryRunRerankResult,
  type MemoryRunUtilityService
} from "./runUtilities";
import {
  createPrismaMemoryVectorRepository,
  type MemoryVectorRepository
} from "./vector";

export const MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION =
  "memory-run-retrieval-admission-v1";

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
  enableQueryExpansion?: boolean;
  enableRemoteRerank?: boolean;
  utilities?: MemoryRunUtilityService;
  vectorRepository?: Pick<MemoryVectorRepository, "resolveActiveProfile">;
}>;

type UtilityEvidence = Readonly<{
  reason: string | null;
  role: "MEMORY_QUERY_EMBED" | "MEMORY_QUERY_EXPAND" | "MEMORY_RERANK";
  state: "READY" | "SKIPPED" | "UNAVAILABLE";
}>;

function boundedCurrentUserText(request: NormalizedRunRequest): string {
  return Array.from(textFromContentBlocks(request.content)).slice(0, 2_000).join("");
}

function priorDirectUserTexts(request: NormalizedRunRequest, current: string): string[] {
  const values = (request.context?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => textFromContentBlocks(message.content).trim())
    .filter((text) => Boolean(text) && !memoryExplicitStatementContainsSecret(text));
  if (values.at(-1) === current.trim()) values.pop();
  return values.slice(-2);
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
    schemaVersion: 1,
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

function rankedByKey(
  ranked: readonly MemoryRankedCandidate[]
): ReadonlyMap<string, MemoryRankedCandidate> {
  return new Map(ranked.map((candidate) => [
    `${candidate.itemType}:${candidate.itemId}`,
    candidate
  ]));
}

function attemptItems(
  pack: MemoryContextPack,
  ranked: readonly MemoryRankedCandidate[]
): readonly MemoryPreparingItemInput[] {
  const candidates = rankedByKey(ranked);
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
        temporalReason: packed.temporalReason
      },
      finalScore: candidate.finalScore,
      laneRanks: candidate.laneRanks,
      projectionKind: packed.projectionKind,
      selectionReason: candidate.selectionReason,
      supportingItemId: packed.supportingItemId
    } as const;
    if (packed.itemType === "FACT_VERSION") {
      return { ...base, factVersionId: packed.itemId, itemType: "FACT_VERSION" };
    }
    if (packed.itemType === "EPISODE") {
      return { ...base, episodeId: packed.itemId, itemType: "EPISODE" };
    }
    return { ...base, itemType: "RECALL_CHUNK", recallChunkId: packed.itemId };
  });
}

function degradationFor(
  result: MemoryLocalRetrievalResult,
  rerank: MemoryRunRerankResult | null
): string | null {
  if (result.lexicalState === "FAILED") return "memory_fts_unavailable";
  if (result.lexicalState === "DEGRADED") return "memory_fts_partial_unavailable";
  if (result.vectorState === "DEGRADED") return "memory_vector_unavailable";
  if (result.snapshot.indexMode === "HYBRID" && result.vectorState === "NOT_CONFIGURED") {
    return "memory_query_embedding_unavailable";
  }
  if (rerank?.status === "UNAVAILABLE") return "memory_reranker_unavailable";
  return null;
}

function planEvidence(plan: MemoryRetrievalPlan): Readonly<Record<string, unknown>> {
  return {
    canonicalHintCount: plan.canonicalKeyHints.length,
    entityHintCount: plan.entityHints.length,
    intent: plan.intent,
    language: plan.language,
    plannerVersion: plan.plannerVersion,
    temporalMode: plan.temporal.mode,
    temporalResolverVersion: plan.temporal.resolverVersion,
    usedPriorUserTurns: plan.usedPriorUserTurns
  };
}

function utilityEvidence(
  role: UtilityEvidence["role"],
  result:
    | MemoryRunQueryEmbeddingResult
    | MemoryRunQueryExpansionResult
    | MemoryRunRerankResult
    | null
): UtilityEvidence {
  if (!result) return { reason: null, role, state: "SKIPPED" };
  return result.status === "READY"
    ? { reason: null, role, state: "READY" }
    : { reason: result.reason, role, state: "UNAVAILABLE" };
}

function utilityUsedExternal(
  result:
    | MemoryRunQueryEmbeddingResult
    | MemoryRunQueryExpansionResult
    | MemoryRunRerankResult
    | null
): boolean {
  return Boolean(result && "bindingId" in result && result.bindingId);
}

function expandedPlan(
  plan: MemoryRetrievalPlan,
  result: MemoryRunQueryExpansionResult | null
): MemoryRetrievalPlan {
  if (!result || result.status !== "READY" || result.terms.length === 0) return plan;
  const normalizedTerms = result.terms.flatMap((term) => {
    const normalized = normalizeMemorySearchText(term);
    return normalized && !memoryExplicitStatementContainsSecret(normalized)
      ? [normalized]
      : [];
  });
  if (normalizedTerms.length === 0) return plan;
  const queryParts = [plan.normalizedQuery];
  for (const term of normalizedTerms) {
    if (normalizeMemorySearchText(`${queryParts.join(" ")} ${term}`).length > 2_000) break;
    queryParts.push(term);
  }
  const normalizedQuery = normalizeMemorySearchText(queryParts.join(" "));
  const queryTerms = Array.from(new Set([
    ...plan.queryTerms,
    ...normalizedTerms.flatMap((term) => term.split(" "))
  ].filter((term) => term.length > 0 && term.length <= 64))).slice(0, 24);
  if (
    normalizedQuery === plan.normalizedQuery ||
    memoryExplicitStatementContainsSecret(normalizedQuery)
  ) return plan;
  return {
    ...plan,
    normalizedQuery,
    normalizedYoQuery: normalizeMemorySearchTextYo(normalizedQuery),
    plannerVersion: `${plan.plannerVersion}+remote-expand-v1`,
    queryTerms
  };
}

function shouldExpandQuery(plan: MemoryRetrievalPlan): boolean {
  return plan.temporal.mode === "AMBIGUOUS" ||
    plan.intent === "PAST_HISTORY" ||
    plan.usedPriorUserTurns > 0 && plan.intent === "PERSONALIZE";
}

function rerankCandidates(
  ranked: readonly MemoryRankedCandidate[],
  expanded: readonly MemoryExpandedCandidate[]
): readonly Readonly<{
  candidate: MemoryRankedCandidate;
  handle: string;
  text: string;
}>[] {
  const projections = new Map(expanded.map((candidate) => [
    `${candidate.itemType}:${candidate.itemId}`,
    candidate.safeText
  ]));
  return ranked.flatMap((candidate) => {
    const text = projections.get(`${candidate.itemType}:${candidate.itemId}`);
    return text ? [{ candidate, handle: "", text }] : [];
  }).slice(0, 25).map((entry, index) => ({ ...entry, handle: `c${index}` }));
}

function shouldRerank(
  plan: MemoryRetrievalPlan,
  ranked: readonly MemoryRankedCandidate[]
): boolean {
  return ranked.length > 4 && (
    ranked.length > 12 ||
    plan.intent === "PAST_HISTORY" ||
    plan.intent === "TEMPORAL" ||
    ranked.some((candidate) => candidate.metadata.conflict) ||
    ranked.some((candidate) => Object.keys(candidate.laneRanks).length > 1)
  );
}

function applyRerank(
  ranked: readonly MemoryRankedCandidate[],
  candidates: ReturnType<typeof rerankCandidates>,
  result: MemoryRunRerankResult | null
): readonly MemoryRankedCandidate[] {
  if (!result || result.status !== "READY") return ranked;
  const byHandle = new Map(candidates.map((entry) => [entry.handle, entry.candidate]));
  const reordered = result.orderedHandles.map((handle) => byHandle.get(handle));
  if (reordered.some((candidate) => !candidate)) return ranked;
  const selectedKeys = new Set(candidates.map(({ candidate }) =>
    `${candidate.itemType}:${candidate.itemId}`));
  return [
    ...reordered.map((candidate) => {
      const value = candidate!;
      const reason = `${value.selectionReason}+remote_rerank`;
      return {
        ...value,
        selectionReason: reason.length <= 128 ? reason : "remote_rerank"
      };
    }),
    ...ranked.filter((candidate) =>
      !selectedKeys.has(`${candidate.itemType}:${candidate.itemId}`))
  ];
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
      if (memoryExplicitStatementContainsSecret(currentUserText)) {
        return {
          ...emptyAttempt(input.expected, "FAILED_SAFE", "query_secret_blocked"),
          queryHash: memorySha256(currentUserText)
        };
      }
      let plan = planMemoryRetrieval({
        currentUserText,
        now: input.now,
        priorDirectUserTexts: priorDirectUserTexts(input.normalizedRequest, currentUserText),
        timeZone: input.normalizedRequest.prompt.baseline?.timeZone
      });
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
      if (snapshot.status === "UNAVAILABLE") {
        return emptyAttempt(input.expected, "FAILED_SAFE", snapshot.reason, null, {
          plan: planEvidence(plan)
        });
      }
      if (!plan.retrievalAllowed) {
        return emptyAttempt(input.expected, "EMPTY", "retrieval_not_needed", null, {
          plan: planEvidence(plan)
        });
      }

      let queryExpansion: MemoryRunQueryExpansionResult | null = null;
      if (
        options.enableQueryExpansion === true &&
        options.utilities &&
        shouldExpandQuery(plan)
      ) {
        queryExpansion = await options.utilities.expandQuery({
          attemptId: input.attemptId,
          intent: plan.intent,
          language: plan.language,
          query: plan.normalizedQuery,
          signal,
          userId: input.userId
        }).catch(() => ({
          reason: "memory_query_expansion_unavailable",
          status: "UNAVAILABLE" as const
        }));
        plan = expandedPlan(plan, queryExpansion);
      }

      let queryEmbedding: MemoryRunQueryEmbeddingResult | null = null;
      if (snapshot.indexMode === "HYBRID") {
        if (options.utilities && options.vectorRepository) {
          const profile = await options.vectorRepository.resolveActiveProfile(
            input.userId
          ).catch(() => ({
            reason: "memory_vector_unavailable" as const,
            status: "DEGRADED" as const
          }));
          if (
            profile.status === "READY" &&
            profile.profile.generationId === snapshot.activeGenerationId
          ) {
            queryEmbedding = await options.utilities.embedQuery({
              attemptId: input.attemptId,
              profile: profile.profile,
              query: plan.normalizedQuery,
              signal,
              userId: input.userId
            }).catch(() => ({
              reason: "memory_query_embedding_unavailable",
              status: "UNAVAILABLE" as const
            }));
          } else {
            queryEmbedding = {
              reason: profile.status === "DEGRADED"
                ? profile.reason
                : "memory_vector_generation_stale",
              status: "UNAVAILABLE"
            };
          }
        } else {
          queryEmbedding = {
            reason: "memory_query_embedding_unavailable",
            status: "UNAVAILABLE"
          };
        }
      }

      const utilityResults = () => [
        utilityEvidence("MEMORY_QUERY_EXPAND", queryExpansion),
        utilityEvidence("MEMORY_QUERY_EMBED", queryEmbedding)
      ];
      const utilityEgressMode = () =>
        utilityUsedExternal(queryExpansion) || utilityUsedExternal(queryEmbedding)
          ? "CONSENTED_EXTERNAL"
          : "LOCAL_ONLY";

      let local: MemoryLocalRetrievalResult;
      try {
        local = await repository.retrieve({
          assistantId: input.expected.assistantId,
          chatId: input.chatId,
          now: input.now,
          plan,
          userId: input.userId,
          ...(queryEmbedding?.status === "READY"
            ? {
                vector: {
                  minimumScore: MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE,
                  profile: queryEmbedding.profile,
                  vector: queryEmbedding.vector
                }
              }
            : {})
        });
      } catch (error) {
        return emptyAttempt(input.expected, "FAILED_SAFE", "memory_local_retrieval_failed",
          plan.normalizedQuery, {
            failureClass: error instanceof Error ? error.name : "unknown",
            plan: planEvidence(plan),
            utilityEgressMode: utilityEgressMode(),
            utilityExecutions: utilityResults()
          });
      }
      assertStableSnapshot(local.snapshot, input.expected);
      let ranked = fuseMemoryRetrievalCandidates(plan, local.laneResults, input.now);
      let expanded: readonly MemoryExpandedCandidate[];
      try {
        expanded = await repository.expand(local.snapshot, plan, ranked);
      } catch (error) {
        return emptyAttempt(input.expected, "FAILED_SAFE", "memory_expansion_failed",
          plan.normalizedQuery, {
            candidateCount: ranked.length,
            failureClass: error instanceof Error ? error.name : "unknown",
            plan: planEvidence(plan),
            utilityEgressMode: utilityEgressMode(),
            utilityExecutions: utilityResults()
          });
      }
      let rerank: MemoryRunRerankResult | null = null;
      const rerankInput = rerankCandidates(ranked, expanded);
      if (
        options.enableRemoteRerank === true &&
        options.utilities &&
        shouldRerank(plan, ranked) &&
        rerankInput.length > 0
      ) {
        rerank = await options.utilities.rerank({
          attemptId: input.attemptId,
          candidates: rerankInput.map(({ handle, text }) => ({ handle, text })),
          intent: plan.intent,
          language: plan.language,
          query: plan.normalizedQuery,
          signal,
          userId: input.userId
        }).catch(() => ({
          reason: "memory_reranker_unavailable",
          status: "UNAVAILABLE" as const
        }));
        ranked = applyRerank(ranked, rerankInput, rerank);
      }
      const utilityExecutions = [
        ...utilityResults(),
        utilityEvidence("MEMORY_RERANK", rerank)
      ];
      const externalUtilityUsed = utilityEgressMode() === "CONSENTED_EXTERNAL" ||
        utilityUsedExternal(rerank);
      const pack = packMemoryPersonalContext({ expanded, plan, ranked });
      const degradationCode = degradationFor(local, rerank);
      if (!pack.text || pack.items.length === 0) {
        const retrievalUnavailable = local.lexicalState === "FAILED" &&
          local.vectorState !== "READY";
        return emptyAttempt(input.expected,
          retrievalUnavailable ? "FAILED_SAFE" : "EMPTY",
          retrievalUnavailable ? "memory_local_retrieval_unavailable" : "no_relevant_memory",
          plan.normalizedQuery, {
            candidateCount: pack.candidateCount,
            laneCount: local.laneResults.length,
            lexicalFailures: local.lexicalFailures,
            lexicalState: local.lexicalState,
            omissionCounts: pack.omissionCounts,
            plan: planEvidence(plan),
            utilityEgressMode: externalUtilityUsed
              ? "CONSENTED_EXTERNAL"
              : "LOCAL_ONLY",
            utilityExecutions,
            vectorEvidence: local.vectorEvidence,
            vectorState: local.vectorState
          });
      }
      const items = attemptItems(pack, ranked);
      return {
        budgetSnapshot: {
          admissionVersion: MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION,
          candidateCount: pack.candidateCount,
          hardCapTokens: pack.hardCapTokens,
          itemCount: items.length,
          laneCount: local.laneResults.length,
          lexicalFailures: local.lexicalFailures,
          lexicalState: local.lexicalState,
          omissionCounts: pack.omissionCounts,
          packedTokens: pack.approxTokens,
          packerVersion: pack.packerVersion,
          pipelineVersion: MEMORY_RETRIEVAL_PIPELINE_VERSION,
          plan: planEvidence(plan),
          schemaVersion: 1,
          settingsRevision: input.expected.settings.settingsRevision,
          targetTokens: pack.targetTokens,
          utilityEgressMode: externalUtilityUsed
            ? "CONSENTED_EXTERNAL"
            : "LOCAL_ONLY",
          utilityExecutions,
          vectorEvidence: local.vectorEvidence,
          vectorState: local.vectorState
        },
        ...(degradationCode ? { degradationCode } : {}),
        items,
        outcome: degradationCode ? "DEGRADED" : "USED",
        preparedContext: {
          approxTokens: pack.approxTokens,
          text: pack.text
        },
        querySnapshot: plan.normalizedQuery
      };
    }
  });
}

export function createPrismaMemoryRunRetrievalService(
  client: PrismaClient = prisma,
  options: Pick<MemoryRunRetrievalOptions,
    "enableQueryExpansion" | "enableRemoteRerank"> & Readonly<{
      authority?: MemoryExecutionAuthorityDependencies;
    }> = {}
): MemoryRunRetrievalService {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  return createMemoryRunRetrievalService(
    createPrismaLocalMemoryRetrievalRepository(client),
    {
      enableQueryExpansion: options.enableQueryExpansion ??
        MEMORY_PHASE7_CAPABILITY_POLICY.queryExpansion.enabled,
      enableRemoteRerank: options.enableRemoteRerank ??
        MEMORY_PHASE7_CAPABILITY_POLICY.remoteReranker.enabled,
      utilities: createPrismaMemoryRunUtilityService(
        authority,
        client
      ),
      vectorRepository: createPrismaMemoryVectorRepository(client)
    }
  );
}
