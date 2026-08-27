import type { PrismaClient } from "@prisma/client";
import type { MemoryActionFeedback } from "../../../contracts/memoryClient";
import {
  MEMORY_CONTEXT_HARD_CAP_TOKENS,
  MEMORY_CONTEXT_TARGET_TOKENS,
  MEMORY_DECAY_POLICY_VERSION,
  MEMORY_RETRIEVAL_MAX_AGGREGATION_HISTORY_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_TARGETED_HISTORY_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_TARGETED_RERANK_CANDIDATES,
  MEMORY_RETRIEVAL_SYNTHESIS_AUTHORITY_MULTIPLIER,
  MEMORY_RETRIEVAL_PIPELINE_VERSION,
  MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR,
  applyMemoryDecay,
  fuseMemoryRetrievalCandidates,
  isEligibleMemoryResponsePreferenceCore,
  memoryRetrievalEvidenceRootKey,
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
import {
  createMemoryReadOnlyControlReuseProof,
  createPrismaMemoryControlService,
  memoryControlInputHash,
  type MemoryControlResult,
  type MemoryControlService,
  type MemoryReadOnlyControlReuseProof
} from "../actions/controlRuntime";
import { defaultMemoryIntentActionExecutor } from "../actions/defaultAction";
import type { MemoryIntentActionExecutor } from "../actions/intentExecutor";
import { loadMemoryRunSources } from "../sources/runProjection";
import {
  createPrismaLocalMemoryRetrievalRepository,
  type MemoryLocalRetrievalResult,
  type MemoryLocalRetrievalSnapshot,
  type PrismaLocalMemoryRetrievalRepository
} from "./localRepository";
import {
  createPrismaMemoryRunUtilityService,
  type MemoryRunAggregationResult,
  type MemoryRunQueryEmbeddingResult,
  type MemoryRunRerankResult,
  type MemoryRunUtilityService
} from "./runUtilities";
import {
  applyMemoryAggregationPlan,
  type MemoryAggregationGuide
} from "./aggregation";
import {
  createPrismaMemoryVectorRepository,
  type MemoryVectorRepository
} from "./vector";
import {
  sanitizeMemoryUtilityText,
  type MemorySanitizedUtilityText
} from "./querySafety";

export const MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION =
  "memory-run-retrieval-admission-v13";
export const MEMORY_RETRIEVAL_COMPONENT_METRICS_VERSION =
  "memory-retrieval-component-metrics-v4";

export { MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS } from "../admissionDeadline";

const MEMORY_ADMISSION_DEADLINE_REASON = Object.freeze({
  code: "memory_admission_deadline_exceeded"
});

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
  aggregationConsumedAttemptId?: string;
  admissionDeadlineAtMs?: number;
  control?: MemoryControlResult;
  controlAttemptId?: string;
  controlInputHash?: string;
  controlReuseScopeHash?: string;
  fallbackControlReuseAttemptId?: string;
  fallbackControlReuseProof?: MemoryFallbackControlReuseProof;
  readOnlyControlReuseAttemptId?: string;
  readOnlyControlReuseProof?: MemoryReadOnlyControlReuseProof;
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
  dispose(): void;
  expired(): boolean;
  remainingMs(): number;
  signal: AbortSignal;
}>;

type UtilityEvidence = Readonly<{
  externalCall: boolean;
  reason: string | null;
  role: "MEMORY_AGGREGATE" | "MEMORY_CONTROL" | "MEMORY_QUERY_EMBED" |
    "MEMORY_RERANK";
  state: "READY" | "SKIPPED" | "UNAVAILABLE";
}>;

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

function plannerSemanticQuery(plan: MemoryRetrievalPlan): string {
  return plan.semanticQueryVariants.find(({ kind }) => kind === "PLANNER_REWRITE")?.text ??
    plan.originalSanitizedQuery;
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
  const deadlineAtMs = hasExistingDeadline
    ? options.admissionDeadlineMs === undefined
      ? existingDeadlineAtMs
      : Math.min(existingDeadlineAtMs, requestedDeadlineAtMs)
    : requestedDeadlineAtMs;
  cache.admissionDeadlineAtMs = deadlineAtMs;

  const controller = new AbortController();
  let expired = deadlineAtMs <= nowMs;
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
    ? setTimeout(expire, deadlineAtMs - nowMs)
    : null;
  if (expired) expire();

  return Object.freeze({
    dispose() {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", forwardParentAbort);
    },
    expired: () => expired,
    remainingMs: () => Math.max(0, deadlineAtMs - clock()),
    signal: controller.signal
  });
}

type OptionalMemoryUtilityRole = "CONTROL" | "QUERY_EMBED" | "RERANK" | "AGGREGATE";

