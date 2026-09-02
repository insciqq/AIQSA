import { Prisma, type PrismaClient } from "@prisma/client";
import type { MemoryActionFeedback } from "../../../contracts/memoryClient";
import {
  MEMORY_CONTEXT_HARD_CAP_TOKENS,
  MEMORY_CONTEXT_PATTERN_MIN_SUPPORTS,
  MEMORY_CONTEXT_AGGREGATION_MAX_SOURCE_CHATS,
  MEMORY_CARDINALITY_PARSER_VERSION,
  MEMORY_CONTEXT_TARGET_TOKENS,
  MEMORY_QUERY_SCOPE_CONSTRAINT_MAX_TOKENS,
  MEMORY_DECAY_POLICY_VERSION,
  MEMORY_RETRIEVAL_MAX_AGGREGATION_HISTORY_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_TARGETED_HISTORY_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_TARGETED_RERANK_CANDIDATES,
  MEMORY_RETRIEVAL_PIPELINE_VERSION,
  MEMORY_RETRIEVAL_RERANK_SCORE_FLOOR,
  MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
  applyMemoryDecay,
  attachMemoryQueryScopeConstraints,
  fuseMemoryRetrievalCandidates,
  isEligibleMemoryResponsePreferenceCore,
  memoryCandidateIsSupportingObservation,
  memoryRetrievalAuthorityMultiplier,
  memoryRetrievalEvidenceRootKey,
  orderMemoryCandidatesByDistinctSourceFirst,
  orderMemoryCandidatesWithSoftSourceDiversity,
  packMemoryPersonalContext,
  planMemoryRetrieval,
  type MemoryContextPack,
  type MemoryCoreCandidate,
  type MemoryExpandedCandidate,
  type MemoryPackedQueryScopeConstraint,
  type MemoryRankedCandidate,
  type MemoryRetrievalLane,
  type MemoryRetrievalPlan,
  type MemoryRetrievalPlanBundle,
  type MemorySourceFamilyHardExclusionReason
} from "../../../domain/memory/retrieval";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import { prisma } from "../../prisma";
import type { NormalizedRunRequest } from "../../providers/types";
import {
  MEMORY_ACTION_NO_COMMIT_RESULT,
  type MemoryActionAnswerResult
} from "../../providers/memoryActionAnswer";
import type {
  MemoryPreparingAttemptResult,
  MemoryPreparingItemInput,
  MemoryPreparingSettingsSnapshot
} from "../../runs/preparingRun";
import { MemoryPreparingRunConflictError } from "../../runs/preparingRun";
import { normalizedRequestPersonalContextTokenLimit } from "../../runs/runContextBudget";
import {
  boundedMemoryAdmissionDeadlineMs,
  MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS
} from "../admissionDeadline";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import type { MemoryExecutionAuthorityDependencies } from "../execution";
import { memorySha256 } from "../persistence/lexical";
import { redactMemorySecrets } from "../explicit/safety";
import {
  createMemoryReadOnlyControlReuseProof,
  createPrismaMemoryControlService,
  memoryControlInputHash,
  type MemoryControlResult,
  type MemoryControlService,
  type MemoryReadOnlyControlReuseProof
} from "../actions/controlRuntime";
import {
  admitMemoryAction,
  type MemoryActionAdmission
} from "../actions/actionAdmission";
import { defaultMemoryIntentActionExecutor } from "../actions/defaultAction";
import type { MemoryIntentActionExecutor } from "../actions/intentExecutor";
import { loadMemoryRunSources } from "../sources/runProjection";
import {
  createPrismaLocalMemoryRetrievalRepository,
  selectMemoryTargetedSessionRepresentatives,
  type MemoryLocalRetrievalResult,
  type MemoryLocalRetrievalSnapshot,
  type MemorySessionEvidenceCompletion,
  type PrismaLocalMemoryRetrievalRepository
} from "./localRepository";
import {
  createPrismaMemoryRunUtilityService,
  MEMORY_RERANK_MAX_ATTEMPTS,
  type MemoryRunQueryEmbeddingResult,
  type MemoryRunRerankDecision,
  type MemoryRunRerankResult,
  type MemoryRunUtilityService
} from "./runUtilities";
import {
  MEMORY_AGGREGATION_POLICY_VERSION,
  type MemoryAggregationState
} from "./aggregation";
import {
  createPrismaMemoryVectorRepository,
  type MemoryVectorRepository
} from "./vector";
import {
  sanitizeMemoryUtilityText,
  type MemorySanitizedUtilityText
} from "./querySafety";
import {
  MEMORY_QUERY_RESOLVER_MAX_SOURCES,
  type MemoryQueryResolverResult,
  type MemoryQueryResolverService,
  type MemoryQueryResolverSource
} from "./queryResolver";
import {
  DEFAULT_MEMORY_READ_UTILITY_POLICY,
  type MemoryReadUtilityPolicy
} from "./readUtilityPolicy";

export const MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION =
  "memory-run-retrieval-admission-v55";
export const MEMORY_RETRIEVAL_COMPONENT_METRICS_VERSION =
  "memory-retrieval-component-metrics-v19";

export { MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS } from "../admissionDeadline";

const MEMORY_ADMISSION_DEADLINE_REASON = Object.freeze({
  code: "memory_admission_deadline_exceeded"
});
const safeInternalMemoryFailure = /^memory_[a-z0-9_]{1,96}$/u;

type MemoryExpansionFailure = Readonly<{
  failureClass: "ABORTED" | "DATABASE" | "INTERNAL" | "UNKNOWN";
  failureCode: string;
}>;