const optionalUtilityBudget = Object.freeze({
  AGGREGATE: { maximumMs: 8_000, remainingFraction: 0.5 },
  CONTROL: { maximumMs: 15_000, remainingFraction: 0.5 },
  QUERY_EMBED: { maximumMs: 8_000, remainingFraction: 0.35 },
  RERANK: { maximumMs: 8_000, remainingFraction: 0.5 }
} satisfies Record<OptionalMemoryUtilityRole, Readonly<{
  maximumMs: number;
  remainingFraction: number;
}>>);

async function runOptionalMemoryUtility<T>(
  deadline: MemoryAdmissionDeadline,
  role: OptionalMemoryUtilityRole,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const budget = optionalUtilityBudget[role];
  const timeoutMs = Math.max(1, Math.min(
    budget.maximumMs,
    Math.floor(deadline.remainingMs() * budget.remainingFraction)
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
        finalScore: candidate.finalScore,
        lastConfirmedAt: packed.lastConfirmedAt,
        observedAt: packed.observedAt,
        projectionKind: packed.projectionKind,
        retrievalReason: packed.retrievalReason,
        rrfScore: candidate.rrfScore,
        sourceAuthority: packed.sourceAuthority,
        sourceSessionHandle: packed.sourceSessionHandle,
        speakerScope: packed.speakerScope,
        status: packed.status,
        supportingItemId: packed.supportingItemId,
        temporalReason: packed.temporalReason,
        historical: candidate.metadata.historical,
        includePatterns: plan.includePatterns,
        lifecycleState: candidate.metadata.lifecycleState,
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
    return packed.itemType === "FACT_VERSION"
      ? { ...base, factVersionId: packed.itemId, itemType: "FACT_VERSION" }
      : { ...base, itemType: "RECALL_CHUNK", recallChunkId: packed.itemId };
  });
}

function memoryAggregationEvidence(
  pack: MemoryContextPack,
  core: readonly MemoryCoreCandidate[],
  dynamic: readonly MemoryRankedCandidate[],
  expanded: readonly MemoryExpandedCandidate[]
): Parameters<MemoryRunUtilityService["aggregate"]>[0]["evidence"] {
  const candidates = candidateMap(core, dynamic);
  const expansions = new Map(expanded.map((entry) => [
    `${entry.itemType}:${entry.itemId}`,
    entry
  ]));
  return pack.items.map((item, index) => {
    const key = `${item.itemType}:${item.itemId}`;
    const candidate = candidates.get(key);
    const expansion = expansions.get(key);
    if (!candidate || !expansion) {
      throw new Error("memory_aggregation_evidence_identity_invalid");
    }
    const occurredFrom = expansion.occurredFrom ?? candidate.metadata.occurredAt ??
      candidate.metadata.validFrom ?? candidate.metadata.observedAt ??
      candidate.metadata.systemFrom;
    const occurredTo = expansion.occurredTo ?? candidate.metadata.validTo;
    return {
      handle: `i${index}`,
      occurredFrom: occurredFrom?.toISOString() ?? null,
      occurredTo: occurredTo?.toISOString() ?? null,
      sourceKind: item.itemType === "RECALL_CHUNK"
        ? "HISTORY" as const
        : candidate.metadata.modality === "EVENT" ? "EVENT" as const : "FACT" as const,
      text: item.exactSafeText
    };
  });
}