function classifyMemoryExpansionFailure(error: unknown): MemoryExpansionFailure {
  if (error instanceof Error && safeInternalMemoryFailure.test(error.message)) {
    return Object.freeze({ failureClass: "INTERNAL", failureCode: error.message });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const code = error.code.toLowerCase();
    return Object.freeze({
      failureClass: "DATABASE",
      failureCode: /^p[0-9]{4}$/u.test(code)
        ? `memory_expansion_database_${code}`
        : "memory_expansion_database_failed"
    });
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof Prisma.PrismaClientInitializationError) {
    return Object.freeze({
      failureClass: "DATABASE",
      failureCode: "memory_expansion_database_failed"
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return Object.freeze({
      failureClass: "ABORTED",
      failureCode: "memory_expansion_aborted"
    });
  }
  return Object.freeze({
    failureClass: "UNKNOWN",
    failureCode: "memory_expansion_failed"
  });
}

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
  controlCache?: MemoryRunControlCache;
  expected: MemoryRunRetrievalExpectedSnapshot;
  modelRunId: string;
  normalizedRequest: NormalizedRunRequest;
  now: Date;
  signal?: AbortSignal;
  userId: string;
}>;

export type MemoryRunRetrievalService = Readonly<{
  retrieve(input: MemoryRunRetrievalInput): Promise<MemoryPreparingAttemptResult>;
}>;

export type MemoryRunRetrievalOptions = Readonly<{
  actionExecutor?: MemoryIntentActionExecutor;
  admissionDeadlineMs?: number;
  clock?: () => number;
  control?: MemoryControlService;
  controlRefs?: MemoryControlRefProvider;
  monotonicClock?: () => number;
  queryResolver?: MemoryQueryResolverService;
  readUtilityPolicy?: MemoryReadUtilityPolicy;
  utilities?: MemoryRunUtilityService;
  vectorRepository?: Pick<MemoryVectorRepository, "resolveActiveProfile">;
}>;

export type MemoryControlRefProvider = Readonly<{
  load(input: Readonly<{
    assistantMessageIds: readonly string[];
    chatId: string;
    userId: string;
  }>): Promise<readonly string[]>;
}>;

export type MemoryRunControlCache = {
  actionAttemptId?: string;
  actionResolved?: boolean;
  actionResult?: MemoryActionFeedback | null;
  admissionDeadlineAtMs?: number;
  control?: MemoryControlResult;
  controlAttemptId?: string;
  controlInputHash?: string;
  controlReuseScopeHash?: string;
  fallbackControlReuseAttemptId?: string;
  fallbackControlReuseProof?: MemoryFallbackControlReuseProof;
  readOnlyControlReuseAttemptId?: string;
  readOnlyControlReuseProof?: MemoryReadOnlyControlReuseProof;
  queryResolverConsumedAttemptId?: string;
  rerankConsumedAttemptId?: string;
  settingsDriftFailedSafeAttemptId?: string;
  settingsDriftFailedSafeBudget?: Readonly<Record<string, unknown>>;
};

export type MemoryFallbackControlReuseProof = Readonly<{
  reason: string;
  sourceAttemptId: string;
  version: 1;
}>;

type MemoryAdmissionDeadline = Readonly<{
  canStartOptional(): boolean;
  dispose(): void;
  expired(): boolean;
  remainingMs(): number;
  signal: AbortSignal;
}>;

type UtilityEvidence = Readonly<{
  externalCall: boolean;
  externalCallCount: number;
  providerRequestRoutes?: readonly (string | null)[];
  reason: string | null;
  role: "MEMORY_CONTROL" | "MEMORY_QUERY_EMBED" | "MEMORY_QUERY_RESOLVE" |
    "MEMORY_RERANK";
  state: "READY" | "SKIPPED" | "UNAVAILABLE";
}>;

type MemoryPreparationStage =
  | "aggregationProviderMs"
  | "controlMs"
  | "deterministicAggregationMs"
  | "localRetrievalMs"
  | "packerMs"
  | "queryEmbeddingMs"
  | "queryResolverMs"
  | "rejoinMs"
  | "rerankMs"
  | "snapshotMs";

type MemoryPreparationTimings = Readonly<{
  finish(): Readonly<Record<MemoryPreparationStage | "memoryPrepareMs", number>>;
  measure<T>(stage: MemoryPreparationStage, operation: () => Promise<T>): Promise<T>;
  measureSync<T>(stage: MemoryPreparationStage, operation: () => T): T;
}>;

function elapsedMilliseconds(clock: () => number, startedAt: number): number {
  const elapsed = clock() - startedAt;
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

function createMemoryPreparationTimings(clock: () => number): MemoryPreparationTimings {
  const startedAt = clock();
  const stages: Record<MemoryPreparationStage, number> = {
    aggregationProviderMs: 0,
    controlMs: 0,
    deterministicAggregationMs: 0,
    localRetrievalMs: 0,
    packerMs: 0,
    queryEmbeddingMs: 0,
    queryResolverMs: 0,
    rejoinMs: 0,
    rerankMs: 0,
    snapshotMs: 0
  };
  const record = (stage: MemoryPreparationStage, stageStartedAt: number) => {
    stages[stage] += elapsedMilliseconds(clock, stageStartedAt);
  };
  return Object.freeze({
    finish() {
      const rounded = Object.fromEntries(Object.entries(stages).map(([stage, value]) => [
        stage,
        Math.round(value)
      ])) as Record<MemoryPreparationStage, number>;
      return Object.freeze({
        ...rounded,
        memoryPrepareMs: Math.round(elapsedMilliseconds(clock, startedAt))
      });
    },
    async measure<T>(stage: MemoryPreparationStage, operation: () => Promise<T>): Promise<T> {
      const stageStartedAt = clock();
      try {
        return await operation();
      } finally {
        record(stage, stageStartedAt);
      }
    },
    measureSync<T>(stage: MemoryPreparationStage, operation: () => T): T {
      const stageStartedAt = clock();
      try {
        return operation();
      } finally {
        record(stage, stageStartedAt);
      }
    }
  });
}

function memoryPreparationLatencyBucket(milliseconds: number): string {
  if (milliseconds < 1_000) return "LT_1S";
  if (milliseconds < 3_000) return "1S_TO_3S";
  if (milliseconds < 5_000) return "3S_TO_5S";
  if (milliseconds < 8_000) return "5S_TO_8S";
  if (milliseconds <= 12_000) return "8S_TO_12S";
  return "GT_12S";
}

function budgetUtilityCallCount(
  budget: Readonly<Record<string, unknown>>,
  role: UtilityEvidence["role"] | "MEMORY_AGGREGATE"
): number {
  if (!Array.isArray(budget.utilityExecutions)) return 0;
  return budget.utilityExecutions.reduce((total, entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return total;
    const record = entry as Record<string, unknown>;
    return record.role === role && Number.isSafeInteger(record.externalCallCount) &&
      Number(record.externalCallCount) >= 0
      ? total + Number(record.externalCallCount)
      : total;
  }, 0);
}

function withMemoryPreparationEvidence(
  result: MemoryPreparingAttemptResult,
  timings: MemoryPreparationTimings,
  queryResolverExecution: MemoryQueryResolverExecution | null = null
): MemoryPreparingAttemptResult {
  const latency = timings.finish();
  let budget = result.budgetSnapshot;
  if (queryResolverExecution) {
    const executions = Array.isArray(budget.utilityExecutions)
      ? budget.utilityExecutions
      : [];
    const resolverDeclared = executions.some((entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
      (entry as Readonly<Record<string, unknown>>).role === "MEMORY_QUERY_RESOLVE");
    const sourceCharacterCount = queryResolverExecution.sources.reduce(
      (total, source) => total + source.userTexts.reduce(
        (sourceTotal, text) => sourceTotal + text.length,
        0
      ),
      0
    );
    const resolverEvidence = utilityEvidence(
      "MEMORY_QUERY_RESOLVE",
      queryResolverExecution.result
    );
    const utilityExecutions = resolverDeclared
      ? executions.map((entry) =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
          (entry as Readonly<Record<string, unknown>>).role === "MEMORY_QUERY_RESOLVE"
            ? resolverEvidence
            : entry)
      : [...executions, resolverEvidence];
    const componentMetrics = typeof budget.componentMetrics === "object" &&
      budget.componentMetrics !== null && !Array.isArray(budget.componentMetrics)
      ? {
          ...(budget.componentMetrics as Readonly<Record<string, unknown>>),
          ...utilityExecutionMetricEvidence(utilityExecutions)
        }
      : null;
    budget = {
      ...budget,
      ...(componentMetrics ? { componentMetrics } : {}),
      queryResolverExecutionStrategy: queryResolverExecution.strategy,
      queryResolverSourceCharacterCount: sourceCharacterCount,
      queryResolverSourceCount: queryResolverExecution.sources.length,
      ...(budget.queryResolverState === undefined
        ? {
            queryResolverState: "SKIPPED",
            queryScopeAttachedConstraintKindCounts: Object.freeze({}),
            queryScopeProposedConstraintCount: 0
          }
        : {}),
      utilityEgressMode: budget.utilityEgressMode === "CONSENTED_EXTERNAL" ||
        utilityUsedExternal(queryResolverExecution.result)
        ? "CONSENTED_EXTERNAL"
        : "LOCAL_ONLY",
      utilityExecutions
    };
  }
  return {
    ...result,
    budgetSnapshot: {
      ...budget,
      ...latency,
      aggregationProviderCalls: budgetUtilityCallCount(budget, "MEMORY_AGGREGATE"),
      controlProviderCalls: budgetUtilityCallCount(budget, "MEMORY_CONTROL"),
      memoryPrepareLatencyBucket: memoryPreparationLatencyBucket(latency.memoryPrepareMs),
      queryEmbeddingProviderCalls: budgetUtilityCallCount(budget, "MEMORY_QUERY_EMBED"),
      queryResolverProviderCalls: budgetUtilityCallCount(budget, "MEMORY_QUERY_RESOLVE"),
      rerankProviderCalls: budgetUtilityCallCount(budget, "MEMORY_RERANK")
    }
  };
}

function exactCurrentUserText(request: NormalizedRunRequest): string {
  return textFromContentBlocks(request.content);
}

function acceptedMemoryTimeZone(request: NormalizedRunRequest): string {
  return request.prompt.baseline?.timeZone ?? "UTC";
}

function recentAssistantMessageIds(request: NormalizedRunRequest): readonly string[] {
  return (request.context?.messages ?? []).flatMap((message) =>
    message.role === "assistant" && message.id ? [message.id] : [])
    .slice(-2);
}

type MemoryControlContext = Parameters<MemoryControlService["decide"]>[0]["context"];

function recentControlMessages(
  request: NormalizedRunRequest
): MemoryControlContext["recentMessages"] {
  return (request.context?.messages ?? []).flatMap((message) => {
    if (message.role !== "assistant" && message.role !== "user") return [];
    const text = textFromContentBlocks(message.content);
    const safeText = sanitizeMemoryUtilityText(text).safeText;
    return safeText ? [{ role: message.role, text: safeText }] : [];
  });
}

function memoryControlContext(
  input: MemoryRunRetrievalInput,
  currentUserMessage: string,
  memoryRefs: readonly string[]
): MemoryControlContext {
  return {
    capabilities: {
      automaticLearning: input.expected.settings.learnAutomatically,
      historyRecall: input.expected.settings.referenceChatHistory,
      memoryEnabled: input.expected.settings.useMemoryFacts
    },
    currentUserMessage,
    memoryRefs,
    recentMessages: recentControlMessages(input.normalizedRequest)
  };
}

/** Retry reuse is deliberately narrower than the provider input hash. The
 * prior opaque Memory refs are safe to retain only because NONE cannot
 * authorize an action; every other admitted setting must still be identical
 * apart from the Memory content revision that caused the retry. */
function memoryControlReuseScopeHash(
  input: MemoryRunRetrievalInput,
  currentUserMessage: string
): string {
  return memorySha256({
    activeIndexGenerationId: input.expected.activeIndexGenerationId,
    assistantId: input.expected.assistantId,
    chatId: input.chatId,
    chatMemoryMode: input.expected.chatMemoryMode,
    controlContext: memoryControlContext(input, currentUserMessage, []),
    folderId: input.expected.folderId,
    memoryGeneration: input.expected.memoryGeneration,
    modelRunId: input.modelRunId,
    settings: input.expected.settings,
    userId: input.userId,
    version: 1
  });
}

function deterministicBaseReadPlan(
  input: MemoryRunRetrievalInput,
  originalSanitizedQuery: string
): MemoryRetrievalPlan {
  const sourceKinds = [
    ...(input.expected.settings.useMemoryFacts
      ? ["FACT" as const, "EVENT" as const]
      : []),
    ...(input.expected.settings.referenceChatHistory ? ["HISTORY" as const] : [])
  ];
  return planMemoryRetrieval({
    currentUserText: originalSanitizedQuery,
    filters: { sourceKinds },
    now: input.now,
    temporalIntent: "ANY",
    timeZone: acceptedMemoryTimeZone(input.normalizedRequest)
  });
}

/** A missing optional planner must not narrow authoritative recall. Use the
 * original sanitized query across every enabled source family and grant the
 * final reader the complex enumerate/deduplicate/count contract. No inferred
 * quantity, language keyword, or benchmark category participates. */
function deterministicBroadFallbackReadPlans(
  input: MemoryRunRetrievalInput,
  originalSanitizedQuery: string
): Readonly<{
  baseline: MemoryRetrievalPlan | null;
  enriched: MemoryRetrievalPlan;
}> {
  if (!input.expected.settings.referenceChatHistory) {
    return {
      baseline: null,
      enriched: deterministicBaseReadPlan(input, originalSanitizedQuery)
    };
  }
  const baseline = input.expected.settings.useMemoryFacts
    ? planMemoryRetrieval({
        currentUserText: originalSanitizedQuery,
        filters: { sourceKinds: ["FACT", "EVENT"] },
        now: input.now,
        temporalIntent: "ANY",
        timeZone: acceptedMemoryTimeZone(input.normalizedRequest)
      })
    : null;
  return {
    baseline,
    enriched: planMemoryRetrieval({
      aggregationRequested: true,
      currentUserText: originalSanitizedQuery,
      filters: { sourceKinds: ["HISTORY"] },
      mode: "PAST_CHAT_SEARCH",
      now: input.now,
      temporalIntent: "ANY",
      timeZone: acceptedMemoryTimeZone(input.normalizedRequest)
    })
  };
}

async function prepareOriginalQueryEmbedding(input: Readonly<{
  deadline: MemoryAdmissionDeadline;
  plan: MemoryRetrievalPlan;
  retrieval: MemoryRunRetrievalInput;
  options: MemoryRunRetrievalOptions;
  snapshot: MemoryLocalRetrievalSnapshot;
  timings: MemoryPreparationTimings;
}>): Promise<MemoryRunQueryEmbeddingResult | null> {
  if (!input.plan.queryPresent || input.snapshot.indexMode !== "HYBRID") return null;
  const utilities = input.options.utilities;
  const vectorRepository = input.options.vectorRepository;
  if (!utilities || !vectorRepository) {
    return { reason: "memory_query_embedding_unavailable", status: "UNAVAILABLE" };
  }
  try {
    return await input.timings.measure("queryEmbeddingMs", () =>
      runOptionalMemoryUtility(input.deadline, "QUERY_EMBED", async (utilitySignal) => {
        const profile = await abortableRead(
          vectorRepository.resolveActiveProfile(input.retrieval.userId),
          utilitySignal
        ).catch(() => ({
          reason: "memory_vector_unavailable" as const,
          status: "DEGRADED" as const
        }));
        if (profile.status !== "READY") {
          return {
            reason: profile.status === "DEGRADED"
              ? profile.reason
              : "memory_vector_generation_stale",
            status: "UNAVAILABLE" as const
          };
        }
        if (profile.profile.generationId !== input.snapshot.activeGenerationId) {
          return {
            reason: "memory_vector_generation_stale",
            status: "UNAVAILABLE" as const
          };
        }
        return utilities.embedQuery({
          attemptId: input.retrieval.attemptId,
          profile: profile.profile,
          query: input.plan.originalSanitizedQuery,
          signal: utilitySignal,
          userId: input.retrieval.userId
        });
      }));
  } catch {
    return { reason: "memory_query_embedding_unavailable", status: "UNAVAILABLE" };
  }
}

function candidateSourceKind(
  candidate: Pick<MemoryRankedCandidate, "itemType" | "metadata">
): "EVENT" | "FACT" | "HISTORY" {
  if (candidate.itemType !== "FACT_VERSION") return "HISTORY";
  return candidate.metadata.modality === "EVENT" ? "EVENT" : "FACT";
}

function requiresBaselineAuthority(
  plan: MemoryRetrievalPlan,
  candidate: Pick<MemoryRankedCandidate, "itemType" | "metadata">
): boolean {
  return !plan.filters.sourceKinds.includes(candidateSourceKind(candidate));
}

async function expandWithSourceFamilyPlans(input: Readonly<{
  candidates: readonly MemoryRankedCandidate[];
  navigation: boolean;
  plans: MemoryRetrievalPlanBundle;
  repository: PrismaLocalMemoryRetrievalRepository;
  snapshot: MemoryLocalRetrievalSnapshot;
}>): Promise<readonly MemoryExpandedCandidate[]> {
  const baseline = input.plans.baseline;
  const baselineCandidates = baseline
    ? input.candidates.filter((candidate) =>
        requiresBaselineAuthority(input.plans.enriched, candidate))
    : [];
  const baselineKeys = new Set(baselineCandidates.map((candidate) =>
    `${candidate.itemType}:${candidate.itemId}`));
  const enrichedCandidates = input.candidates.filter((candidate) =>
    !baselineKeys.has(`${candidate.itemType}:${candidate.itemId}`));
  const [baselineExpanded, enrichedExpanded] = await Promise.all([
    baseline && baselineCandidates.length > 0
      ? input.repository.expand(input.snapshot, baseline, baselineCandidates)
      : Promise.resolve([]),
    enrichedCandidates.length > 0
      ? input.navigation
        ? input.repository.expandAggregationNavigation(
            input.snapshot,
            input.plans.enriched,
            enrichedCandidates
          )
        : input.repository.expand(
            input.snapshot,
            input.plans.enriched,
            enrichedCandidates
          )
      : Promise.resolve([])
  ]);
  const expanded = new Map([...baselineExpanded, ...enrichedExpanded].map((candidate) => [
    `${candidate.itemType}:${candidate.itemId}`,
    candidate
  ]));
  return input.candidates.flatMap((candidate) => {
    const value = expanded.get(`${candidate.itemType}:${candidate.itemId}`);
    return value ? [value] : [];
  });
}

function readOnlyControlRetryProof(
  cache: MemoryRunControlCache,
  input: MemoryRunRetrievalInput,
  reuseScopeHash: string
): MemoryReadOnlyControlReuseProof | null {
  const control = cache.control;
  if (
    !control ||
    control.status !== "READY" ||
    control.intent.action !== "NONE" ||
    cache.controlAttemptId === undefined ||
    cache.controlAttemptId === input.attemptId ||
    cache.controlInputHash === undefined ||
    cache.controlReuseScopeHash !== reuseScopeHash ||
    cache.actionResolved !== true ||
    cache.actionAttemptId !== cache.controlAttemptId ||
    (cache.actionResult ?? null) !== null
  ) return null;
  return createMemoryReadOnlyControlReuseProof({
    inputHash: cache.controlInputHash,
    result: control,
    sourceAttemptId: cache.controlAttemptId
  });
}

function fallbackControlRetryProof(
  cache: MemoryRunControlCache,
  input: MemoryRunRetrievalInput,
  reuseScopeHash: string
): MemoryFallbackControlReuseProof | null {
  const control = cache.control;
  if (
    !control ||
    control.status !== "UNAVAILABLE" ||
    cache.controlAttemptId === undefined ||
    cache.controlAttemptId === input.attemptId ||
    cache.controlReuseScopeHash !== reuseScopeHash ||
    cache.actionResolved !== true ||
    cache.actionAttemptId !== cache.controlAttemptId ||
    (cache.actionResult ?? null) !== null
  ) return null;
  return Object.freeze({
    reason: control.reason,
    sourceAttemptId: cache.controlAttemptId,
    version: 1 as const
  });
}

function createPrismaMemoryControlRefProvider(
  client: PrismaClient
): MemoryControlRefProvider {
  return Object.freeze({
    async load(input) {
      const assistantMessageIds = [...new Set(input.assistantMessageIds)].slice(-2);
      if (assistantMessageIds.length === 0) return [];
      const runs = await client.modelRun.findMany({
        select: { assistantMessageId: true, id: true },
        where: {
          assistantMessageId: { in: assistantMessageIds },
          chatId: input.chatId,
          status: "complete",
          userId: input.userId
        }
      });
      const runByMessageId = new Map(runs.flatMap((run) =>
        run.assistantMessageId ? [[run.assistantMessageId, run.id] as const] : []));
      const orderedRunIds = assistantMessageIds.flatMap((messageId) => {
        const runId = runByMessageId.get(messageId);
        return runId ? [runId] : [];
      });
      const sources = await loadMemoryRunSources(client, {
        runIds: orderedRunIds,
        userId: input.userId
      });
      return orderedRunIds.flatMap((runId) => sources.get(runId) ?? [])
        .flatMap((source) => source.sourceAvailable && source.sourceType !== "PAST_CHAT" &&
          typeof source.memoryRef === "string" &&
          (source.actions.includes("CORRECT") || source.actions.includes("FORGET"))
          ? [source.memoryRef]
          : [])
        .slice(-20);
    }
  });
}

function baseBudget(
  reason: string,
  snapshot: MemoryRunRetrievalExpectedSnapshot,
  extras: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return {
    admissionVersion: MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION,
    budgetProfile: "SIMPLE",
    hardCapTokens: MEMORY_CONTEXT_HARD_CAP_TOKENS,
    itemCount: 0,
    memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
    pipelineVersion: MEMORY_RETRIEVAL_PIPELINE_VERSION,
    reason,
    schemaVersion: 2,
    settingsRevision: snapshot.settings.settingsRevision,
    providerTokenLimit: null,
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
  const queryHash = typeof extras.queryHash === "string" ? extras.queryHash : null;
  return {
    budgetSnapshot: baseBudget(reason, expected, extras),
    items: [],
    outcome,
    preparedContext: null,
    ...(queryHash ? { queryHash } : {}),
    querySnapshot
  };
}

function createMemoryAdmissionDeadline(
  cache: MemoryRunControlCache,
  parentSignal: AbortSignal | undefined,
  options: Pick<MemoryRunRetrievalOptions, "admissionDeadlineMs" | "clock">
): MemoryAdmissionDeadline {
  const clock = options.clock ?? Date.now;
  const nowMs = clock();
  const existingDeadlineAtMs = cache.admissionDeadlineAtMs;
  const requestedDeadlineAtMs = nowMs + boundedMemoryAdmissionDeadlineMs(
    options.admissionDeadlineMs
  );
  const hasExistingDeadline = typeof existingDeadlineAtMs === "number" &&
    Number.isFinite(existingDeadlineAtMs);
  const outerDeadlineAtMs = hasExistingDeadline
    ? options.admissionDeadlineMs === undefined
      ? existingDeadlineAtMs
      : Math.min(existingDeadlineAtMs, requestedDeadlineAtMs)
    : requestedDeadlineAtMs;
  cache.admissionDeadlineAtMs = outerDeadlineAtMs;
  const hardDeadlineAtMs = Math.min(
    outerDeadlineAtMs,
    nowMs + MEMORY_INTERACTIVE_HARD_DEADLINE_MS
  );
  const softDeadlineAtMs = Math.min(
    hardDeadlineAtMs,
    nowMs + MEMORY_INTERACTIVE_SOFT_DEADLINE_MS
  );

  const controller = new AbortController();
  let expired = hardDeadlineAtMs <= nowMs;
  const expire = () => {
    expired = true;
    if (!controller.signal.aborted) {
      controller.abort(MEMORY_ADMISSION_DEADLINE_REASON);
    }
  };
  const forwardParentAbort = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) {
    forwardParentAbort();
  } else {
    parentSignal?.addEventListener("abort", forwardParentAbort, { once: true });
  }
  const timeout = !controller.signal.aborted && !expired
    ? setTimeout(expire, hardDeadlineAtMs - nowMs)
    : null;
  if (expired) expire();

  return Object.freeze({
    canStartOptional: () => !controller.signal.aborted &&
      clock() < softDeadlineAtMs,
    dispose() {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", forwardParentAbort);
    },
    expired: () => expired || clock() >= hardDeadlineAtMs,
    remainingMs: () => Math.max(0, hardDeadlineAtMs - clock()),
    signal: controller.signal
  });
}

type OptionalMemoryUtilityRole = "CONTROL" | "QUERY_EMBED" | "QUERY_RESOLVE" | "RERANK";

// Keep enough room for a measured 20-second System Model utility followed by
// the unchanged four-second reranker and the two-second terminal reserve. The
// installation-wide 30-second admission deadline remains the outer authority.
export const MEMORY_INTERACTIVE_SOFT_DEADLINE_MS = 20_000;
export const MEMORY_INTERACTIVE_HARD_DEADLINE_MS = 26_000;
export const MEMORY_SNAPSHOT_OPTIONAL_MAXIMUM_MS = 1_000;
export const MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS = 1_500;
// Query embedding starts beside the control call and keeps its own eight-second
// fence. System Model utilities get a wider measurement window without
// extending embedding or reranker provider budgets.
export const MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS = 8_000;
// The resolver starts from the original-query speculative frontier beside the
// control call. Its child fence is only a provider-execution safety ceiling:
// the final pack boundary never waits for it, while the admission fence and
// terminal-settlement reserve remain authoritative.
export const MEMORY_QUERY_RESOLVER_OPTIONAL_MAXIMUM_MS = 20_000;
export const MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS = 2_000;
export const MEMORY_RERANK_OPTIONAL_MAXIMUM_MS = 4_000;
export const MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS = 20_000;

const optionalUtilityBudget = Object.freeze({
  CONTROL: {
    maximumMs: MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS,
    reserveMs: 0
  },
  QUERY_EMBED: {
    maximumMs: MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS,
    reserveMs: 0
  },
  QUERY_RESOLVE: {
    maximumMs: MEMORY_QUERY_RESOLVER_OPTIONAL_MAXIMUM_MS,
    // Governed cancellation settlement must stay inside the hard admission
    // envelope even though the synchronous attachment boundary never waits.
    reserveMs: MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS
  },
  RERANK: {
    maximumMs: MEMORY_RERANK_OPTIONAL_MAXIMUM_MS,
    // Preserve time for authoritative rejoin and the synchronous packer.
    reserveMs: 2_000
  }
} satisfies Record<OptionalMemoryUtilityRole, Readonly<{
  maximumMs: number;
  reserveMs: number;
}>>);

async function runOptionalMemoryUtility<T>(
  deadline: MemoryAdmissionDeadline,
  role: OptionalMemoryUtilityRole,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (!deadline.canStartOptional()) {
    throw new Error("memory_optional_soft_deadline_exceeded");
  }
  const budget = optionalUtilityBudget[role];
  const availableMs = deadline.remainingMs() - budget.reserveMs;
  if (availableMs < 1) {
    throw new Error("memory_optional_hard_deadline_reserved");
  }
  const timeoutMs = Math.max(1, Math.min(
    budget.maximumMs,
    Math.floor(availableMs)
  ));
  const controller = new AbortController();
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(deadline.signal.reason);
  };
  if (deadline.signal.aborted) forwardAbort();
  else deadline.signal.addEventListener("abort", forwardAbort, { once: true });
  const timeout = !controller.signal.aborted
    ? setTimeout(() => controller.abort({ code: `memory_${role.toLocaleLowerCase("und")}_timeout` }),
        timeoutMs)
    : null;
  try {
    // Governed utilities own their binding lifecycle and settle it before
    // returning an unavailable result. Await that settlement after
    // cancellation instead of racing ahead with a pending binding.
    return await operation(controller.signal);
  } finally {
    if (timeout) clearTimeout(timeout);
    deadline.signal.removeEventListener("abort", forwardAbort);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("memory_admission_aborted");
}

async function abortableRead<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function runBoundedMemoryRead<T>(
  deadline: MemoryAdmissionDeadline,
  maximumMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  cancellationSignal?: AbortSignal
): Promise<T> {
  const timeoutMs = Math.min(maximumMs, deadline.remainingMs());
  if (timeoutMs < 1 || deadline.signal.aborted) throw abortReason(deadline.signal);
  const controller = new AbortController();
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(deadline.signal.reason);
  };
  const forwardCancellation = () => {
    if (!controller.signal.aborted) controller.abort(cancellationSignal?.reason);
  };
  if (deadline.signal.aborted) forwardAbort();
  else deadline.signal.addEventListener("abort", forwardAbort, { once: true });
  if (cancellationSignal?.aborted) forwardCancellation();
  else cancellationSignal?.addEventListener("abort", forwardCancellation, { once: true });
  const timeout = !controller.signal.aborted
    ? setTimeout(() => controller.abort({ code: "memory_local_read_timeout" }), timeoutMs)
    : null;
  try {
    return await operation(controller.signal);
  } finally {
    if (timeout) clearTimeout(timeout);
    deadline.signal.removeEventListener("abort", forwardAbort);
    cancellationSignal?.removeEventListener("abort", forwardCancellation);
  }
}

function sameRetrievalSnapshot(
  actual: MemoryLocalRetrievalSnapshot,
  expected: MemoryRunRetrievalExpectedSnapshot
): boolean {
  return actual.activeGenerationId === expected.activeIndexGenerationId &&
    actual.chatMemoryMode === expected.chatMemoryMode &&
    actual.decayEnabled === expected.settings.decayEnabled &&
    actual.decayPolicyVersion === expected.settings.decayPolicyVersion &&
    actual.folderId === expected.folderId &&
    actual.memoryGeneration === expected.memoryGeneration &&
    actual.memoryRevision === expected.memoryRevision &&
    actual.referenceChatHistory === expected.settings.referenceChatHistory &&
    actual.useMemoryFacts === expected.settings.useMemoryFacts;
}

function assertStableSnapshot(
  actual: MemoryLocalRetrievalSnapshot,
  expected: MemoryRunRetrievalExpectedSnapshot,
  cache: MemoryRunControlCache,
  attemptId: string,
  failedSafeBudget: Readonly<Record<string, unknown>>
): void {
  if (!sameRetrievalSnapshot(actual, expected)) {
    cache.settingsDriftFailedSafeAttemptId = attemptId;
    cache.settingsDriftFailedSafeBudget = failedSafeBudget;
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
  dynamic: readonly MemoryRankedCandidate[],
  plan: MemoryRetrievalPlan
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
        aggregationRequested: plan.aggregationRequested,
        derived: packed.derived,
        documentTime: packed.documentTime,
        eventTimeEnd: packed.eventTimeEnd,
        eventTimeStart: packed.eventTimeStart,
        evidenceHandle: packed.evidenceHandle,
        evidenceType: packed.evidenceType,
        contextualRetrievalHintHash: packed.retrievalHint
          ? memorySha256(packed.retrievalHint)
          : null,
        contextualSupportingEvidenceHashes: (packed.supportingEvidence ?? []).map((support) =>
          memorySha256(support.rawSafeText)),
        contextualSupportingRoundIds: (packed.supportingEvidence ?? []).map((support) =>
          support.itemId),
        finalScore: candidate.finalScore,
        lastConfirmedAt: packed.lastConfirmedAt,
        observedAt: packed.observedAt,
        patternSupportingEvidence: (packed.patternSupportingEvidence ?? []).map((support) => ({
          factVersionId: support.itemId,
          observedAt: support.documentTime,
          sourceAuthority: support.sourceAuthority,
          sourceRootHash: support.sourceRootHash,
          textHash: memorySha256(support.rawSafeText)
        })),
        projectionKind: packed.projectionKind,
        retrievalReason: packed.retrievalReason,
        rrfScore: candidate.rrfScore,
        sourceAuthority: packed.sourceAuthority,
        sourceSessionHandle: packed.sourceSessionHandle,
        speakerScope: packed.speakerScope,
        status: packed.recordStatus,
        supportingItemId: packed.supportingItemId,
        temporalReason: packed.temporalReason,
        historical: candidate.metadata.historical,
        ...(candidate.historyEvidenceView
          ? { historyEvidenceView: candidate.historyEvidenceView }
          : {}),
        includePatterns: plan.includePatterns,
        lifecycleState: candidate.metadata.lifecycleState,
        matchedSegmentId: candidate.matchedSegmentId ?? null,
        matchedSegmentPosition: candidate.matchedSegmentPosition ?? null,
        retrievalMode: plan.mode,
        temporalIntent: plan.temporalIntent,
        tier: packed.tier,
        validFrom: packed.validFrom,
        validTo: packed.validTo
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
    if (packed.itemType === "TOOL_EVENT") {
      return { ...base, itemType: "TOOL_EVENT", toolEventId: packed.itemId };
    }
    return packed.itemType === "RECALL_CHUNK"
      ? { ...base, itemType: "RECALL_CHUNK", recallChunkId: packed.itemId }
      : {
          ...base,
          itemType: "RECALL_ROUND",
          recallRoundId: packed.itemId,
          recallRoundSegmentId: candidate.matchedSegmentId ?? null
        };
  });
}

function planEvidence(plan: MemoryRetrievalPlan): Readonly<Record<string, unknown>> {
  return {
    aggregationRequested: plan.aggregationRequested,
    answerFocusHash: plan.answerFocus === null ? null : memorySha256(plan.answerFocus),
    answerFocusPresent: plan.answerFocus !== null,
    applyResponsePreferences: plan.applyResponsePreferences,
    entityMentionCount: plan.entityMentions.length,
    filterAsOf: plan.filters.asOf?.toISOString() ?? null,
    filterFrom: plan.filters.from?.toISOString() ?? null,
    filterScopeTargetId: plan.filters.scopeTargetId,
    filterScopeType: plan.filters.scopeType,
    filterSourceKinds: plan.filters.sourceKinds,
    filterTo: plan.filters.to?.toISOString() ?? null,
    includePatterns: plan.includePatterns,
    lexicalAvailable: plan.lexicalQuery !== null,
    mode: plan.mode,
    originalQueryHash: memorySha256(plan.originalSanitizedQuery),
    plannerVersion: plan.plannerVersion,
    profileRequested: plan.profileRequested,
    queryPresent: plan.queryPresent,
    recencyRequested: plan.recencyRequested,
    resolvedEntityMentionCount: plan.entityMentions.filter(({ resolvedRef }) =>
      resolvedRef !== null).length,
    semanticQueryVariants: plan.semanticQueryVariants.map(({ kind, text }) => ({
      hash: memorySha256(text),
      kind
    })),
    temporalIntent: plan.temporalIntent,
    temporalQuery: {
      confidence: plan.temporalQuery.confidence,
      expressionCount: plan.temporalQuery.matchedExpressionCount,
      parserVersion: plan.temporalQuery.parserVersion,
      state: plan.temporalQuery.state,
      type: plan.temporalQuery.expressionType
    },
    temporalQueryVariants: plan.temporalQueryVariants.map(({ kind, text }) => ({
      hash: memorySha256(text),
      kind
    }))
  };
}

function utilityEvidence(
  role: UtilityEvidence["role"],
  result: MemoryControlResult | MemoryRunQueryEmbeddingResult |
    MemoryQueryResolverResult | MemoryRunRerankResult | null
): UtilityEvidence {
  if (!result) return {
    externalCall: false,
    externalCallCount: 0,
    reason: null,
    role,
    state: "SKIPPED"
  };
  const externalCallCount = "externalCallCount" in result &&
    typeof result.externalCallCount === "number"
    ? result.externalCallCount
    : utilityUsedExternal(result) ? 1 : 0;
  const providerRequestRoutes = "providerRequestRoutes" in result &&
    Array.isArray(result.providerRequestRoutes)
    ? result.providerRequestRoutes as readonly (string | null)[]
    : null;
  return result.status === "READY"
    ? {
        externalCall: externalCallCount > 0,
        externalCallCount,
        ...(providerRequestRoutes !== null ? { providerRequestRoutes } : {}),
        reason: null,
        role,
        state: "READY"
      }
    : {
        externalCall: externalCallCount > 0,
        externalCallCount,
        ...(providerRequestRoutes !== null ? { providerRequestRoutes } : {}),
        reason: result.reason,
        role,
        state: "UNAVAILABLE"
      };
}

function utilityExecutionMetricEvidence(
  executions: readonly unknown[]
): Readonly<{
  utilityCallCounts: Readonly<Record<string, number>>;
  utilityFailureReasonCounts: Readonly<Record<string, number>>;
}> {
  const utilityCallCounts: Record<string, number> = {};
  const utilityFailureReasonCounts: Record<string, number> = {};
  for (const execution of executions) {
    if (typeof execution !== "object" || execution === null ||
      Array.isArray(execution)) continue;
    const record = execution as Readonly<Record<string, unknown>>;
    if (typeof record.role !== "string" ||
      !Number.isSafeInteger(record.externalCallCount) ||
      Number(record.externalCallCount) < 0) continue;
    incrementCountBy(utilityCallCounts, record.role, Number(record.externalCallCount));
    if (record.state === "UNAVAILABLE" && typeof record.reason === "string") {
      incrementCount(utilityFailureReasonCounts, record.reason);
    }
  }
  return Object.freeze({
    utilityCallCounts: Object.freeze(utilityCallCounts),
    utilityFailureReasonCounts: Object.freeze(utilityFailureReasonCounts)
  });
}

function incrementCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function incrementCountBy(
  target: Record<string, number>,
  key: string,
  count: number
): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("memory_utility_call_count_invalid");
  }
  if (count > 0) target[key] = (target[key] ?? 0) + count;
}