function planEvidence(plan: MemoryRetrievalPlan): Readonly<Record<string, unknown>> {
  return {
    aggregationRequested: plan.aggregationRequested,
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
  result: MemoryControlResult | MemoryRunAggregationResult |
    MemoryRunQueryEmbeddingResult | MemoryRunRerankResult | null
): UtilityEvidence {
  if (!result) return { externalCall: false, reason: null, role, state: "SKIPPED" };
  return result.status === "READY"
    ? { externalCall: utilityUsedExternal(result), reason: null, role, state: "READY" }
    : {
        externalCall: utilityUsedExternal(result),
        reason: result.reason,
        role,
        state: "UNAVAILABLE"
      };
}

function incrementCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
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
  control: MemoryControlResult;
  dynamicFused: readonly MemoryRankedCandidate[];
  expanded: readonly MemoryExpandedCandidate[];
  laneResults: MemoryLocalRetrievalResult["laneResults"];
  pack: MemoryContextPack;
  plan: MemoryRetrievalPlan;
  plannerFallbackReason: string | null;
  preparedTokens: number;
  querySafety: MemorySanitizedUtilityText;
  queryEmbedding: MemoryRunQueryEmbeddingResult | null;
  relevance: MemoryRunRerankResult | null;
  relevanceInput: readonly MemoryRelevanceCandidate[];
  relevant: readonly MemoryRankedCandidate[];
  rejoinedRelevant: readonly MemoryRankedCandidate[];
  selectedCore: readonly MemoryCoreCandidate[];
  selectedDynamic: readonly MemoryRankedCandidate[];
  utilityExecutions: readonly UtilityEvidence[];
}>): Readonly<Record<string, unknown>> {
  const candidateCountsByLane: Record<string, number> = {};
  const beforeFusionRoots = new Set<string>();
  for (const result of input.laneResults) {
    candidateCountsByLane[result.lane] = result.candidates.length;
    for (const candidate of result.candidates) {
      beforeFusionRoots.add(memoryRetrievalEvidenceRootKey(candidate));
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
  const utilityCallCounts: Record<string, number> = {};
  const utilityFailureReasonCounts: Record<string, number> = {};
  for (const utility of input.utilityExecutions) {
    if (utility.externalCall) incrementCount(utilityCallCounts, utility.role);
    if (utility.state === "UNAVAILABLE" && utility.reason) {
      incrementCount(utilityFailureReasonCounts, utility.reason);
    }
  }
  const digestHits = (candidateCountsByLane.HISTORY_DIGEST_FTS_SIMPLE ?? 0) +
    input.expanded.filter((candidate) =>
      candidate.projectionKind === "CHAT_DIGEST_SAFE_TEXT").length;
  const rawChunkExpansions = input.expanded.filter((candidate) =>
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
  return Object.freeze({
    candidateCountsByLane,
    candidatesRetainedAfterReranker: input.relevant.length,
    candidatesRetainedAfterRejoin: input.rejoinedRelevant.length,
    candidatesSentToReranker: input.relevanceInput.length,
    digestHits,
    embeddingBatchSizeDistribution: utilityCallCounts.MEMORY_QUERY_EMBED
      ? { "1": utilityCallCounts.MEMORY_QUERY_EMBED }
      : {},
    packedEvidenceItems: input.pack.items.length,
    packedEvidenceTokens: input.preparedTokens,
    plannerFallbackUsed: input.plannerFallbackReason !== null,
    queryVariantCounts: queryVariantCounts(input.plan),
    rawChunkExpansions,
    rawRoundExpansions: 0,
    rerankerFallbackUsed: input.relevanceInput.length > 0 &&
      (input.relevance?.status === "READY"
        ? input.relevanceInput.some(({ handle }) => !rerankerDecisionHandles.has(handle))
        : true),
    safetyFindingCounts: input.querySafety.findingCounts,
    safetyMetricsState: "QUERY_REDACTION_ACTIVE",
    selectedSourceChats: selectedSourceChats.size,
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
          category: candidate.candidate.metadata.category,
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
  result: MemoryRunAggregationResult | null,
  guide: MemoryAggregationGuide | null
): Readonly<Record<string, unknown>> {
  if (!result) return { aggregationState: "SKIPPED" };
  if (result.status !== "READY") {
    return {
      aggregationReason: result.reason,
      aggregationState: "UNAVAILABLE"
    };
  }
  const groupCounts: Record<string, number> = {};
  for (const group of result.plan.groups) {
    groupCounts[group.role] = (groupCounts[group.role] ?? 0) + 1;
  }
  return {
    aggregationBoundaryCount: guide?.boundaryCount ?? 0,
    aggregationGroupCounts: groupCounts,
    aggregationGuideFormat: guide?.format ?? null,
    aggregationMemberCount: guide?.memberCount ?? 0,
    aggregationOperation: result.plan.operation,
    aggregationResolution: result.plan.resolution,
    aggregationState: "READY"
  };
}

function utilityUsedExternal(
  result: MemoryControlResult | MemoryRunAggregationResult |
    MemoryRunQueryEmbeddingResult | MemoryRunRerankResult | null
): boolean {
  return Boolean(result && "bindingId" in result && result.bindingId);
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
    result: MemoryRunAggregationResult | MemoryRunQueryEmbeddingResult |
      MemoryRunRerankResult | null;
    role: "MEMORY_AGGREGATE" | "MEMORY_QUERY_EMBED" | "MEMORY_RERANK";
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
    result: MemoryRunAggregationResult | MemoryRunQueryEmbeddingResult |
      MemoryRunRerankResult | null;
    role: "MEMORY_AGGREGATE" | "MEMORY_QUERY_EMBED" | "MEMORY_RERANK";
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
  authorityLevel: "LEARNED" | "PAST_CHAT" | "SAVED";
  candidate: MemoryRankedCandidate;
  current: boolean;
  directness: "DIRECT" | "INFERRED" | "PARAPHRASED" | null;
  handle: string;
  historical: boolean;
  lifecycleState: "ACTIVE" | "SUPERSEDED" | null;
  occurredFrom: string | null;
  occurredTo: string | null;
  sensitivityClass: "NORMAL";
  speakerScope: "assistant" | "memory_record" | "mixed_conversation" | "user";
  sourceKind: "EVENT" | "FACT" | "HISTORY";
  temporalReason: "any" | "as_of" | "between" | "current" | "historical";
  text: string;
}>;

function relevanceSpeakerScope(
  sourceKind: MemoryRelevanceCandidate["sourceKind"],
  text: string
): MemoryRelevanceCandidate["speakerScope"] {
  if (sourceKind !== "HISTORY") return "memory_record";
  const user = /(?:^|\n)User:\s/u.test(text);
  const assistant = /(?:^|\n)Assistant:\s/u.test(text);
  if (user && !assistant) return "user";
  if (assistant && !user) return "assistant";
  return "mixed_conversation";
}

function sourceDiversityOrder(
  candidates: readonly MemoryRelevanceCandidate[]
): readonly MemoryRelevanceCandidate[] {
  type SourceGroup = {
    candidates: MemoryRelevanceCandidate[];
    firstIndex: number;
    sourceChatId: string;
  };
  const groups = new Map<string, SourceGroup>();
  candidates.forEach((candidate, index) => {
    if (candidate.sourceKind !== "HISTORY") return;
    const sourceChatId = candidate.candidate.metadata.sourceChatId ??
      `missing-source:${candidate.candidate.itemId}`;
    const group = groups.get(sourceChatId);
    if (group) group.candidates.push(candidate);
    else groups.set(sourceChatId, { candidates: [candidate], firstIndex: index, sourceChatId });
  });
  const selectedGroups = [...groups.values()].sort((left, right) => {
    const score = (group: SourceGroup): number => {
      const top = group.candidates.slice(0, 3)
        .map(({ candidate }) => candidate.finalScore);
      const best = Math.max(...top);
      const average = top.reduce((sum, value) => sum + value, 0) / top.length;
      return best + average * 0.1;
    };
    return score(right) - score(left) ||
      left.firstIndex - right.firstIndex ||
      left.sourceChatId.localeCompare(right.sourceChatId);
  });

  // Session relevance is estimated from its strongest chunk plus a small
  // breadth signal. Give every source one semantic-review slot, then fill the
  // remaining bounded pool by the original global rank. This is a soft order:
  // no source is excluded and there is no per-source quota.
  const firstCandidates = selectedGroups.map(({ candidates: entries }) => entries[0]!);
  const firstKeys = new Set(firstCandidates.map(({ candidate }) =>
    `${candidate.itemType}:${candidate.itemId}`));
  const repeats = candidates.filter((candidate) => {
    if (candidate.sourceKind !== "HISTORY") return false;
    const key = `${candidate.candidate.itemType}:${candidate.candidate.itemId}`;
    return !firstKeys.has(key);
  });
  const history = [...firstCandidates, ...repeats];
  let historyIndex = 0;
  return candidates.map((candidate) => candidate.sourceKind === "HISTORY"
    ? history[historyIndex++]!
    : candidate);
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
    const sourceKind = candidate.itemType === "RECALL_CHUNK"
      ? "HISTORY" as const
      : candidate.metadata.modality === "EVENT" ? "EVENT" as const : "FACT" as const;
    return [{
      authorityLevel: candidate.itemType === "RECALL_CHUNK"
        ? "PAST_CHAT" as const
        : candidate.metadata.sourceMode === "EXPLICIT" ? "SAVED" as const : "LEARNED" as const,
      candidate,
      current: candidate.metadata.current,
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
      temporalReason: (options.temporalIntent ?? "CURRENT").toLocaleLowerCase("und") as
        MemoryRelevanceCandidate["temporalReason"],
      text: projection.safeText
    }];
  });
  const ordered = sourceDiversityOrder(projected);
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

export function applyMemoryRelevance(
  candidates: readonly MemoryRelevanceCandidate[],
  result: MemoryRunRerankResult | null,
  _plan?: MemoryRetrievalPlan
): readonly MemoryRankedCandidate[] {
  if (!result || result.status !== "READY") {
    return candidates.map((entry) => ({
      ...entry.candidate,
      selectionReason: `${entry.candidate.selectionReason}+rerank_fallback_rrf`
    }));
  }
  const byHandle = new Map(candidates.map((entry) => [entry.handle, entry]));
  const decisionByHandle = new Map(result.decisions.flatMap((decision) =>
    byHandle.has(decision.handle) ? [[decision.handle, decision] as const] : []));
  const originalOrder = new Map(candidates.map((entry, index) => [
    `${entry.candidate.itemType}:${entry.candidate.itemId}`,
    index
  ]));
  return candidates.map((entry) => {
    const candidate = entry.candidate;
    const decision = decisionByHandle.get(entry.handle);
    if (!decision) {
      return {
        ...candidate,
        selectionReason: `${candidate.selectionReason}+rerank_partial_rrf`
      };
    }
    const matches = candidate.featureSnapshot.deterministicMatches ?? [];
    const deterministicBonus = matches.includes("EXACT_TEXT")
      ? 0.05
      : matches.includes("EXACT_ALIAS_SINGLE_ROOT") || matches.includes("PROFILE")
        ? 0.025
        : candidate.metadata.current && candidate.metadata.sourceMode === "EXPLICIT"
          ? 0.01
          : 0;
    const authorityMultiplier = candidate.metadata.sourceAuthority === "SYNTHESIS"
      ? MEMORY_RETRIEVAL_SYNTHESIS_AUTHORITY_MULTIPLIER
      : 1;
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

function degradationFor(
  result: MemoryLocalRetrievalResult,
  queryEmbedding: MemoryRunQueryEmbeddingResult | null,
  relevance: MemoryRunRerankResult | null,
  hadCandidates: boolean,
  dynamicAllowed = true,
  profileRequested = false
): string | null {
  if (hadCandidates && relevance?.status === "UNAVAILABLE") {
    return "memory_relevance_unavailable";
  }
  if (!dynamicAllowed) return null;
  if (result.lexicalState === "FAILED" || result.lexicalState === "DEGRADED") {
    const families = new Set(result.lexicalFailures.map((lane) =>
      lane === "FACT_ENTITY" ? "entity" :
        lane.includes("_FTS_") || lane.endsWith("_TRIGRAM") ? "fts"
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
      if (input.expected.chatMemoryMode === "TEMPORARY") {
        return emptyAttempt(input.expected, "DISABLED", "temporary_chat");
      }
      const controlCache = input.controlCache ?? {};
      const deadline = createMemoryAdmissionDeadline(
        controlCache,
        input.signal,
        options
      );
      try {
      const signal = deadline.signal;
      if (deadline.expired()) {
        return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId);
      }
      const currentUserText = exactCurrentUserText(input.normalizedRequest);
      const querySafety = sanitizeMemoryUtilityText(currentUserText);
      const provisionalPlan = planMemoryRetrieval({
        currentUserText: querySafety.safeText,
        now: input.now,
        timeZone: acceptedMemoryTimeZone(input.normalizedRequest)
      });
      if (!provisionalPlan.queryPresent) {
        return emptyAttempt(input.expected, "FAILED_SAFE", "memory_plan_query_missing", null, {
          memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
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
      const cachedControl = controlCache.control;
      const cachedActionResult = controlCache.actionResolved
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
        utilityEgressMode:
          readOnlyControlReuse && cachedControl &&
          utilityUsedExternal(cachedControl)
            ? "CONSENTED_EXTERNAL" as const
            : "LOCAL_ONLY" as const
      };

      let snapshot: MemoryLocalRetrievalSnapshot;
      try {
        snapshot = await abortableRead(repository.snapshot({
          assistantId: input.expected.assistantId,
          chatId: input.chatId,
          now: input.now,
          plan: provisionalPlan,
          userId: input.userId
        }), signal);
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
      const controlRefs = options.controlRefs
        ? await abortableRead(options.controlRefs.load({
            assistantMessageIds: recentAssistantMessageIds(input.normalizedRequest),
            chatId: input.chatId,
            userId: input.userId
          }), signal).catch(() => [])
        : [];
      if (deadline.expired()) {
        return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId);
      }
      const controlContext = memoryControlContext(
        input,
        provisionalPlan.originalSanitizedQuery,
        controlRefs
      );
      const control = controlCache.control ?? (options.control
        ? await runOptionalMemoryUtility(deadline, "CONTROL", (utilitySignal) =>
            options.control!.decide({
              attemptId: input.attemptId,
              context: controlContext,
              signal: utilitySignal,
              userId: input.userId
            }))
          .catch(() => ({ reason: "memory_action_intent_unavailable", status: "UNAVAILABLE" as const }))
        : { reason: "memory_action_intent_unavailable", status: "UNAVAILABLE" as const });
      if (controlCache.control === undefined) {
        controlCache.control = control;
        controlCache.controlAttemptId = input.attemptId;
        controlCache.controlInputHash = memoryControlInputHash(controlContext);
        controlCache.controlReuseScopeHash = controlReuseScopeHash;
      }
      if (deadline.expired()) {
        return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId);
      }
      if (controlCache.actionResolved !== true) {
        let resolvedAction: MemoryActionFeedback | null = null;
        if (control.status === "READY" && options.actionExecutor &&
          control.intent.action !== "NONE") {
          try {
            resolvedAction = await options.actionExecutor.execute({
              admissionDeadlineAtMs: controlCache.admissionDeadlineAtMs!,
              bindingId: control.bindingId,
              chatId: input.chatId,
              currentUserText,
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
      const actionResult = controlCache.actionResult ?? null;
      if (deadline.expired()) {
        return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId);
      }
      const answerResult = memoryActionAnswerResult(control, actionResult);
      const controlEvidence = controlForAttemptEvidence(control, fallbackControlReuse)!;
      const currentControlExternal = utilityUsedExternal(control) &&
        (controlCache.controlAttemptId === input.attemptId || readOnlyControlReuse !== null);
      const actionEvidence = {
        ...(answerResult ? { memoryActionAnswerResult: answerResult } : {}),
        ...(actionResult ? { memoryActionResult: actionResult } : {}),
        ...(readOnlyControlReuse ? { readOnlyControlReuse } : {}),
        ...(fallbackControlReuse ? { fallbackControlReuse } : {}),
        utilityEgressMode: currentControlExternal
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
          utilityExecutions: [utilityEvidence("MEMORY_CONTROL", controlEvidence)]
        });
      }

      let plan = deterministicBaseReadPlan(input, provisionalPlan.originalSanitizedQuery);
      let plannerFallbackReason: string | null = null;
      let plannerDegradationCode: string | null = null;
      if (control.status !== "READY") {
        plannerFallbackReason = control.reason;
        plannerDegradationCode = control.reason;
      } else if (!controlRetrievalRequested) {
        plannerFallbackReason = "memory_control_read_not_requested";
      } else if (!control.intent.queryText) {
        plannerFallbackReason = "memory_plan_query_missing";
        plannerDegradationCode = "memory_plan_query_missing";
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
            includePatterns: control.intent.includePatterns,
            mode: control.intent.retrievalMode,
            now: input.now,
            profileRequested: control.intent.profileRequested,
            recencyRequested: control.intent.recencyRequested,
            semanticRewrite: rewriteSafety.safeText,
            temporalIntent: control.intent.temporalIntent,
            timeZone: acceptedMemoryTimeZone(input.normalizedRequest)
          });
        } catch {
          plannerFallbackReason = "memory_plan_invalid";
          plannerDegradationCode = "memory_plan_invalid";
        }
      }
      const factsRequested = input.expected.settings.useMemoryFacts &&
        (plan.filters.sourceKinds.includes("FACT") ||
          plan.filters.sourceKinds.includes("EVENT"));
      const historyRequested = input.expected.settings.referenceChatHistory &&
        plan.filters.sourceKinds.includes("HISTORY");
      const preferencesRequested = input.expected.settings.useMemoryFacts &&
        plan.applyResponsePreferences;

      let queryEmbedding: MemoryRunQueryEmbeddingResult | null = null;
      if (!plan.profileRequested && plan.queryPresent && snapshot.indexMode === "HYBRID") {
        if (options.utilities && options.vectorRepository) {
          const profile = await abortableRead(
            options.vectorRepository.resolveActiveProfile(input.userId),
            signal
          )
            .catch(() => ({ reason: "memory_vector_unavailable" as const,
              status: "DEGRADED" as const }));
          if (deadline.expired()) {
            return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId);
          }
          if (profile.status === "READY" && profile.profile.generationId === snapshot.activeGenerationId) {
            queryEmbedding = await runOptionalMemoryUtility(
              deadline,
              "QUERY_EMBED",
              (utilitySignal) => options.utilities!.embedQuery({
                attemptId: input.attemptId,
                profile: profile.profile,
                query: plannerSemanticQuery(plan),
                signal: utilitySignal,
                userId: input.userId
              })
            ).catch(() => ({ reason: "memory_query_embedding_unavailable",
              status: "UNAVAILABLE" as const }));
            if (deadline.expired()) {
              return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [{
                result: queryEmbedding,
                role: "MEMORY_QUERY_EMBED"
              }]);
            }
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
        local = await abortableRead(repository.retrieve({
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
        }), signal);
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
              utilityEvidence("MEMORY_CONTROL", controlEvidence),
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
      let expanded: readonly MemoryExpandedCandidate[] = [];
      let expansionFailed = false;
      if (dynamicFused.length > 0) {
        try {
          dynamicCandidates = plan.aggregationRequested && plan.mode === "PAST_CHAT_SEARCH"
            ? await abortableRead(
                repository.projectAggregationSessions(local.snapshot, plan, dynamicFused),
                signal
              )
            : dynamicFused;
          if (dynamicCandidates.length > 0) {
            expanded = await abortableRead(
              repository.expand(local.snapshot, plan, dynamicCandidates),
              signal
            );
          }
        } catch {
          if (deadline.expired()) {
            return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [{
              result: queryEmbedding,
              role: "MEMORY_QUERY_EMBED"
            }]);
          }
          expansionFailed = true;
        }
      }
      // The exact direct query was locally redacted before control. Every
      // later utility receives that same safe original or a sanitized rewrite.
      const eligibleCore = preferencesRequested
        ? local.core.filter(isEligibleMemoryResponsePreferenceCore)
        : [];
      const relevanceInput = memoryRelevanceCandidates(
        [...eligibleCore.map(({ candidate }) => candidate), ...dynamicCandidates],
        [...eligibleCore.map(({ expansion }) => expansion), ...expanded],
        {
          aggregationRequested: plan.aggregationRequested,
          recencyRequested: plan.recencyRequested,
          temporalIntent: plan.temporalIntent
        }
      );
      let relevance: MemoryRunRerankResult | null = null;
      if (relevanceInput.length > 0) {
        if (controlCache.rerankConsumedAttemptId === input.attemptId) {
          relevance = {
            reason: "memory_relevance_retry_budget_exhausted",
            status: "UNAVAILABLE"
          };
        } else if (options.utilities) {
          // The outer preparing state machine owns at most two distinct
          // retrieval attempts. A retry gets a new durable attempt owner, so
          // its read-only rerank may execute once again without replaying an
          // action or colliding with the first attempt's governed bindings.
          controlCache.rerankConsumedAttemptId = input.attemptId;
          relevance = await runOptionalMemoryUtility(
            deadline,
            "RERANK",
            (utilitySignal) => options.utilities!.rerank({
                attemptId: input.attemptId,
                aggregationRequested: plan.aggregationRequested,
                candidates: relevanceInput.map(({ candidate: _candidate, ...candidate }) => candidate),
                profileRequested: plan.profileRequested,
                query: plan.originalSanitizedQuery,
                retrievalMode: plan.mode,
                signal: utilitySignal,
                temporalIntent: plan.temporalIntent,
                userId: input.userId
              })
          ).catch(() => ({ reason: "memory_relevance_unavailable",
            status: "UNAVAILABLE" as const }));
          if (deadline.expired()) {
            return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [
              { result: queryEmbedding, role: "MEMORY_QUERY_EMBED" },
              { result: relevance, role: "MEMORY_RERANK" }
            ]);
          }
        } else {
          relevance = { reason: "memory_relevance_unavailable", status: "UNAVAILABLE" };
        }
      }
      const relevant = applyMemoryRelevance(relevanceInput, relevance, plan);
      let rejoined: readonly MemoryExpandedCandidate[] = [];
      if (relevant.length > 0) {
        try {
          // The reranker operates on the first safe expansion. Reload its
          // bounded accepted set so decay and packing see only rows that still
          // satisfy every authoritative admission fence.
          rejoined = await abortableRead(
            repository.expand(local.snapshot, plan, relevant),
            signal
          );
        } catch {
          if (deadline.expired()) {
            return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [
              { result: queryEmbedding, role: "MEMORY_QUERY_EMBED" },
              { result: relevance, role: "MEMORY_RERANK" }
            ]);
          }
          expansionFailed = true;
        }
      }
      const rejoinedByKey = new Map(rejoined.map((candidate) => [
        `${candidate.itemType}:${candidate.itemId}`,
        candidate
      ]));
      const rejoinedRelevant = relevant.filter((candidate) =>
        rejoinedByKey.has(`${candidate.itemType}:${candidate.itemId}`));
      const dynamic = applyMemoryDecay(rejoinedRelevant, {
        enabled: input.expected.settings.decayEnabled,
        mode: plan.mode,
        now: input.now,
        policyVersion: input.expected.settings.decayPolicyVersion
      });
      if (deadline.expired()) {
        return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [
          { result: queryEmbedding, role: "MEMORY_QUERY_EMBED" },
          { result: relevance, role: "MEMORY_RERANK" }
        ]);
      }
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
      if (expansionFailed) {
        return emptyAttempt(input.expected, "FAILED_SAFE", "memory_expansion_unavailable",
          plan.originalSanitizedQuery, {
            ...actionEvidence,
            candidateCount: relevanceInput.length,
            ...relevanceEvidence(relevanceInput, relevance, relevant.length, 0),
            lexicalFailures: local.lexicalFailures,
            lexicalState: local.lexicalState,
            plan: planEvidence(plan),
            plannerFallbackReason,
            querySafetyVersion: querySafety.version,
            safetyFindingCounts: querySafety.findingCounts,
            utilityEgressMode: currentControlExternal ||
              utilityUsedExternal(queryEmbedding) || utilityUsedExternal(relevance)
              ? "CONSENTED_EXTERNAL"
              : "LOCAL_ONLY",
            utilityExecutions: [
              utilityEvidence("MEMORY_CONTROL", controlEvidence),
              utilityEvidence("MEMORY_QUERY_EMBED", queryEmbedding),
              utilityEvidence("MEMORY_RERANK", relevance)
            ],
            vectorEvidence: local.vectorEvidence,
            vectorState: local.vectorState
          });
      }
      let degradationCode = plannerDegradationCode ?? degradationFor(
        local,
        queryEmbedding,
        relevance,
        relevanceInput.length > 0,
        dynamicAllowed,
        plan.profileRequested
      );
      const pack = packMemoryPersonalContext({
        core: selectedCore,
        expanded: dynamicExpanded,
        maximumTokens: normalizedRequestPersonalContextTokenLimit(input.normalizedRequest),
        plan,
        ranked: selectedDynamic
      });
      let aggregation: MemoryRunAggregationResult | null = null;
      let aggregationGuide: MemoryAggregationGuide | null = null;
      let preparedText = pack.text;
      let preparedTokens = pack.approxTokens;
      if (plan.aggregationRequested && pack.text && pack.items.length > 0) {
        if (controlCache.aggregationConsumedAttemptId === input.attemptId) {
          aggregation = {
            reason: "memory_aggregation_retry_budget_exhausted",
            status: "UNAVAILABLE"
          };
        } else if (options.utilities) {
          controlCache.aggregationConsumedAttemptId = input.attemptId;
          aggregation = await runOptionalMemoryUtility(
            deadline,
            "AGGREGATE",
            (utilitySignal) => options.utilities!.aggregate({
              attemptId: input.attemptId,
              evidence: memoryAggregationEvidence(
                pack,
                selectedCore,
                selectedDynamic,
                rejoined
              ),
              query: plan.originalSanitizedQuery,
              signal: utilitySignal,
              userId: input.userId
            })
          ).catch(() => ({
            reason: "memory_aggregation_unavailable",
            status: "UNAVAILABLE" as const
          }));
          if (deadline.expired()) {
            return admissionDeadlineAttempt(input.expected, controlCache, input.attemptId, [
              { result: queryEmbedding, role: "MEMORY_QUERY_EMBED" },
              { result: relevance, role: "MEMORY_RERANK" },
              { result: aggregation, role: "MEMORY_AGGREGATE" }
            ]);
          }
        } else {
          aggregation = {
            reason: "memory_aggregation_unavailable",
            status: "UNAVAILABLE"
          };
        }
        if (aggregation.status === "READY") {
          try {
            aggregationGuide = applyMemoryAggregationPlan(pack, aggregation.plan);
            preparedText = aggregationGuide.text;
            preparedTokens = aggregationGuide.tokens;
          } catch {
            aggregation = {
              bindingId: aggregation.bindingId,
              reason: "memory_aggregation_context_invalid",
              status: "UNAVAILABLE"
            };
          }
        }
        if (aggregation.status !== "READY") {
          degradationCode ??= "memory_aggregation_unavailable";
        } else if (aggregation.plan.resolution !== "RESOLVED") {
          degradationCode ??= "memory_aggregation_unresolved";
        }
      }
      const utilityExecutions = [
        utilityEvidence("MEMORY_CONTROL", controlEvidence),
        utilityEvidence("MEMORY_QUERY_EMBED", queryEmbedding),
        utilityEvidence("MEMORY_RERANK", relevance),
        ...(plan.aggregationRequested
          ? [utilityEvidence("MEMORY_AGGREGATE", aggregation)]
          : [])
      ];
      const externalUtilityUsed = currentControlExternal ||
        utilityUsedExternal(queryEmbedding) || utilityUsedExternal(relevance) ||
        utilityUsedExternal(aggregation);
      const commonEvidence = {
        ...actionEvidence,
        ...aggregationPlanEvidence(aggregation, aggregationGuide),
        budgetProfile: pack.budgetProfile,
        candidateCount: pack.candidateCount,
        componentMetrics: memoryRetrievalComponentEvidence({
          control: controlEvidence,
          dynamicFused,
          expanded,
          laneResults: local.laneResults,
          pack,
          plan,
          plannerFallbackReason,
          preparedTokens,
          querySafety,
          queryEmbedding,
          relevance,
          relevanceInput,
          relevant,
          rejoinedRelevant,
          selectedCore,
          selectedDynamic,
          utilityExecutions
        }),
        coreCount: selectedCore.length,
        laneCount: local.laneResults.length,
        lexicalFailures: local.lexicalFailures,
        lexicalState: local.lexicalState,
        omissionCounts: pack.omissionCounts,
        hardCapTokens: pack.hardCapTokens,
        packedTokens: preparedTokens,
        packerVersion: pack.packerVersion,
        plan: planEvidence(plan),
        plannerFallbackReason,
        providerTokenLimit: pack.providerTokenLimit,
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
        deadline.dispose();
      }
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
      utilities: createPrismaMemoryRunUtilityService(authority, client),
      vectorRepository: createPrismaMemoryVectorRepository(client)
    }
  );
}