function queryVariantCounts(plan: MemoryRetrievalPlan): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const variant of plan.semanticQueryVariants) incrementCount(counts, variant.kind);
  for (const variant of plan.temporalQueryVariants) {
    incrementCount(counts, `TEMPORAL_${variant.kind}`);
  }
  return Object.freeze(counts);
}

function memoryRetrievalComponentEvidence(input: Readonly<{
  broadLexicalFallbackUsed: boolean;
  control: MemoryControlResult;
  digestEvidence: NonNullable<MemoryLocalRetrievalResult["digestEvidence"]>;
  dynamicFused: readonly MemoryRankedCandidate[];
  enabledSourceKinds: readonly ("EVENT" | "FACT" | "HISTORY")[];
  laneResults: MemoryLocalRetrievalResult["laneResults"];
  navigationExpanded: readonly MemoryExpandedCandidate[];
  pack: MemoryContextPack;
  plan: MemoryRetrievalPlan;
  plannerFallbackReason: string | null;
  sessionCompletionCandidateCount: number;
  sessionCompletionExpandedSourceChatCount: number;
  sessionCompletionSelectedSourceChatCount: number;
  sessionCompletionState: "READY" | "SKIPPED" | "UNAVAILABLE";
  speculativeBaselineUsed: boolean;
  speculativeHybridUsed: boolean;
  preparedTokens: number;
  querySafety: MemorySanitizedUtilityText;
  queryEmbedding: MemoryRunQueryEmbeddingResult | null;
  relevance: MemoryRunRerankResult | null;
  relevanceInput: readonly MemoryRelevanceCandidate[];
  relevant: readonly MemoryRankedCandidate[];
  rawExpanded: readonly MemoryExpandedCandidate[];
  rejoinedRelevant: readonly MemoryRankedCandidate[];
  selectedCore: readonly MemoryCoreCandidate[];
  selectedDynamic: readonly MemoryRankedCandidate[];
  sourceFamilyEvidence: NonNullable<MemoryLocalRetrievalResult["sourceFamilyEvidence"]>;
  sourceFamilyHardExclusionReasons: readonly MemorySourceFamilyHardExclusionReason[];
  utilityExecutions: readonly UtilityEvidence[];
}>): Readonly<Record<string, unknown>> {
  const candidateCountsByLane: Record<string, number> = {};
  const beforeFusionRoots = new Set<string>();
  const segmentIdsByEvidenceRoot = new Map<string, Set<string>>();
  for (const result of input.laneResults) {
    candidateCountsByLane[result.lane] = result.candidates.length;
    for (const candidate of result.candidates) {
      const evidenceRoot = memoryRetrievalEvidenceRootKey(candidate);
      beforeFusionRoots.add(evidenceRoot);
      if (candidate.matchedSegmentId) {
        const segmentIds = segmentIdsByEvidenceRoot.get(evidenceRoot) ?? new Set<string>();
        segmentIds.add(candidate.matchedSegmentId);
        segmentIdsByEvidenceRoot.set(evidenceRoot, segmentIds);
      }
    }
  }
  const packedKeys = new Set(input.pack.items.map((item) =>
    `${item.itemType}:${item.itemId}`));
  const selectedSourceChats = new Set(
    [...input.selectedCore.map(({ candidate }) => candidate), ...input.selectedDynamic]
      .filter((candidate) => packedKeys.has(`${candidate.itemType}:${candidate.itemId}`))
      .flatMap((candidate) => candidate.metadata.sourceChatId
        ? [candidate.metadata.sourceChatId]
        : [])
  );
  const { utilityCallCounts, utilityFailureReasonCounts } =
    utilityExecutionMetricEvidence(input.utilityExecutions);
  const digestHits = input.digestEvidence.navigationCandidateCount +
    input.navigationExpanded.filter((candidate) =>
      candidate.projectionKind === "CHAT_DIGEST_SAFE_TEXT").length;
  const rawChunkExpansions = input.rawExpanded.filter((candidate) =>
    candidate.itemType === "RECALL_CHUNK" &&
    candidate.projectionKind === "RECALL_CHUNK_SAFE_PROJECTED_TEXT").length;
  const rerankerDecisionHandles = new Set(input.relevance?.status === "READY"
    ? input.relevance.decisions.map(({ handle }) => handle)
    : []);
  const temporalFilteredCandidateCount = Object.entries(candidateCountsByLane)
    .filter(([lane]) => lane.endsWith("_TEMPORAL_FILTERED"))
    .reduce((count, [, laneCount]) => count + laneCount, 0);
  const temporalUnrestrictedCandidateCount = Object.entries(candidateCountsByLane)
    .filter(([lane]) => lane.endsWith("_TEMPORAL_UNRESTRICTED"))
    .reduce((count, [, laneCount]) => count + laneCount, 0);
  const sourceCandidateCounts = { EVENT: 0, FACT: 0, HISTORY: 0 };
  for (const candidate of input.dynamicFused) {
    const sourceKind = candidate.itemType === "TOOL_EVENT"
      ? "HISTORY"
      : candidate.itemType === "FACT_VERSION"
      ? candidate.metadata.modality === "EVENT" ? "EVENT" : "FACT"
      : "HISTORY";
    sourceCandidateCounts[sourceKind] += 1;
  }
  const plannerPreferredSourceKinds = [...input.plan.filters.sourceKinds];
  const plannerExcludedSourceKinds = input.enabledSourceKinds.filter((kind) =>
    !plannerPreferredSourceKinds.includes(kind));
  const relevanceKeys = new Set(input.relevanceInput.map(({ candidate }) =>
    `${candidate.itemType}:${candidate.itemId}`));
  const expandableKeys = new Set(input.rawExpanded.map((candidate) =>
    `${candidate.itemType}:${candidate.itemId}`));
  const expandedSegmentCandidates = input.rejoinedRelevant.filter((candidate) =>
    candidate.matchedSegmentId &&
    expandableKeys.has(`${candidate.itemType}:${candidate.itemId}`));
  const matchedSegmentHits = (position: "MIDDLE" | "PREFIX" | "SUFFIX"): number =>
    expandedSegmentCandidates.filter((candidate) =>
      candidate.matchedSegmentPosition === position).length;
  const patternItems = input.pack.items.filter((item) => item.evidenceType === "pattern");
  const patternDirectSupportCount = patternItems.reduce((count, item) =>
    count + (item.patternSupportingEvidence?.length ?? 0), 0);
  const baselineOnlySelectedCount = input.selectedDynamic.filter((candidate) =>
    candidate.laneRanks.FACT_BASELINE_ORIGINAL !== undefined ||
    candidate.laneRanks.HISTORY_BASELINE_ORIGINAL !== undefined).length;
  const sessionCompletionPackedCount = input.selectedDynamic.filter((candidate) =>
    candidate.selectionReason.includes("session_completion") &&
    packedKeys.has(`${candidate.itemType}:${candidate.itemId}`)).length;
  const rerankDiagnostics = input.relevance?.diagnostics;
  return Object.freeze({
    baselineFactCandidateCount: input.sourceFamilyEvidence.baselineFactCandidateCount,
    baselineHistoryCandidateCount: input.sourceFamilyEvidence.baselineHistoryCandidateCount,
    baselineOnlyCandidateCount: input.sourceFamilyEvidence.baselineOnlyCandidateCount,
    baselineOnlySelectedCount,
    baselineSourceKinds: [...input.enabledSourceKinds],
    broadLexicalFallbackUsed: input.broadLexicalFallbackUsed,
    candidateCountsByLane,
    candidateCountsBySourceKind: sourceCandidateCounts,
    candidatesRetainedAfterReranker: input.relevant.length,
    candidatesRetainedAfterRejoin: input.rejoinedRelevant.length,
    candidatesSentToReranker: input.relevanceInput.length,
    digestHits,
    digestChatHitWithoutRawAnchorCount: input.digestEvidence.digestOnlyChatCount,
    digestNavigationCandidateCount: input.digestEvidence.navigationCandidateCount,
    digestNavigationOnlyContextCount: input.pack.items.filter((item) =>
      item.evidenceType === "derived_session_synopsis").length,
    digestSelectedChatCount: input.digestEvidence.selectedChatCount,
    embeddingBatchSizeDistribution: utilityCallCounts.MEMORY_QUERY_EMBED
      ? { "1": utilityCallCounts.MEMORY_QUERY_EMBED }
      : {},
    intraChatRawAnchorCount: input.digestEvidence.rawAnchorCount,
    intraChatRawCandidateCount: input.digestEvidence.rawCandidateCount,
    intraChatSecondStageQueryCount: input.digestEvidence.secondStageQueryCount,
    matchedSegmentMiddleHits: matchedSegmentHits("MIDDLE"),
    matchedSegmentPrefixHits: matchedSegmentHits("PREFIX"),
    matchedSegmentSuffixHits: matchedSegmentHits("SUFFIX"),
    packedEvidenceItems: input.pack.items.length,
    packedEvidenceTokens: input.preparedTokens,
    patternContextCount: patternItems.length,
    patternDirectSupportCount,
    patternMissingSupportContextCount: patternItems.filter((item) =>
      (item.patternSupportingEvidence?.length ?? 0) <
        MEMORY_CONTEXT_PATTERN_MIN_SUPPORTS).length,
    patternOnlyContextCount: patternItems.length > 0 &&
      input.pack.items.every((item) => item.evidenceType === "pattern") &&
      patternDirectSupportCount === 0
      ? patternItems.length
      : 0,
    plannerExcludedSourceKinds,
    plannerExcludedFamilyRecoveredCount:
      input.sourceFamilyEvidence.plannerExcludedFamilyRecoveredCount,
    plannerFallbackUsed: input.plannerFallbackReason !== null,
    speculativeBaselineUsed: input.speculativeBaselineUsed,
    speculativeHybridUsed: input.speculativeHybridUsed,
    plannerOnlyCandidateCount: input.sourceFamilyEvidence.plannerOnlyCandidateCount,
    plannerPreferredSourceKinds,
    queryVariantCounts: queryVariantCounts(input.plan),
    rawChunkExpansions,
    rawRoundExpansions: input.rawExpanded.filter((candidate) =>
      candidate.itemType === "RECALL_ROUND" &&
      candidate.projectionKind === "RECALL_ROUND_RAW_SAFE_TEXT").length,
    rawRoundSegmentExpansions: input.rawExpanded.filter((candidate) =>
      candidate.itemType === "RECALL_ROUND" &&
      candidate.projectionKind === "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT").length,
    readerPackSegmentCount: input.pack.items.filter((item) =>
      item.projectionKind === "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT").length,
    rerankBatchCount: rerankDiagnostics?.batchCount ??
      (input.relevanceInput.length > 0 ? 1 : 0),
    rerankCandidateCount: rerankDiagnostics?.candidateCount ?? input.relevanceInput.length,
    rerankCoverageRatio: rerankDiagnostics?.coverageRatio ??
      (input.relevanceInput.length === 0
        ? 0
        : rerankerDecisionHandles.size / input.relevanceInput.length),
    rerankDecisionCount: rerankDiagnostics?.decisionCount ?? rerankerDecisionHandles.size,
    rerankDuplicateDecisionCount: rerankDiagnostics?.duplicateDecisionCount ?? 0,
    rerankFailedBatchCount: rerankDiagnostics?.failedBatchCount ??
      (input.relevanceInput.length > 0 && input.relevance?.status !== "READY" ? 1 : 0),
    rerankerFallbackUsed: input.relevanceInput.length > 0 &&
      (input.relevance?.status === "READY"
        ? input.relevanceInput.some(({ handle }) => !rerankerDecisionHandles.has(handle))
        : true),
    rerankFullFallbackUsed: input.relevanceInput.length > 0 &&
      (rerankDiagnostics?.fullFallbackUsed ?? input.relevance?.status !== "READY"),
    rerankInvalidResponseCount: rerankDiagnostics?.invalidResponseCount ?? 0,
    rerankMissingDecisionCount: rerankDiagnostics?.missingDecisionCount ?? Math.max(
      0,
      input.relevanceInput.length - rerankerDecisionHandles.size
    ),
    rerankModelAttemptCount: rerankDiagnostics?.modelAttemptCount ??
      (input.relevanceInput.length > 0 ? 1 : 0),
    rerankModelFallbackDepth: rerankDiagnostics?.fallbackDepth ?? 0,
    rerankProviderModelMismatchCount:
      rerankDiagnostics?.providerModelMismatchCount ?? 0,
    rerankReadyBatchCount: rerankDiagnostics?.readyBatchCount ??
      (input.relevance?.status === "READY" ? 1 : 0),
    rerankRetryCount: rerankDiagnostics?.retryCount ?? Math.max(
      0,
      (input.relevance?.externalCallCount ?? 0) - 1
    ),
    rerankRoutePolicyVersion: rerankDiagnostics?.routePolicyVersion ?? null,
    rerankScoreFloor: input.relevance?.status === "READY"
      ? input.relevance.relevanceScoreFloor ?? null
      : null,
    rerankUsedProviderModelId: input.relevance?.status === "READY"
      ? input.relevance.rerankerRoute?.providerModelId ?? null
      : null,
    sessionCompletionCandidateCount: input.sessionCompletionCandidateCount,
    sessionCompletionExpandedSourceChatCount:
      input.sessionCompletionExpandedSourceChatCount,
    sessionCompletionPackedCount,
    sessionCompletionSelectedSourceChatCount:
      input.sessionCompletionSelectedSourceChatCount,
    sessionCompletionState: input.sessionCompletionState,
    safetyFindingCounts: input.querySafety.findingCounts,
    safetyMetricsState: "QUERY_REDACTION_ACTIVE",
    selectedSourceChats: selectedSourceChats.size,
    searchHitCount: relevanceKeys.size,
    searchHitExpandableCount: [...relevanceKeys].filter((key) =>
      expandableKeys.has(key)).length,
    searchHitWithoutExpandableEvidence: [...relevanceKeys].filter((key) =>
      !expandableKeys.has(key)).length,
    segmentsCollapsedByEvidenceRoot: [...segmentIdsByEvidenceRoot.values()]
      .reduce((count, segmentIds) => count + Math.max(0, segmentIds.size - 1), 0),
    sourceFamilyHardExclusionReasons: [...input.sourceFamilyHardExclusionReasons],
    temporalFilteredCandidateCount,
    temporalParserConfidence: input.plan.temporalQuery.confidence,
    temporalParserState: input.plan.temporalQuery.state,
    temporalParserType: input.plan.temporalQuery.expressionType,
    temporalUnrestrictedCandidateCount,
    uniqueEvidenceRootsAfterFusion: new Set(input.dynamicFused.map((candidate) =>
      memoryRetrievalEvidenceRootKey(candidate))).size,
    uniqueEvidenceRootsBeforeFusion: beforeFusionRoots.size,
    utilityCallCounts,
    utilityFailureReasonCounts,
    version: MEMORY_RETRIEVAL_COMPONENT_METRICS_VERSION
  });
}

function relevanceEvidence(
  candidates: readonly MemoryRelevanceCandidate[],
  result: MemoryRunRerankResult | null,
  acceptedCount: number,
  rejoinedCount: number
): Readonly<Record<string, unknown>> {
  const decisionCounts: Record<string, number> = {};
  const byHandle = new Map(candidates.map((candidate) => [candidate.handle, candidate]));
  const decisions = result?.status === "READY"
    ? result.decisions.flatMap((decision) => {
        const candidate = byHandle.get(decision.handle);
        if (!candidate) return [];
        return [{
          applicable: decision.applicable,
          authorityLevel: candidate.authorityLevel,
          category: candidate.candidate.metadata.category === null
            ? null
            : redactMemorySecrets(candidate.candidate.metadata.category).redactedText,
          current: decision.current,
          deterministicMatches:
            candidate.candidate.featureSnapshot.deterministicMatches ?? [],
          directness: candidate.directness,
          itemType: candidate.candidate.itemType,
          laneRankKeys: Object.keys(candidate.candidate.laneRanks).sort(),
          modality: candidate.candidate.metadata.modality,
          reasonCode: decision.reasonCode,
          relevanceScore: decision.relevanceScore,
          sourceKind: candidate.sourceKind,
          sourceMode: candidate.candidate.metadata.sourceMode
        }];
      })
    : [];
  if (result?.status === "READY") {
    for (const decision of result.decisions) {
      decisionCounts[decision.reasonCode] = (decisionCounts[decision.reasonCode] ?? 0) + 1;
    }
  }
  return {
    relevanceAcceptedCount: acceptedCount,
    relevanceCandidateCount: candidates.length,
    relevanceDecisionCounts: decisionCounts,
    relevanceDecisions: decisions,
    relevanceRejoinedCount: rejoinedCount
  };
}

function aggregationPlanEvidence(
  requested: boolean,
  pack: MemoryContextPack
): Readonly<Record<string, unknown>> {
  const aggregationState: MemoryAggregationState = !requested
    ? "NOT_REQUESTED"
    : pack.text && pack.items.length > 0
      ? "READER_REQUIRED"
      : "UNAVAILABLE_MANDATORY_EVIDENCE";
  return {
    aggregationPolicyVersion: MEMORY_AGGREGATION_POLICY_VERSION,
    aggregationReaderFallbackUsed: aggregationState.startsWith("READER_REQUIRED"),
    aggregationState,
    cardinalityParserAcceptedCount: 0,
    cardinalityParserReasonCounts: {},
    cardinalityParserRejectedCount: 0,
    cardinalityParserVersion: MEMORY_CARDINALITY_PARSER_VERSION
  };
}

function utilityUsedExternal(
  result: MemoryControlResult | MemoryRunQueryEmbeddingResult |
    MemoryQueryResolverResult | MemoryRunRerankResult | null
): boolean {
  if (!result) return false;
  if ("externalCallCount" in result &&
    typeof result.externalCallCount === "number") {
    return result.externalCallCount > 0;
  }
  return Boolean("bindingId" in result && result.bindingId);
}

function controlForAttemptEvidence(
  control: MemoryControlResult | null,
  fallbackReuse: MemoryFallbackControlReuseProof | null
): MemoryControlResult | null {
  if (!fallbackReuse || control?.status !== "UNAVAILABLE") return control;
  // An unavailable control has no provider-authored plan or mutation
  // authority. Its source attempt already owns any failed binding; the retry
  // records the fallback proof without claiming a second external execution.
  return { reason: control.reason, status: "UNAVAILABLE" };
}

function memoryActionAnswerResult(
  control: MemoryControlResult,
  actionResult: MemoryActionFeedback | null
): MemoryActionAnswerResult {
  if (control.status !== "READY") {
    return MEMORY_ACTION_NO_COMMIT_RESULT;
  }
  if (control.intent.action === "NONE") return MEMORY_ACTION_NO_COMMIT_RESULT;
  if (!actionResult || actionResult.operation !== control.intent.action) {
    return { operation: control.intent.action, status: "UNAVAILABLE", version: 1 };
  }
  return {
    operation: actionResult.operation,
    status: actionResult.status,
    version: 1
  };
}

function admissionDeadlineAttempt(
  expected: MemoryRunRetrievalExpectedSnapshot,
  cache: MemoryRunControlCache,
  attemptId: string,
  utilities: readonly Readonly<{
    result: MemoryQueryResolverResult | MemoryRunQueryEmbeddingResult |
      MemoryRunRerankResult | null;
    role: "MEMORY_QUERY_EMBED" | "MEMORY_QUERY_RESOLVE" | "MEMORY_RERANK";
  }>[] = []
): MemoryPreparingAttemptResult {
  const readOnlyControlReuse = cache.readOnlyControlReuseAttemptId === attemptId
    ? cache.readOnlyControlReuseProof ?? null
    : null;
  const fallbackControlReuse = cache.fallbackControlReuseAttemptId === attemptId
    ? cache.fallbackControlReuseProof ?? null
    : null;
  const cachedControl = cache.controlAttemptId === attemptId || readOnlyControlReuse ||
    fallbackControlReuse
    ? cache.control ?? null
    : null;
  const control = controlForAttemptEvidence(cachedControl, fallbackControlReuse);
  const actionResult = cache.actionResolved && cache.actionAttemptId === attemptId
    ? cache.actionResult ?? null
    : null;
  const results = [
    ...(control ? [{ result: control, role: "MEMORY_CONTROL" as const }] : []),
    ...utilities
  ];
  const externalUsed = results.some(({ result }) => utilityUsedExternal(result));
  return emptyAttempt(expected, "FAILED_SAFE", "memory_admission_deadline_exceeded", null, {
    ...(control ? {
      memoryActionAnswerResult: memoryActionAnswerResult(control, actionResult)
    } : {}),
    ...(actionResult ? { memoryActionResult: actionResult } : {}),
    ...(readOnlyControlReuse
      ? { readOnlyControlReuse }
      : {}),
    ...(fallbackControlReuse
      ? { fallbackControlReuse }
      : {}),
    utilityEgressMode: externalUsed ? "CONSENTED_EXTERNAL" : "LOCAL_ONLY",
    utilityExecutions: results.map(({ result, role }) =>
      utilityEvidence(role, result))
  });
}

function settingsDriftFailedSafeBudget(
  expected: MemoryRunRetrievalExpectedSnapshot,
  cache: MemoryRunControlCache,
  attemptId: string,
  utilities: readonly Readonly<{
    result: MemoryQueryResolverResult | MemoryRunQueryEmbeddingResult |
      MemoryRunRerankResult | null;
    role: "MEMORY_QUERY_EMBED" | "MEMORY_QUERY_RESOLVE" | "MEMORY_RERANK";
  }>[] = []
): Readonly<Record<string, unknown>> {
  const deadlineBudget = admissionDeadlineAttempt(
    expected,
    cache,
    attemptId,
    utilities
  ).budgetSnapshot;
  const { memoryActionResult: _memoryActionResult, ...safeBudget } = deadlineBudget;
  return {
    ...safeBudget,
    memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
    reason: "memory_admission_settings_changed"
  };
}

export type MemoryRelevanceCandidate = Readonly<{
  authorityLevel: "LEARNED" | "PAST_CHAT" | "SAVED" | "SUPPORTING";
  candidate: MemoryRankedCandidate;
  current: boolean;
  /** Server-proven direct-user source fragments; never sent to the reranker. */
  directUserTexts: readonly string[];
  directness: "DIRECT" | "INFERRED" | "PARAPHRASED" | null;
  handle: string;
  historical: boolean;
  lifecycleState: "ACTIVE" | "SUPERSEDED" | null;
  occurredFrom: string | null;
  occurredTo: string | null;
  sensitivityClass: "NORMAL";
  speakerScope: "assistant" | "memory_record" | "mixed_conversation" | "tool" | "user";
  sourceKind: "EVENT" | "FACT" | "HISTORY" | "TOOL_OBSERVATION";
  retrievalHint: string | null;
  supportingEvidence: readonly Readonly<{
    itemId: string;
    occurredFrom: string;
    occurredTo: string;
    sourceChatId: string;
    text: string;
  }>[];
  temporalReason: "any" | "as_of" | "between" | "current" | "historical";
  text: string;
}>;

function relevanceSpeakerScope(
  sourceKind: MemoryRelevanceCandidate["sourceKind"],
  text: string
): MemoryRelevanceCandidate["speakerScope"] {
  if (sourceKind === "TOOL_OBSERVATION") return "tool";
  if (sourceKind !== "HISTORY") return "memory_record";
  const user = /(?:^|\n)User:\s/u.test(text);
  const assistant = /(?:^|\n)Assistant:\s/u.test(text);
  if (user && !assistant) return "user";
  if (assistant && !user) return "assistant";
  return "mixed_conversation";
}

function sourceDiversityOrder(
  candidates: readonly MemoryRelevanceCandidate[],
  strictCoverage: boolean
): readonly MemoryRelevanceCandidate[] {
  const order = strictCoverage
    ? orderMemoryCandidatesByDistinctSourceFirst
    : orderMemoryCandidatesWithSoftSourceDiversity;
  return order(
    candidates,
    (candidate) => candidate.sourceKind === "HISTORY" ||
      candidate.sourceKind === "TOOL_OBSERVATION"
      ? candidate.candidate.metadata.sourceChatId ??
        `missing-source:${candidate.candidate.itemId}`
      : null
  );
}

function aggregationSelectedRawCandidate(
  candidate: MemoryRankedCandidate,
  source: MemoryRankedCandidate
): MemoryRankedCandidate {
  const reason = `${candidate.selectionReason}+aggregation_source_selected`;
  return {
    ...candidate,
    finalScore: source.finalScore,
    selectionReason: reason.length <= 128 ? reason : "aggregation_source_selected"
  };
}

/** Converts reranked session-navigation candidates back to authoritative raw
 * search hits. A digest navigation candidate keeps its exact raw anchor when
 * that anchor was retrieved; otherwise the source falls back to its strongest
 * fused hit. The parent-session rank and child-hit rank form a deterministic
 * best-first traversal: strong sessions may contribute deeper evidence before
 * the entire weak-session tail, while every child remains reachable and later
 * packing still applies soft source diversity. */
export function selectMemoryAggregationRawCandidates(
  fused: readonly MemoryRankedCandidate[],
  selectedSources: readonly MemoryRankedCandidate[]
): readonly MemoryRankedCandidate[] {
  const fusedHistoryBySource = new Map<string, MemoryRankedCandidate[]>();
  for (const candidate of fused) {
    if (candidate.itemType === "FACT_VERSION" || !candidate.metadata.sourceChatId) continue;
    const source = fusedHistoryBySource.get(candidate.metadata.sourceChatId);
    if (source) source.push(candidate);
    else fusedHistoryBySource.set(candidate.metadata.sourceChatId, [candidate]);
  }
  const selectedSourceIds = new Set<string>();
  const sourceGroups: MemoryRankedCandidate[][] = [];
  for (const selected of selectedSources) {
    if (selected.itemType === "FACT_VERSION") {
      sourceGroups.push([selected]);
      continue;
    }
    const sourceChatId = selected.metadata.sourceChatId;
    if (!sourceChatId || selectedSourceIds.has(sourceChatId) ||
      selectedSourceIds.size >= MEMORY_CONTEXT_AGGREGATION_MAX_SOURCE_CHATS) continue;
    const raw = fusedHistoryBySource.get(sourceChatId);
    if (!raw || raw.length === 0) continue;
    selectedSourceIds.add(sourceChatId);
    const exactRawIndex = raw.findIndex((candidate) =>
      candidate.itemType === selected.itemType && candidate.itemId === selected.itemId);
    const firstRawIndex = exactRawIndex >= 0 ? exactRawIndex : 0;
    sourceGroups.push([
      raw[firstRawIndex]!,
      ...raw.filter((_candidate, index) => index !== firstRawIndex)
    ].map((candidate) => aggregationSelectedRawCandidate(candidate, selected)));
  }
  return sourceGroups.flatMap((candidates, sourceRank) =>
    candidates.map((candidate, childRank) => ({
      candidate,
      childRank,
      routeRank: (sourceRank + 1) * (childRank + 1),
      sourceRank
    })))
    .sort((left, right) =>
      left.routeRank - right.routeRank ||
      left.childRank - right.childRank ||
      left.sourceRank - right.sourceRank)
    .map(({ candidate }) => candidate)
    .slice(0, MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES);
}

export type MemorySessionRejoin = Readonly<{
  candidates: readonly MemoryRankedCandidate[];
  completionCandidateCount: number;
  expansions: readonly MemoryExpandedCandidate[];
}>;

/**
 * Adds source-completion rounds behind each source's query-matched raw anchors
 * and traverses the resulting source groups best-first. Exact item and
 * evidence-root identity both deduplicate, so completion can widen a selected
 * session but can never double-count an already retrieved round.
 */
export function mergeMemorySessionEvidenceCompletion(
  candidates: readonly MemoryRankedCandidate[],
  expansions: readonly MemoryExpandedCandidate[],
  completion: MemorySessionEvidenceCompletion,
  completionExpansions: readonly MemoryExpandedCandidate[]
): MemorySessionRejoin {
  const expansionByKey = new Map(expansions.map((expansion) => [
    `${expansion.itemType}:${expansion.itemId}`,
    expansion
  ]));
  const completionCandidateKeys = new Set(completion.candidates.map((candidate) =>
    `${candidate.itemType}:${candidate.itemId}`));
  const completionExpansionByKey = new Map(completionExpansions.map((expansion) => [
    `${expansion.itemType}:${expansion.itemId}`,
    expansion
  ]));
  if (completionExpansionByKey.size !== completionExpansions.length ||
    completionExpansions.some((expansion) =>
      !completionCandidateKeys.has(`${expansion.itemType}:${expansion.itemId}`))) {
    throw new Error("memory_session_completion_invalid");
  }
  type RejoinEntry = {
    candidate: MemoryRankedCandidate;
    completion: boolean;
    expansion: MemoryExpandedCandidate;
    sourceKey: string;
  };
  const sourceGroups = new Map<string, RejoinEntry[]>();
  const entriesByItem = new Map<string, RejoinEntry>();
  const entriesByRoot = new Map<string, RejoinEntry>();
  const primaryQueryEntryBySource = new Map<string, RejoinEntry>();
  const register = (entry: RejoinEntry): void => {
    entriesByItem.set(
      `${entry.candidate.itemType}:${entry.candidate.itemId}`,
      entry
    );
    entriesByRoot.set(memoryRetrievalEvidenceRootKey(entry.candidate), entry);
  };
  const unregister = (entry: RejoinEntry): void => {
    const itemKey = `${entry.candidate.itemType}:${entry.candidate.itemId}`;
    const evidenceRoot = memoryRetrievalEvidenceRootKey(entry.candidate);
    if (entriesByItem.get(itemKey) === entry) entriesByItem.delete(itemKey);
    if (entriesByRoot.get(evidenceRoot) === entry) entriesByRoot.delete(evidenceRoot);
  };
  const append = (
    candidate: MemoryRankedCandidate,
    expansion: MemoryExpandedCandidate | undefined,
    completionCandidate: boolean
  ): boolean => {
    if (!expansion || expansion.sourceChatId !== candidate.metadata.sourceChatId) return false;
    const itemKey = `${candidate.itemType}:${candidate.itemId}`;
    const evidenceRoot = memoryRetrievalEvidenceRootKey(candidate);
    if (entriesByItem.has(itemKey) || entriesByRoot.has(evidenceRoot)) return false;
    const sourceKey = candidate.metadata.sourceChatId ?? itemKey;
    const source = sourceGroups.get(sourceKey);
    const entry = { candidate, completion: completionCandidate, expansion, sourceKey };
    if (source) source.push(entry);
    else sourceGroups.set(sourceKey, [entry]);
    register(entry);
    if (!completionCandidate && !primaryQueryEntryBySource.has(sourceKey)) {
      primaryQueryEntryBySource.set(sourceKey, entry);
    }
    return true;
  };
  for (const candidate of candidates) {
    append(
      candidate,
      expansionByKey.get(`${candidate.itemType}:${candidate.itemId}`),
      false
    );
  }
  for (const candidate of completion.candidates) {
    const itemKey = `${candidate.itemType}:${candidate.itemId}`;
    const expansion = completionExpansionByKey.get(itemKey);
    if (!expansion || expansion.sourceChatId !== candidate.metadata.sourceChatId) continue;
    const evidenceRoot = memoryRetrievalEvidenceRootKey(candidate);
    const itemDuplicate = entriesByItem.get(itemKey);
    const rootDuplicate = entriesByRoot.get(evidenceRoot);
    const duplicate = itemDuplicate ?? rootDuplicate;
    const sourceKey = candidate.metadata.sourceChatId ?? itemKey;
    if (
      duplicate && (!itemDuplicate || !rootDuplicate || itemDuplicate === rootDuplicate) &&
      duplicate.sourceKey === sourceKey && !duplicate.completion &&
      primaryQueryEntryBySource.get(sourceKey) !== duplicate &&
      candidate.historyEvidenceView === "USER_TESTIMONY"
    ) {
      // The best query-matched episode remains a complete conversational
      // anchor. For a secondary episode, however, the compact authoritative
      // user span must not be shadowed by a verbose whole-round projection of
      // the same evidence root before the packer can apply its user-evidence
      // coverage floor.
      unregister(duplicate);
      duplicate.candidate = candidate;
      duplicate.completion = true;
      duplicate.expansion = expansion;
      register(duplicate);
      continue;
    }
    append(candidate, expansion, true);
  }
  // Traverse strong source sessions best-first instead of placing every
  // completion round behind the full weak-source tail. Query-matched anchors
  // remain first within each source; bounded completion evidence then becomes
  // reachable before the context budget is exhausted.
  const ordered = [...sourceGroups.values()].flatMap((entries, sourceRank) =>
    entries.map((entry, childRank) => ({
      childRank,
      entry,
      routeRank: (sourceRank + 1) * (childRank + 1),
      sourceRank
    })))
    .sort((left, right) =>
      left.routeRank - right.routeRank ||
      left.childRank - right.childRank ||
      left.sourceRank - right.sourceRank)
    .slice(0, MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES)
    .map(({ entry }) => entry);
  return Object.freeze({
    candidates: Object.freeze(ordered.map(({ candidate }) => candidate)),
    completionCandidateCount: ordered.filter(({ completion }) => completion).length,
    expansions: Object.freeze(ordered.map(({ expansion }) => expansion))
  });
}

export function memoryRelevanceCandidates(
  ranked: readonly MemoryRankedCandidate[],
  expanded: readonly MemoryExpandedCandidate[],
  options: Readonly<{
    aggregationRequested?: boolean;
    recencyRequested?: boolean;
    temporalIntent?: MemoryRetrievalPlan["temporalIntent"];
  }> = {}
): readonly MemoryRelevanceCandidate[] {
  const projections = new Map(expanded.map((candidate) => [
    `${candidate.itemType}:${candidate.itemId}`,
    candidate
  ]));
  const projected = ranked.flatMap((candidate) => {
    const projection = projections.get(`${candidate.itemType}:${candidate.itemId}`);
    if (!projection) return [];
    const sourceKind = candidate.itemType === "TOOL_EVENT"
      ? "TOOL_OBSERVATION" as const
      : candidate.itemType !== "FACT_VERSION"
        ? "HISTORY" as const
      : candidate.metadata.modality === "EVENT" ? "EVENT" as const : "FACT" as const;
    return [{
      authorityLevel: candidate.itemType === "TOOL_EVENT"
        ? "SUPPORTING" as const
        : candidate.itemType !== "FACT_VERSION"
          ? "PAST_CHAT" as const
        : candidate.metadata.sourceMode === "EXPLICIT"
          ? "SAVED" as const
          : memoryCandidateIsSupportingObservation(candidate.metadata)
            ? "SUPPORTING" as const
            : "LEARNED" as const,
      candidate,
      current: candidate.metadata.current,
      directUserTexts: Object.freeze([...(projection.directUserTexts ?? [])]),
      directness: candidate.metadata.directness,
      handle: "",
      historical: candidate.metadata.historical,
      lifecycleState: candidate.metadata.lifecycleState,
      occurredFrom: (projection.occurredFrom ?? candidate.metadata.validFrom ??
        candidate.metadata.systemFrom)?.toISOString() ?? null,
      occurredTo: (projection.occurredTo ?? candidate.metadata.validTo)?.toISOString() ?? null,
      sensitivityClass: "NORMAL" as const,
      speakerScope: relevanceSpeakerScope(sourceKind, projection.safeText),
      sourceKind,
      retrievalHint: projection.retrievalHint ?? null,
      supportingEvidence: Object.freeze((projection.supportingEvidence ?? []).map((support) => ({
        itemId: support.itemId,
        occurredFrom: support.occurredFrom.toISOString(),
        occurredTo: support.occurredTo.toISOString(),
        sourceChatId: support.sourceChatId,
        text: support.safeText
      }))),
      temporalReason: (options.temporalIntent ?? "CURRENT").toLocaleLowerCase("und") as
        MemoryRelevanceCandidate["temporalReason"],
      text: projection.safeText
    }];
  });
  const ordered = sourceDiversityOrder(projected, options.aggregationRequested === true);
  let factCount = 0;
  let historyCount = 0;
  const historyLimit = options.aggregationRequested
    ? MEMORY_RETRIEVAL_MAX_AGGREGATION_HISTORY_CANDIDATES
    : MEMORY_RETRIEVAL_MAX_TARGETED_HISTORY_CANDIDATES;
  const bounded = ordered.filter((entry) => {
    if (entry.candidate.itemType === "FACT_VERSION") {
      factCount += 1;
      return factCount <= 20;
    }
    historyCount += 1;
    return historyCount <= historyLimit;
  }).slice(0, options.aggregationRequested
    ? MEMORY_RETRIEVAL_MAX_AGGREGATION_HISTORY_CANDIDATES
    : MEMORY_RETRIEVAL_MAX_TARGETED_RERANK_CANDIDATES);
  return bounded.map((entry, index) => ({ ...entry, handle: `c${index}` }));
}

/** Builds a bounded resolver frontier from exact current-user text and
 * authoritative direct-user fragments only. Assistant text in a mixed raw
 * round remains available to the reader, but can never become resolver
 * authority. */
export function memoryQueryResolverSources(
  query: string,
  candidates: readonly MemoryRelevanceCandidate[]
): readonly MemoryQueryResolverSource[] {
  if (!query || query.length > 32_000 || query.includes("\u0000")) return Object.freeze([]);
  const sources: MemoryQueryResolverSource[] = [{
    handle: "R1",
    itemKey: null,
    sourceType: "CURRENT_QUERY",
    userTexts: Object.freeze([query])
  }];
  const seenItems = new Set<string>();
  for (const entry of candidates) {
    if (sources.length >= MEMORY_QUERY_RESOLVER_MAX_SOURCES) break;
    const itemKey = `${entry.candidate.itemType}:${entry.candidate.itemId}`;
    if (seenItems.has(itemKey)) continue;
    const userTexts = [...new Set(entry.directUserTexts)].filter((text) =>
      text.length > 0 && text.length <= 4_000 && !text.includes("\u0000"));
    if (userTexts.length === 0) continue;
    seenItems.add(itemKey);
    sources.push(Object.freeze({
      handle: `R${sources.length + 1}`,
      itemKey,
      sourceType: "MEMORY_EVIDENCE",
      userTexts: Object.freeze(userTexts.slice(0, 8))
    }));
  }
  return sources.length > 1 ? Object.freeze(sources) : Object.freeze([]);
}

export function memoryPackedQueryScopeConstraints(input: Readonly<{
  expanded: readonly MemoryExpandedCandidate[];
  pack: MemoryContextPack;
  resolution: Extract<MemoryQueryResolverResult, { status: "READY" }>;
  sources: readonly MemoryQueryResolverSource[];
}>): readonly MemoryPackedQueryScopeConstraint[] | null {
  if (input.resolution.constraints.length === 0) return Object.freeze([]);
  const sourceByKey = new Map(input.sources.flatMap((source) => source.itemKey
    ? [[source.itemKey, source] as const]
    : []));
  const currentSource = input.sources.find(({ sourceType }) =>
    sourceType === "CURRENT_QUERY");
  const expansionByKey = new Map(input.expanded.map((candidate) => [
    `${candidate.itemType}:${candidate.itemId}`,
    candidate
  ]));
  const packedByKey = new Map(input.pack.items.map((item) => [
    `${item.itemType}:${item.itemId}`,
    item
  ]));
  const mapped: MemoryPackedQueryScopeConstraint[] = [];
  for (const constraint of input.resolution.constraints) {
    if (constraint.sourceType === "CURRENT_QUERY") {
      if (constraint.itemKey !== null || !currentSource?.userTexts.some((text) =>
        text.includes(constraint.targetQuote))) return null;
      mapped.push(Object.freeze({
        evidenceHandle: "current_query",
        kind: constraint.kind,
        targetQuote: constraint.targetQuote
      }));
      continue;
    }
    if (!constraint.itemKey) return null;
    const source = sourceByKey.get(constraint.itemKey);
    const expansion = expansionByKey.get(constraint.itemKey);
    const packed = packedByKey.get(constraint.itemKey);
    if (!source || !expansion || !packed ||
      !source.userTexts.some((text) => text.includes(constraint.targetQuote)) ||
      !(expansion.directUserTexts ?? []).some((text) =>
        text.includes(constraint.targetQuote)) ||
      !packed.rawSafeText.includes(constraint.targetQuote)) return null;
    mapped.push(Object.freeze({
      evidenceHandle: packed.evidenceHandle,
      kind: constraint.kind,
      targetQuote: constraint.targetQuote
    }));
  }
  const identities = mapped.map((constraint) => [
    constraint.kind,
    constraint.evidenceHandle,
    constraint.targetQuote
  ].join("\u0000"));
  return new Set(identities).size === identities.length
    ? Object.freeze(mapped)
    : null;
}

type MemoryQueryScopeAttachmentState =
  | "BUDGET_FALLBACK"
  | "NOT_READY_AT_ATTACH"
  | "READY_ATTACHED"
  | "READY_NONE"
  | "REJECTED_FINAL"
  | "SKIPPED"
  | "UNAVAILABLE";

function applyMemoryQueryScopeResolution(input: Readonly<{
  expanded: readonly MemoryExpandedCandidate[];
  pack: MemoryContextPack;
  resolution: MemoryQueryResolverResult | null;
  sources: readonly MemoryQueryResolverSource[];
}>): Readonly<{
  attachedConstraintKindCounts: Readonly<Record<string, number>>;
  pack: MemoryContextPack;
  proposedConstraintCount: number;
  state: MemoryQueryScopeAttachmentState;
}> {
  if (!input.resolution) return {
    attachedConstraintKindCounts: Object.freeze({}),
    pack: input.pack,
    proposedConstraintCount: 0,
    state: "SKIPPED"
  };
  if (input.resolution.status === "UNAVAILABLE") return {
    attachedConstraintKindCounts: Object.freeze({}),
    pack: input.pack,
    proposedConstraintCount: 0,
    state: "UNAVAILABLE"
  };
  if (input.resolution.constraints.length === 0) return {
    attachedConstraintKindCounts: Object.freeze({}),
    pack: input.pack,
    proposedConstraintCount: 0,
    state: "READY_NONE"
  };
  const constraints = memoryPackedQueryScopeConstraints({
    expanded: input.expanded,
    pack: input.pack,
    resolution: input.resolution,
    sources: input.sources
  });
  if (!constraints || constraints.length === 0) return {
    attachedConstraintKindCounts: Object.freeze({}),
    pack: input.pack,
    proposedConstraintCount: input.resolution.constraints.length,
    state: "REJECTED_FINAL"
  };
  const attachment = attachMemoryQueryScopeConstraints(
    input.pack,
    constraints,
    MEMORY_QUERY_SCOPE_CONSTRAINT_MAX_TOKENS
  );
  if (!attachment.attached) return {
    attachedConstraintKindCounts: Object.freeze({}),
    pack: input.pack,
    proposedConstraintCount: input.resolution.constraints.length,
    state: attachment.reason === "BUDGET" ? "BUDGET_FALLBACK" : "REJECTED_FINAL"
  };
  const counts: Record<string, number> = {};
  for (const constraint of constraints) incrementCount(counts, constraint.kind);
  return {
    attachedConstraintKindCounts: Object.freeze(counts),
    pack: attachment.pack,
    proposedConstraintCount: input.resolution.constraints.length,
    state: "READY_ATTACHED"
  };
}

export function applyMemoryRelevance(
  candidates: readonly MemoryRelevanceCandidate[],
  result: MemoryRunRerankResult | null,
  plan?: MemoryRetrievalPlan
): readonly MemoryRankedCandidate[] {
  const decisionByHandle = exactMemoryRerankDecisionMap(candidates, result);
  if (!decisionByHandle) {
    return candidates.map((entry) => ({
      ...entry.candidate,
      selectionReason: boundedSelectionReason(
        entry.candidate.selectionReason,
        "rerank_fallback_rrf"
      )
    }));
  }
  const originalOrder = new Map(candidates.map((entry, index) => [
    `${entry.candidate.itemType}:${entry.candidate.itemId}`,
    index
  ]));
  const relevanceScoreFloor = result?.status === "READY" &&
    result.relevanceScoreFloor !== undefined
    ? result.relevanceScoreFloor
    : MEMORY_RETRIEVAL_RERANK_SCORE_FLOOR;
  return candidates.filter((entry) => {
    if (relevanceScoreFloor === null) return true;
    const decision = decisionByHandle.get(entry.handle)!;
    if (decision.relevanceScore >= relevanceScoreFloor) return true;
    const matches = entry.candidate.featureSnapshot.deterministicMatches ?? [];
    return matches.includes("EXACT_TEXT") ||
      matches.includes("EXACT_ALIAS_SINGLE_ROOT") ||
      (plan?.profileRequested === true && matches.includes("PROFILE"));
  }).map((entry) => {
    const candidate = entry.candidate;
    const decision = decisionByHandle.get(entry.handle)!;
    const matches = candidate.featureSnapshot.deterministicMatches ?? [];
    const deterministicBonus = matches.includes("EXACT_TEXT")
      ? 0.05
      : matches.includes("EXACT_ALIAS_SINGLE_ROOT") || matches.includes("PROFILE")
        ? 0.025
        : candidate.metadata.current && candidate.metadata.sourceMode === "EXPLICIT"
          ? 0.01
          : 0;
    const authorityMultiplier = memoryRetrievalAuthorityMultiplier(candidate.metadata);
    const reason = `${candidate.selectionReason}+semantic_sort.` +
      decision.reasonCode.toLocaleLowerCase("und");
    return {
      ...candidate,
      // Model applicable/current fields are compatibility metadata only. All
      // authority and lifecycle decisions were already enforced server-side.
      finalScore: Math.min(1, decision.relevanceScore * authorityMultiplier +
        deterministicBonus),
      selectionReason: reason.length <= 128 ? reason : "semantic_sort"
    };
  }).sort((left, right) =>
    right.finalScore - left.finalScore ||
    right.rrfScore - left.rrfScore ||
    (originalOrder.get(`${left.itemType}:${left.itemId}`) ?? Number.MAX_SAFE_INTEGER) -
      (originalOrder.get(`${right.itemType}:${right.itemId}`) ?? Number.MAX_SAFE_INTEGER));
}

const memoryRerankReasonCodes = new Set([
  "DIRECT_RELEVANCE",
  "SUPPORTING_CONTEXT",
  "RESPONSE_PREFERENCE",
  "OUTDATED",
  "NOT_RELEVANT",
  "SCORE_ONLY"
]);

function exactMemoryRerankDecisionMap(
  candidates: readonly MemoryRelevanceCandidate[],
  result: MemoryRunRerankResult | null
): ReadonlyMap<string, MemoryRunRerankDecision> | null {
  if (!result || result.status !== "READY" || !Array.isArray(result.decisions) ||
    result.decisions.length !== candidates.length) return null;
  const expectedHandles = new Set(candidates.map(({ handle }) => handle));
  if (expectedHandles.size !== candidates.length) return null;
  const decisions = new Map<string, MemoryRunRerankDecision>();
  for (const decision of result.decisions) {
    if (!decision || typeof decision !== "object") return null;
    const compatibilityFieldsValid = decision.reasonCode === "SCORE_ONLY"
      ? decision.applicable === null && decision.current === null
      : typeof decision.applicable === "boolean" &&
        typeof decision.current === "boolean";
    if (typeof decision.handle !== "string" ||
      !expectedHandles.has(decision.handle) || decisions.has(decision.handle) ||
      !memoryRerankReasonCodes.has(decision.reasonCode) ||
      typeof decision.relevanceScore !== "number" ||
      !Number.isFinite(decision.relevanceScore) ||
      decision.relevanceScore < 0 || decision.relevanceScore > 1 ||
      !compatibilityFieldsValid) return null;
    decisions.set(decision.handle, decision);
  }
  return decisions.size === candidates.length ? decisions : null;
}

function atomicMemoryRerankResult(
  candidates: readonly MemoryRelevanceCandidate[],
  result: MemoryRunRerankResult | null
): MemoryRunRerankResult | null {
  if (!result || result.status !== "READY" ||
    exactMemoryRerankDecisionMap(candidates, result)) return result;
  const expectedHandles = new Set(candidates.map(({ handle }) => handle));
  const decisions = Array.isArray(result.decisions) ? result.decisions : [];
  const decisionHandles = decisions.flatMap((decision) =>
    decision && typeof decision === "object" && typeof decision.handle === "string"
      ? [decision.handle]
      : []);
  const coveredHandles = new Set(decisionHandles.filter((handle) =>
    expectedHandles.has(handle)));
  const duplicateDecisionCount = decisionHandles.length -
    new Set(decisionHandles).size;
  const previous = result.diagnostics;
  return Object.freeze({
    bindingId: result.bindingId,
    diagnostics: Object.freeze({
      batchCount: previous?.batchCount ?? (candidates.length > 0 ? 1 : 0),
      candidateCount: candidates.length,
      coverageRatio: candidates.length === 0
        ? 0
        : coveredHandles.size / candidates.length,
      decisionCount: decisions.length,
      duplicateDecisionCount,
      failedBatchCount: Math.max(1, previous?.failedBatchCount ?? 0),
      fullFallbackUsed: true,
      invalidResponseCount: Math.max(1, previous?.invalidResponseCount ?? 0),
      missingDecisionCount: Math.max(0, candidates.length - coveredHandles.size),
      providerModelMismatchCount: previous?.providerModelMismatchCount ?? 0,
      readyBatchCount: 0,
      retryCount: previous?.retryCount ?? Math.max(
        0,
        (result.externalCallCount ?? 1) - 1
      )
    }),
    ...(result.externalCallCount !== undefined
      ? { externalCallCount: result.externalCallCount }
      : {}),
    reason: "memory_run_utility_output_invalid",
    status: "UNAVAILABLE"
  });
}

function boundedSelectionReason(base: string, suffix: string): string {
  const reason = `${base}+${suffix}`;
  return reason.length <= 128 ? reason : suffix;
}

function speculativeSparseCoverageComplete(
  result: MemoryLocalRetrievalResult,
  enabledSourceKinds: readonly ("EVENT" | "FACT" | "HISTORY")[]
): boolean {
  const failed = new Set(result.lexicalFailures);
  const completed = new Set(result.laneResults
    .filter(({ candidates }) => candidates.length > 0)
    .map(({ lane }) => lane)
    .filter((lane) => !failed.has(lane)));
  const factsCovered = !enabledSourceKinds.some((kind) =>
    kind === "FACT" || kind === "EVENT") || [...completed].some((lane) =>
    lane.startsWith("FACT_") && lane !== "FACT_VECTOR");
  const historyCovered = !enabledSourceKinds.includes("HISTORY") ||
    [...completed].some((lane) => lane.startsWith("HISTORY_") &&
      lane !== "HISTORY_RECALL_VECTOR");
  return factsCovered && historyCovered;
}

function speculativeReadUsable(
  result: MemoryLocalRetrievalResult,
  enabledSourceKinds: readonly ("EVENT" | "FACT" | "HISTORY")[]
): boolean {
  // READY is also the authoritative healthy-empty signal: every scheduled
  // lexical lane settled even when no candidate happened to match.
  if (result.lexicalState === "READY" ||
    speculativeSparseCoverageComplete(result, enabledSourceKinds)) return true;
  const vectorLanes = new Set(result.laneResults.map(({ lane }) => lane));
  const vectorCoverage = result.vectorState === "READY" &&
    (!enabledSourceKinds.some((kind) => kind === "FACT" || kind === "EVENT") ||
      vectorLanes.has("FACT_VECTOR")) &&
    (!enabledSourceKinds.includes("HISTORY") ||
      vectorLanes.has("HISTORY_RECALL_VECTOR"));
  return vectorCoverage && result.laneResults.some(({ candidates }) =>
    candidates.length > 0);
}

function healthRelevantLexicalFailures(
  result: MemoryLocalRetrievalResult,
  enabledSourceKinds: readonly ("EVENT" | "FACT" | "HISTORY")[]
): readonly MemoryRetrievalLane[] {
  const failed = new Set(result.lexicalFailures);
  const sourceFamilyEnabled = (lane: MemoryRetrievalLane) =>
    enabledSourceKinds.length === 0 || (lane.startsWith("FACT_")
      ? enabledSourceKinds.some((kind) => kind === "FACT" || kind === "EVENT")
      : enabledSourceKinds.includes("HISTORY"));
  const primarySparseLane = (lane: MemoryRetrievalLane) =>
    lane === "FACT_ENTITY" || lane === "HISTORY_DIGEST_FTS_SIMPLE" ||
    lane === "HISTORY_INTRA_CHAT_RAW" || lane.endsWith("_EXACT") ||
    lane.endsWith("_LEXICAL_UNICODE");
  const primarySparseSettled = (fallbackLane: MemoryRetrievalLane) => {
    const factFamily = fallbackLane === "FACT_LEXICAL_NGRAM";
    return result.laneResults.some(({ lane }) =>
      !failed.has(lane) && primarySparseLane(lane) &&
      (factFamily ? lane.startsWith("FACT_") : lane.startsWith("HISTORY_")));
  };
  return result.lexicalFailures.filter((lane) =>
    sourceFamilyEnabled(lane) &&
    (!(lane === "FACT_LEXICAL_NGRAM" || lane === "HISTORY_RECALL_LEXICAL_NGRAM") ||
      !primarySparseSettled(lane)));
}

function mergeSpeculativeRetrieval(
  sparse: MemoryLocalRetrievalResult | null,
  dense: MemoryLocalRetrievalResult | null
): MemoryLocalRetrievalResult | null {
  const vectorLane = (lane: string) =>
    lane === "FACT_VECTOR" || lane === "HISTORY_RECALL_VECTOR";
  if (!sparse || !dense || sparse.snapshot !== dense.snapshot ||
    dense.core.length > 0 || dense.lexicalState !== "DISABLED" ||
    (dense.lexicalEvidence?.length ?? 0) > 0 || dense.lexicalFailures.length > 0 ||
    sparse.laneResults.some(({ lane }) => vectorLane(lane)) ||
    dense.laneResults.some(({ lane }) => !vectorLane(lane))) return null;
  return Object.freeze({
    core: sparse.core,
    ...(sparse.digestEvidence ? { digestEvidence: sparse.digestEvidence } : {}),
    laneResults: Object.freeze([...sparse.laneResults, ...dense.laneResults]),
    lexicalEvidence: sparse.lexicalEvidence ?? [],
    lexicalFailures: sparse.lexicalFailures,
    lexicalState: sparse.lexicalState,
    snapshot: sparse.snapshot,
    ...(sparse.sourceFamilyEvidence
      ? { sourceFamilyEvidence: sparse.sourceFamilyEvidence }
      : {}),
    vectorEvidence: dense.vectorEvidence,
    vectorState: dense.vectorState
  });
}

type MemoryQueryResolverExecution = Readonly<{
  result: MemoryQueryResolverResult;
  sources: readonly MemoryQueryResolverSource[];
  strategy: "SPECULATIVE";
}>;

const MEMORY_QUERY_RESOLVER_SPECULATIVE_CANDIDATE_MULTIPLIER = 3;

/** Builds only an early resolver frontier. It has no authority over final
 * retrieval, ordering, or packing: every returned constraint is still joined
 * to the final authoritative expansion and opaque packed evidence handle
 * before it can reach the reader. */
async function speculativeMemoryQueryResolverSources(input: Readonly<{
  cancellationSignal: AbortSignal;
  deadline: MemoryAdmissionDeadline;
  dense: MemoryLocalRetrievalResult | null;
  now: Date;
  plan: MemoryRetrievalPlan;
  query: string;
  repository: PrismaLocalMemoryRetrievalRepository;
  sparse: MemoryLocalRetrievalResult | null;
}>): Promise<readonly MemoryQueryResolverSource[]> {
  if (input.cancellationSignal.aborted) return Object.freeze([]);
  const merged = mergeSpeculativeRetrieval(input.sparse, input.dense);
  const available = [merged, input.sparse, input.dense].filter(
    (value): value is MemoryLocalRetrievalResult => value !== null
  );
  const local = available.sort((left, right) => {
    const count = (value: MemoryLocalRetrievalResult) => value.laneResults.reduce(
      (total, lane) => total + lane.candidates.length,
      0
    );
    return count(right) - count(left);
  })[0];
  if (!local) return Object.freeze([]);
  const candidates = fuseMemoryRetrievalCandidates(
    input.plan,
    local.laneResults,
    input.now
  ).filter((candidate) => candidate.metadata.sourceAuthority === "PAST_CHAT")
    .slice(
      0,
      (MEMORY_QUERY_RESOLVER_MAX_SOURCES - 1) *
        MEMORY_QUERY_RESOLVER_SPECULATIVE_CANDIDATE_MULTIPLIER
    );
  if (candidates.length === 0 || input.cancellationSignal.aborted) {
    return Object.freeze([]);
  }
  const expanded = await runBoundedMemoryRead(
    input.deadline,
    MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
    (expansionSignal) => abortableRead(
      input.repository.expand(local.snapshot, input.plan, candidates),
      expansionSignal
    ),
    input.cancellationSignal
  );
  if (input.cancellationSignal.aborted) return Object.freeze([]);
  const relevance = memoryRelevanceCandidates(candidates, expanded, {
    aggregationRequested: false,
    recencyRequested: false,
    temporalIntent: input.plan.temporalIntent
  });
  return memoryQueryResolverSources(input.query, relevance);
}

function degradationFor(
  result: MemoryLocalRetrievalResult,
  queryEmbedding: MemoryRunQueryEmbeddingResult | null,
  dynamicAllowed = true,
  profileRequested = false,
  speculativeBaselineUsed = false,
  enabledSourceKinds: readonly ("EVENT" | "FACT" | "HISTORY")[] = []
): string | null {
  if (!dynamicAllowed) return null;
  if (speculativeBaselineUsed &&
    speculativeSparseCoverageComplete(result, enabledSourceKinds)) return null;
  const lexicalFailures = healthRelevantLexicalFailures(result, enabledSourceKinds);
  if (lexicalFailures.length > 0 &&
    (result.lexicalState === "FAILED" || result.lexicalState === "DEGRADED")) {
    const families = new Set(lexicalFailures.map((lane) =>
      lane === "FACT_ENTITY" ? "entity" :
        lane.includes("_FTS_") || lane.includes("_LEXICAL_") ? "fts"
        : lane.endsWith("_EXACT") ? "exact" : "recent"));
    if (families.size === 1 && families.has("entity")) return "memory_entity_unavailable";
    if (families.size === 1 && families.has("fts")) return "memory_fts_unavailable";
    if (families.size === 1 && families.has("exact")) return "memory_exact_unavailable";
    return result.lexicalState === "FAILED"
      ? "memory_lexical_unavailable"
      : "memory_lexical_partial_unavailable";
  }
  if (!result.snapshot.indexMode && !profileRequested) {
    return "memory_index_unavailable";
  }
  // A broad profile request deliberately reads the bounded current-fact lane.
  // It neither needs nor uses query-vector retrieval, so vector degradation is
  // not a failure for this mode.
  if (profileRequested) return null;
  if (queryEmbedding?.status === "UNAVAILABLE") {
    return "memory_query_embedding_unavailable";
  }
  if (result.vectorState === "DEGRADED") return "memory_vector_unavailable";
  if (result.snapshot.indexMode === "HYBRID" && result.vectorState === "NOT_CONFIGURED") {
    return "memory_query_embedding_unavailable";
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
      const readUtilityPolicy = options.readUtilityPolicy ??
        DEFAULT_MEMORY_READ_UTILITY_POLICY;
      const deterministicRead = readUtilityPolicy === "DETERMINISTIC_READ_V1";
      const timings = createMemoryPreparationTimings(
        options.monotonicClock ?? (() => performance.now())
      );
      const queryResolverState: { execution: MemoryQueryResolverExecution | null } = {
        execution: null
      };
      const result: MemoryPreparingAttemptResult = await (
        async (): Promise<MemoryPreparingAttemptResult> => {
      if (input.expected.chatMemoryMode === "TEMPORARY") {
        return emptyAttempt(input.expected, "DISABLED", "temporary_chat");
      }
      const controlCache = input.controlCache ?? {};
      const deadline = createMemoryAdmissionDeadline(
        controlCache,
        input.signal,
        options
      );
      const speculativeBaselineController = new AbortController();
      const speculativeDenseController = new AbortController();
      const speculativeQueryResolverController = new AbortController();
      let speculativeBaselinePromise: Promise<MemoryLocalRetrievalResult | null> =
        Promise.resolve(null);
      let speculativeDensePromise: Promise<MemoryLocalRetrievalResult | null> =
        Promise.resolve(null);
      let speculativeQueryResolverEligible = false;
      let speculativeQueryResolutionSettled = true;
      let speculativeQueryResolutionPromise: Promise<MemoryQueryResolverExecution | null> =
        Promise.resolve(null);
      try {
      const signal = deadline.signal;
      if (deadline.expired()) {
        return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId);
      }
      const currentUserText = exactCurrentUserText(input.normalizedRequest);
      const querySafety = sanitizeMemoryUtilityText(currentUserText);
      const actionAdmission: MemoryActionAdmission = admitMemoryAction(
        querySafety.safeText
      );
      const actionControlRequested = !deterministicRead ||
        actionAdmission.state === "EXPLICIT_CANDIDATE";
      const provisionalPlan = planMemoryRetrieval({
        currentUserText: querySafety.safeText,
        now: input.now,
        timeZone: acceptedMemoryTimeZone(input.normalizedRequest)
      });
      if (!provisionalPlan.queryPresent) {
        return emptyAttempt(input.expected, "FAILED_SAFE", "memory_plan_query_missing", null, {
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
          memoryActionAdmissionReason: actionAdmission.reason,
          memoryActionAdmissionState: actionAdmission.state,
          memoryActionAdmissionVersion: actionAdmission.version,
          memoryActionControlRequested: actionControlRequested,
          memoryReadUtilityPolicy: readUtilityPolicy,
          plan: planEvidence(provisionalPlan),
          querySafetyVersion: querySafety.version,
          safetyFindingCounts: querySafety.findingCounts,
          utilityEgressMode: "LOCAL_ONLY"
        });
      }
      const controlReuseScopeHash = memoryControlReuseScopeHash(
        input,
        provisionalPlan.originalSanitizedQuery
      );
      const cachedControl = actionControlRequested
        ? controlCache.control
        : undefined;
      const cachedActionResult = actionControlRequested && controlCache.actionResolved
        ? controlCache.actionResult ?? null
        : null;
      const cachedAnswerResult = cachedControl
        ? memoryActionAnswerResult(cachedControl, cachedActionResult)
        : null;
      let readOnlyControlReuse: MemoryReadOnlyControlReuseProof | null = null;
      let fallbackControlReuse: MemoryFallbackControlReuseProof | null = null;
      if (cachedControl && controlCache.controlAttemptId !== input.attemptId) {
        if (cachedControl.status === "UNAVAILABLE") {
          fallbackControlReuse = fallbackControlRetryProof(
            controlCache,
            input,
            controlReuseScopeHash
          );
        } else {
          readOnlyControlReuse = readOnlyControlRetryProof(
            controlCache,
            input,
            controlReuseScopeHash
          );
        }
        if (!readOnlyControlReuse && !fallbackControlReuse) {
          return emptyAttempt(
            input.expected,
            "FAILED_SAFE",
            "memory_control_retry_not_reused",
            null,
            {
              ...(cachedAnswerResult ? { memoryActionAnswerResult: cachedAnswerResult } : {}),
              ...(cachedActionResult ? { memoryActionResult: cachedActionResult } : {}),
              utilityEgressMode: "LOCAL_ONLY"
            }
          );
        }
        controlCache.readOnlyControlReuseProof = readOnlyControlReuse ?? undefined;
        controlCache.readOnlyControlReuseAttemptId = readOnlyControlReuse
          ? input.attemptId
          : undefined;
        controlCache.fallbackControlReuseProof = fallbackControlReuse ?? undefined;
        controlCache.fallbackControlReuseAttemptId = fallbackControlReuse
          ? input.attemptId
          : undefined;
      }
      const cachedActionEvidence = {
        ...(cachedAnswerResult ? { memoryActionAnswerResult: cachedAnswerResult } : {}),
        ...(cachedActionResult ? { memoryActionResult: cachedActionResult } : {}),
        ...(readOnlyControlReuse ? { readOnlyControlReuse } : {}),
        ...(fallbackControlReuse ? { fallbackControlReuse } : {}),
        memoryActionAdmissionReason: actionAdmission.reason,
        memoryActionAdmissionState: actionAdmission.state,
        memoryActionAdmissionVersion: actionAdmission.version,
        memoryActionControlRequested: actionControlRequested,
        memoryReadUtilityPolicy: readUtilityPolicy,
        utilityEgressMode:
          readOnlyControlReuse && cachedControl &&
          utilityUsedExternal(cachedControl)
            ? "CONSENTED_EXTERNAL" as const
            : "LOCAL_ONLY" as const
      };

      let snapshot: MemoryLocalRetrievalSnapshot;
      try {
        snapshot = await timings.measure("snapshotMs", () =>
          runBoundedMemoryRead(
            deadline,
            MEMORY_SNAPSHOT_OPTIONAL_MAXIMUM_MS,
            (snapshotSignal) => abortableRead(repository.snapshot({
              assistantId: input.expected.assistantId,
              chatId: input.chatId,
              now: input.now,
              plan: provisionalPlan,
              userId: input.userId
            }), snapshotSignal)
          ));
      } catch (error) {
        if (deadline.expired()) {
          return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId);
        }
        return emptyAttempt(input.expected, "FAILED_SAFE", "memory_snapshot_unavailable", null, {
          ...cachedActionEvidence,
          failureClass: error instanceof Error ? error.name : "unknown",
          plan: planEvidence(provisionalPlan)
        });
      }
      if (input.expected.assistantId !== null && snapshot.assistantId === null) {
        return emptyAttempt(input.expected, "DISABLED", "assistant_memory_grant_missing", null,
          cachedActionEvidence);
      }
      assertStableSnapshot(
        snapshot,
        input.expected,
        controlCache,
        input.attemptId,
        settingsDriftFailedSafeBudget(
          input.expected,
          controlCache,
          input.attemptId
        )
      );
      if (snapshot.status === "DISABLED") {
        return emptyAttempt(input.expected, "DISABLED", snapshot.reason, null,
          cachedActionEvidence);
      }
      const baselineReadPlan = deterministicBaseReadPlan(
        input,
        provisionalPlan.originalSanitizedQuery
      );
      const executeQueryResolver = async (
        sources: readonly MemoryQueryResolverSource[],
        cancellationSignal?: AbortSignal
      ): Promise<MemoryQueryResolverExecution | null> => {
        if (deterministicRead || sources.length === 0 || !options.queryResolver ||
          cancellationSignal?.aborted) return null;
        let result: MemoryQueryResolverResult;
        if (controlCache.queryResolverConsumedAttemptId === input.attemptId) {
          result = {
            reason: "memory_query_resolution_retry_budget_exhausted",
            status: "UNAVAILABLE"
          };
        } else {
          controlCache.queryResolverConsumedAttemptId = input.attemptId;
          result = await timings.measure("queryResolverMs", () =>
            runOptionalMemoryUtility(
              deadline,
              "QUERY_RESOLVE",
              (utilitySignal) => options.queryResolver!.resolve({
                attemptId: input.attemptId,
                query: baselineReadPlan.originalSanitizedQuery,
                signal: cancellationSignal
                  ? AbortSignal.any([utilitySignal, cancellationSignal])
                  : utilitySignal,
                sources,
                userId: input.userId
              })
            ).catch(() => ({
              reason: "memory_query_resolution_unavailable",
              status: "UNAVAILABLE" as const
            })));
        }
        const execution = Object.freeze({
          result,
          sources,
          strategy: "SPECULATIVE" as const
        });
        queryResolverState.execution = execution;
        return execution;
      };
      if (typeof repository.retrieveSpeculativeBaseline === "function") {
        speculativeBaselinePromise = timings.measure("localRetrievalMs", () =>
          runBoundedMemoryRead(
            deadline,
            MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
            (retrievalSignal) => repository.retrieveSpeculativeBaseline!({
                assistantId: input.expected.assistantId,
                chatId: input.chatId,
                now: input.now,
                plan: baselineReadPlan,
                sourceSnapshot: snapshot,
                userId: input.userId
              }, retrievalSignal),
            speculativeBaselineController.signal
          )).catch(() => null);
      }
      const controlRefsPromise: Promise<readonly string[]> = actionControlRequested &&
        options.controlRefs
        ? timings.measure("snapshotMs", () =>
            runBoundedMemoryRead(
              deadline,
              MEMORY_SNAPSHOT_OPTIONAL_MAXIMUM_MS,
              (controlRefSignal) => abortableRead(options.controlRefs!.load({
                assistantMessageIds: recentAssistantMessageIds(input.normalizedRequest),
                chatId: input.chatId,
                userId: input.userId
              }), controlRefSignal)
            ).catch(() => []))
        : Promise.resolve([]);
      const queryEmbeddingPromise = prepareOriginalQueryEmbedding({
        deadline,
        options,
        plan: baselineReadPlan,
        retrieval: input,
        snapshot,
        timings
      });
      let settledControl: MemoryControlResult | null = null;
      const controlPromise = (async (): Promise<MemoryControlResult> => {
        if (!actionControlRequested) {
          return {
            reason: "memory_action_control_not_admitted",
            status: "UNAVAILABLE"
          };
        }
        const refs = await controlRefsPromise;
        if (controlCache.control) return controlCache.control;
        if (!options.control) {
          return {
            reason: "memory_action_intent_unavailable",
            status: "UNAVAILABLE"
          };
        }
        const context = memoryControlContext(
          input,
          provisionalPlan.originalSanitizedQuery,
          refs
        );
        return timings.measure("controlMs", () =>
          runOptionalMemoryUtility(deadline, "CONTROL", (utilitySignal) =>
            options.control!.decide({
              attemptId: input.attemptId,
              context,
              signal: utilitySignal,
              userId: input.userId
            }))
            .catch(() => ({
              reason: "memory_action_intent_unavailable",
              status: "UNAVAILABLE" as const
            })));
      })().then((result) => {
        settledControl = result;
        return result;
      });
      if (typeof repository.retrieveSpeculativeDense === "function") {
        speculativeDensePromise = queryEmbeddingPromise.then((embedding) => {
          if (embedding?.status !== "READY" ||
            !deterministicRead && settledControl?.status === "READY" ||
            !deadline.canStartOptional()) return null;
          return timings.measure("localRetrievalMs", () =>
            runBoundedMemoryRead(
              deadline,
              MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
              (retrievalSignal) => repository.retrieveSpeculativeDense!({
                  assistantId: input.expected.assistantId,
                  chatId: input.chatId,
                  now: input.now,
                  plan: baselineReadPlan,
                  sourceSnapshot: snapshot,
                  userId: input.userId,
                  vector: {
                    minimumScore: MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
                    profile: embedding.profile,
                    vector: embedding.vector
                  }
                }, retrievalSignal),
              speculativeDenseController.signal
            ));
        }).catch(() => null);
      }
      if (!deterministicRead && options.queryResolver &&
        input.expected.settings.referenceChatHistory) {
        speculativeQueryResolverEligible = true;
        speculativeQueryResolutionSettled = false;
        speculativeQueryResolutionPromise = (async () => {
          try {
            const [sparse, dense] = await Promise.all([
              speculativeBaselinePromise,
              speculativeDensePromise
            ]);
            const sources = await speculativeMemoryQueryResolverSources({
              cancellationSignal: speculativeQueryResolverController.signal,
              deadline,
              dense,
              now: input.now,
              plan: baselineReadPlan,
              query: baselineReadPlan.originalSanitizedQuery,
              repository,
              sparse
            });
            return executeQueryResolver(
              sources,
              speculativeQueryResolverController.signal
            );
          } catch {
            return null;
          }
        })().finally(() => {
          speculativeQueryResolutionSettled = true;
        });
      }
      const [controlRefs, queryEmbedding, control] = await Promise.all([
        controlRefsPromise,
        queryEmbeddingPromise,
        controlPromise
      ]);
      const controlContext = memoryControlContext(
        input,
        provisionalPlan.originalSanitizedQuery,
        controlRefs
      );
      if (actionControlRequested && controlCache.control === undefined) {
        controlCache.control = control;
        controlCache.controlAttemptId = input.attemptId;
        controlCache.controlInputHash = memoryControlInputHash(controlContext);
        controlCache.controlReuseScopeHash = controlReuseScopeHash;
      }
      if (deadline.expired()) {
        return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [{
          result: queryEmbedding,
          role: "MEMORY_QUERY_EMBED"
        }]);
      }
      if (actionControlRequested && controlCache.actionResolved !== true) {
        let resolvedAction: MemoryActionFeedback | null = null;
        if (control.status === "READY" && options.actionExecutor &&
          control.intent.action !== "NONE") {
          try {
            resolvedAction = await options.actionExecutor.execute({
              admissionDeadlineAtMs: controlCache.admissionDeadlineAtMs!,
              bindingId: control.bindingId,
              chatId: input.chatId,
              currentUserText: querySafety.safeText,
              intent: control.intent,
              modelRunId: input.modelRunId,
              now: input.now,
              attemptId: input.attemptId,
              signal,
              userId: input.userId
            });
          } catch {
            if (control.intent.action === "SAVE" || control.intent.action === "UPDATE" ||
              control.intent.action === "FORGET") {
              resolvedAction = { operation: control.intent.action, status: "REJECTED" };
            }
          }
        }
        controlCache.actionResolved = true;
        controlCache.actionResult = resolvedAction;
        controlCache.actionAttemptId = input.attemptId;
      }
      const actionResult = actionControlRequested
        ? controlCache.actionResult ?? null
        : null;
      if (deadline.expired()) {
        return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [{
          result: queryEmbedding,
          role: "MEMORY_QUERY_EMBED"
        }]);
      }
      const answerResult = memoryActionAnswerResult(control, actionResult);
      const controlEvidence = controlForAttemptEvidence(control, fallbackControlReuse)!;
      const controlUtilityResult = actionControlRequested ? controlEvidence : null;
      const currentControlExternal = actionControlRequested &&
        utilityUsedExternal(control) &&
        (controlCache.controlAttemptId === input.attemptId || readOnlyControlReuse !== null);
      const actionEvidence = {
        ...(answerResult ? { memoryActionAnswerResult: answerResult } : {}),
        ...(actionResult ? { memoryActionResult: actionResult } : {}),
        ...(readOnlyControlReuse ? { readOnlyControlReuse } : {}),
        ...(fallbackControlReuse ? { fallbackControlReuse } : {}),
        memoryActionAdmissionReason: actionAdmission.reason,
        memoryActionAdmissionState: actionAdmission.state,
        memoryActionAdmissionVersion: actionAdmission.version,
        memoryActionControlRequested: actionControlRequested,
        memoryReadUtilityPolicy: readUtilityPolicy,
        utilityEgressMode: currentControlExternal || utilityUsedExternal(queryEmbedding)
          ? "CONSENTED_EXTERNAL" as const
          : "LOCAL_ONLY" as const
      };
      const controlRetrievalRequested = control.status === "READY" && (
        control.intent.memoryUseful || control.intent.pastChatsUseful ||
        control.intent.applyResponsePreferences || control.intent.profileRequested
      );
      if (control.status === "READY" && control.intent.action !== "NONE" &&
        !controlRetrievalRequested) {
        return emptyAttempt(input.expected, "EMPTY", "memory_action_only", null, {
          ...actionEvidence,
          controlReason: control.intent.reasonCode,
          plan: planEvidence(provisionalPlan),
          querySafetyVersion: querySafety.version,
          safetyFindingCounts: querySafety.findingCounts,
          sourceFamilyHardExclusionReasons: [
            "MUTATION_ONLY_READ_EXCLUDED"
          ] satisfies readonly MemorySourceFamilyHardExclusionReason[],
          utilityExecutions: [
            utilityEvidence("MEMORY_CONTROL", controlUtilityResult),
            utilityEvidence("MEMORY_QUERY_EMBED", queryEmbedding)
          ]
        });
      }

      let plan = baselineReadPlan;
      let plannerFallbackReason: string | null = null;
      let broadPlannerFallback = false;
      let broadFallbackBaselinePlan: MemoryRetrievalPlan | null = null;
      if (deterministicRead) {
        const deterministic = deterministicBroadFallbackReadPlans(
          input,
          provisionalPlan.originalSanitizedQuery
        );
        plan = deterministic.enriched;
        broadFallbackBaselinePlan = deterministic.baseline;
        broadPlannerFallback = true;
      } else if (control.status !== "READY") {
        plannerFallbackReason = control.reason;
        const fallback = deterministicBroadFallbackReadPlans(
          input,
          provisionalPlan.originalSanitizedQuery
        );
        plan = fallback.enriched;
        broadFallbackBaselinePlan = fallback.baseline;
        broadPlannerFallback = true;
      } else if (!controlRetrievalRequested) {
        plannerFallbackReason = "memory_control_read_not_requested";
      } else if (!control.intent.queryText) {
        plannerFallbackReason = "memory_plan_query_missing";
        const fallback = deterministicBroadFallbackReadPlans(
          input,
          provisionalPlan.originalSanitizedQuery
        );
        plan = fallback.enriched;
        broadFallbackBaselinePlan = fallback.baseline;
        broadPlannerFallback = true;
      } else {
        const factsRequested = control.intent.memoryUseful &&
          input.expected.settings.useMemoryFacts;
        const historyRequested = !control.intent.profileRequested &&
          control.intent.pastChatsUseful &&
          input.expected.settings.referenceChatHistory;
        const preferencesRequested = control.intent.applyResponsePreferences &&
          input.expected.settings.useMemoryFacts;
        const dynamicSourceKinds = [
          ...(factsRequested ? ["FACT" as const, "EVENT" as const] : []),
          ...(historyRequested ? ["HISTORY" as const] : [])
        ];
        const rewriteSafety = sanitizeMemoryUtilityText(control.intent.queryText);
        const semanticDecompositions = control.intent.queryDecompositions.flatMap((value) => {
          const projected = sanitizeMemoryUtilityText(value);
          return projected.eligible && projected.safeText ? [projected.safeText] : [];
        });
        const includePatterns = factsRequested &&
          control.intent.retrievalMode === "TARGETED_CURRENT" &&
          control.intent.temporalIntent === "CURRENT" &&
          !control.intent.profileRequested &&
          !control.intent.patternExclusionRequested;
        try {
          plan = planMemoryRetrieval({
            aggregationRequested: control.intent.aggregationRequested,
            allowedEntityRefs: controlRefs,
            applyResponsePreferences: preferencesRequested,
            currentUserText: provisionalPlan.originalSanitizedQuery,
            entityMentions: control.intent.entityMentions,
            filters: {
              asOf: control.intent.temporalAsOf
                ? new Date(control.intent.temporalAsOf)
                : null,
              from: control.intent.temporalFrom
                ? new Date(control.intent.temporalFrom)
                : null,
              sourceKinds: dynamicSourceKinds,
              to: control.intent.temporalTo
                ? new Date(control.intent.temporalTo)
                : null
            },
            includePatterns,
            mode: control.intent.retrievalMode,
            now: input.now,
            profileRequested: control.intent.profileRequested,
            recencyRequested: control.intent.recencyRequested,
            semanticDecompositions,
            semanticRewrite: rewriteSafety.safeText,
            temporalIntent: control.intent.temporalIntent,
            timeZone: acceptedMemoryTimeZone(input.normalizedRequest)
          });
        } catch {
          plannerFallbackReason = "memory_plan_invalid";
          const fallback = deterministicBroadFallbackReadPlans(
            input,
            provisionalPlan.originalSanitizedQuery
          );
          plan = fallback.enriched;
          broadFallbackBaselinePlan = fallback.baseline;
          broadPlannerFallback = true;
        }
      }
      const queryResolverFinalPlanEligible = plan.mode === "PAST_CHAT_SEARCH" &&
        (!plan.aggregationRequested || broadPlannerFallback);
      if (!queryResolverFinalPlanEligible &&
        !speculativeQueryResolverController.signal.aborted) {
        speculativeQueryResolverController.abort({
          code: "memory_query_resolution_not_required"
        });
      }
      const hardExclusionReasons: MemorySourceFamilyHardExclusionReason[] = [
        ...(!input.expected.settings.useMemoryFacts
          ? ["FACTS_SETTING_DISABLED" as const]
          : []),
        ...(!input.expected.settings.referenceChatHistory
          ? ["HISTORY_SETTING_DISABLED" as const]
          : []),
        ...(plan.profileRequested
          ? ["PROFILE_OPERATION_HISTORY_EXCLUDED" as const]
          : []),
        ...(plan.applyResponsePreferences && plan.filters.sourceKinds.length === 0
          ? ["RESPONSE_PREFERENCE_ONLY_DYNAMIC_EXCLUDED" as const]
          : [])
      ];
      const typedNarrowRead = plan.profileRequested ||
        plan.applyResponsePreferences && plan.filters.sourceKinds.length === 0;
      const plans: MemoryRetrievalPlanBundle = Object.freeze({
        baseline: typedNarrowRead
          ? null
          : broadPlannerFallback ? broadFallbackBaselinePlan : baselineReadPlan,
        enriched: plan,
        hardExclusionReasons: Object.freeze(hardExclusionReasons)
      });
      const admittedSourceKinds = [...new Set([
        ...(plans.baseline?.filters.sourceKinds ?? []),
        ...plan.filters.sourceKinds
      ])];
      const factsRequested = input.expected.settings.useMemoryFacts &&
        (admittedSourceKinds.includes("FACT") || admittedSourceKinds.includes("EVENT"));
      const historyRequested = input.expected.settings.referenceChatHistory &&
        admittedSourceKinds.includes("HISTORY");
      const preferencesRequested = input.expected.settings.useMemoryFacts &&
        plan.applyResponsePreferences;

      let local: MemoryLocalRetrievalResult;
      let broadLexicalFallbackUsed = false;
      let speculativeBaselineUsed = false;
      let speculativeHybridUsed = false;
      try {
        const speculationUsable = broadPlannerFallback || plan === baselineReadPlan;
        // The fast hedge intentionally omits broad digest navigation. It may
        // replace the enriched plan only while dense original-query evidence
        // is available; otherwise the existing bounded broad lexical plan is
        // the authoritative fail-soft path.
        const broadLexicalFallbackRequired = broadPlannerFallback &&
          queryEmbedding?.status !== "READY";
        const [speculativeBaseline, speculativeDense] = speculationUsable
          ? await Promise.all([speculativeBaselinePromise, speculativeDensePromise])
          : [null, null];
        const speculativeHybrid = mergeSpeculativeRetrieval(
          speculativeBaseline,
          speculativeDense
        );
        const speculativeHybridUsable = speculativeHybrid !== null &&
          speculativeReadUsable(
            speculativeHybrid,
            baselineReadPlan.filters.sourceKinds
          );
        const speculativeBaselineUsable = speculativeBaseline !== null &&
          speculativeReadUsable(
            speculativeBaseline,
            baselineReadPlan.filters.sourceKinds
          );
        speculativeBaselineController.abort({ code: "memory_speculation_settled" });
        speculativeDenseController.abort({ code: "memory_speculation_settled" });
        if (speculativeHybridUsable) {
          local = speculativeHybrid;
          speculativeHybridUsed = true;
        } else if (speculativeBaselineUsable && !broadLexicalFallbackRequired) {
          local = speculativeBaseline;
          speculativeBaselineUsed = true;
        } else {
          broadLexicalFallbackUsed = broadLexicalFallbackRequired;
          local = await timings.measure("localRetrievalMs", () =>
            runBoundedMemoryRead(
              deadline,
              MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
              (retrievalSignal) => repository.retrieve({
                assistantId: input.expected.assistantId,
                ...(plans.baseline ? { baselinePlan: plans.baseline } : {}),
                chatId: input.chatId,
                now: input.now,
                plan,
                settleSignal: retrievalSignal,
                sourceSnapshot: snapshot,
                userId: input.userId,
                ...(queryEmbedding?.status === "READY" && !plan.profileRequested
                  ? { vector: {
                      minimumScore: MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
                      profile: queryEmbedding.profile,
                      vector: queryEmbedding.vector
                    } }
                  : {})
              })
            ));
        }
      } catch (error) {
        if (deadline.expired()) {
          return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [{
            result: queryEmbedding,
            role: "MEMORY_QUERY_EMBED"
          }]);
        }
        return emptyAttempt(input.expected, "FAILED_SAFE", "memory_local_retrieval_failed",
          plan.originalSanitizedQuery, {
            ...actionEvidence,
            failureClass: error instanceof Error ? error.name : "unknown",
            plan: planEvidence(plan),
            plannerFallbackReason,
            querySafetyVersion: querySafety.version,
            safetyFindingCounts: querySafety.findingCounts,
            utilityEgressMode: currentControlExternal || utilityUsedExternal(queryEmbedding)
              ? "CONSENTED_EXTERNAL"
              : "LOCAL_ONLY",
            utilityExecutions: [
              utilityEvidence("MEMORY_CONTROL", controlUtilityResult),
              utilityEvidence("MEMORY_QUERY_EMBED", queryEmbedding)
            ]
          });
      }
      assertStableSnapshot(
        local.snapshot,
        input.expected,
        controlCache,
        input.attemptId,
        settingsDriftFailedSafeBudget(
          input.expected,
          controlCache,
          input.attemptId,
          [{ result: queryEmbedding, role: "MEMORY_QUERY_EMBED" }]
        )
      );

      const dynamicAllowed = factsRequested || historyRequested;
      const dynamicLaneResults = dynamicAllowed ? local.laneResults : [];
      const fused = fuseMemoryRetrievalCandidates(plan, dynamicLaneResults, input.now);
      const coreKeys = new Set(local.core.map(({ candidate }) =>
        `${candidate.itemType}:${candidate.itemId}`));
      const dynamicFused = fused.filter((candidate) =>
        !coreKeys.has(`${candidate.itemType}:${candidate.itemId}`));
      let dynamicCandidates: readonly MemoryRankedCandidate[] = dynamicFused;
      let navigationExpanded: readonly MemoryExpandedCandidate[] = [];
      let expansionFailure: MemoryExpansionFailure | null = null;
      let sessionCompletion: MemorySessionEvidenceCompletion = Object.freeze({
        candidates: Object.freeze([]),
        sourceChatCount: 0
      });
      let sessionCompletionExpansions: readonly MemoryExpandedCandidate[] = [];
      let sessionCompletionState: "READY" | "SKIPPED" | "UNAVAILABLE" = "SKIPPED";
      let sessionCompletionCandidateCount = 0;
      const targetedSessionCompletionEnabled = !plan.aggregationRequested &&
        plan.mode === "PAST_CHAT_SEARCH" &&
        typeof repository.completeSessionEvidence === "function";
      if (dynamicFused.length > 0) {
        try {
          dynamicCandidates = plan.aggregationRequested && plan.mode === "PAST_CHAT_SEARCH"
            ? await timings.measure("localRetrievalMs", () =>
                runBoundedMemoryRead(
                  deadline,
                  MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
                  (projectionSignal) => abortableRead(
                    repository.projectAggregationSessions(local.snapshot, plan, dynamicFused),
                    projectionSignal
                  )
                ))
            : dynamicFused;
          if (dynamicCandidates.length > 0) {
            const targetedCompletionSources = targetedSessionCompletionEnabled
              ? selectMemoryTargetedSessionRepresentatives(dynamicCandidates)
              : [];
            const targetedCompletionSourceChatCount = new Set(
              targetedCompletionSources.flatMap((candidate) =>
                candidate.itemType !== "FACT_VERSION" && candidate.metadata.sourceChatId
                  ? [candidate.metadata.sourceChatId]
                  : [])
            ).size;
            if (targetedCompletionSourceChatCount > 0) {
              sessionCompletion = Object.freeze({
                candidates: Object.freeze([]),
                sourceChatCount: targetedCompletionSourceChatCount
              });
            }
            const [expandedResult, completionResult] = await timings.measure(
              "localRetrievalMs",
              () => Promise.all([
                runBoundedMemoryRead(
                  deadline,
                  MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
                  (expansionSignal) => abortableRead(
                    expandWithSourceFamilyPlans({
                      candidates: dynamicCandidates,
                      navigation: plan.aggregationRequested &&
                        plan.mode === "PAST_CHAT_SEARCH",
                      plans,
                      repository,
                      snapshot: local.snapshot
                    }),
                    expansionSignal
                  )
                ).then(
                  (value) => ({ error: null, value }),
                  (error: unknown) => ({
                    error,
                    value: [] as readonly MemoryExpandedCandidate[]
                  })
                ),
                targetedCompletionSourceChatCount > 0
                  ? runBoundedMemoryRead(
                      deadline,
                      MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
                      (completionSignal) => abortableRead((async () => {
                        const value = await repository.completeSessionEvidence!(
                          local.snapshot,
                          plan,
                          targetedCompletionSources,
                          {
                            queryCandidates: dynamicCandidates,
                            ...(queryEmbedding?.status === "READY"
                              ? { vector: {
                                  minimumScore:
                                    MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
                                  profile: queryEmbedding.profile,
                                  vector: queryEmbedding.vector
                                } }
                              : {})
                          }
                        );
                        const expansions = await expandWithSourceFamilyPlans({
                          candidates: value.candidates,
                          navigation: false,
                          plans,
                          repository,
                          snapshot: local.snapshot
                        });
                        return { expansions, value };
                      })(), completionSignal)
                    ).then(
                      ({ expansions, value }) => ({ error: null, expansions, value }),
                      (error: unknown) => ({
                        error,
                        expansions: [] as readonly MemoryExpandedCandidate[],
                        value: sessionCompletion
                      })
                    )
                  : Promise.resolve({
                      error: null,
                      expansions: [] as readonly MemoryExpandedCandidate[],
                      value: sessionCompletion
                    })
              ])
            );
            if (expandedResult.error) throw expandedResult.error;
            navigationExpanded = expandedResult.value;
            if (targetedCompletionSourceChatCount > 0) {
              if (completionResult.error) sessionCompletionState = "UNAVAILABLE";
              else {
                sessionCompletion = completionResult.value;
                sessionCompletionExpansions = completionResult.expansions;
                sessionCompletionState = "READY";
                const completedNavigation = mergeMemorySessionEvidenceCompletion(
                  dynamicCandidates,
                  navigationExpanded,
                  sessionCompletion,
                  sessionCompletionExpansions
                );
                dynamicCandidates = completedNavigation.candidates;
                navigationExpanded = completedNavigation.expansions;
                sessionCompletionCandidateCount =
                  completedNavigation.completionCandidateCount;
              }
            }
          }
        } catch (error) {
          if (deadline.expired()) {
            return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [{
              result: queryEmbedding,
              role: "MEMORY_QUERY_EMBED"
            }]);
          }
          expansionFailure ??= classifyMemoryExpansionFailure(error);
        }
      }
      // The exact direct query was locally redacted before control. Every
      // later utility receives that same safe original or a sanitized rewrite.
      const eligibleCore = preferencesRequested
        ? local.core.filter(isEligibleMemoryResponsePreferenceCore)
        : [];
      const relevanceInput = memoryRelevanceCandidates(
        [...eligibleCore.map(({ candidate }) => candidate), ...dynamicCandidates],
        [...eligibleCore.map(({ expansion }) => expansion), ...navigationExpanded],
        {
          aggregationRequested: plan.aggregationRequested,
          recencyRequested: plan.recencyRequested,
          temporalIntent: plan.temporalIntent
        }
      );
      // A control-unavailable broad fallback uses aggregation machinery only
      // to preserve recall. It does not turn an open-ended guidance query into
      // a semantic enumerate/count request, so a previously started resolver
      // may still finish. Explicitly planned aggregation remains excluded.
      const finalResolverSources = queryResolverFinalPlanEligible
        ? memoryQueryResolverSources(plan.originalSanitizedQuery, relevanceInput)
        : Object.freeze([]);
      const finalResolverApplicable = finalResolverSources.length > 0;
      if (!finalResolverApplicable &&
        !speculativeQueryResolverController.signal.aborted) {
        speculativeQueryResolverController.abort({
          code: "memory_query_resolution_not_required"
        });
      }
      const relevancePromise = (async (): Promise<MemoryRunRerankResult | null> => {
        if (relevanceInput.length === 0) return null;
        if (controlCache.rerankConsumedAttemptId === input.attemptId) {
          return {
            reason: "memory_relevance_retry_budget_exhausted",
            status: "UNAVAILABLE"
          };
        }
        if (!options.utilities) {
          return { reason: "memory_relevance_unavailable", status: "UNAVAILABLE" };
        }
        // The outer preparing state machine owns at most two distinct
        // retrieval attempts. A retry gets a new durable attempt owner, so
        // its read-only rerank may execute once again without replaying an
        // action or colliding with the first attempt's governed bindings.
        controlCache.rerankConsumedAttemptId = input.attemptId;
        return timings.measure("rerankMs", () =>
          runOptionalMemoryUtility(
            deadline,
            "RERANK",
            (utilitySignal) => options.utilities!.rerank({
                attemptId: input.attemptId,
                aggregationRequested: plan.aggregationRequested,
                canRetry: deadline.canStartOptional,
                candidates: relevanceInput.map(({
                  candidate: _candidate,
                  directUserTexts: _directUserTexts,
                  ...candidate
                }) => candidate),
                profileRequested: plan.profileRequested,
                query: plan.originalSanitizedQuery,
                retrievalMode: plan.mode,
                signal: utilitySignal,
                temporalIntent: plan.temporalIntent,
                userId: input.userId
              })
          ).catch(() => ({ reason: "memory_relevance_unavailable",
            status: "UNAVAILABLE" as const })));
      })();
      const initialRelevance = await relevancePromise;
      if (deadline.expired()) {
        return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [
          { result: queryEmbedding, role: "MEMORY_QUERY_EMBED" },
          {
            result: queryResolverState.execution?.result ?? null,
            role: "MEMORY_QUERY_RESOLVE"
          },
          { result: initialRelevance, role: "MEMORY_RERANK" }
        ]);
      }
      const relevance = atomicMemoryRerankResult(relevanceInput, initialRelevance);
      const relevant = applyMemoryRelevance(relevanceInput, relevance, plan);
      const rejoinCandidates = plan.aggregationRequested && plan.mode === "PAST_CHAT_SEARCH"
        ? selectMemoryAggregationRawCandidates(dynamicFused, relevant)
        : relevant;
      let rejoined: readonly MemoryExpandedCandidate[] = [];
      const aggregationSessionCompletionEnabled = plan.aggregationRequested &&
        plan.mode === "PAST_CHAT_SEARCH" &&
        typeof repository.completeSessionEvidence === "function";
      const aggregationSessionCompletionSources = aggregationSessionCompletionEnabled
        ? relevant
        : [];
      const aggregationSessionCompletionSourceChatCount = new Set(
        aggregationSessionCompletionSources.flatMap((candidate) =>
          candidate.itemType !== "FACT_VERSION" && candidate.metadata.sourceChatId
            ? [candidate.metadata.sourceChatId]
            : [])
      ).size;
      if (aggregationSessionCompletionSourceChatCount > 0) {
        sessionCompletion = Object.freeze({
          candidates: Object.freeze([]),
          sourceChatCount: aggregationSessionCompletionSourceChatCount
        });
      }
      if (rejoinCandidates.length > 0) {
        try {
          // The reranker operates on the first safe expansion. Reload its
          // bounded accepted set so decay and packing see only rows that still
          // satisfy every authoritative admission fence. Aggregation alone
          // completes reranker-selected source sessions here because its
          // chronological window is part of answer-time comparison. Targeted
          // user episodes already entered the single rerank batch above. Every
          // linked item passes the same final authoritative expansion as an
          // ordinary retrieval hit, and completion failure never hides an
          // admitted anchor.
          const [expandedResult, completionResult] = await timings.measure("rejoinMs", () =>
            Promise.all([
              runBoundedMemoryRead(
                deadline,
                MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
                (rejoinSignal) => abortableRead(expandWithSourceFamilyPlans({
                  candidates: rejoinCandidates,
                  navigation: false,
                  plans,
                  repository,
                  snapshot: local.snapshot
                }), rejoinSignal)
              ).then(
                (value) => ({ error: null, value }),
                (error: unknown) => ({
                  error,
                  value: [] as readonly MemoryExpandedCandidate[]
                })
              ),
              aggregationSessionCompletionSourceChatCount > 0
                ? runBoundedMemoryRead(
                    deadline,
                    MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
                    (completionSignal) => abortableRead((async () => {
                        const value = await repository.completeSessionEvidence!(
                          local.snapshot,
                          plan,
                          aggregationSessionCompletionSources
                        );
                      const expansions = await expandWithSourceFamilyPlans({
                        candidates: value.candidates,
                        navigation: false,
                        plans,
                        repository,
                        snapshot: local.snapshot
                      });
                      return { expansions, value };
                    })(), completionSignal)
                  ).then(
                    ({ expansions, value }) => ({ error: null, expansions, value }),
                    (error: unknown) => ({
                      error,
                      expansions: [] as readonly MemoryExpandedCandidate[],
                      value: sessionCompletion
                    })
                  )
                : Promise.resolve({
                    error: null,
                    expansions: [] as readonly MemoryExpandedCandidate[],
                    value: sessionCompletion
                  })
            ]));
          if (expandedResult.error) throw expandedResult.error;
          rejoined = expandedResult.value;
          if (aggregationSessionCompletionSourceChatCount > 0) {
            if (completionResult.error) sessionCompletionState = "UNAVAILABLE";
            else {
              sessionCompletion = completionResult.value;
              sessionCompletionExpansions = completionResult.expansions;
              sessionCompletionState = "READY";
            }
          }
        } catch (error) {
          if (deadline.expired()) {
            return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [
              { result: queryEmbedding, role: "MEMORY_QUERY_EMBED" },
              {
                result: queryResolverState.execution?.result ?? null,
                role: "MEMORY_QUERY_RESOLVE"
              },
              { result: relevance, role: "MEMORY_RERANK" }
            ]);
          }
          expansionFailure ??= classifyMemoryExpansionFailure(error);
        }
      }
      const rejoinedByKey = new Map(rejoined.map((candidate) => [
        `${candidate.itemType}:${candidate.itemId}`,
        candidate
      ]));
      const queryMatchedRelevant = rejoinCandidates.filter((candidate) =>
        rejoinedByKey.has(`${candidate.itemType}:${candidate.itemId}`));
      const sessionCompletionCandidateKeys = new Set(sessionCompletion.candidates.map(
        (candidate) => `${candidate.itemType}:${candidate.itemId}`));
      const mergedRejoin = aggregationSessionCompletionSourceChatCount > 0 &&
        sessionCompletionState === "READY"
        ? mergeMemorySessionEvidenceCompletion(
            queryMatchedRelevant,
            rejoined,
            sessionCompletion,
            sessionCompletionExpansions
          )
        : Object.freeze({
            candidates: queryMatchedRelevant,
            completionCandidateCount: sessionCompletionCandidateCount ||
              queryMatchedRelevant.filter((candidate) =>
              candidate.historyEvidenceView === "USER_TESTIMONY" &&
              sessionCompletionCandidateKeys.has(
                `${candidate.itemType}:${candidate.itemId}`
              )).length,
            expansions: rejoined
          });
      const rejoinedRelevant = mergedRejoin.candidates;
      rejoined = mergedRejoin.expansions;
      sessionCompletionExpansions = rejoined.filter((expansion) =>
        sessionCompletionCandidateKeys.has(`${expansion.itemType}:${expansion.itemId}`));
      const sessionCompletionExpansionKeys = new Set(sessionCompletionExpansions.map(
        (expansion) => `${expansion.itemType}:${expansion.itemId}`));
      const completedSourceChats = new Set(sessionCompletion.candidates.flatMap((candidate) =>
        candidate.metadata.sourceChatId && sessionCompletionExpansionKeys.has(
          `${candidate.itemType}:${candidate.itemId}`
        ) ? [candidate.metadata.sourceChatId] : []));
      const dynamic = applyMemoryDecay(rejoinedRelevant, {
        enabled: input.expected.settings.decayEnabled,
        mode: plan.mode,
        now: input.now,
        policyVersion: input.expected.settings.decayPolicyVersion
      });
      const decayActive = input.expected.settings.decayEnabled &&
        input.expected.settings.decayPolicyVersion === MEMORY_DECAY_POLICY_VERSION;
      const selectedByKey = new Map(dynamic.map((candidate) => [
        `${candidate.itemType}:${candidate.itemId}`,
        candidate
      ]));
      const selectedKeys = new Set(selectedByKey.keys());
      const coreByKey = new Map(eligibleCore.map((entry) => [
        `${entry.candidate.itemType}:${entry.candidate.itemId}`,
        entry
      ]));
      // Disabled/incompatible decay preserves the exact legacy Core order.
      // When enabled, Core items follow the same post-relevance decay order as
      // dynamic facts before their own final budget is applied.
      const orderedCore = decayActive
        ? dynamic.flatMap((candidate) => {
            const entry = coreByKey.get(`${candidate.itemType}:${candidate.itemId}`);
            return entry ? [entry] : [];
          })
        : eligibleCore;
      const selectedCore = orderedCore.flatMap((entry) => {
        const key = `${entry.candidate.itemType}:${entry.candidate.itemId}`;
        const selected = selectedByKey.get(key);
        const expansion = rejoinedByKey.get(key);
        return selected && expansion ? [{
          candidate: {
            ...selected,
            featureSnapshot: selected.featureSnapshot,
            laneRanks: entry.candidate.laneRanks,
            metadata: entry.candidate.metadata,
            selectionReason: entry.candidate.selectionReason
          },
          expansion
        }] : [];
      });
      const selectedCoreKeys = new Set(selectedCore.map(({ candidate }) =>
        `${candidate.itemType}:${candidate.itemId}`));
      const selectedDynamic = dynamic.filter((candidate) =>
        !selectedCoreKeys.has(`${candidate.itemType}:${candidate.itemId}`));
      const dynamicExpanded = rejoined.filter((candidate) =>
        selectedKeys.has(`${candidate.itemType}:${candidate.itemId}`));
      if (expansionFailure) {
        return emptyAttempt(input.expected, "FAILED_SAFE", "memory_expansion_unavailable",
          plan.originalSanitizedQuery, {
            ...actionEvidence,
            candidateCount: relevanceInput.length,
            failureClass: expansionFailure.failureClass,
            failureCode: expansionFailure.failureCode,
            ...relevanceEvidence(relevanceInput, relevance, relevant.length, 0),
            lexicalEvidence: local.lexicalEvidence ?? [],
            lexicalFailures: local.lexicalFailures,
            lexicalState: local.lexicalState,
            plan: planEvidence(plan),
            plannerFallbackReason,
            querySafetyVersion: querySafety.version,
            safetyFindingCounts: querySafety.findingCounts,
            utilityEgressMode: currentControlExternal ||
              utilityUsedExternal(queryEmbedding) ||
              utilityUsedExternal(queryResolverState.execution?.result ?? null) ||
              utilityUsedExternal(relevance)
              ? "CONSENTED_EXTERNAL"
              : "LOCAL_ONLY",
            utilityExecutions: [
              utilityEvidence("MEMORY_CONTROL", controlUtilityResult),
              utilityEvidence("MEMORY_QUERY_EMBED", queryEmbedding),
              utilityEvidence(
                "MEMORY_QUERY_RESOLVE",
                queryResolverState.execution?.result ?? null
              ),
              utilityEvidence("MEMORY_RERANK", relevance)
            ],
            vectorEvidence: local.vectorEvidence,
            vectorState: local.vectorState
          });
      }
      let degradationCode = degradationFor(
        local,
        queryEmbedding,
        dynamicAllowed,
        plan.profileRequested,
        speculativeBaselineUsed || speculativeHybridUsed || broadLexicalFallbackUsed,
        admittedSourceKinds
      );
      const queryScopeDecision = timings.measureSync("packerMs", () => {
        const basePack = packMemoryPersonalContext({
          core: selectedCore,
          expanded: dynamicExpanded,
          maximumTokens: normalizedRequestPersonalContextTokenLimit(input.normalizedRequest),
          plan,
          questionDirectedTemporalFallback: broadPlannerFallback,
          ranked: selectedDynamic
        });
        const resolverAtAttach = finalResolverApplicable
          ? queryResolverState.execution
          : null;
        if (!finalResolverApplicable) {
          return Object.freeze({
            execution: null,
            queryScope: Object.freeze({
              attachedConstraintKindCounts: Object.freeze({}),
              pack: basePack,
              proposedConstraintCount: 0,
              state: "SKIPPED" as const
            })
          });
        }
        if (!resolverAtAttach) {
          const pendingAtAttach = speculativeQueryResolverEligible &&
            !speculativeQueryResolutionSettled;
          if (pendingAtAttach &&
            !speculativeQueryResolverController.signal.aborted) {
            speculativeQueryResolverController.abort({
              code: "memory_query_resolution_not_ready_at_attach"
            });
          }
          return Object.freeze({
            execution: null,
            queryScope: Object.freeze({
              attachedConstraintKindCounts: Object.freeze({}),
              pack: basePack,
              proposedConstraintCount: 0,
              state: pendingAtAttach
                ? "NOT_READY_AT_ATTACH" as const
                : "SKIPPED" as const
            })
          });
        }
        return Object.freeze({
          execution: resolverAtAttach,
          queryScope: applyMemoryQueryScopeResolution({
            expanded: rejoined,
            pack: basePack,
            resolution: resolverAtAttach.result,
            sources: resolverAtAttach.sources
          })
        });
      });
      const queryResolutionExecution = queryScopeDecision.execution;
      const queryResolutionEvidence = queryResolutionExecution?.result ?? null;
      const resolverEvidenceSources = queryResolutionExecution?.sources ?? [];
      const queryScope = queryScopeDecision.queryScope;
      const pack = queryScope.pack;
      const preparedText = pack.text;
      const preparedTokens = pack.approxTokens;
      const utilityExecutions = [
        utilityEvidence("MEMORY_CONTROL", controlUtilityResult),
        utilityEvidence("MEMORY_QUERY_EMBED", queryEmbedding),
        utilityEvidence("MEMORY_QUERY_RESOLVE", queryResolutionEvidence),
        utilityEvidence("MEMORY_RERANK", relevance)
      ];
      const externalUtilityUsed = currentControlExternal ||
        utilityUsedExternal(queryEmbedding) || utilityUsedExternal(queryResolutionEvidence) ||
        utilityUsedExternal(relevance);
      const commonEvidence = {
        ...actionEvidence,
        ...aggregationPlanEvidence(plan.aggregationRequested, pack),
        budgetProfile: pack.budgetProfile,
        candidateCount: pack.candidateCount,
        componentMetrics: memoryRetrievalComponentEvidence({
          broadLexicalFallbackUsed,
          control: controlEvidence,
          digestEvidence: local.digestEvidence ?? {
            digestOnlyChatCount: 0,
            navigationCandidateCount: 0,
            rawAnchorCount: 0,
            rawCandidateCount: 0,
            secondStageQueryCount: 0,
            selectedChatCount: 0
          },
          dynamicFused,
          enabledSourceKinds: [...new Set([
            ...(plans.baseline?.filters.sourceKinds ?? []),
            ...plan.filters.sourceKinds
          ])],
          laneResults: local.laneResults,
          navigationExpanded,
          pack,
          plan,
          plannerFallbackReason,
          sessionCompletionCandidateCount: mergedRejoin.completionCandidateCount,
          sessionCompletionExpandedSourceChatCount: completedSourceChats.size,
          sessionCompletionSelectedSourceChatCount: sessionCompletion.sourceChatCount,
          sessionCompletionState,
          speculativeBaselineUsed,
          speculativeHybridUsed,
          preparedTokens,
          querySafety,
          queryEmbedding,
          relevance,
          relevanceInput,
          relevant,
          rawExpanded: rejoined,
          rejoinedRelevant,
          selectedCore,
          selectedDynamic,
          sourceFamilyEvidence: local.sourceFamilyEvidence ?? {
            baselineFactCandidateCount: 0,
            baselineHistoryCandidateCount: 0,
            baselineOnlyCandidateCount: 0,
            plannerExcludedFamilyRecoveredCount: 0,
            plannerOnlyCandidateCount: 0
          },
          sourceFamilyHardExclusionReasons: plans.hardExclusionReasons,
          utilityExecutions
        }),
        coreCount: selectedCore.length,
        laneCount: local.laneResults.length,
        lexicalEvidence: local.lexicalEvidence ?? [],
        lexicalFailures: local.lexicalFailures,
        lexicalState: local.lexicalState,
        memoryHardDeadlineReached: deadline.expired(),
        omissionCounts: pack.omissionCounts,
        hardCapTokens: pack.hardCapTokens,
        packedTokens: preparedTokens,
        packerVersion: pack.packerVersion,
        plan: planEvidence(plan),
        plannerFallbackReason,
        broadLexicalFallbackUsed,
        speculativeBaselineUsed,
        speculativeHybridUsed,
        providerTokenLimit: pack.providerTokenLimit,
        queryResolverState: queryScope.state,
        queryResolverBroadFallbackAttachment: broadPlannerFallback &&
          queryScope.state === "READY_ATTACHED",
        queryResolverExecutionStrategy: queryResolutionExecution?.strategy ?? "SKIPPED",
        queryResolverSourceCharacterCount: resolverEvidenceSources.reduce(
          (total, source) => total + source.userTexts.reduce(
            (sourceTotal, text) => sourceTotal + text.length,
            0
          ),
          0
        ),
        queryResolverSourceCount: resolverEvidenceSources.length,
        queryScopeAttachedConstraintKindCounts: queryScope.attachedConstraintKindCounts,
        queryScopeProposedConstraintCount: queryScope.proposedConstraintCount,
        querySafetyVersion: querySafety.version,
        ...relevanceEvidence(
          relevanceInput,
          relevance,
          relevant.length,
          rejoinedRelevant.length
        ),
        ...(degradationCode ? { degradationCode } : {}),
        utilityEgressMode: externalUtilityUsed ? "CONSENTED_EXTERNAL" : "LOCAL_ONLY",
        utilityExecutions,
        vectorEvidence: local.vectorEvidence,
        vectorState: local.vectorState,
        targetTokens: pack.targetTokens
      } as const;
      if (!preparedText || pack.items.length === 0) {
        return emptyAttempt(
          input.expected,
          "EMPTY",
          degradationCode ?? "no_relevant_memory",
          plan.originalSanitizedQuery,
          commonEvidence
        );
      }
      const items = attemptItems(pack, selectedCore, selectedDynamic, plan);
      return {
        budgetSnapshot: {
          admissionVersion: MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION,
          ...commonEvidence,
          budgetProfile: pack.budgetProfile,
          hardCapTokens: pack.hardCapTokens,
          itemCount: items.length,
          packedTokens: preparedTokens,
          packerVersion: pack.packerVersion,
          pipelineVersion: MEMORY_RETRIEVAL_PIPELINE_VERSION,
          providerTokenLimit: pack.providerTokenLimit,
          schemaVersion: 2,
          settingsRevision: input.expected.settings.settingsRevision,
          targetTokens: pack.targetTokens
        },
        items,
        ...(degradationCode ? { degradationCode } : {}),
        outcome: degradationCode ? "DEGRADED" : "USED",
        preparedContext: { approxTokens: preparedTokens, text: preparedText },
        querySnapshot: plan.originalSanitizedQuery
      };
      } finally {
        if (!speculativeBaselineController.signal.aborted) {
          speculativeBaselineController.abort({ code: "memory_speculation_cancelled" });
        }
        if (!speculativeDenseController.signal.aborted) {
          speculativeDenseController.abort({ code: "memory_speculation_cancelled" });
        }
        if (!speculativeQueryResolverController.signal.aborted) {
          speculativeQueryResolverController.abort({
            code: "memory_query_resolution_speculation_cancelled"
          });
        }
        await speculativeQueryResolutionPromise.catch(() => null);
        deadline.dispose();
      }
      })();
      return withMemoryPreparationEvidence(result, timings, queryResolverState.execution);
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
      actionExecutor: defaultMemoryIntentActionExecutor,
      control: createPrismaMemoryControlService(authority, client),
      controlRefs: createPrismaMemoryControlRefProvider(client),
      readUtilityPolicy: DEFAULT_MEMORY_READ_UTILITY_POLICY,
      utilities: createPrismaMemoryRunUtilityService(authority, client),
      vectorRepository: createPrismaMemoryVectorRepository(client)
    }
  );
}
