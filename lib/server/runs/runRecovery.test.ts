import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { McpClientSessionError } from "../mcp/clientSession";
import { MCP_FIND_TOOLS_NAME } from "../mcp/discovery";
import type {
  NormalizedRunRequest,
  ProviderAdapter,
  ProviderRunRefreshResult,
  ProviderRunRequest,
  ProviderRunResult,
  ProviderSearchAdapter,
  ProviderSearchRequest
} from "../providers/types";
import { ProviderStreamTooLargeError } from "../providers/streamSafety";
import { PERSONAL_CONTEXT_HEADING } from "../providers/personalContext";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import type {
  FocusedKnowledgeRecoveryScope,
  PersistedRunUsageAttribution,
  RunControlRecord,
  RunUsageAttribution,
  StaleRunControlRecord
} from "./runRepositoryContract";
import {
  toolLoopCheckpoint,
  toolLoopPersistenceLimits,
  upsertAnswerRoundUsage,
  type CheckpointedToolLoopRun,
  type PersistedAnswerRoundUsage,
  type PersistedToolLoopCall,
  type ProjectRunRecoveryAuthority,
  type ToolLoopCheckpoint,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import {
  parsePersistedToolExecutionResult,
  snapshotToolExecutionResult
} from "./toolExecutionPersistence";
import {
  SEARCH_TOOL_RESULT_VERSION,
  searchToolResultContent,
  type SearchExecutionEvidence
} from "../search/toolResult";
import { createKnowledgeFocusedRequest } from "../knowledge/focusedRequest";
import {
  FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID,
  focusedKnowledgeCallArguments
} from "../knowledge/automaticEvidence";
import type {
  KnowledgeRunAdmissionExclusion,
  KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../knowledge/knowledgeBudget";
import { DEFAULT_KNOWLEDGE_ANSWER_POLICY } from "../knowledge/answerPolicy";
import { knowledgeRetrievalTool } from "../knowledge/knowledgeTools";
import {
  KNOWLEDGE_FOCUSED_OPERATION_NAME,
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  type KnowledgeRetrievalEvidence
} from "../knowledge/retrievalTypes";
import { knowledgeToolResultContent, knowledgeToolResultText } from "../knowledge/toolResult";
import type { ToolExecutionResult } from "../tools/types";
import {
  packKnowledgeEvidenceDispatchManifest,
  type KnowledgeEvidenceDispatchManifestDraft
} from "../knowledge/evidenceDispatchManifest";
import type { StoredKnowledgeEvidenceDispatch } from "../knowledge/evidenceDispatchRepository";
import {
  KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
  KNOWLEDGE_INSUFFICIENT_MESSAGE
} from "../knowledge/answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
  KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
  createKnowledgeAnswerOperationRequestSnapshotV21,
  knowledgeAnswerDraftPromptV21
} from "../knowledge/answerGroundingV21";
import type {
  KnowledgeProviderDispatchLifecycle,
  KnowledgeProviderDispatchRecovery,
  PreparedKnowledgeProviderDispatch
} from "../knowledge/providerDispatchLifecycle";
import type { MemoryToolEgressReceiptService } from "../memory/egress/receipts";
import {
  activeRunStaleMs,
  reconcileInstallationRuns,
  reconcileStaleRuns,
  refreshProviderRunIfNeeded,
  sweepBootOrphanedRunsOnce,
  type RunRecoveryDeps,
  type RunRecoveryRegistry,
  type RunRecoveryRepository
} from "./runRecovery";
import { resetBootOrphanSweepForTest } from "@/tests/support/runExecution";

const userId = "user-1";
const runId = "run-1";

const providerEvent = {
  data: {
    artifactType: "reasoning",
    payload: {
      text: "Recovered reasoning"
    }
  },
  type: "artifact"
} satisfies ModelRunSseEvent;

const providerResult = {
  finalProviderResponsePreview: {
    id: "response-new",
    status: "completed"
  },
  finalText: "Recovered answer",
  providerResponseId: "response-new",
  usage: {
    inputTokens: 2,
    outputTokens: 3,
    reasoningTokens: 1
  }
} satisfies ProviderRunResult;

function control(overrides: Partial<RunControlRecord> = {}): RunControlRecord {
  return {
    assistantMessageId: "assistant-1",
    chatId: "chat-1",
    id: runId,
    modelId: "gpt-test",
    provider: "openai",
    providerResponseId: "response-old",
    status: "streaming",
    ...overrides
  };
}

function projectRecoveryAuthority(
  overrides: Partial<ProjectRunRecoveryAuthority> = {}
): ProjectRunRecoveryAuthority {
  return {
    accessRevision: 3,
    instructionsRevision: 4,
    memoryRevision: 5,
    policyRevision: 6,
    projectId: "project-1",
    providerAdmissionFingerprint: "a".repeat(64),
    providerConnectionId: "connection-1",
    providerModelId: "model-1",
    providerRequiresClientTools: false,
    providerSearchPlan: { mode: "all_selected", optionIds: [] },
    ...overrides
  };
}

function staleControl(overrides: Partial<StaleRunControlRecord> = {}): StaleRunControlRecord {
  return {
    ...control(overrides),
    updatedAt: new Date("2026-07-12T09:00:00.000Z"),
    ...overrides
  };
}

function providerWithRefresh(refresh: () => Promise<ProviderRunRefreshResult>): ProviderAdapter {
  return {
    buildRequestPreview: () => ({}),
    refresh,
    async *stream() {
      return providerResult;
    }
  };
}

function registry(
  liveRunIds: readonly string[] = []
): RunRecoveryRegistry & { abort(runId: string): boolean } {
  const live = new Map(liveRunIds.map((id) => [id, new AbortController()]));

  return {
    abort(candidateRunId) {
      const controller = live.get(candidateRunId);
      if (!controller) return false;
      controller.abort();
      live.delete(candidateRunId);
      return true;
    },
    has: (candidateRunId) => live.has(candidateRunId),
    ids: () => [...live.keys()],
    register(candidateRunId) {
      if (live.has(candidateRunId)) return null;
      const controller = new AbortController();
      live.set(candidateRunId, controller);
      return {
        release() {
          if (live.get(candidateRunId) === controller) live.delete(candidateRunId);
        },
        signal: controller.signal
      };
    }
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function recoveredKnowledgeV5Finalization(finalText = "Recovered grounded answer [K1]") {
  return {
    grounding: {
      contradictedClaimCount: 0,
      draftClaimCount: 1,
      draftContractVersion: 11 as const,
      draftHash: "a".repeat(64),
      draftOperationId: "draft-operation-1",
      durations: { draftMs: 10, selectorMs: 8 },
      evidenceReceiptHash: "b".repeat(64),
      fallbackReason: null,
      finalAnswerHash: "c".repeat(64),
      finalText,
      finalizationMode: "selected_claims" as const,
      groundingStatus: "verified" as const,
      originalAnswerHash: "d".repeat(64),
      outcome: "answered" as const,
      providerRequestIds: { draft: "provider-draft-1", selector: "provider-selector-1" },
      receiptHash: "b".repeat(64),
      requestCoverage: "complete" as const,
      selectorContractVersion: 7 as const,
      selectorHash: "e".repeat(64),
      selectorOperationId: "selector-operation-1",
      sessionId: "evidence-session-1",
      supportedClaimCount: 1,
      unsupportedClaimCount: 0,
      usage: {
        draft: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          estimatedCostMicros: null,
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 0,
          totalTokens: 15
        },
        selector: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          estimatedCostMicros: null,
          inputTokens: 8,
          outputTokens: 4,
          reasoningTokens: 0,
          totalTokens: 12
        }
      },
      version: 7 as const
    }
  };
}

function recoveredKnowledgeV21Finalization(finalText = "Recovered audited answer [K1]") {
  return {
    grounding: {
      answerBindingFingerprint: "0".repeat(64),
      contracts: {
        coverageAuditorContractVersion: 6 as const,
        draftContractVersion: 21 as const,
        selectorContractVersion: 21 as const,
        settlementVersion: 6 as const
      },
      coverage: {
        coveredDimensionCount: 1,
        excludedDimensionCount: 0,
        missingDimensionCount: 0,
        selectorPayloadHash: "1".repeat(64),
        status: "accepted" as const
      },
      coverageScope: {
        dimensionCount: 1,
        payloadHash: "8".repeat(64),
        status: "accepted" as const
      },
      correctionAttempted: false,
      correctionSucceeded: false,
      contradictedClaimCount: 0,
      draftClaimCount: 1,
      evidenceReceiptHash: "2".repeat(64),
      executionPolicy: {
        auditorReasoningEffort: "high",
        draftReasoningEffort: "low",
        egressDestination: "answer_provider" as const,
        overriddenRoles: ["auditor"] as const,
        providerBindingKey: "answer" as const,
        selectorReasoningEffort: "low",
        supplementReasoningEffort: "low",
        version: 1 as const
      },
      executionPolicyFingerprint: "9".repeat(64),
      fallbackReason: null,
      finalAnswerHash: "3".repeat(64),
      finalText,
      finalizationMode: "selected_claims" as const,
      groundingStatus: "verified" as const,
      modelPinFingerprint: "4".repeat(64),
      operations: [],
      originalAnswerHash: "5".repeat(64),
      outcome: "answered" as const,
      providerPinFingerprint: "6".repeat(64),
      receiptHash: "7".repeat(64),
      requestCoverage: "complete" as const,
      scopeRepairAttempted: false,
      scopeRepairSucceeded: false,
      selectorRepairAttempted: false,
      selectorRepairSucceeded: false,
      sessionId: "evidence-session-v21",
      supportedClaimCount: 1,
      unsupportedClaimCount: 0,
      version: 23 as const
    }
  };
}

function createHarness(options: Readonly<{
  attachmentLimits?: ReturnType<NonNullable<RunRecoveryDeps["getAttachmentLimits"]>>;
  completeRun?: boolean;
  controls?: readonly (RunControlRecord | null)[];
  failRun?: boolean;
  groundKnowledgeAnswer?: RunRecoveryRepository["groundKnowledgeAnswer"];
  groundKnowledgeAnswerV5?: RunRecoveryRepository["groundKnowledgeAnswerV5"];
  groundKnowledgeAnswerV21?: RunRecoveryRepository["groundKnowledgeAnswerV21"];
  liveRunIds?: readonly string[];
  knowledgeExecutor?: RunRecoveryDeps["knowledgeExecutor"];
  knowledgeAdmission?: RunRecoveryDeps["knowledgeAdmission"];
  knowledgeFullContextDispatchRecovery?: Awaited<ReturnType<
    NonNullable<RunRecoveryRepository["loadKnowledgeFullContextDispatchRecovery"]>
  >>;
  knowledgeProviderDispatch?: KnowledgeProviderDispatchLifecycle;
  focusedKnowledgeRecoveryScope?: FocusedKnowledgeRecoveryScope | null;
  focusedKnowledgeScopeExclusions?: readonly KnowledgeRunAdmissionExclusion[] | null;
  memoryEgress?: MemoryToolEgressReceiptService;
  mcp?: RunRecoveryDeps["mcp"];
  mcpRuntime?: RunRecoveryDeps["mcpRuntime"];
  projectAccessCurrent?: boolean;
  providerAdmission?: RunRecoveryDeps["providerAdmission"];
  providerDispatchRecoveryRequest?: NormalizedRunRequest | null;
  pricing?: {
    inputTokenPriceMicros: number;
    outputTokenPriceMicros: number;
  } | null;
  pricingError?: Error;
  providers?: Readonly<Record<string, ProviderAdapter>>;
  recoveryControls?: readonly (RunControlRecord | null)[];
  registry?: RunRecoveryRegistry;
  settleRecoveredRunError?: boolean;
  searchProviders?: RunRecoveryDeps["searchProviders"];
  searchStrategyEnabled?: boolean;
  staleRuns?: readonly StaleRunControlRecord[];
  storage?: RunRecoveryDeps["storage"];
}> = {}) {
  const controls = options.controls ?? [control()];
  const recoveryControls = options.recoveryControls ?? [];
  const initialControl = controls.find((candidate): candidate is RunControlRecord => candidate !== null) ??
    recoveryControls.find((candidate): candidate is RunControlRecord => candidate !== null) ??
    control();
  let controlIndex = 0;
  let recoveryControlIndex = 0;
  let nextSequence = 0;
  const state: {
    assistantAppendOptions: Array<Readonly<{ allowErrored?: boolean; runId: string }> | undefined>;
    assistantTexts: string[];
    completed: Parameters<RunRecoveryRepository["completeRun"]>[0] | null;
    events: { event: ModelRunSseEvent; runId: string; sequence: number }[];
    failed: {
      assistantMessageId: string;
      error: { code: string; message: string };
      runId: string;
    }[];
    operations: string[];
    providerResponseIds: { providerResponseId: string; runId: string }[];
    preparingRecoveries: Parameters<RunRecoveryRepository["recoverPreparingRun"]>[0][];
    recoveredErrors: Parameters<RunRecoveryRepository["settleRecoveredRunError"]>[0][];
    run: {
      providerResponseId: string | null;
      recoverySettled: boolean;
      status: RunControlRecord["status"];
    };
    staleQueries: Parameters<RunRecoveryRepository["findStaleActiveRunsForUser"]>[0][];
    sweeps: string[][];
    usageAttributions: RunUsageAttribution[][];
  } = {
    assistantAppendOptions: [],
    assistantTexts: [],
    completed: null,
    events: [],
    failed: [],
    operations: [],
    providerResponseIds: [],
    preparingRecoveries: [],
    recoveredErrors: [],
    run: {
      providerResponseId: initialControl.providerResponseId,
      recoverySettled: initialControl.recoverySettled ?? false,
      status: initialControl.status
    },
    staleQueries: [],
    sweeps: [],
    usageAttributions: []
  };
  const repository: RunRecoveryRepository = {
    advanceToolLoopCallBatch: async () => "not_found",
    appendAssistantText: async (_assistantMessageId, text, appendOptions) => {
      state.operations.push("append_assistant_text");
      state.assistantAppendOptions.push(appendOptions);
      state.assistantTexts.push(text);
    },
    appendRunOutputEvent: async (eventRunId, event) => {
      state.operations.push(`append:${event.type}`);
      state.events.push({ event, runId: eventRunId, sequence: nextSequence });
      nextSequence += 1;
    },
    completeRun: async (input) => {
      state.operations.push("complete");
      if (options.completeRun === false) {
        return false;
      }
      const active = state.run.status === "streaming" || state.run.status === "queued" ||
        state.run.status === "in_progress";
      const recovered = state.run.status === "error" && !state.run.recoverySettled &&
        state.run.providerResponseId === (input.providerResponseId ?? null);
      if (!active && !recovered) return false;

      state.completed = input;
      state.run.providerResponseId = input.providerResponseId ?? state.run.providerResponseId;
      state.run.status = "complete";
      for (const event of input.outputEvents ?? []) {
        state.events.push({ event, runId: input.runId, sequence: nextSequence });
        nextSequence += 1;
      }
      return true;
    },
    claimToolLoopCall: async () => ({ kind: "not_found" }),
    createSearchRun: async () => undefined,
    failRun: async (failedRunId, assistantMessageId, error, failOptions) => {
      if (options.failRun === false) {
        return false;
      }
      state.operations.push(`fail:${error.code}`);
      state.run.recoverySettled = failOptions?.recoveryTerminal === true;
      state.run.status = "error";
      state.failed.push({ assistantMessageId, error, runId: failedRunId });
      return true;
    },
    findStaleActiveRunsForUser: async (input) => {
      state.staleQueries.push(input);
      return [...(options.staleRuns ?? [])];
    },
    getRunControlForUser: async () => {
      const value = controls[Math.min(controlIndex, controls.length - 1)] ?? null;
      controlIndex += 1;
      return value;
    },
    ...(options.recoveryControls
      ? {
          getRunControlForRecovery: async () => {
            const value = recoveryControls[
              Math.min(recoveryControlIndex, recoveryControls.length - 1)
            ] ?? null;
            recoveryControlIndex += 1;
            return value;
          }
        }
      : {}),
    ...(options.groundKnowledgeAnswer
      ? { groundKnowledgeAnswer: options.groundKnowledgeAnswer }
      : {}),
    ...(options.groundKnowledgeAnswerV5 || options.knowledgeProviderDispatch
      ? {
          groundKnowledgeAnswerV5: options.groundKnowledgeAnswerV5 ??
            (async () => recoveredKnowledgeV5Finalization())
        }
      : {}),
    ...(options.groundKnowledgeAnswerV21
      ? { groundKnowledgeAnswerV21: options.groundKnowledgeAnswerV21 }
      : {}),
    loadAttachments: async () => [],
    loadCheckpointedToolLoopRun: async () => null,
    ...(options.knowledgeFullContextDispatchRecovery
      ? {
          loadKnowledgeFullContextDispatchRecovery: async () =>
            options.knowledgeFullContextDispatchRecovery!
        }
      : {}),
    loadFocusedKnowledgeScopeExclusions: async () =>
      options.focusedKnowledgeScopeExclusions === undefined
        ? []
        : options.focusedKnowledgeScopeExclusions,
    ...(options.focusedKnowledgeRecoveryScope !== undefined
      ? {
          loadFocusedKnowledgeRecoveryScope: async () =>
            options.focusedKnowledgeRecoveryScope ?? null
        }
      : {}),
    loadProviderDispatchRecoveryRequest: async () =>
      options.providerDispatchRecoveryRequest ?? null,
    isSearchStrategyEnabled: async () => options.searchStrategyEnabled ?? true,
    isProjectRunAccessCurrent: async () => options.projectAccessCurrent ?? true,
    loadEntitlements: async () => ({
      fullAccess: true,
      modelKeys: new Set<string>(),
      providerKeys: new Set<string>(),
      searchStrategies: new Set<string>()
    }),
    loadModelPricing: async () => {
      if (options.pricingError) throw options.pricingError;
      return options.pricing === undefined
        ? {
            inputTokenPriceMicros: 10,
            outputTokenPriceMicros: 20
          }
        : options.pricing;
    },
    loadRunUsageAttributions: async () => [],
    markAssistantMessageGroundedLiveOnly: async () => true,
    persistToolLoopCallBatch: async () => ({ kind: "not_found" }),
    recordRunUsageEvents: async (input) => {
      if (state.run.status === "complete") return false;
      state.usageAttributions.push(input.usageAttributions);
      return true;
    },
    recoverPreparingRun: async (input) => {
      state.preparingRecoveries.push(input);
      return "settled";
    },
    resetToolLoopAssistantDraft: async () => false,
    settleRecoveredRunError: async (input) => {
      if (options.settleRecoveredRunError === false || state.run.status === "cancelled" ||
        state.run.status === "complete" || state.run.recoverySettled) {
        return false;
      }
      state.operations.push(`settle_recovered:${input.error.code}`);
      state.run.recoverySettled = true;
      state.run.status = "error";
      state.recoveredErrors.push(input);
      state.failed.push({
        assistantMessageId: "assistant-1",
        error: input.error,
        runId: input.runId
      });
      for (const event of input.outputEvents) {
        state.events.push({ event, runId: input.runId, sequence: nextSequence });
        nextSequence += 1;
      }
      return true;
    },
    settleToolLoopCall: async () => "not_found",
    sweepBootOrphanedRuns: async ({ liveRunIds }) => {
      state.sweeps.push(liveRunIds);
      return 0;
    },
    updateRunProviderResponseId: async (responseRunId, providerResponseId) => {
      state.operations.push("update_response_id");
      if (state.run.status === "cancelled") return "cancelled";
      const active = state.run.status === "streaming" || state.run.status === "queued" ||
        state.run.status === "in_progress";
      if (!active && !(state.run.status === "error" && !state.run.recoverySettled)) {
        return "terminal";
      }
      state.run.providerResponseId = providerResponseId;
      state.providerResponseIds.push({ providerResponseId, runId: responseRunId });
      return "published";
    }
  };
  const deps: RunRecoveryDeps = {
    ...(options.attachmentLimits
      ? { getAttachmentLimits: () => options.attachmentLimits! }
      : {}),
    ...(options.knowledgeAdmission ? { knowledgeAdmission: options.knowledgeAdmission } : {}),
    ...(options.knowledgeExecutor ? { knowledgeExecutor: options.knowledgeExecutor } : {}),
    ...(options.knowledgeProviderDispatch
      ? { knowledgeProviderDispatch: options.knowledgeProviderDispatch }
      : {}),
    ...(options.memoryEgress ? { memoryEgress: options.memoryEgress } : {}),
    ...(options.mcp ? { mcp: options.mcp } : {}),
    ...(options.mcpRuntime ? { mcpRuntime: options.mcpRuntime } : {}),
    ...(options.providerAdmission ? { providerAdmission: options.providerAdmission } : {}),
    providers: options.providers ?? {},
    registry: options.registry ?? registry(options.liveRunIds),
    repository,
    ...(options.searchProviders ? { searchProviders: options.searchProviders } : {}),
    ...(options.storage ? { storage: options.storage } : {})
  };

  return {
    deps,
    repository,
    setStoredRun(input: Partial<typeof state.run>) {
      Object.assign(state.run, input);
    },
    state
  };
}

function createRecoveryMemoryEgressRecorder() {
  type BeginInput = Parameters<MemoryToolEgressReceiptService["beginDispatch"]>[0];
  type BlockInput = Parameters<MemoryToolEgressReceiptService["recordBlockedDispatch"]>[0];
  const began: BeginInput[] = [];
  const blocked: BlockInput[] = [];
  const completed: string[] = [];
  const failed: Array<{ errorCode: string; receiptId: string }> = [];
  const recovered: Array<{
    errorCode?: string;
    outcome: "COMPLETED" | "FAILED";
    runId: string;
    userId: string;
  }> = [];
  let ordinal = 0;
  const service: MemoryToolEgressReceiptService = {
    async beginDispatch(input) {
      began.push(input);
      ordinal += 1;
      return { id: `recovery-egress-${ordinal}`, requestOrdinal: ordinal };
    },
    async recordBlockedDispatch(input) {
      blocked.push(input);
      ordinal += 1;
      return { id: `recovery-egress-${ordinal}`, requestOrdinal: ordinal };
    },
    async settleRecoveredProviderDispatch(input) {
      recovered.push(input);
      return true;
    },
    async completeDispatch(receiptId) {
      completed.push(receiptId);
      return true;
    },
    async failDispatch(receiptId, errorCode) {
      failed.push({ errorCode, receiptId });
      return true;
    }
  };
  return { began, blocked, completed, failed, recovered, service };
}

const recoveryToolName = "mcp_memory_remember_1234567890";
const recoveryFingerprint = "a".repeat(64);

function normalizedToolRequest(): NormalizedRunRequest {
  return {
    attachmentIds: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "remember this", type: "text" }] },
    context: { messages: [], mode: "branch_path" },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
    mcp: {
      servers: [{
        fingerprint: recoveryFingerprint,
        revisionId: "revision-1",
        serverId: "server-1",
        serverName: "Memory"
      }],
      tools: [{
        definitionHash: "b".repeat(64),
        description: "Remember a value",
        inputSchema: { type: "object" },
        name: "remember",
        namespacedName: recoveryToolName,
        originalName: "remember",
        serverId: "server-1",
        serverName: "Memory"
      }],
      version: 1
    },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      parallelToolCalls: true,
      pdf: false,
      reasoning: true,
      streaming: true,
      vision: false
    },
    modelId: "gpt-test",
    params: { background: true, stream: true },
    prompt: { developer: null, system: null },
    provider: "openai",
    searchPlan: { mode: "all_selected", options: [] }
  };
}

function normalizedClientSearchRequest(): NormalizedRunRequest {
  const { mcp: _mcp, ...request } = normalizedToolRequest();
  return {
    ...request,
    searchPlan: {
      mode: "model_choice",
      options: [{
        adapterKind: "provider_model_client",
        config: {
          maxResults: 8,
          modelCapabilities: {
            nativePdfInput: false,
            nativeSearch: true,
            pdf: false,
            reasoning: false,
            streaming: true,
            toolCalling: false,
            vision: false
          },
          modelDefaultParams: {},
          queryMaxCharacters: 500,
          timeoutMs: 5_000
        },
        credentialMode: "provider_model",
        displayName: "OpenAI Search",
        executionModes: ["all_selected", "model_choice"],
        modelId: "search-model",
        optionId: "openai-native-web-search",
        protocol: "openai_responses_web_search",
        provider: "openai_compatible",
        providerModelId: "search-model-row",
        revisionId: "search-revision-1",
        searchStrategyRowId: "search-strategy-row-1"
      }]
    }
  };
}

function normalizedKnowledgeRequest(): NormalizedRunRequest {
  const { mcp: _mcp, ...request } = normalizedToolRequest();
  return {
    ...request,
    knowledgePlan: {
      baseIds: ["knowledge-base-1"], mode: "explicit", sourceIds: [], version: 1
    },
    modelCapabilities: {
      ...request.modelCapabilities,
      toolCalling: true
    },
    toolMode: "auto"
  };
}


function knowledgeProviderDispatchRecorder(
  recoveryKind:
    | "ambiguous"
    | "dispatch"
    | "released"
    | "resume"
    | "settled"
    | "settled_without_handle",
  draftOverride?: KnowledgeEvidenceDispatchManifestDraft
) {
  const draft = draftOverride ?? packKnowledgeEvidenceDispatchManifest({
    candidates: [{
      ambiguity: "none",
      evidenceId: "knowledge-planner-v1-1:result:1",
      exactExcerpt: "PERSISTED_EXACT_RECOVERY_MANIFEST",
      fileName: "recovery.txt",
      handle: "K1",
      locator: "page=1",
      operationOrdinal: 1,
      resultOrdinal: 1,
      sourceAlias: "S1",
      sourceLabel: "Recovery source",
      sourceTruncated: false,
      sourceVersionNumber: 1,
      state: "available"
    }],
    coverageStatement: "Coverage verified: no.",
    footer: "</private_knowledge_evidence>",
    header: "<private_knowledge_evidence version=\"2\">",
    maximumBytes: 16_384,
    maximumTokens: 4_096,
    runtimeVersion: 1,
    profileId: "openai:gpt-test",
    promptFragmentVersion: 2
  });
  const state = recoveryKind === "dispatch"
    ? "reserved" as const
    : recoveryKind === "resume"
      ? "dispatched" as const
      : recoveryKind === "released"
        ? "released" as const
        : recoveryKind === "settled" || recoveryKind === "settled_without_handle"
          ? "settled" as const
          : "ambiguous" as const;
  const dispatch: StoredKnowledgeEvidenceDispatch = {
    attempt: {
      acceptedRequest: null,
      acceptedResult: null,
      actualUsage: state === "settled" ? {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        estimatedCostMicros: null,
        inputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 0,
        totalTokens: 5
      } : null,
      ambiguousAt: state === "ambiguous" ? new Date("2026-07-12T09:02:00.000Z") : null,
      checkpointHash: "a".repeat(64),
      contractVersion: null,
      dispatchedAt: state === "reserved" ? null : new Date("2026-07-12T09:01:00.000Z"),
      evidenceReceiptHash: null,
      estimatedUsage: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        estimatedCostMicros: null,
        inputTokens: 2,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: 2
      },
      failureCode: state === "ambiguous"
        ? "provider_response_handle_missing"
        : state === "released"
          ? "provider_dispatch_not_started"
          : null,
      id: "attempt-1",
      idempotencyKey: "knowledge-answer:1:checkpoint",
      leaseExpiresAt: state === "reserved" || state === "dispatched"
        ? new Date("2026-07-12T09:30:00.000Z")
        : null,
      leaseToken: state === "reserved" || state === "dispatched"
        ? "lease-token-original"
        : null,
      modelRunId: runId,
      ordinal: 1,
      providerBindingKey: "answer",
      providerResponseId: state === "settled" && recoveryKind !== "settled_without_handle"
        ? "response-tool-1"
        : state === "dispatched"
          ? "response-old"
          : null,
      purpose: "answer",
      releasedAt: state === "released" ? new Date("2026-07-12T09:02:00.000Z") : null,
      requestHash: "b".repeat(64),
      resultAcceptedAt: null,
      resultHash: null,
      roundIndex: 0,
      settledAt: state === "settled" ? new Date("2026-07-12T09:02:00.000Z") : null,
      state
    },
    draft,
    exclusions: [],
    items: [{
      dispatchEvidenceId: "knowledge-planner-v1-1:result:1",
      evidenceItemId: "evidence-item-1",
      handle: "K1",
      sourceArtifactId: "knowledge-artifact-1",
      sourceVersionId: "knowledge-document-version-1"
    }],
    manifestId: "manifest-1",
    profileRevisionIds: ["profile-revision-1"],
    retrievalSessionId: "knowledge-evidence-session-1"
  };
  const prepared: PreparedKnowledgeProviderDispatch = {
    dispatch,
    identity: {
      attemptId: dispatch.attempt.id,
      checkpointHash: dispatch.attempt.checkpointHash,
      idempotencyKey: dispatch.attempt.idempotencyKey,
      manifestHash: draft.manifestHash,
      modelRunId: runId,
      providerBindingKey: dispatch.attempt.providerBindingKey,
      requestHash: dispatch.attempt.requestHash
    },
    leaseToken: "lease-token-recovery"
  };
  const recovery: KnowledgeProviderDispatchRecovery = recoveryKind === "dispatch"
    ? { kind: "dispatch", prepared, providerResponseId: null }
    : recoveryKind === "resume"
      ? { kind: "resume", prepared, providerResponseId: "response-old" }
    : recoveryKind === "settled"
      ? { dispatch, kind: "settled", providerResponseId: "response-tool-1" }
    : recoveryKind === "settled_without_handle"
      ? { dispatch, kind: "settled", providerResponseId: null }
    : recoveryKind === "released"
      ? { dispatch, kind: "released" }
      : { dispatch, kind: "ambiguous" };
  const lifecycle: KnowledgeProviderDispatchLifecycle = {
    dispatch: vi.fn(async () => undefined),
    inspect: vi.fn(async () => dispatch),
    markAmbiguous: vi.fn(async () => undefined),
    prepare: vi.fn(async () => prepared),
    recover: vi.fn(async (input) =>
      recoveryKind === "dispatch" && input.requestPreview === undefined
        ? { dispatch, kind: "request_required" as const }
        : recovery),
    release: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined)
  };
  return { dispatch, draft, lifecycle, prepared };
}

function focusedKnowledgeProviderRecoveryFixture() {
  const knowledgeFocusedRequest = createKnowledgeFocusedRequest({
    currentUserMessage: "remember this",
    previousUserMessage: "earlier knowledge question"
  });
  if (!knowledgeFocusedRequest) throw new Error("invalid_focused_recovery_fixture");
  const base = normalizedKnowledgeRequest();
  const normalizedRequest: NormalizedRunRequest = {
    ...base,
    knowledgeFocusedRequest,
    modelCapabilities: { ...base.modelCapabilities, toolCalling: false },
    toolMode: "none"
  };
  return { knowledgeFocusedRequest, normalizedRequest };
}

function focusedKnowledgeRecoveryAuthorizationFixture(): Readonly<{
  admitted: KnowledgeRunAdmissionPlan;
  scope: FocusedKnowledgeRecoveryScope;
}> {
  const vectorSpaceFingerprint = "a".repeat(64);
  const knowledgePlan: KnowledgeRunAdmissionPlan["knowledgePlan"] = {
    baseIds: ["knowledge-base-1"], mode: "explicit", sourceIds: [], version: 1
  };
  const profile = {
    embeddingCredentialSource: "default" as const,
    embeddingExecutionSnapshot: {} as never,
    embeddingProviderModelId: "embedding-model",
    ordinal: 0,
    profileRevisionId: "profile-revision-1",
    targetDimension: 1_024,
    vectorSpaceFingerprint
  };
  const binding = {
    baseContentRevision: 1,
    embeddingCredentialSource: "default" as const,
    embeddingExecutionSnapshot: {} as never,
    embeddingProviderModelId: "embedding-model",
    indexedContentRevision: 1,
    indexGenerationId: "generation-1",
    includeWholeBase: true,
    knowledgeBaseId: "knowledge-base-1",
    ordinal: 0,
    selectedSourceIds: [] as readonly string[],
    targetDimension: 1_024,
    vectorSpaceFingerprint
  };
  const sourceAuthorization = {
    authority: {
      knowledgeBaseIds: ["knowledge-base-1"] as readonly string[],
      owner: false,
      projectId: null
    },
    baseProvenance: [{
      indexGenerationId: "generation-1",
      knowledgeBaseId: "knowledge-base-1"
    }],
    directSelected: false,
    profileRevisionId: "profile-revision-1",
    selectionProvenance: ["base" as const],
    sourceArtifactId: "artifact-1",
    sourceId: "source-1",
    sourceVersionId: "source-version-1"
  };
  const scope: FocusedKnowledgeRecoveryScope = {
    bindings: [binding],
    exclusions: [],
    knowledgePlan,
    profiles: [profile],
    sources: [sourceAuthorization]
  };
  return {
    admitted: {
      bindings: [binding],
      budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      exclusions: [],
      fingerprint: "accepted-focused-scope",
      knowledgePlan,
      profiles: [profile],
      resolvedSourceCount: 1,
      sources: [{
        ...sourceAuthorization,
        approxTokens: 32,
        ordinal: 0,
        passageCount: 1,
        privateLabels: { fileName: "source.txt", sourceName: "Source" },
        profileOrdinal: 0,
        sourceAlias: "S1",
        sourceVersionNumber: 1
      }],
      userId
    },
    scope
  };
}

function focusedKnowledgeRetrievalResult(): ToolExecutionResult {
  const includedText = "Recovered focused evidence";
  const draft: KnowledgeRetrievalEvidence = {
    bases: [{
      baseContentRevision: 1,
      baseName: "Recovery base",
      candidateCount: 1,
      indexedContentRevision: 1,
      indexGenerationId: "recovery-generation-1",
      knowledgeBaseId: "recovery-base-1",
      ordinal: 0,
      state: "ready",
      targetDimension: 1024,
      vectorSearch: {
        bindingOrdinal: 0,
        candidateCount: 1,
        eligibleRows: 1,
        mode: "exact",
        scan: {
          efSearch: null,
          iterativeScan: null,
          maxScanTuples: null,
          retrievalBucket: 0
        },
        targetDimension: 1024
      },
      vectorSpaceFingerprint: "a".repeat(64)
    }],
    candidateCount: 1,
    candidateLimit: 40,
    durationMs: 3,
    embeddingExecutions: [{
      bindingOrdinals: [0],
      durationMs: 1,
      inputTokens: 2,
      modelId: "embedding-model",
      provider: "test",
      providerModelId: "embedding-upstream",
      requestId: null,
      status: "complete",
      totalTokens: 2
    }],
    fusion: "weighted_rrf_v2",
    invocationOrdinal: 1,
    outcome: "complete",
    providerText: "pending",
    query: "remember this",
    resultLimit: 8,
    results: [{
      annRank: 1,
      baseName: "Recovery base",
      bindingOrdinal: 0,
      chunkId: "recovery-chunk-1",
      chunkIndex: 0,
      contentHash: "b".repeat(64),
      documentId: "recovery-source-1",
      documentVersionId: "recovery-source-version-1",
      documentVersionNumber: 1,
      fileName: "recovery.txt",
      ftsRank: 1,
      ftsScore: 0.5,
      fusedScore: 2 / 61,
      handle: "K1",
      headingPath: ["Recovery"],
      includedText,
      includedTextBytes: Buffer.byteLength(includedText),
      knowledgeBaseId: "recovery-base-1",
      page: 1,
      sectionId: "recovery-section-1",
      signalProvenance: [{
        exactKind: null,
        lane: "passage_semantic",
        rank: 1,
        rawScore: 0.9,
        vectorDistance: 0.1,
        vectorMode: "exact"
      }],
      sourceAlias: "S1",
      sourceArtifactId: "recovery-artifact-1",
      sourceName: "Recovery source",
      sourceTextBytes: Buffer.byteLength(includedText),
      textTruncated: false,
      vectorDistance: 0.1,
      vectorScore: 0.9
    }],
    scopeAliases: [{ alias: "S1", kind: "source", label: "Recovery source" }],
    version: KNOWLEDGE_RESULT_VERSION
  };
  const evidence = { ...draft, providerText: knowledgeToolResultText(draft) };
  return {
    callId: FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID,
    content: knowledgeToolResultContent(evidence),
    name: KNOWLEDGE_FOCUSED_OPERATION_NAME,
    rawPreview: {
      knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION,
      knowledgeRetrieval: evidence,
      providerCall: true
    },
    status: "complete"
  };
}

function focusedKnowledgeZeroCandidateResult(): ToolExecutionResult {
  const complete = focusedKnowledgeRetrievalResult();
  const preview = complete.rawPreview as Readonly<{
    knowledgeRetrieval: KnowledgeRetrievalEvidence;
  }>;
  const draft: KnowledgeRetrievalEvidence = {
    ...preview.knowledgeRetrieval,
    bases: preview.knowledgeRetrieval.bases.map((base) => ({
      ...base,
      candidateCount: 0,
      state: "empty",
      ...(base.vectorSearch
        ? {
            vectorSearch: {
              ...base.vectorSearch,
              candidateCount: 0,
              eligibleRows: 0
            }
          }
        : {})
    })),
    candidateCount: 0,
    outcome: "base_empty",
    providerText: "pending",
    results: []
  };
  const evidence = { ...draft, providerText: knowledgeToolResultText(draft) };
  return {
    ...complete,
    content: knowledgeToolResultContent(evidence),
    rawPreview: {
      ...complete.rawPreview,
      knowledgeRetrieval: evidence
    }
  };
}


function normalizedMemoryActionRequest(): NormalizedRunRequest {
  const { mcp: _mcp, ...request } = normalizedToolRequest();
  return {
    ...request,
    memoryActionTools: { version: "model-driven-v2" },
    modelCapabilities: {
      ...request.modelCapabilities,
      toolCalling: true
    },
    toolMode: "auto"
  };
}

function normalizedMemoryHistoryRequest(): NormalizedRunRequest {
  const { mcp: _mcp, ...request } = normalizedToolRequest();
  return {
    ...request,
    memoryHistoryTool: { maxCalls: 2, pageSize: 20 },
    modelCapabilities: {
      ...request.modelCapabilities,
      toolCalling: true
    },
    toolMode: "auto"
  };
}

function normalizedHostedSearchRequest(): NormalizedRunRequest {
  const request = normalizedToolRequest();
  const option = normalizedClientSearchRequest().searchPlan.options[0]!;
  return {
    ...request,
    searchPlan: {
      mode: "model_choice",
      options: [{
        ...option,
        adapterKind: "answer_provider_hosted",
        credentialMode: "answer_provider",
        modelId: null,
        provider: request.provider,
        providerModelId: null
      }]
    }
  };
}

function normalizedAnthropicSearchRequest(): NormalizedRunRequest {
  const request = normalizedClientSearchRequest();
  const option = request.searchPlan.options[0]!;
  return {
    ...request,
    searchPlan: {
      mode: "model_choice",
      options: [{
        ...option,
        config: {
          ...option.config,
          maxOutputTokens: 4_096,
          maxSearchCallsPerAnswer: 2,
          modelCapabilities: {
            nativePdfInput: true,
            nativeSearch: true,
            pdf: true,
            reasoning: true,
            reasoningEfforts: ["low", "medium", "high"],
            streaming: true,
            toolCalling: true,
            vision: true
          },
          reasoningPolicy: "lowest_supported"
        },
        displayName: "Anthropic Web Search",
        modelId: "claude-opus-5",
        optionId: "anthropic-web-search",
        protocol: "anthropic_web_search",
        provider: "anthropic",
        providerModelId: "anthropic-search-deployment",
        revisionId: "anthropic-search-revision-1",
        searchStrategyRowId: "anthropic-search-client-route"
      }]
    }
  };
}

function checkpoint(
  phase: "provider_running" | "tools_pending" | "tools_running",
  roundIndex: number,
  continuation: ToolLoopJsonValue,
  answerRoundUsage?: readonly PersistedAnswerRoundUsage[]
): ToolLoopCheckpoint {
  const currentUsage = answerRoundUsage ?? (phase === "provider_running" || roundIndex === 0
    ? []
    : [{
        completeness: "terminal" as const,
        roundIndex,
        usage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0
        }
      }]);
  const value = toolLoopCheckpoint({
    answerRoundUsage: currentUsage,
    phase,
    providerContinuation: continuation,
    roundIndex
  });
  if (!value) throw new Error("invalid_test_checkpoint");
  return value;
}

function persistedRecoveryCall(
  state: PersistedToolLoopCall["state"] = "pending"
): PersistedToolLoopCall {
  return {
    arguments: { value: "alpha" },
    completedAt: state === "complete" || state === "error" ? "2026-07-12T09:01:00.000Z" : null,
    id: "stored-call-1",
    mcpBinding: {
      id: "binding-1",
      runtimeGenerationFingerprint: recoveryFingerprint,
      runtimeGenerationId: "generation-1"
    },
    ordinal: 0,
    providerCallId: "provider-call-1",
    result: null,
    roundIndex: 1,
    startedAt: state === "pending" ? null : "2026-07-12T09:00:30.000Z",
    state,
    toolName: recoveryToolName
  };
}

function checkpointedRun(input: Readonly<{
  answerRoundUsage?: readonly PersistedAnswerRoundUsage[];
  calls?: readonly PersistedToolLoopCall[];
  phase: "provider_running" | "tools_pending" | "tools_running";
  providerResponseId?: string | null;
  providerToolMessages?: ToolLoopJsonValue[];
  roundIndex?: number;
}>): CheckpointedToolLoopRun {
  const continuation = {
    providerResponseId: input.providerResponseId ?? "response-tool-1",
    providerToolMessages: input.providerToolMessages ?? [{
      arguments: "{\"value\":\"alpha\"}",
      call_id: "provider-call-1",
      name: recoveryToolName,
      type: "function_call"
    }]
  } satisfies ToolLoopJsonValue;
  return {
    assistantMessageId: "assistant-1",
    assistantText: "",
    calls: [...(input.calls ?? [])],
    chatId: "chat-1",
    checkpoint: checkpoint(
      input.phase,
      input.roundIndex ?? 1,
      continuation,
      input.answerRoundUsage
    ),
    id: runId,
    modelId: "gpt-test",
    normalizedRequest: normalizedToolRequest(),
    provider: "openai",
    providerResponseId: input.providerResponseId ?? null,
    status: "streaming",
    userId
  };
}

function installCheckpointState(
  harness: ReturnType<typeof createHarness>,
  initial: CheckpointedToolLoopRun,
  persistedUsage: PersistedRunUsageAttribution[] = []
) {
  let currentCheckpoint = initial.checkpoint;
  let calls = initial.calls.map((call) => ({ ...call }));
  harness.setStoredRun({
    providerResponseId: initial.providerResponseId,
    recoverySettled: false,
    status: initial.status
  });
  harness.repository.loadCheckpointedToolLoopRun = async () => ({
    ...initial,
    calls,
    checkpoint: currentCheckpoint
  });
  harness.repository.loadRunUsageAttributions = async () => persistedUsage;
  const recordRunUsageEvents = harness.repository.recordRunUsageEvents;
  harness.repository.recordRunUsageEvents = async (input) => {
    if (input.answerRoundUsage) {
      const next = upsertAnswerRoundUsage(currentCheckpoint, input.answerRoundUsage);
      if (!next) return false;
      currentCheckpoint = next;
    }
    return recordRunUsageEvents(input);
  };
  harness.repository.loadAttachments = async () => [];
  const claimToolLoopCall: RunRecoveryRepository["claimToolLoopCall"] = async ({ callId }) => {
    const call = calls.find((candidate) => candidate.id === callId);
    if (!call) return { kind: "not_found" };
    if (call.state === "running" && call.toolName !== MCP_FIND_TOOLS_NAME) {
      return { call, kind: "ambiguous" };
    }
    if (call.state === "cancelled") return { call, kind: "cancelled" };
    if (call.state === "complete" || call.state === "error") {
      return { call, kind: "settled" };
    }
    const claimed = {
      ...call,
      startedAt: "2026-07-12T09:00:30.000Z",
      state: "running" as const
    };
    calls = calls.map((candidate) => candidate.id === call.id ? claimed : candidate);
    currentCheckpoint = checkpoint(
      "tools_running",
      currentCheckpoint.roundIndex,
      currentCheckpoint.providerContinuation,
      currentCheckpoint.answerRoundUsage
    );
    return { call: claimed, kind: "claimed" };
  };
  harness.repository.claimToolLoopCall = claimToolLoopCall;
  harness.repository.claimAutomaticKnowledgeCall = claimToolLoopCall;
  harness.repository.settleToolLoopCall = async ({ callId, result, state }) => {
    const call = calls.find((candidate) => candidate.id === callId);
    if (!call) return "not_found";
    calls = calls.map((candidate) => candidate.id === callId
      ? {
          ...candidate,
          completedAt: "2026-07-12T09:01:00.000Z",
          result,
          state
        }
      : candidate);
    return "settled";
  };
  harness.repository.persistToolLoopCallBatch = async (input) => {
    const existing = calls.filter((call) => call.roundIndex === input.roundIndex);
    if (existing.length > 0) return { calls: existing, kind: "reused" };
    const created = input.calls.map((call, index): PersistedToolLoopCall => ({
      arguments: call.arguments,
      completedAt: null,
      id: `stored-call-${input.roundIndex}-${index}`,
      mcpBinding: call.runtimeGenerationFingerprint
        ? {
            id: "binding-1",
            runtimeGenerationFingerprint: call.runtimeGenerationFingerprint,
            runtimeGenerationId: "generation-1"
          }
        : null,
      ordinal: call.ordinal,
      providerCallId: call.providerCallId,
      result: null,
      roundIndex: input.roundIndex,
      startedAt: null,
      state: "pending",
      toolName: call.toolName
    }));
    calls = [...calls, ...created];
    currentCheckpoint = checkpoint(
      "tools_pending",
      input.roundIndex,
      input.providerContinuation,
      currentCheckpoint.answerRoundUsage
    );
    return { calls: created, kind: "persisted" };
  };
  harness.repository.resetToolLoopAssistantDraft = async () => true;
  harness.repository.advanceToolLoopCallBatch = async ({ roundIndex }) => {
    const current = calls.filter((call) => call.roundIndex === roundIndex);
    if (current.some((call) => call.state !== "complete" && call.state !== "error")) {
      return "incomplete";
    }
    currentCheckpoint = checkpoint(
      "provider_running",
      roundIndex + 1,
      currentCheckpoint.providerContinuation,
      currentCheckpoint.answerRoundUsage
    );
    harness.setStoredRun({ providerResponseId: null });
    return "advanced";
  };
  return {
    calls: () => calls,
    checkpoint: () => currentCheckpoint
  };
}

describe("run recovery", () => {
  beforeEach(() => {
    resetBootOrphanSweepForTest(new Date("2026-07-12T10:00:00.000Z"));
  });

  it("recovers installation-wide resumable runs without waiting for an owner request", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      providerResponseId: "response-old",
      status: "in_progress",
      terminal: false
    }));
    const harness = createHarness({
      providers: { openai: providerWithRefresh(refresh) }
    });
    const installationQueries: unknown[] = [];
    harness.repository.findInstallationRecoverableRuns = async (input) => {
      installationQueries.push(input);
      return [{
        ...staleControl({ updatedAt: new Date("2026-07-12T09:59:59.000Z") }),
        userId
      }];
    };

    await reconcileInstallationRuns(harness.deps, {
      now: new Date("2026-07-12T10:00:01.000Z")
    });

    expect(harness.state.sweeps).toEqual([[]]);
    expect(installationQueries).toEqual([
      expect.objectContaining({
        bootedBefore: new Date("2026-07-12T10:00:00.000Z"),
        limit: 100
      })
    ]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("settles installation-wide PREPARING rows without resolving a provider", async () => {
    const refresh = vi.fn();
    const harness = createHarness({
      providers: { openai: providerWithRefresh(refresh) }
    });
    harness.repository.findInstallationRecoverableRuns = async () => [{
      ...staleControl({
        providerResponseId: null,
        status: "preparing",
        updatedAt: new Date("2026-07-12T09:00:00.000Z")
      }),
      userId
    }];
    const now = new Date("2026-07-12T10:00:01.000Z");

    await reconcileInstallationRuns(harness.deps, { now });

    expect(harness.state.preparingRecoveries).toEqual([{ now, runId, userId }]);
    expect(refresh).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([]);
  });

  it("fails a revoked Project candidate before installation recovery can orphan or dispatch it", async () => {
    const project = projectRecoveryAuthority();
    const refresh = vi.fn();
    const harness = createHarness({
      controls: [null],
      projectAccessCurrent: false,
      providerAdmission: {
        load: vi.fn(async () => ({ fingerprint: project.providerAdmissionFingerprint }) as ProviderAdmissionPlan)
      },
      providers: { openai: providerWithRefresh(refresh) },
      recoveryControls: [control({ project, providerResponseId: null })]
    });
    harness.repository.findInstallationRecoverableRuns = async () => [{
      ...staleControl({ providerResponseId: null }),
      userId
    }];

    await reconcileInstallationRuns(harness.deps, {
      now: new Date("2026-07-12T10:00:01.000Z")
    });

    expect(harness.state.failed).toEqual([expect.objectContaining({
      error: expect.objectContaining({ code: "provider_admission_changed" })
    })]);
    expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("fails Project background recovery before provider I/O when accepted authority drifted", async () => {
    const project = projectRecoveryAuthority();
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      providerResponseId: "response-old",
      status: "in_progress",
      terminal: false
    }));
    const load = vi.fn(async () => ({
      fingerprint: "b".repeat(64)
    }) as ProviderAdmissionPlan);
    const harness = createHarness({
      controls: [control({ project })],
      projectAccessCurrent: true,
      providerAdmission: { load },
      providers: { openai: providerWithRefresh(refresh) }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(load).toHaveBeenCalledWith({
      executionScope: "project",
      providerConnectionId: project.providerConnectionId,
      providerModelId: project.providerModelId,
      searchPlan: project.providerSearchPlan,
      userId
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "provider_admission_changed",
        message: "Project provider authority is no longer current."
      },
      runId
    }]);
  });

  it("sweeps boot-orphaned runs once with the injected live-run ids", async () => {
    const harness = createHarness({ liveRunIds: ["run-live-1", "run-live-2"] });
    const secondRepository = createHarness({ liveRunIds: ["run-other"] });

    await Promise.all([
      sweepBootOrphanedRunsOnce(harness.deps),
      sweepBootOrphanedRunsOnce(harness.deps),
      sweepBootOrphanedRunsOnce(secondRepository.deps)
    ]);
    await sweepBootOrphanedRunsOnce(harness.deps);

    expect(harness.state.sweeps).toEqual([["run-live-1", "run-live-2"]]);
    expect(secondRepository.state.sweeps).toEqual([]);
  });

  it("retries the one-time boot sweep after a rejected attempt", async () => {
    const harness = createHarness();
    let attempts = 0;
    harness.repository.sweepBootOrphanedRuns = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("boot_sweep_failed");
      }

      return 0;
    };

    await expect(sweepBootOrphanedRunsOnce(harness.deps)).rejects.toThrow("boot_sweep_failed");
    await expect(sweepBootOrphanedRunsOnce(harness.deps)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("refreshes and finalizes before appending provider, usage, and done events", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [providerEvent],
      providerResponseId: "response-new",
      result: providerResult,
      status: "completed",
      terminal: true
    }));
    const harness = createHarness({
      controls: [control({ status: "error" })],
      providers: {
        openai: providerWithRefresh(refresh)
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledWith("response-old");
    expect(harness.state.providerResponseIds).toEqual([
      {
        providerResponseId: "response-new",
        runId
      }
    ]);
    expect(harness.state.completed).toMatchObject({
      assistantMessageId: "assistant-1",
      estimatedCostMicros: 80,
      providerResponseId: "response-new",
      runId,
      usage: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        estimatedCostMicros: 80,
        inputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
        totalTokens: 5
      },
      userId
    });
    expect(harness.state.operations).toEqual(["update_response_id", "complete"]);
    expect(harness.state.events.map(({ event, sequence }) => ({ sequence, type: event.type }))).toEqual([
      { sequence: 0, type: "artifact" }
    ]);
  });

  it("settles a recovered non-tool Knowledge attempt from its durable refresh handle", async () => {
    const dispatch = knowledgeProviderDispatchRecorder("resume");
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      providerResponseId: "response-new",
      result: providerResult,
      status: "completed",
      terminal: true
    }));
    const harness = createHarness({
      knowledgeProviderDispatch: dispatch.lifecycle,
      providers: { openai: providerWithRefresh(refresh) }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledWith("response-old");
    expect(dispatch.lifecycle.dispatch).not.toHaveBeenCalled();
    expect(dispatch.lifecycle.settle).toHaveBeenCalledWith(
      dispatch.prepared,
      expect.objectContaining({ providerResponseId: "response-new" })
    );
    expect(harness.state.completed).toMatchObject({
      providerResponseId: "response-new"
    });
  });

  it("rebuilds the first focused manifest from persisted scope exclusions with no tools", async () => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const persistedExclusions = [{
      count: 2,
      reason: "not_ready",
      resourceType: "source"
    }] as const;
    const dispatch = knowledgeProviderDispatchRecorder("dispatch");
    vi.mocked(dispatch.lifecycle.inspect).mockResolvedValue(null);
    const execute = vi.fn(async () => focusedKnowledgeRetrievalResult());
    const requests: ProviderRunRequest[] = [];
    const harness = createHarness({
      controls: [control({ providerResponseId: null })],
      focusedKnowledgeScopeExclusions: persistedExclusions,
      knowledgeExecutor: {
        accepts: (name) => name === KNOWLEDGE_FOCUSED_OPERATION_NAME,
        capability: "knowledge",
        execute,
        tool: knowledgeRetrievalTool,
        tools: []
      },
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: {
        ...fixture.normalizedRequest,
        modelCapabilities: {
          ...fixture.normalizedRequest.modelCapabilities,
          toolCalling: true
        },
        toolMode: "auto"
      },
      providers: {
        openai: {
          buildRequestPreview: (request) => ({ context: request.context }),
          async *stream(request) {
            requests.push(request);
            return {
              ...providerResult,
              finalText: requests.length === 1
                ? JSON.stringify({
                    dimensions: [{ description: "The requested answer.", id: "D1" }],
                    version: 1
                  })
                : requests.length === 2
                ? JSON.stringify({
                    claims: [{ citationHints: ["K1"], text: "Recovered focused evidence" }],
                    version: 1
                  })
                  : JSON.stringify({
                      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
                      coverage: [{
                        id: "D1",
                        status: "covered",
                        supportIds: ["C1"]
                      }],
                      extractIds: [],
                      insufficientReason: "not_applicable",
                      version: 1
                    }),
              providerResponseId: `response-recovered-${requests.length}`
            };
          }
        }
      }
    });
    const persistedCall: PersistedToolLoopCall = {
      arguments: focusedKnowledgeCallArguments(fixture.knowledgeFocusedRequest),
      completedAt: null,
      id: "focused-call-row-1",
      mcpBinding: null,
      ordinal: 0,
      providerCallId: FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID,
      result: null,
      roundIndex: 0,
      startedAt: null,
      state: "pending",
      toolName: KNOWLEDGE_FOCUSED_OPERATION_NAME
    };
    harness.repository.loadFocusedKnowledgeCall = async () => persistedCall;
    harness.repository.claimAutomaticKnowledgeCall = async () => ({
      call: { ...persistedCall, state: "running" },
      kind: "claimed"
    });
    harness.repository.settleToolLoopCall = async () => "settled";

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(execute).toHaveBeenCalledOnce();
    expect(dispatch.lifecycle.prepare).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({
        coverageStatement:
          "2 selected Knowledge resource(s) were unavailable; do not claim complete coverage."
      })
    }));
    expect(dispatch.lifecycle.prepare).toHaveBeenCalledTimes(3);
    expect(dispatch.lifecycle.prepare).toHaveBeenNthCalledWith(1, expect.objectContaining({
      contractVersion: 20,
      purpose: "knowledge_coverage_planner_v20"
    }));
    expect(dispatch.lifecycle.prepare).toHaveBeenNthCalledWith(2, expect.objectContaining({
      contractVersion: 20,
      purpose: "knowledge_answer_draft_v20"
    }));
    expect(dispatch.lifecycle.prepare).toHaveBeenNthCalledWith(3, expect.objectContaining({
      contractVersion: 16,
      purpose: "knowledge_grounded_selector_v16"
    }));
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.toolChoice === "none" && !request.tools)).toBe(true);
    expect(requests.every((request) => request.prompt.knowledgeAnswerContract === undefined))
      .toBe(true);
    expect(harness.state.completed?.finalText).toBe("Recovered grounded answer [K1]");
  });

  it.each([{
    current: false,
    executionPolicy: undefined,
    expectedReasoningEfforts: [],
    snapshotVersion: 1
  }, {
    current: false,
    executionPolicy: {
      auditorReasoningEffort: "high",
      draftReasoningEffort: "low",
      egressDestination: "answer_provider",
      overriddenRoles: ["selector", "auditor"],
      providerBindingKey: "answer",
      selectorReasoningEffort: "medium",
      supplementReasoningEffort: "low",
      version: 1
    } as const,
    expectedReasoningEfforts: [],
    snapshotVersion: 2
  }, {
    current: false,
    executionPolicy: {
      auditorReasoningEffort: "high",
      draftReasoningEffort: "low",
      egressDestination: "answer_provider",
      overriddenRoles: ["selector", "auditor"],
      providerBindingKey: "answer",
      selectorReasoningEffort: "medium",
      supplementReasoningEffort: "low",
      version: 1
    } as const,
    expectedReasoningEfforts: [],
    snapshotVersion: 3
  }, {
    current: false,
    executionPolicy: {
      auditorReasoningEffort: "high",
      draftReasoningEffort: "low",
      egressDestination: "answer_provider",
      overriddenRoles: ["selector", "auditor"],
      providerBindingKey: "answer",
      selectorReasoningEffort: "medium",
      supplementReasoningEffort: "low",
      version: 1
    } as const,
    expectedReasoningEfforts: [],
    snapshotVersion: 4
  }, {
    current: false,
    executionPolicy: {
      auditorReasoningEffort: "high",
      draftReasoningEffort: "low",
      egressDestination: "answer_provider",
      overriddenRoles: ["selector", "auditor"],
      providerBindingKey: "answer",
      selectorReasoningEffort: "medium",
      supplementReasoningEffort: "low",
      version: 1
    } as const,
    expectedReasoningEfforts: [],
    snapshotVersion: 5
  }, {
    current: false,
    executionPolicy: {
      auditorReasoningEffort: "high",
      draftReasoningEffort: "low",
      egressDestination: "answer_provider",
      overriddenRoles: ["selector", "auditor"],
      providerBindingKey: "answer",
      selectorReasoningEffort: "medium",
      supplementReasoningEffort: "low",
      version: 1
    } as const,
    expectedReasoningEfforts: [],
    snapshotVersion: 6
  }, {
    current: true,
    executionPolicy: {
      auditorReasoningEffort: "high",
      draftReasoningEffort: "low",
      egressDestination: "answer_provider",
      overriddenRoles: ["selector", "auditor"],
      providerBindingKey: "answer",
      selectorReasoningEffort: "medium",
      supplementReasoningEffort: "low",
      version: 1
    } as const,
    expectedReasoningEfforts: ["high", "medium"],
    snapshotVersion: 7
  }])("handles persisted V21 snapshot V$snapshotVersion independently of rollout",
    async ({ current, executionPolicy, expectedReasoningEfforts, snapshotVersion }) => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const dispatch = knowledgeProviderDispatchRecorder("dispatch");
    const acceptedDraft = {
      claims: [{
        citationHints: ["K1"],
        text: "Recovered focused evidence"
      }],
      version: 1
    };
    const primaryPrompt = knowledgeAnswerDraftPromptV21({
      draftPass: "primary",
      evidenceManifest: dispatch.draft.message,
      request: "remember this",
      routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION
    });
    const acceptedRequest = createKnowledgeAnswerOperationRequestSnapshotV21({
      contractVersion: 21,
      evidenceReceiptHash: dispatch.draft.manifestHash,
      maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
      operation: KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
      ...(snapshotVersion === 7
        ? {
            executionPolicy: executionPolicy!,
            protocol: "scope_v6_targeted_delta_v3" as const
          }
        : snapshotVersion === 6
        ? { executionPolicy: executionPolicy!, protocol: "scope_v6" as const }
        : snapshotVersion === 5
          ? { executionPolicy: executionPolicy!, protocol: "scope_v5" as const }
        : snapshotVersion === 4
          ? { executionPolicy: executionPolicy!, protocol: "scope_v4" as const }
        : snapshotVersion === 3
          ? { executionPolicy: executionPolicy!, protocol: "scope_v3" as const }
        : executionPolicy ? { executionPolicy } : {}),
      schema: KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
      systemPrompt: primaryPrompt.systemPrompt,
      transport: "provider_neutral_json",
      userPrompt: primaryPrompt.userPrompt
    });
    const settledAt = new Date("2026-07-12T09:02:00.000Z");
    const draftDispatch: StoredKnowledgeEvidenceDispatch = {
      ...dispatch.dispatch,
      attempt: {
        ...dispatch.dispatch.attempt,
        acceptedRequest,
        acceptedResult: acceptedDraft,
        actualUsage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          estimatedCostMicros: null,
          inputTokens: 5,
          outputTokens: 3,
          reasoningTokens: 0,
          totalTokens: 8
        },
        contractVersion: 21,
        dispatchedAt: new Date("2026-07-12T09:01:00.000Z"),
        evidenceReceiptHash: dispatch.draft.manifestHash,
        leaseExpiresAt: null,
        leaseToken: null,
        providerResponseId: "response-v21-draft",
        purpose: KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
        requestHash: "1".repeat(64),
        resultAcceptedAt: settledAt,
        resultHash: "2".repeat(64),
        settledAt,
        state: "settled"
      }
    };
    vi.mocked(dispatch.lifecycle.inspect).mockImplementation(async ({ ordinal }) =>
      ordinal === 1 ? draftDispatch : null);
    const requests: ProviderRunRequest[] = [];
    const groundKnowledgeAnswerV5 = vi.fn<NonNullable<
      RunRecoveryRepository["groundKnowledgeAnswerV5"]
    >>(async () => recoveredKnowledgeV5Finalization());
    const groundKnowledgeAnswerV21 = vi.fn<NonNullable<
      RunRecoveryRepository["groundKnowledgeAnswerV21"]
    >>(async () => recoveredKnowledgeV21Finalization());
    const harness = createHarness({
      controls: [control({ providerResponseId: null })],
      groundKnowledgeAnswerV5,
      groundKnowledgeAnswerV21,
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: fixture.normalizedRequest,
      providers: {
        openai: {
          buildRequestPreview: (request) => ({ context: request.context }),
          async *stream(request) {
            requests.push(request);
            return {
              ...providerResult,
              finalText: JSON.stringify(snapshotVersion === 7 && requests.length === 1
                ? {
                    evidenceUnits: [{
                      findings: [{
                        description: "Answer the exact saved request.",
                        evidenceAtomIds: ["A1"],
                        requestAnchor: "remember this"
                      }],
                      handle: "K1"
                    }],
                    jointFindings: [],
                    unsupportedDimensions: [],
                    version: 6
                  }
                : snapshotVersion === 7
                  ? {
                      claims: [{
                        id: "C1",
                        supportHandles: ["K1"],
                        verdict: "supported"
                      }],
                      coverage: [{
                        id: "D1",
                        status: "covered",
                        supportIds: ["C1"]
                      }],
                      extractIds: [],
                      insufficientReason: "not_applicable",
                      version: 1
                    }
                  : {}),
              providerResponseId: `response-v21-${requests.length}`
            };
          }
        }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(requests).toHaveLength(expectedReasoningEfforts.length);
    expect(requests.map(({ params }) => params.reasoningEffort))
      .toEqual(expectedReasoningEfforts);
    if (current) {
      expect(dispatch.lifecycle.prepare).toHaveBeenCalledTimes(2);
      expect(dispatch.lifecycle.prepare).toHaveBeenNthCalledWith(1,
        expect.objectContaining({
          contractVersion: 6,
          ordinal: 2,
          purpose: "knowledge_coverage_scope_v6"
        }));
      expect(dispatch.lifecycle.prepare).toHaveBeenNthCalledWith(2,
        expect.objectContaining({
          contractVersion: 21,
          ordinal: 3,
          purpose: "knowledge_grounded_selector_v21"
        }));
      expect(groundKnowledgeAnswerV5).not.toHaveBeenCalled();
      expect(groundKnowledgeAnswerV21).toHaveBeenCalledWith({ runId, userId });
      expect(harness.state.completed?.finalText).toBe("Recovered audited answer [K1]");
      expect(harness.state.failed).toEqual([]);
    } else {
      expect(dispatch.lifecycle.prepare).not.toHaveBeenCalled();
      expect(groundKnowledgeAnswerV5).not.toHaveBeenCalled();
      expect(groundKnowledgeAnswerV21).not.toHaveBeenCalled();
      expect(harness.state.completed).toBeNull();
      expect(harness.state.failed).toEqual([{
        assistantMessageId: "assistant-1",
        error: {
          code: "knowledge_answer_contract_failed",
          message: "The Knowledge answer did not satisfy the required output contract."
        },
        runId
      }]);
    }
  });

  it("rebuilds full-context evidence before starting Draft V5 without retrieval", async () => {
    const base = normalizedKnowledgeRequest();
    const normalizedRequest: NormalizedRunRequest = {
      ...base,
      knowledgeAnswering: {
        answerPolicy: DEFAULT_KNOWLEDGE_ANSWER_POLICY,
        approximateDocumentTokens: 100,
        evidenceCount: 1,
        exactDocumentTokens: 100,
        route: "full_context_v1",
        version: 1
      },
      modelCapabilities: {
        ...base.modelCapabilities,
        contextWindow: 10_000,
        toolCalling: false
      },
      toolMode: "none"
    };
    const draft = packKnowledgeEvidenceDispatchManifest({
      allowExpandedContextOmission: false,
      candidates: [{
        ambiguity: "none",
        evidenceId: "full-context-evidence-1:result:1",
        exactExcerpt: "Recovered full-context evidence",
        fileName: "recovery.txt",
        handle: "K1",
        locator: "page=1; heading=Recovery; source-passage=1",
        operationOrdinal: 0,
        resultOrdinal: 1,
        sourceAlias: "S1",
        sourceLabel: "Recovery source",
        sourceTruncated: false,
        sourceVersionNumber: 1,
        state: "available"
      }],
      coverageStatement: "The full admitted corpus is included with no passage omitted.",
      footer: "</private_knowledge_evidence>",
      header: '<private_knowledge_evidence version="10" coverage="full_admitted_corpus">',
      maximumBytes: 28_000,
      maximumTokens: 7_000,
      profileId: "openai:gpt-test",
      promptFragmentVersion: 16,
      runtimeVersion: 2
    });
    const dispatch = knowledgeProviderDispatchRecorder("dispatch", draft);
    vi.mocked(dispatch.lifecycle.inspect).mockResolvedValue(null);
    const requests: ProviderRunRequest[] = [];
    const harness = createHarness({
      controls: [control({ providerResponseId: null })],
      knowledgeFullContextDispatchRecovery: {
        draft,
        evidenceBindings: [{
          dispatchEvidenceId: "full-context-evidence-1:result:1",
          evidenceItemId: "evidence-item-1"
        }]
      },
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: normalizedRequest,
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream(request) {
            requests.push(request);
            return {
              ...providerResult,
              finalText: requests.length === 1
                ? JSON.stringify({
                    dimensions: [{ description: "The requested answer.", id: "D1" }],
                    version: 1
                  })
                : requests.length === 2
                ? JSON.stringify({
                    claims: [{ citationHints: ["K1"], text: "Recovered full-context evidence" }],
                    version: 1
                  })
                  : JSON.stringify({
                      claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
                      coverage: [{
                        id: "D1",
                        status: "covered",
                        supportIds: ["C1"]
                      }],
                      extractIds: [],
                      insufficientReason: "not_applicable",
                      version: 1
                    })
            };
          }
        }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(requests).toHaveLength(3);
    expect(dispatch.lifecycle.prepare).toHaveBeenCalledTimes(3);
    expect(dispatch.lifecycle.prepare).toHaveBeenNthCalledWith(1, expect.objectContaining({
      evidenceBindings: [{
        dispatchEvidenceId: "full-context-evidence-1:result:1",
        evidenceItemId: "evidence-item-1"
      }],
      purpose: "knowledge_coverage_planner_v20"
    }));
    expect(harness.state.completed?.finalText).toBe("Recovered grounded answer [K1]");
    expect(harness.state.failed).toEqual([]);
  });

  it("terminalizes zero focused retrieval candidates without answer-provider I/O or retry", async () => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const dispatch = knowledgeProviderDispatchRecorder("dispatch");
    vi.mocked(dispatch.lifecycle.inspect).mockResolvedValue(null);
    const execute = vi.fn(async () => focusedKnowledgeZeroCandidateResult());
    const refresh = vi.fn<NonNullable<ProviderAdapter["refresh"]>>();
    const stream = vi.fn(async function* () {
      return providerResult;
    });
    const terminal = control({
      providerResponseId: null,
      recoverySettled: true,
      status: "error"
    });
    const harness = createHarness({
      controls: [control({ providerResponseId: null }), terminal],
      knowledgeExecutor: {
        accepts: (name) => name === KNOWLEDGE_FOCUSED_OPERATION_NAME,
        capability: "knowledge",
        execute,
        tool: knowledgeRetrievalTool,
        tools: []
      },
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: fixture.normalizedRequest,
      providers: {
        openai: { buildRequestPreview: () => ({}), refresh, stream }
      }
    });
    const persistedCall: PersistedToolLoopCall = {
      arguments: focusedKnowledgeCallArguments(fixture.knowledgeFocusedRequest),
      completedAt: null,
      id: "focused-call-row-zero",
      mcpBinding: null,
      ordinal: 0,
      providerCallId: FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID,
      result: null,
      roundIndex: 0,
      startedAt: null,
      state: "pending",
      toolName: KNOWLEDGE_FOCUSED_OPERATION_NAME
    };
    harness.repository.loadFocusedKnowledgeCall = async () => persistedCall;
    harness.repository.claimAutomaticKnowledgeCall = async () => ({
      call: { ...persistedCall, state: "running" },
      kind: "claimed"
    });
    harness.repository.settleToolLoopCall = async () => "settled";

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(execute).toHaveBeenCalledOnce();
    expect(dispatch.lifecycle.prepare).not.toHaveBeenCalled();
    expect(dispatch.lifecycle.dispatch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "no_retrieval_candidates",
        message: "No retrieval candidates were found in the ready Knowledge sources."
      },
      runId
    }]);
    expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
  });

  it("terminalizes a tombstoned persisted focused scope before retrieval or provider I/O", async () => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const dispatch = knowledgeProviderDispatchRecorder("dispatch");
    vi.mocked(dispatch.lifecycle.inspect).mockResolvedValue(null);
    const execute = vi.fn(async () => focusedKnowledgeRetrievalResult());
    const authorizeSnapshot = vi.fn(async () => true);
    const refresh = vi.fn<NonNullable<ProviderAdapter["refresh"]>>();
    const stream = vi.fn(async function* () {
      return providerResult;
    });
    const harness = createHarness({
      controls: [
        control({ providerResponseId: null }),
        control({ providerResponseId: null, recoverySettled: true, status: "error" })
      ],
      focusedKnowledgeRecoveryScope: null,
      knowledgeAdmission: {
        authorizeSnapshot,
        load: vi.fn(async () => ({ bindings: [], sources: [] }) as never)
      },
      knowledgeExecutor: {
        accepts: (name) => name === KNOWLEDGE_FOCUSED_OPERATION_NAME,
        capability: "knowledge",
        execute,
        tool: knowledgeRetrievalTool,
        tools: []
      },
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: fixture.normalizedRequest,
      providers: {
        openai: { buildRequestPreview: () => ({}), refresh, stream }
      }
    });
    const persistedCall: PersistedToolLoopCall = {
      arguments: focusedKnowledgeCallArguments(fixture.knowledgeFocusedRequest),
      completedAt: null,
      id: "focused-call-row-processing",
      mcpBinding: null,
      ordinal: 0,
      providerCallId: FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID,
      result: null,
      roundIndex: 0,
      startedAt: null,
      state: "pending",
      toolName: KNOWLEDGE_FOCUSED_OPERATION_NAME
    };
    const claim = vi.fn(async () => ({ kind: "not_found" as const }));
    harness.repository.loadFocusedKnowledgeCall = async () => persistedCall;
    harness.repository.claimAutomaticKnowledgeCall = claim;

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(authorizeSnapshot).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(dispatch.lifecycle.prepare).not.toHaveBeenCalled();
    expect(dispatch.lifecycle.dispatch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "knowledge_retrieval_failed",
        message: "Knowledge retrieval failed."
      },
      runId
    }]);
    expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
  });

  it("reauthorizes the exact focused Source tuple before recovered retrieval", async () => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const authorization = focusedKnowledgeRecoveryAuthorizationFixture();
    const authorizeSnapshot = vi.fn(async (input) => {
      expect(input.snapshot).toEqual(authorization.scope);
      return false;
    });
    const dispatch = knowledgeProviderDispatchRecorder("dispatch");
    vi.mocked(dispatch.lifecycle.inspect).mockResolvedValue(null);
    const execute = vi.fn(async () => focusedKnowledgeRetrievalResult());
    const claim = vi.fn(async () => ({ kind: "not_found" as const }));
    const stream = vi.fn(async function* () {
      return providerResult;
    });
    const harness = createHarness({
      controls: [control({ providerResponseId: null })],
      focusedKnowledgeRecoveryScope: authorization.scope,
      knowledgeAdmission: {
        authorizeSnapshot,
        load: vi.fn(async () => authorization.admitted)
      },
      knowledgeExecutor: {
        accepts: (name) => name === KNOWLEDGE_FOCUSED_OPERATION_NAME,
        capability: "knowledge",
        execute,
        tool: knowledgeRetrievalTool,
        tools: []
      },
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: fixture.normalizedRequest,
      providers: { openai: { buildRequestPreview: () => ({}), stream } }
    });
    harness.repository.loadFocusedKnowledgeCall = async () => null;
    harness.repository.claimAutomaticKnowledgeCall = claim;

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(authorizeSnapshot).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(dispatch.lifecycle.prepare).not.toHaveBeenCalled();
    expect(dispatch.lifecycle.dispatch).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([{
      assistantMessageId: "assistant-1",
      error: { code: "knowledge_retrieval_failed", message: "Knowledge retrieval failed." },
      runId
    }]);
    expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
  });

  it("reauthorizes focused authority again after manifest preparation and before provider egress", async () => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const authorization = focusedKnowledgeRecoveryAuthorizationFixture();
    const authorizeSnapshot = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const dispatch = knowledgeProviderDispatchRecorder("dispatch");
    let prepared = false;
    vi.mocked(dispatch.lifecycle.inspect).mockImplementation(async () =>
      prepared ? dispatch.dispatch : null);
    vi.mocked(dispatch.lifecycle.prepare).mockImplementation(async () => {
      prepared = true;
      return dispatch.prepared;
    });
    const execute = vi.fn(async () => focusedKnowledgeRetrievalResult());
    const stream = vi.fn(async function* () {
      return providerResult;
    });
    const harness = createHarness({
      controls: [control({ providerResponseId: null })],
      focusedKnowledgeRecoveryScope: authorization.scope,
      knowledgeAdmission: {
        authorizeSnapshot,
        load: vi.fn(async () => authorization.admitted)
      },
      knowledgeExecutor: {
        accepts: (name) => name === KNOWLEDGE_FOCUSED_OPERATION_NAME,
        capability: "knowledge",
        execute,
        tool: knowledgeRetrievalTool,
        tools: []
      },
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: fixture.normalizedRequest,
      providers: { openai: { buildRequestPreview: () => ({}), stream } }
    });
    const persistedCall: PersistedToolLoopCall = {
      arguments: focusedKnowledgeCallArguments(fixture.knowledgeFocusedRequest),
      completedAt: null,
      id: "focused-call-row-reauthorize",
      mcpBinding: null,
      ordinal: 0,
      providerCallId: FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID,
      result: null,
      roundIndex: 0,
      startedAt: null,
      state: "pending",
      toolName: KNOWLEDGE_FOCUSED_OPERATION_NAME
    };
    harness.repository.loadFocusedKnowledgeCall = async () => persistedCall;
    harness.repository.claimAutomaticKnowledgeCall = async () => ({
      call: { ...persistedCall, state: "running" },
      kind: "claimed"
    });
    harness.repository.settleToolLoopCall = async () => "settled";

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(authorizeSnapshot).toHaveBeenCalledTimes(2);
    expect(authorizeSnapshot).toHaveBeenNthCalledWith(1, expect.objectContaining({
      snapshot: authorization.scope
    }));
    expect(authorizeSnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({
      snapshot: authorization.scope
    }));
    expect(execute).toHaveBeenCalledOnce();
    expect(dispatch.lifecycle.prepare).toHaveBeenCalledOnce();
    expect(dispatch.lifecycle.dispatch).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([{
      assistantMessageId: "assistant-1",
      error: { code: "knowledge_answer_failed", message: "The Knowledge answer provider failed." },
      runId
    }]);
    expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
  });

  it("never executes a retired Knowledge checkpoint through generic tool-loop recovery", async () => {
    const execute = vi.fn(async () => focusedKnowledgeRetrievalResult());
    const refresh = vi.fn<NonNullable<ProviderAdapter["refresh"]>>();
    const stream = vi.fn(async function* () {
      return providerResult;
    });
    const harness = createHarness({
      knowledgeExecutor: {
        accepts: () => true,
        capability: "knowledge",
        execute,
        tool: knowledgeRetrievalTool,
        tools: []
      },
      providers: {
        openai: { buildRequestPreview: () => ({}), refresh, stream }
      }
    });
    const legacyCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      mcpBinding: null,
      toolName: "retrieve_knowledge"
    };
    installCheckpointState(harness, {
      ...checkpointedRun({ calls: [legacyCall], phase: "tools_pending" }),
      normalizedRequest: normalizedKnowledgeRequest()
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(execute).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "knowledge_legacy_runtime_retired",
        message:
          "Checkpointed legacy Knowledge calls cannot be replayed through the generic tool loop."
      },
      runId
    }]);
    expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
  });

  it("recovers a pending search_knowledge call and replays its result into continuation", async () => {
    const authorization = focusedKnowledgeRecoveryAuthorizationFixture();
    const egress = createRecoveryMemoryEgressRecorder();
    const dispatch = knowledgeProviderDispatchRecorder("dispatch");
    vi.mocked(dispatch.lifecycle.inspect).mockResolvedValue(null);
    const execute = vi.fn(async (call: { id: string; name: string }) => {
      const result = focusedKnowledgeRetrievalResult();
      return { ...result, callId: call.id, name: call.name };
    });
    const requests: ProviderRunRequest[] = [];
    const harness = createHarness({
      focusedKnowledgeRecoveryScope: authorization.scope,
      knowledgeAdmission: {
        authorizeSnapshot: vi.fn(async () => true),
        load: vi.fn(async () => authorization.admitted)
      },
      knowledgeExecutor: {
        accepts: (name) => name === KNOWLEDGE_SEARCH_TOOL_NAME,
        capability: "knowledge",
        execute,
        preflight: vi.fn(async () => ({ kind: "admitted" as const })),
        tool: knowledgeRetrievalTool,
        tools: [knowledgeRetrievalTool]
      },
      groundKnowledgeAnswerV5: async () =>
        recoveredKnowledgeV5Finalization("Recovered answer"),
      knowledgeProviderDispatch: dispatch.lifecycle,
      memoryEgress: egress.service,
      providerDispatchRecoveryRequest: normalizedKnowledgeRequest(),
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream(request) {
            requests.push(request);
            if (request.tools?.length) return providerResult;
            const answerOperationOrdinal = requests.filter(
              (candidate) => !candidate.tools?.length
            ).length;
            return {
              ...providerResult,
              finalText: answerOperationOrdinal === 1
                ? JSON.stringify({
                    dimensions: [{ description: "The requested answer.", id: "D1" }],
                    version: 1
                  })
                : answerOperationOrdinal === 2
                ? JSON.stringify({
                    claims: [{ citationHints: ["K1"], text: "Recovered focused evidence" }],
                    version: 1
                  })
                : JSON.stringify({
                    claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
                    coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
                    extractIds: [],
                    insufficientReason: "not_applicable",
                    version: 1
                  })
            };
          }
        }
      }
    });
    const knowledgeCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "remember this" },
      mcpBinding: null,
      providerCallId: "knowledge-provider-call-1",
      toolName: KNOWLEDGE_SEARCH_TOOL_NAME
    };
    installCheckpointState(harness, {
      ...checkpointedRun({ calls: [knowledgeCall], phase: "tools_pending" }),
      knowledgeScope: {
        bindings: authorization.admitted.bindings,
        budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
        exclusions: [],
        knowledgePlan: authorization.scope.knowledgePlan,
        resolvedSourceCount: 1
      },
      normalizedRequest: normalizedKnowledgeRequest()
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(execute).toHaveBeenCalledOnce();
    expect(harness.state.failed).toEqual([]);
    expect(harness.state.completed).toMatchObject({ finalText: "Recovered answer" });
    expect(dispatch.lifecycle.prepare).toHaveBeenCalledTimes(3);
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[0]?.providerToolMessages)).toContain(
      "Recovered focused evidence"
    );
    expect(egress.began.some((receipt) => receipt.destinationKind === "knowledge"))
      .toBe(true);
  });

  it("terminalizes a recovered Knowledge tool loop with zero evidence without exposing provider text", async () => {
    const authorization = focusedKnowledgeRecoveryAuthorizationFixture();
    const execute = vi.fn(async (call: { id: string; name: string }) => ({
      ...focusedKnowledgeZeroCandidateResult(),
      callId: call.id,
      name: call.name
    }));
    const stream = vi.fn(async function* () {
      yield { data: { delta: "UNTRUSTED_PROVIDER_FINAL_TEXT" }, type: "token" } as const;
      return providerResult;
    });
    const harness = createHarness({
      focusedKnowledgeRecoveryScope: authorization.scope,
      knowledgeAdmission: {
        authorizeSnapshot: vi.fn(async () => true),
        load: vi.fn(async () => authorization.admitted)
      },
      knowledgeExecutor: {
        accepts: (name) => name === KNOWLEDGE_SEARCH_TOOL_NAME,
        capability: "knowledge",
        execute,
        preflight: vi.fn(async () => ({ kind: "admitted" as const })),
        tool: knowledgeRetrievalTool,
        tools: [knowledgeRetrievalTool]
      },
      providers: { openai: { buildRequestPreview: () => ({}), stream } }
    });
    const knowledgeCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "missing evidence", sourceAliases: [] },
      mcpBinding: null,
      providerCallId: "knowledge-provider-call-empty",
      toolName: KNOWLEDGE_SEARCH_TOOL_NAME
    };
    installCheckpointState(harness, {
      ...checkpointedRun({ calls: [knowledgeCall], phase: "tools_pending" }),
      knowledgeScope: {
        bindings: authorization.admitted.bindings,
        budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
        exclusions: [],
        knowledgePlan: authorization.scope.knowledgePlan,
        resolvedSourceCount: 1
      },
      normalizedRequest: normalizedKnowledgeRequest()
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(execute).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledOnce();
    expect(harness.state.completed?.finalText).toBe(KNOWLEDGE_INSUFFICIENT_MESSAGE);
    expect(harness.state.assistantTexts).toEqual([]);
    expect(harness.state.failed).toEqual([]);
  });

  it("rebuilds and dispatches an expired non-checkpointed RESERVED attempt exactly once", async () => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const normalizedRequest: NormalizedRunRequest = {
      ...fixture.normalizedRequest,
      modelCapabilities: {
        ...fixture.normalizedRequest.modelCapabilities,
        toolCalling: true
      },
      toolMode: "auto"
    };
    const dispatch = knowledgeProviderDispatchRecorder("dispatch");
    const requests: ProviderRunRequest[] = [];
    const refresh = vi.fn<NonNullable<ProviderAdapter["refresh"]>>();
    const harness = createHarness({
      controls: [control({ providerResponseId: null })],
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: normalizedRequest,
      providers: {
        openai: {
          buildRequestPreview: (request) => ({ context: request.context }),
          refresh,
          async *stream(request) {
            requests.push(request);
            return {
              finalProviderResponsePreview: {},
              finalText: "Recovered direct answer",
              providerResponseId: "response-recovered-direct",
              usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
            };
          }
        }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ toolChoice: "none" });
    expect(requests[0]?.tools).toBeUndefined();
    expect(JSON.stringify(requests[0]?.context)).toContain(
      "PERSISTED_EXACT_RECOVERY_MANIFEST"
    );
    expect(JSON.stringify(requests[0]?.context)).not.toContain(
      "RECOMPUTED_RECOVERY_EVIDENCE"
    );
    expect(dispatch.lifecycle.recover).toHaveBeenCalledTimes(2);
    expect(dispatch.lifecycle.recover).toHaveBeenNthCalledWith(1, {
      modelRunId: runId,
      ordinal: 1,
      providerResponseId: null
    });
    expect(dispatch.lifecycle.recover).toHaveBeenNthCalledWith(2, expect.objectContaining({
      modelRunId: runId,
      ordinal: 1,
      requestPreview: expect.objectContaining({
        context: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              id: "knowledge-evidence:v2",
              purpose: "knowledge_evidence"
            })
          ])
        })
      })
    }));
    expect(dispatch.lifecycle.dispatch).toHaveBeenCalledOnce();
    expect(dispatch.lifecycle.settle).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered direct answer",
      providerResponseId: "response-recovered-direct"
    });
  });

  it("persists the final response handle before settlement and resumes without redispatch", async () => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const normalizedRequest: NormalizedRunRequest = {
      ...fixture.normalizedRequest,
      toolMode: "none"
    };
    const dispatch = knowledgeProviderDispatchRecorder("dispatch");
    let claimed = false;
    vi.mocked(dispatch.lifecycle.recover).mockImplementation(async (input) => {
      if (!claimed && input.requestPreview === undefined) {
        return { dispatch: dispatch.dispatch, kind: "request_required" };
      }
      if (!claimed) {
        claimed = true;
        return { kind: "dispatch", prepared: dispatch.prepared, providerResponseId: null };
      }
      return {
        kind: "resume",
        prepared: dispatch.prepared,
        providerResponseId: "response-recovered-direct"
      };
    });
    vi.mocked(dispatch.lifecycle.settle)
      .mockRejectedValueOnce(new Error("simulated crash after provider completion"));
    const stream = vi.fn(async function* () {
      return {
        ...providerResult,
        finalText: "Recovered direct answer",
        providerResponseId: "response-recovered-direct"
      };
    });
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      providerResponseId: "response-recovered-direct",
      result: {
        ...providerResult,
        finalText: "Recovered direct answer",
        providerResponseId: "response-recovered-direct"
      },
      status: "completed",
      terminal: true
    }));
    const harness = createHarness({
      controls: [
        control({ providerResponseId: null }),
        control({ providerResponseId: "response-recovered-direct" })
      ],
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: normalizedRequest,
      providers: {
        openai: {
          buildRequestPreview: (request) => ({ context: request.context }),
          refresh,
          stream
        }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    expect(harness.state.providerResponseIds).toEqual([{
      providerResponseId: "response-recovered-direct",
      runId
    }]);
    expect(harness.state.completed).toBeNull();

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(stream).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(dispatch.lifecycle.dispatch).toHaveBeenCalledOnce();
    expect(dispatch.lifecycle.settle).toHaveBeenCalledTimes(2);
    expect(dispatch.lifecycle.markAmbiguous).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([]);
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered direct answer",
      providerResponseId: "response-recovered-direct"
    });
  });

  it.each([
    {
      code: "knowledge_answer_contract_failed" as const,
      finalText: "missing required status\nRecovered answer",
      message: "The Knowledge answer did not satisfy the required output contract."
    },
    {
      code: "knowledge_citation_contract_failed" as const,
      finalText: "AIQSA_KB_STATUS=ANSWERED\nRecovered answer [K999]",
      message: "The Knowledge answer cited evidence outside the final manifest."
    }
  ])("terminalizes a recovered focused $code without redispatch", async ({
    code,
    finalText,
    message
  }) => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const dispatch = knowledgeProviderDispatchRecorder("settled");
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      providerResponseId: "response-new",
      result: { ...providerResult, finalText },
      status: "completed",
      terminal: true
    }));
    const groundKnowledgeAnswer = vi.fn(async () => {
      throw Object.assign(new Error("private contract diagnostic"), { code });
    });
    const terminal = control({ recoverySettled: true, status: "error" });
    const harness = createHarness({
      controls: [control(), control(), control(), terminal],
      groundKnowledgeAnswer,
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: fixture.normalizedRequest,
      providers: { openai: providerWithRefresh(refresh) }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledOnce();
    expect(dispatch.lifecycle.dispatch).not.toHaveBeenCalled();
    expect(groundKnowledgeAnswer).toHaveBeenCalledOnce();
    expect(harness.state.completed).toBeNull();
    expect(harness.state.failed).toEqual([{
      assistantMessageId: "assistant-1",
      error: { code, message },
      runId
    }]);
    expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
  });

  it("terminalizes provider tool calls in a focused answer as a safe answer failure", async () => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const dispatch = knowledgeProviderDispatchRecorder("settled");
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      providerResponseId: "response-new",
      result: {
        ...providerResult,
        toolCalls: [{ arguments: {}, id: "unexpected-call", name: "unexpected_tool" }]
      },
      status: "completed",
      terminal: true
    }));
    const terminal = control({ recoverySettled: true, status: "error" });
    const harness = createHarness({
      controls: [control(), control(), control(), terminal],
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: fixture.normalizedRequest,
      providers: { openai: providerWithRefresh(refresh) }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledOnce();
    expect(dispatch.lifecycle.dispatch).not.toHaveBeenCalled();
    expect(harness.state.completed).toBeNull();
    expect(harness.state.failed).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "knowledge_answer_failed",
        message: "The Knowledge answer provider failed."
      },
      runId
    }]);
  });

  it("never exposes or retries a focused provider refresh error", async () => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const dispatch = knowledgeProviderDispatchRecorder("settled");
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => {
      throw new Error("private upstream refresh diagnostic");
    });
    const terminal = control({ recoverySettled: true, status: "error" });
    const harness = createHarness({
      controls: [control(), control(), terminal],
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: fixture.normalizedRequest,
      providers: { openai: providerWithRefresh(refresh) }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.state.failed).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "knowledge_answer_failed",
        message: "The Knowledge answer provider failed."
      },
      runId
    }]);
  });

  it("replaces a terminal focused provider error with the safe fixed state", async () => {
    const fixture = focusedKnowledgeProviderRecoveryFixture();
    const dispatch = knowledgeProviderDispatchRecorder("settled");
    const harness = createHarness({
      controls: [control(), control(), control()],
      knowledgeProviderDispatch: dispatch.lifecycle,
      providerDispatchRecoveryRequest: fixture.normalizedRequest,
      providers: {
        openai: providerWithRefresh(async () => ({
          error: {
            code: "private_provider_code",
            message: "private provider terminal diagnostic"
          },
          events: [],
          status: "failed",
          terminal: true
        }))
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.failed).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "knowledge_answer_failed",
        message: "The Knowledge answer provider failed."
      },
      runId
    }]);
    expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
  });

  it.each(["ambiguous", "released"] as const)(
    "terminalizes a %s focused provider attempt without provider I/O",
    async (recoveryKind) => {
      const fixture = focusedKnowledgeProviderRecoveryFixture();
      const dispatch = knowledgeProviderDispatchRecorder(recoveryKind);
      const refresh = vi.fn<NonNullable<ProviderAdapter["refresh"]>>();
      const stream = vi.fn(async function* () {
        return providerResult;
      });
      const harness = createHarness({
        knowledgeProviderDispatch: dispatch.lifecycle,
        providerDispatchRecoveryRequest: fixture.normalizedRequest,
        providers: {
          openai: { buildRequestPreview: () => ({}), refresh, stream }
        }
      });

      await refreshProviderRunIfNeeded(harness.deps, runId, userId);

      expect(dispatch.lifecycle.recover).toHaveBeenCalledOnce();
      expect(dispatch.lifecycle.dispatch).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
      expect(harness.state.failed).toEqual([{
        assistantMessageId: "assistant-1",
        error: {
          code: "knowledge_answer_failed",
          message: "The Knowledge answer provider failed."
        },
        runId
      }]);
      expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
    }
  );

  it.each([
    {
      code: "provider_response_handle_missing",
      message: "The completed provider round has no durable response handle for recovery.",
      providerResponseId: null,
      recoveryKind: "settled_without_handle" as const
    },
    {
      code: "provider_refresh_unavailable",
      message: "The saved provider response cannot be refreshed safely.",
      providerResponseId: "response-old",
      recoveryKind: "settled" as const
    }
  ])("settles missing SETTLED recovery capability terminally: $code", async ({
    code,
    message,
    providerResponseId,
    recoveryKind
  }) => {
    const dispatch = knowledgeProviderDispatchRecorder(recoveryKind);
    const stream = vi.fn(async function* () {
      return providerResult;
    });
    const harness = createHarness({
      controls: [
        control({ providerResponseId }),
        control({ providerResponseId, recoverySettled: true, status: "error" })
      ],
      knowledgeProviderDispatch: dispatch.lifecycle,
      providers: {
        openai: { buildRequestPreview: () => ({}), stream }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(stream).not.toHaveBeenCalled();
    expect(dispatch.lifecycle.recover).toHaveBeenCalledOnce();
    expect(harness.state.run).toMatchObject({
      recoverySettled: true,
      status: "error"
    });
    expect(harness.state.failed).toEqual([{
      assistantMessageId: "assistant-1",
      error: { code, message },
      runId
    }]);
  });

  it("fails recovery with attributable usage instead of finalizing an intermediate tool-call response", async () => {
    const intermediateResult: ProviderRunResult = {
      finalProviderResponsePreview: {
        id: "response-tool-call",
        status: "completed"
      },
      finalText: "",
      providerResponseId: "response-tool-call",
      toolCalls: [
        {
          arguments: { query: "current information" },
          id: "call-1",
          name: "search_engine_1"
        }
      ],
      usage: {
        inputTokens: 7,
        outputTokens: 2,
        reasoningTokens: 1,
        totalTokens: 9
      }
    };
    const harness = createHarness({
      controls: [control({ status: "error" })],
      providers: {
        openai: providerWithRefresh(async () => ({
          events: [providerEvent],
          providerResponseId: "response-tool-call",
          result: intermediateResult,
          status: "completed",
          terminal: true
        }))
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.completed).toBeNull();
    expect(harness.state.failed).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: {
          code: "tool_loop_recovery_required",
          message: "The provider response contains outstanding tool calls and cannot be finalized as an answer. Retry the run."
        },
        runId
      }
    ]);
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: {
          code: "tool_loop_recovery_required",
          message: "The provider response contains outstanding tool calls and cannot be finalized as an answer. Retry the run."
        },
        outputEvents: [providerEvent],
        providerResponseId: "response-tool-call",
        runId,
        usageAttributions: [
          {
            estimatedCostMicros: 110,
            modelId: "gpt-test",
            provider: "openai",
            usage: {
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              inputTokens: 7,
              outputTokens: 2,
              reasoningTokens: 1,
              totalTokens: 9
            }
          }
        ],
        userId
      })
    ]);
    expect(harness.state.events.map(({ event }) => event.type)).toEqual(["artifact"]);
  });

  it("does not append terminal refresh events when another writer wins completion", async () => {
    const harness = createHarness({
      completeRun: false,
      providers: {
        openai: providerWithRefresh(async () => ({
          events: [providerEvent],
          result: providerResult,
          status: "completed",
          terminal: true
        }))
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.operations).toEqual(["update_response_id", "complete"]);
    expect(harness.state.events).toEqual([]);
  });

  it("stops settlement when cancellation changes status after provider refresh", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [providerEvent],
      result: providerResult,
      status: "completed",
      terminal: true
    }));
    const harness = createHarness({
      controls: [control(), control({ status: "cancelled" })],
      providers: {
        openai: providerWithRefresh(refresh)
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.state.providerResponseIds).toEqual([]);
    expect(harness.state.completed).toBeNull();
    expect(harness.state.events).toEqual([]);
  });

  it("persists reloadable output artifacts from a non-terminal refresh", async () => {
    const harness = createHarness({
      controls: [control({ status: "error" })],
      providers: {
        openai: providerWithRefresh(async () => ({
          events: [providerEvent],
          providerResponseId: "response-next",
          status: "in_progress",
          terminal: false
        }))
      }
    });
    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.events).toEqual([
      {
        event: providerEvent,
        runId,
        sequence: 0
      }
    ]);
    expect(harness.state.providerResponseIds).toEqual([
      {
        providerResponseId: "response-next",
        runId
      }
    ]);
  });

  it("persists refresh failures only while the latest run is active", async () => {
    const provider = providerWithRefresh(async () => {
      throw new Error("provider unavailable");
    });
    const activeHarness = createHarness({ providers: { openai: provider } });

    await refreshProviderRunIfNeeded(activeHarness.deps, runId, userId);

    expect(activeHarness.state.failed).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: {
          code: "provider_refresh_failed",
          message: "provider unavailable"
        },
        runId
      }
    ]);
    expect(activeHarness.state.events).toEqual([]);

    const cancelledHarness = createHarness({
      controls: [control(), control({ status: "cancelled" })],
      providers: { openai: provider }
    });
    await refreshProviderRunIfNeeded(cancelledHarness.deps, runId, userId);
    expect(cancelledHarness.state.failed).toEqual([]);
    expect(cancelledHarness.state.events).toEqual([]);
  });

  it("settles terminal provider errors while retaining only refreshed output artifacts", async () => {
    const providerError = {
      code: "provider_terminal_error",
      message: "Provider stopped"
    };
    const harness = createHarness({
      controls: [control({ status: "error" })],
      providers: {
        openai: providerWithRefresh(async () => ({
          error: providerError,
          events: [providerEvent],
          status: "failed",
          terminal: true
        }))
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.operations).toEqual([
      "settle_recovered:provider_terminal_error"
    ]);
    expect(harness.state.events.map(({ event }) => event.type)).toEqual(["artifact"]);
  });

  it("does not append a recovery error when completion wins the failure CAS", async () => {
    const harness = createHarness({
      settleRecoveredRunError: false,
      providers: {
        openai: providerWithRefresh(async () => ({
          error: {
            code: "provider_terminal_error",
            message: "Provider stopped"
          },
          events: [providerEvent],
          status: "failed",
          terminal: true
        }))
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.failed).toEqual([]);
    expect(harness.state.operations).toEqual([]);
    expect(harness.state.events).toEqual([]);
  });

  it("coalesces concurrent refreshes by run id before one terminal settlement", async () => {
    const started = deferred();
    const release = deferred();
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => {
      started.resolve();
      await release.promise;
      return {
        error: {
          code: "provider_terminal_error",
          message: "Provider stopped"
        },
        events: [providerEvent],
        status: "failed",
        terminal: true
      };
    });
    const harness = createHarness({
      controls: [control({ status: "error" })],
      providers: {
        openai: providerWithRefresh(refresh)
      }
    });

    const first = refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await started.promise;
    const second = refreshProviderRunIfNeeded(harness.deps, runId, userId);
    release.resolve();
    await Promise.all([first, second]);

    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.state.recoveredErrors).toHaveLength(1);
    expect(harness.state.events.map(({ event }) => event.type)).toEqual(["artifact"]);
  });

  it("does not refresh a definitively settled recovery error again", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      error: {
        code: "provider_terminal_error",
        message: "Provider stopped"
      },
      events: [providerEvent],
      status: "failed",
      terminal: true
    }));
    const harness = createHarness({
      controls: [
        control({ status: "error" }),
        control({ status: "error" }),
        control({ status: "error" }),
        control({ recoverySettled: true, status: "error" })
      ],
      providers: {
        openai: providerWithRefresh(refresh)
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.state.recoveredErrors).toHaveLength(1);
    expect(harness.state.events.map(({ event }) => event.type)).toEqual(["artifact"]);
  });

  it("does not block recovery for a different run while one provider read is pending", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const firstHarness = createHarness({
      providers: {
        openai: providerWithRefresh(async () => {
          firstStarted.resolve();
          await releaseFirst.promise;
          return {
            error: { code: "first_failed", message: "First failed" },
            events: [],
            status: "failed",
            terminal: true
          };
        })
      }
    });
    const secondHarness = createHarness({
      providers: {
        openai: providerWithRefresh(async () => ({
          error: { code: "second_failed", message: "Second failed" },
          events: [],
          status: "failed",
          terminal: true
        }))
      }
    });

    const first = refreshProviderRunIfNeeded(
      firstHarness.deps,
      "run-pending-a",
      userId
    );
    await firstStarted.promise;
    await refreshProviderRunIfNeeded(
      secondHarness.deps,
      "run-independent-b",
      userId
    );

    expect(secondHarness.state.recoveredErrors).toHaveLength(1);
    expect(firstHarness.state.recoveredErrors).toHaveLength(0);
    releaseFirst.resolve();
    await first;
    expect(firstHarness.state.recoveredErrors).toHaveLength(1);
  });

  it("skips refresh and stale reconciliation for locally owned foreground runs", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      status: "in_progress",
      terminal: false
    }));
    const harness = createHarness({
      liveRunIds: [runId],
      providers: {
        openai: providerWithRefresh(refresh)
      },
      staleRuns: [staleControl()]
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await reconcileStaleRuns(harness.deps, {
      now: new Date("2026-07-12T10:00:00.000Z"),
      userId
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([]);
    expect(harness.state.events).toEqual([]);
  });

  it("marks stale non-refreshable runs orphaned using the shared freshness threshold", async () => {
    const now = new Date("2026-07-12T10:00:00.000Z");
    const harness = createHarness({
      staleRuns: [
        staleControl({
          provider: "anthropic",
          providerResponseId: null
        })
      ]
    });

    await reconcileStaleRuns(harness.deps, {
      chatId: "chat-1",
      now,
      runId,
      userId
    });

    expect(harness.state.staleQueries).toEqual([
      {
        chatId: "chat-1",
        runId,
        staleBefore: new Date(now.getTime() - activeRunStaleMs),
        userId
      }
    ]);
    expect(harness.state.failed).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: {
          code: "run_orphaned",
          message: "Run stopped reporting progress and was marked failed."
        },
        runId
      }
    ]);
    expect(harness.state.events).toEqual([]);
  });

  it("routes stale PREPARING rows only to their owned-attempt recovery", async () => {
    const refresh = vi.fn();
    const now = new Date("2026-07-12T10:00:00.000Z");
    const harness = createHarness({
      providers: { openai: providerWithRefresh(refresh) },
      staleRuns: [staleControl({ providerResponseId: null, status: "preparing" })]
    });

    await reconcileStaleRuns(harness.deps, { now, userId });

    expect(harness.state.preparingRecoveries).toEqual([{ now, runId, userId }]);
    expect(refresh).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([]);
  });

  it("delegates refreshable stale runs to provider recovery", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [providerEvent],
      status: "in_progress",
      terminal: false
    }));
    const harness = createHarness({
      providers: {
        openai: providerWithRefresh(refresh)
      },
      staleRuns: [staleControl()]
    });

    await reconcileStaleRuns(harness.deps, {
      now: new Date("2026-07-12T10:00:00.000Z"),
      userId
    });

    expect(refresh).toHaveBeenCalledWith("response-old");
    expect(harness.state.failed).toEqual([]);
    expect(harness.state.events.map(({ event }) => event.type)).toEqual(["artifact"]);
  });

  it.each([
    { providerResponseId: "response-fresh", variant: "with a provider response id" },
    { providerResponseId: undefined, variant: "without a provider response id" }
  ])("completes a recoverable error-status tool round $variant", async ({
    providerResponseId
  }) => {
    const runtimeCall = vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: ["remembered"],
      unsupportedContentTypes: []
    }));
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream() {
        return {
          finalProviderResponsePreview: { status: "completed" },
          finalText: "Recovered fresh answer",
          ...(providerResponseId ? { providerResponseId } : {}),
          usage: { inputTokens: 6, outputTokens: 4, reasoningTokens: 1 }
        };
      }
    };
    const harness = createHarness({
      controls: [control({
        providerResponseId: "response-tool-1",
        recoverySettled: false,
        status: "error"
      })],
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    installCheckpointState(harness, {
      ...checkpointedRun({
        calls: [persistedRecoveryCall()],
        phase: "tools_pending",
        providerResponseId: "response-tool-1"
      }),
      status: "error"
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered fresh answer",
      providerResponseId,
      usage: { inputTokens: 6, outputTokens: 4, reasoningTokens: 1, totalTokens: 10 }
    });
    expect(harness.state.run).toEqual({
      providerResponseId: providerResponseId ?? null,
      recoverySettled: false,
      status: "complete"
    });
    expect(harness.state.providerResponseIds).toEqual(providerResponseId
      ? [{ providerResponseId, runId }]
      : []);
    expect(harness.state.usageAttributions.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: "gpt-test",
        provider: "openai",
        usage: expect.objectContaining({ inputTokens: 6, outputTokens: 4, reasoningTokens: 1 })
      })
    ]));
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("attributes a finished round when cancellation wins response-id publication", async () => {
    const cancel = vi.fn(async () => ({}));
    let harness!: ReturnType<typeof createHarness>;
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      cancel,
      async *stream() {
        harness.setStoredRun({ status: "cancelled" });
        return {
          finalProviderResponsePreview: { status: "completed" },
          finalText: "Late answer",
          providerResponseId: "response-late",
          usage: { inputTokens: 8, outputTokens: 5, reasoningTokens: 0 }
        };
      }
    };
    harness = createHarness({
      controls: [control({ recoverySettled: false, status: "error" })],
      mcpRuntime: {
        callTool: async () => ({
          isError: false,
          structuredContent: null,
          text: ["remembered"],
          unsupportedContentTypes: []
        }),
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    installCheckpointState(harness, {
      ...checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" }),
      status: "error"
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(cancel).toHaveBeenCalledWith("response-late");
    expect(harness.state.providerResponseIds).toEqual([]);
    expect(harness.state.completed).toBeNull();
    expect(harness.state.run.status).toBe("cancelled");
    expect(harness.state.usageAttributions.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        usage: expect.objectContaining({ inputTokens: 8, outputTokens: 5 })
      })
    ]));
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("continues a checkpointed OpenAI background tool round from its response id", async () => {
    const requests: ProviderRunRequest[] = [];
    const egress = createRecoveryMemoryEgressRecorder();
    const runtimeCall = vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: ["remembered"],
      unsupportedContentTypes: []
    }));
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      refresh: async () => ({
        events: [providerEvent],
        providerResponseId: "response-tool-1",
        result: {
          finalProviderResponsePreview: { id: "response-tool-1" },
          finalText: "",
          providerResponseId: "response-tool-1",
          providerToolCallMessage: [{
            arguments: "{\"value\":\"alpha\"}",
            call_id: "provider-call-1",
            name: recoveryToolName,
            type: "function_call"
          }],
          toolCalls: [{
            arguments: { value: "alpha" },
            id: "provider-call-1",
            name: recoveryToolName
          }],
          usage: { inputTokens: 5, outputTokens: 1, reasoningTokens: 0 }
        },
        status: "completed",
        terminal: true
      }),
      async *stream(request) {
        requests.push(request);
        return {
          finalProviderResponsePreview: { id: "response-final" },
          finalText: "Recovered final answer",
          providerResponseId: "response-final",
          usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      controls: [control({ providerResponseId: "response-tool-1" })],
      memoryEgress: egress.service,
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    const durable = checkpointedRun({
      phase: "provider_running",
      providerResponseId: "response-tool-1",
      providerToolMessages: []
    });
    const installed = installCheckpointState(harness, durable);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(egress.recovered).toEqual([{
      outcome: "COMPLETED",
      runId,
      userId
    }]);
    expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({
      inputSchema: { type: "object" },
      name: "remember"
    }));
    expect(installed.calls()).toEqual([
      expect.objectContaining({ result: expect.any(Object), state: "complete" })
    ]);
    expect(harness.state.events.map(({ event }) => event)).toEqual([providerEvent]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.previousProviderResponseId).toBeUndefined();
    expect(requests[0]).toMatchObject({
      parallelToolCalls: true,
      toolChoice: "auto",
      tools: [expect.objectContaining({
        capability: "mcp",
        name: recoveryToolName
      })]
    });
    expect(requests[0]?.providerToolMessages).toEqual([
      {
        arguments: "{\"value\":\"alpha\"}",
        call_id: "provider-call-1",
        name: recoveryToolName,
        type: "function_call"
      },
      {
        call_id: "provider-call-1",
        output: "remembered",
        type: "function_call_output"
      }
    ]);
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered final answer",
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 }
    });
  });

  it.each([
    { code: "mcp_initialize_response_too_large", operation: "initialize" },
    { code: "mcp_inventory_response_too_large", operation: "list_tools" },
    { code: "mcp_call_result_too_large", operation: "call_tool" },
    { code: "mcp_response_too_large", operation: "session" }
  ] as const)("keeps recovered $code evidence and provider output free of overflow data", async ({
    code,
    operation
  }) => {
    const argumentMarker = `private-recovery-argument-${code}`;
    const prohibitedMarkers = {
      body: `private-recovery-body-${code}`,
      credential: `private-recovery-credential-${code}`,
      endpoint: `private-recovery-endpoint-${code}`,
      headers: `private-recovery-headers-${code}`,
      parserDetail: `private-recovery-parser-detail-${code}`,
      partialResult: `private-recovery-partial-result-${code}`
    };
    const canonicalArguments = { topic: argumentMarker, value: "alpha" };
    const overflow = new McpClientSessionError({ code, operation });
    for (const [key, value] of Object.entries(prohibitedMarkers)) {
      Object.defineProperty(overflow, key, { enumerable: true, value });
    }

    const requests: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        requests.push(request);
        return {
          finalProviderResponsePreview: { id: "response-after-overflow" },
          finalText: "Recovered after safe tool failure",
          providerResponseId: "response-after-overflow",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const runtimeCall = vi.fn(async () => {
      throw overflow;
    });
    const harness = createHarness({
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    const persistedCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: canonicalArguments
    };
    const checkpointState = installCheckpointState(harness, checkpointedRun({
      calls: [persistedCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: JSON.stringify(canonicalArguments),
        call_id: "provider-call-1",
        name: recoveryToolName,
        type: "function_call"
      }]
    }));

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({
      arguments: canonicalArguments,
      name: "remember"
    }));
    const [settledCall] = checkpointState.calls();
    expect(settledCall).toMatchObject({
      arguments: canonicalArguments,
      state: "error"
    });
    expect(settledCall?.result).toMatchObject({
      callId: "provider-call-1",
      content: [{ text: `Tool failed: ${overflow.message}`, type: "text" }],
      name: recoveryToolName,
      rawPreview: {
        finalProviderResponsePreview: { code, error: overflow.message },
        requestPreview: {
          toolCall: { id: "provider-call-1", name: recoveryToolName }
        }
      },
      status: "error",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0
      }
    });
    const settledResult = JSON.stringify(settledCall?.result);
    expect(settledResult).not.toContain(argumentMarker);
    for (const marker of Object.values(prohibitedMarkers)) {
      expect(settledResult).not.toContain(marker);
    }

    const events = harness.state.events.map(({ event }) => event);
    const toolResultEvent = events.find((event) =>
      event.type === "artifact" && event.data.artifactType === "tool_result"
    );
    expect(toolResultEvent).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain(argumentMarker);
    for (const marker of Object.values(prohibitedMarkers)) {
      expect(JSON.stringify(events)).not.toContain(marker);
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.providerToolMessages).toEqual([
      {
        arguments: JSON.stringify(canonicalArguments),
        call_id: "provider-call-1",
        name: recoveryToolName,
        type: "function_call"
      },
      {
        call_id: "provider-call-1",
        output: `Tool failed: ${overflow.message}`,
        type: "function_call_output"
      }
    ]);
    const providerOutput = JSON.stringify(requests[0]?.providerToolMessages?.[1]);
    expect(providerOutput).not.toContain(argumentMarker);
    for (const marker of Object.values(prohibitedMarkers)) {
      expect(JSON.stringify(requests)).not.toContain(marker);
    }
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered after safe tool failure"
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("persists a recovered provider delta as ordinary durable assistant text", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [{ data: { delta: "recovered" }, type: "token" }],
      providerResponseId: "response-tool-1",
      status: "in_progress",
      terminal: false
    }));
    const adapter = providerWithRefresh(refresh);
    const harness = createHarness({
      controls: [control({
        providerResponseId: "response-tool-1",
        recoverySettled: false,
        status: "error"
      })],
      providers: { openai: adapter }
    });
    const durable = {
      ...checkpointedRun({
        phase: "provider_running",
        providerResponseId: "response-tool-1",
        providerToolMessages: []
      }),
      assistantText: "durable ",
      status: "error" as const
    };
    installCheckpointState(harness, durable);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.state.assistantTexts).toEqual(["durable recovered"]);
    expect(harness.state.assistantAppendOptions).toEqual([{ allowErrored: true, runId }]);
    expect(harness.state.events.some(({ event }) => event.type === "token")).toBe(false);
    expect(harness.state.completed).toBeNull();
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("keeps a published-response safety failure terminal across later refresh requests", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let answerRounds = 0;
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream() {
        answerRounds += 1;
        yield { data: { delta: "recovered partial" }, type: "token" };
        yield {
          data: { inputTokens: 4, outputTokens: 2, reasoningTokens: 0 },
          type: "usage"
        };
        throw new ProviderStreamTooLargeError({
          maxBytes: 512,
          observedBytes: 513,
          snapshot: { durationMs: 88, totalStreamBytes: 513 }
        });
      }
    };
    const runtimeCall = vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: ["remembered"],
      unsupportedContentTypes: []
    }));
    const harness = createHarness({
      controls: [
        control({ providerResponseId: "response-tool-1" }),
        control({
          providerResponseId: "response-tool-1",
          recoverySettled: true,
          status: "error"
        })
      ],
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    const durable = checkpointedRun({
      calls: [persistedRecoveryCall()],
      phase: "tools_pending",
      providerResponseId: "response-tool-1"
    });
    installCheckpointState(harness, durable);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(answerRounds).toBe(1);
    expect(harness.state.assistantTexts).toEqual(["recovered partial"]);
    expect(harness.state.assistantAppendOptions).toEqual([{ allowErrored: true, runId }]);
    expect(harness.state.recoveredErrors).toHaveLength(1);
    expect(harness.state.recoveredErrors[0]).toMatchObject({
      error: {
        code: "provider_stream_too_large",
        message: "The provider stream exceeded a safety limit."
      },
      runId,
      usageAttributions: [{
        modelId: "gpt-test",
        provider: "openai",
        usage: { inputTokens: 4, outputTokens: 2, reasoningTokens: 0 }
      }]
    });
    expect(harness.state.recoveredErrors[0]).not.toHaveProperty("providerResponseId");
    expect(harness.state.completed).toBeNull();
    expect(harness.state.events.map(({ event }) => event.type)).not.toContain("done");
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toMatchObject({
      code: "provider_stream_too_large",
      durationMs: 88,
      limit: 512,
      observed: 513,
      termination: "total_limit",
      totalStreamBytes: 513
    });
    warning.mockRestore();
  });

  it("fails grounded live-only checkpoint recovery before contacting the provider", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      status: "in_progress",
      terminal: false
    }));
    const adapter = providerWithRefresh(refresh);
    const stream = vi.spyOn(adapter, "stream");
    const harness = createHarness({
      controls: [control({ providerResponseId: "response-tool-1" })],
      providers: { openai: adapter }
    });
    const durable = {
      ...checkpointedRun({
        phase: "provider_running",
        providerResponseId: "response-tool-1"
      }),
      assistantText: null
    };
    installCheckpointState(harness, durable);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.assistantTexts).toEqual([]);
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: {
          code: "grounding_live_only_not_recoverable",
          message: "Grounded live-only output cannot resume after process recovery."
        },
        runId
      })
    ]);
  });

  it("recovers a pending Gemini client Search without repeating settled answer context", async () => {
    const answerRequests: ProviderRunRequest[] = [];
    const searchRequests: ProviderSearchRequest[] = [];
    const answerAdapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        answerRequests.push(request);
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered cross-provider answer",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({ store: false }),
      async search(request) {
        searchRequests.push(request);
        return {
          artifacts: [],
          finalProviderResponsePreview: {
            searchSuggestionsHtml: "<div>RECOVERY_RAW_SUGGESTIONS_CANARY</div>",
            thoughtSignature: "RECOVERY_RAW_SIGNATURE_CANARY"
          },
          findings: "Recovered Gemini findings",
          requestPreview: { queryCharacters: request.query.length, store: false },
          sources: [{
            rank: 1,
            title: "Recovered Gemini source",
            url: "https://example.test/recovered-gemini"
          }],
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      providers: { gemini: answerAdapter, openai: answerAdapter },
      searchProviders: { gemini: searchAdapter }
    });
    const createSearchRun = vi.fn<RunRecoveryRepository["createSearchRun"]>();
    harness.repository.createSearchRun = createSearchRun;
    const option = {
      ...normalizedClientSearchRequest().searchPlan.options[0]!,
      config: {
        ...normalizedClientSearchRequest().searchPlan.options[0]!.config,
        maxOutputTokens: 4_096,
        maxSearchCallsPerAnswer: 2,
        reasoningPolicy: "lowest_supported"
      },
      displayName: "Google Search",
      modelId: "gemini-3.6-flash",
      optionId: "gemini-google-search",
      protocol: "gemini_google_search" as const,
      provider: "gemini",
      providerModelId: "gemini-search-deployment",
      revisionId: "gemini-search-revision-1",
      searchStrategyRowId: "gemini-search-client-route"
    };
    const storedCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "weather in Valencia" },
      mcpBinding: null,
      toolName: "search_engine_1"
    };
    const base = checkpointedRun({
      calls: [storedCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: "{\"query\":\"weather in Valencia\"}",
        call_id: "provider-call-1",
        name: "search_engine_1",
        type: "function_call"
      }]
    });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...normalizedClientSearchRequest(),
        searchPlan: { mode: "model_choice", options: [option] }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]).toMatchObject({
      query: "weather in Valencia",
      searchPolicy: {
        modelId: "gemini-3.6-flash",
        provider: "gemini",
        reasoningPolicy: "lowest_supported",
        strategyId: "gemini-google-search"
      },
      strategyId: "gemini-google-search"
    });
    expect(JSON.stringify(searchRequests[0])).not.toContain("Recovered cross-provider answer");
    expect(answerRequests).toHaveLength(1);
    expect(answerRequests[0]?.providerToolMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ output: expect.stringContaining("Recovered Gemini findings") })
    ]));
    expect(createSearchRun).toHaveBeenCalledWith(expect.objectContaining({
      artifacts: expect.objectContaining({
        sources: [{
          rank: 1,
          title: "Recovered Gemini source",
          url: "https://example.test/recovered-gemini"
        }]
      }),
      modelId: "gemini-3.6-flash",
      provider: "gemini",
      searchRevisionId: "gemini-search-revision-1",
      strategyId: "gemini-google-search"
    }));
    const durable = JSON.stringify(createSearchRun.mock.calls);
    expect(durable).not.toContain("RECOVERY_RAW_SUGGESTIONS_CANARY");
    expect(durable).not.toContain("RECOVERY_RAW_SIGNATURE_CANARY");
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered cross-provider answer",
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 }
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("recovers a pending Anthropic client Search with normalized evidence and exact usage", async () => {
    const answerRequests: ProviderRunRequest[] = [];
    const searchRequests: ProviderSearchRequest[] = [];
    const answerAdapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        answerRequests.push(request);
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered answer from Anthropic evidence",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: (request) => ({
        modelId: request.searchPolicy.modelId,
        protocol: "anthropic_web_search",
        queryCharacters: request.query.length
      }),
      async search(request) {
        searchRequests.push(request);
        return {
          artifacts: [{
            data: {
              artifactType: "search",
              payload: {
                action: { queries: [request.query], type: "search" },
                encrypted_content: "RECOVERY_ENCRYPTED_CONTENT_CANARY",
                encrypted_index: "RECOVERY_ENCRYPTED_INDEX_CANARY",
                id: "srvtoolu_recovery_1",
                provider: "anthropic",
                rawResultBody: "RECOVERY_RAW_RESULT_CANARY",
                status: "completed",
                type: "web_search_call",
                webSearchRequests: 2
              }
            },
            type: "artifact"
          }],
          finalProviderResponsePreview: {
            encrypted_content: "RECOVERY_ENCRYPTED_CONTENT_CANARY",
            encrypted_index: "RECOVERY_ENCRYPTED_INDEX_CANARY",
            rawResultBody: "RECOVERY_RAW_RESULT_CANARY"
          },
          findings: "Recovered Anthropic findings",
          requestPreview: {
            modelId: "claude-opus-5",
            queryCharacters: request.query.length,
            tool: "web_search_20250305"
          },
          sources: [{
            rank: 1,
            title: "Recovered Anthropic source",
            url: "https://example.test/recovered-anthropic"
          }],
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 1 }
        };
      }
    };
    const harness = createHarness({
      providers: { anthropic: answerAdapter, openai: answerAdapter },
      searchProviders: { anthropic: searchAdapter }
    });
    const createSearchRun = vi.fn<RunRecoveryRepository["createSearchRun"]>();
    harness.repository.createSearchRun = createSearchRun;
    const storedCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "latest Anthropic evidence" },
      mcpBinding: null,
      toolName: "search_engine_1"
    };
    const base = checkpointedRun({
      calls: [storedCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: "{\"query\":\"latest Anthropic evidence\"}",
        call_id: "provider-call-1",
        name: "search_engine_1",
        type: "function_call"
      }]
    });
    const checkpointState = installCheckpointState(harness, {
      ...base,
      normalizedRequest: normalizedAnthropicSearchRequest()
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]).toMatchObject({
      query: "latest Anthropic evidence",
      searchPolicy: {
        maxOutputTokens: 4_096,
        modelId: "claude-opus-5",
        provider: "anthropic",
        reasoningPolicy: "lowest_supported",
        strategyId: "anthropic-web-search"
      },
      strategyId: "anthropic-web-search"
    });
    expect(answerRequests).toHaveLength(1);
    expect(answerRequests[0]?.providerToolMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ output: expect.stringContaining("Recovered Anthropic findings") })
    ]));
    expect(createSearchRun).toHaveBeenCalledWith(expect.objectContaining({
      artifacts: expect.objectContaining({
        sources: [{
          rank: 1,
          title: "Recovered Anthropic source",
          url: "https://example.test/recovered-anthropic"
        }]
      }),
      modelId: "claude-opus-5",
      provider: "anthropic",
      searchRevisionId: "anthropic-search-revision-1",
      strategyId: "anthropic-web-search"
    }));
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered answer from Anthropic evidence",
      usage: { inputTokens: 3, outputTokens: 5, reasoningTokens: 1, totalTokens: 8 },
      usageAttributions: expect.arrayContaining([
        expect.objectContaining({
          modelId: "gpt-test",
          provider: "openai",
          usage: expect.objectContaining({ inputTokens: 2, outputTokens: 3 })
        }),
        expect.objectContaining({
          modelId: "claude-opus-5",
          provider: "anthropic",
          usage: expect.objectContaining({ inputTokens: 1, outputTokens: 2 })
        })
      ])
    });
    const durable = JSON.stringify({
      checkpointCalls: checkpointState.calls(),
      completed: harness.state.completed,
      events: harness.state.events,
      searchRuns: createSearchRun.mock.calls
    });
    expect(durable).not.toContain("RECOVERY_ENCRYPTED_CONTENT_CANARY");
    expect(durable).not.toContain("RECOVERY_ENCRYPTED_INDEX_CANARY");
    expect(durable).not.toContain("RECOVERY_RAW_RESULT_CANARY");
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("recovers attachment-bearing Anthropic client Search without disclosing the attachment", async () => {
    const search = vi.fn<ProviderSearchAdapter["search"]>(async (request) => ({
      artifacts: [],
      finalProviderResponsePreview: {},
      findings: "Recovered attachment-safe findings",
      requestPreview: { queryCharacters: request.query.length },
      sources: [{
        rank: 1,
        title: "Recovered source",
        url: "https://example.test/recovered-attachment-search"
      }],
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 }
    }));
    const answerRequests: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        answerRequests.push(request);
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered with Search and a private attachment",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      providers: { anthropic: adapter, openai: adapter },
      searchProviders: {
        anthropic: { buildRequestPreview: () => ({}), search }
      }
    });
    const createSearchRun = vi.fn<RunRecoveryRepository["createSearchRun"]>();
    harness.repository.createSearchRun = createSearchRun;
    const storedCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "public query with attachment" },
      mcpBinding: null,
      toolName: "search_engine_1"
    };
    const base = checkpointedRun({
      calls: [storedCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: "{\"query\":\"public query with attachment\"}",
        call_id: "provider-call-1",
        name: "search_engine_1",
        type: "function_call"
      }]
    });
    const normalized = normalizedAnthropicSearchRequest();
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...normalized,
        attachmentIds: ["document-1"],
        content: {
          blocks: [
            ...normalized.content.blocks,
            { attachmentId: "document-1", type: "attachment" }
          ]
        }
      }
    });
    harness.repository.loadAttachments = async () => [{
      byteSize: 32,
      checksum: null,
      extractedText: "Private attachment evidence",
      fileName: "private.txt",
      id: "document-1",
      kind: "document",
      metadata: {},
      mimeType: "text/plain",
      processingErrorCode: null,
      status: "ready",
      storageKey: "private/document-1"
    }];

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "public query with attachment" }),
      expect.anything()
    );
    expect(JSON.stringify(search.mock.calls)).not.toContain("Private attachment evidence");
    expect(createSearchRun).toHaveBeenCalledWith(expect.objectContaining({
      artifacts: expect.objectContaining({
        sources: [{
          rank: 1,
          title: "Recovered source",
          url: "https://example.test/recovered-attachment-search"
        }]
      }),
      status: "complete",
      strategyId: "anthropic-web-search"
    }));
    expect(answerRequests).toHaveLength(1);
    expect(JSON.stringify(answerRequests[0]?.providerToolMessages))
      .toContain("Recovered attachment-safe findings");
    expect(JSON.stringify(answerRequests[0]?.providerToolMessages))
      .not.toContain("Private attachment evidence");
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered with Search and a private attachment"
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("compacts a large pending fan-out Search result before settling recovery", async () => {
    const answerRequests: ProviderRunRequest[] = [];
    const findingsByModel = new Map<string, string>();
    const answerAdapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        answerRequests.push(request);
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered large fan-out answer",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search(request) {
        const modelId = request.searchPolicy.modelId;
        const findings = `${modelId}:${modelId.slice(-1).repeat(44_000)}`;
        findingsByModel.set(modelId, findings);
        return {
          artifacts: [],
          finalProviderResponsePreview: {},
          findings,
          requestPreview: { queryCharacters: request.query.length },
          sources: [{
            rank: 1,
            title: `Source ${modelId}`,
            url: `https://example.com/${modelId}`
          }],
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      providers: { openai: answerAdapter, openai_compatible: answerAdapter },
      searchProviders: { openai_compatible: searchAdapter }
    });
    const baseRequest = normalizedClientSearchRequest();
    const baseOption = baseRequest.searchPlan!.options[0]!;
    const options = Array.from({ length: 3 }, (_, index) => ({
      ...baseOption,
      displayName: `Search ${index + 1}`,
      modelId: `search-model-${index + 1}`,
      optionId: `search-option-${index + 1}`,
      providerModelId: `search-model-row-${index + 1}`,
      revisionId: `search-revision-${index + 1}`,
      searchStrategyRowId: `search-strategy-row-${index + 1}`
    }));
    const storedCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "large recovery evidence" },
      mcpBinding: null,
      toolName: "search_selected_engines"
    };
    const base = checkpointedRun({
      calls: [storedCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: "{\"query\":\"large recovery evidence\"}",
        call_id: "provider-call-1",
        name: "search_selected_engines",
        type: "function_call"
      }]
    });
    const checkpointState = installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...baseRequest,
        searchPlan: { mode: "all_selected", options }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(findingsByModel.size).toBe(3);
    expect(answerRequests).toHaveLength(1);
    const [settledCall] = checkpointState.calls();
    expect(settledCall?.state).toBe("complete");
    if (!settledCall?.result) throw new Error("expected settled large Search result");
    const serialized = JSON.stringify(settledCall.result);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      toolLoopPersistenceLimits.resultBytes
    );
    expect(serialized).toContain('"aiqsaType":"search_result"');
    for (const findings of findingsByModel.values()) {
      expect(serialized.split(findings)).toHaveLength(2);
    }
    const replayed = parsePersistedToolExecutionResult({
      id: settledCall.providerCallId,
      name: settledCall.toolName
    }, settledCall.result);
    expect(replayed?.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("search-model-1"),
        type: "text"
      })
    ]);
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("restores Search budgets per source and replays settled Search usage without duplicating it", async () => {
    const baseRequest = normalizedClientSearchRequest();
    const baseOption = baseRequest.searchPlan!.options[0]!;
    const firstOption = {
      ...baseOption,
      config: { ...baseOption.config, maxSearchCallsPerAnswer: 1 },
      displayName: "First Search",
      modelId: "search-model-1",
      optionId: "search-option-1",
      providerModelId: "search-model-row-1",
      revisionId: "search-revision-1",
      searchStrategyRowId: "search-strategy-row-1"
    };
    const secondOption = {
      ...baseOption,
      config: { ...baseOption.config, maxSearchCallsPerAnswer: 1 },
      displayName: "Second Search",
      modelId: "search-model-2",
      optionId: "search-option-2",
      providerModelId: "search-model-row-2",
      revisionId: "search-revision-2",
      searchStrategyRowId: "search-strategy-row-2"
    };
    const settledExecution: SearchExecutionEvidence = {
      displayName: firstOption.displayName,
      findings: "already persisted findings",
      invocationId: "provider-call-1:search-option-1",
      modelId: firstOption.modelId,
      optionId: firstOption.optionId,
      provider: firstOption.provider,
      revisionId: firstOption.revisionId,
      sources: [{
        rank: 1,
        title: "First source",
        url: "https://example.com/first-source"
      }],
      status: "complete",
      usage: { inputTokens: 5, outputTokens: 6, reasoningTokens: 0 }
    };
    const settledResult = snapshotToolExecutionResult({
      callId: "provider-call-1",
      content: searchToolResultContent([settledExecution]),
      name: "search_engine_1",
      rawPreview: {
        providerCall: true,
        searchExecutions: [settledExecution],
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete",
      usage: { inputTokens: 5, outputTokens: 6, reasoningTokens: 0 }
    }, 32_000);
    if (!settledResult) throw new Error("invalid_settled_search_fixture");
    expect(JSON.stringify(settledResult).split("already persisted findings")).toHaveLength(2);
    const firstCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall("complete"),
      arguments: { query: "first source query" },
      mcpBinding: null,
      result: settledResult,
      toolName: "search_engine_1"
    };
    const secondCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "second source query" },
      id: "stored-call-2",
      mcpBinding: null,
      ordinal: 1,
      providerCallId: "provider-call-2",
      toolName: "search_engine_2"
    };
    const searchRequests: ProviderSearchRequest[] = [];
    const answerAdapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream() {
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered with the second source",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search(request) {
        searchRequests.push(request);
        return {
          artifacts: [],
          finalProviderResponsePreview: {},
          findings: "fresh second-source findings",
          requestPreview: {},
          sources: [{
            rank: 1,
            title: "Second source",
            url: "https://example.com/second-source"
          }],
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      providers: { openai: answerAdapter, openai_compatible: answerAdapter },
      searchProviders: { openai_compatible: searchAdapter }
    });
    const base = checkpointedRun({
      calls: [firstCall, secondCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: "{\"query\":\"first source query\"}",
        call_id: "provider-call-1",
        name: "search_engine_1",
        type: "function_call"
      }, {
        arguments: "{\"query\":\"second source query\"}",
        call_id: "provider-call-2",
        name: "search_engine_2",
        type: "function_call"
      }]
    });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...baseRequest,
        searchPlan: { mode: "model_choice", options: [firstOption, secondOption] }
      }
    }, [{
      modelId: "search-model-1",
      provider: "openai_compatible",
      recordedAt: "2026-07-12T09:02:00.000Z",
      usage: { inputTokens: 5, outputTokens: 6, reasoningTokens: 0 }
    }]);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]).toMatchObject({
      query: "second source query",
      searchPolicy: { modelId: "search-model-2", provider: "openai_compatible" }
    });
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered with the second source",
      usage: { inputTokens: 9, outputTokens: 12, totalTokens: 21 },
      usageAttributions: expect.arrayContaining([expect.objectContaining({
        modelId: "search-model-1",
        provider: "openai_compatible",
        usage: expect.objectContaining({ inputTokens: 5, outputTokens: 6 })
      }), expect.objectContaining({
        modelId: "search-model-2",
        provider: "openai_compatible",
        usage: expect.objectContaining({ inputTokens: 2, outputTokens: 3 })
      })])
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it.each([
    ["action", normalizedMemoryActionRequest, "save_memory"],
    ["history", normalizedMemoryHistoryRequest, "search_private_history"]
  ] as const)("terminalizes a checkpointed answer-model Memory %s contract", async (
    _kind,
    requestFactory,
    toolName
  ) => {
    const stream = vi.fn<ProviderAdapter["stream"]>(async function* () {
      return {
        finalProviderResponsePreview: {},
        finalText: "must not dispatch",
        usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
      };
    });
    const harness = createHarness({
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          stream
        }
      }
    });
    const memoryCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: {},
      mcpBinding: null,
      toolName
    };
    const installed = installCheckpointState(harness, {
      ...checkpointedRun({
        calls: [memoryCall],
        phase: "tools_pending",
        providerToolMessages: [{
          arguments: JSON.stringify(memoryCall.arguments),
          call_id: memoryCall.providerCallId,
          name: memoryCall.toolName,
          type: "function_call"
        }]
      }),
      normalizedRequest: requestFactory()
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(stream).not.toHaveBeenCalled();
    expect(installed.calls()).toEqual([
      expect.objectContaining({ state: "pending", toolName })
    ]);
    expect(harness.state.completed).toBeNull();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: {
          code: "memory_answer_model_tools_retired",
          message: "Checkpointed answer-model Memory tools cannot be replayed."
        },
        runId
      })
    ]);
  });

  it.each([
    ["action", normalizedMemoryActionRequest],
    ["history", normalizedMemoryHistoryRequest]
  ] as const)("terminalizes an accepted legacy Memory %s request without a checkpoint", async (
    _kind,
    requestFactory
  ) => {
    const stream = vi.fn<ProviderAdapter["stream"]>(async function* () {
      return {
        finalProviderResponsePreview: {},
        finalText: "must not dispatch",
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
      };
    });
    const harness = createHarness({
      providerDispatchRecoveryRequest: requestFactory(),
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          stream
        }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([
      expect.objectContaining({
        error: {
          code: "memory_answer_model_tools_retired",
          message: "This saved run uses a retired answer-model Memory tool contract."
        },
        runId
      })
    ]);
    expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
  });

  it("blocks a recovered hosted-Search dispatch when current access was revoked", async () => {
    const stream = vi.fn<ProviderAdapter["stream"]>(async function* () {
      return {
        finalProviderResponsePreview: {},
        finalText: "must not dispatch",
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
      };
    });
    const egress = createRecoveryMemoryEgressRecorder();
    const harness = createHarness({
      memoryEgress: egress.service,
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          stream
        }
      },
      searchStrategyEnabled: false
    });
    const settledResult = snapshotToolExecutionResult({
      callId: "provider-call-1",
      content: [{ text: "completed", type: "text" }],
      name: recoveryToolName,
      status: "complete"
    }, 32_000);
    if (!settledResult) throw new Error("invalid_settled_mcp_fixture");
    const settledCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall("complete"),
      result: settledResult
    };
    installCheckpointState(harness, {
      ...checkpointedRun({
        calls: [settledCall],
        phase: "tools_pending"
      }),
      normalizedRequest: normalizedHostedSearchRequest()
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(stream).not.toHaveBeenCalled();
    expect(egress.blocked).toEqual([
      expect.objectContaining({
        destinationKind: "answer_provider",
        errorCode: "memory_egress_search_revoked",
        mode: "PROVIDER_REQUEST"
      })
    ]);
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: "search_strategy_not_available" })
      })
    ]);
  });

  it("terminally fails a Project recovery after initiator access loss without provider or tool I/O", async () => {
    const project = projectRecoveryAuthority();
    const refresh = vi.fn(async () => ({ terminal: false }) as ProviderRunRefreshResult);
    const stream = vi.fn<ProviderAdapter["stream"]>();
    const providerLoad = vi.fn(async () => ({
      fingerprint: project.providerAdmissionFingerprint
    }) as ProviderAdmissionPlan);
    const runtimeCall = vi.fn<NonNullable<RunRecoveryDeps["mcpRuntime"]>["callTool"]>();
    const harness = createHarness({
      controls: [null],
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      projectAccessCurrent: false,
      providerAdmission: { load: providerLoad },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          refresh,
          stream
        }
      },
      recoveryControls: [control({ project })]
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.failed).toEqual([expect.objectContaining({
      error: expect.objectContaining({ code: "provider_admission_changed" })
    })]);
    expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
    expect(harness.deps.registry.has(runId)).toBe(false);
    expect(providerLoad).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(runtimeCall).not.toHaveBeenCalled();
    expect(harness.state.assistantTexts).toEqual([]);
  });

  it("fails an active legacy Project binding closed without poisoning terminal history", async () => {
    const refresh = vi.fn(async () => ({ terminal: false }) as ProviderRunRefreshResult);
    const harness = createHarness({
      controls: [null],
      providers: {
        openai: providerWithRefresh(refresh)
      },
      recoveryControls: [control({ projectRecoveryInvalid: true })]
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.failed).toEqual([expect.objectContaining({
      error: expect.objectContaining({ code: "provider_admission_changed" })
    })]);
    expect(harness.state.run).toMatchObject({ recoverySettled: true, status: "error" });
    expect(refresh).not.toHaveBeenCalled();

    const terminal = createHarness({
      controls: [null],
      recoveryControls: [control({ projectRecoveryInvalid: true, status: "complete" })]
    });
    await refreshProviderRunIfNeeded(terminal.deps, runId, userId);
    expect(terminal.state.failed).toEqual([]);
    expect(terminal.state.run.status).toBe("complete");
  });

  it("revalidates recovered Project MCP through shared authority only", async () => {
    const project = projectRecoveryAuthority({ providerRequiresClientTools: true });
    const snapshot = normalizedToolRequest().mcp!;
    const prepare = vi.fn<NonNullable<RunRecoveryDeps["mcp"]>["prepare"]>(async () => {
      throw new Error("personal_mcp_path_used");
    });
    const prepareProject = vi.fn<NonNullable<
      NonNullable<RunRecoveryDeps["mcp"]>["prepareProject"]
    >>(async () => ({
      bindings: [{
        fingerprint: recoveryFingerprint,
        runtimeGenerationId: "generation-1",
        serverId: "server-1"
      }],
      ok: true,
      snapshot
    }));
    const runtimeCall = vi.fn<NonNullable<RunRecoveryDeps["mcpRuntime"]>["callTool"]>(
      async () => ({
        isError: false,
        structuredContent: { accepted: true },
        text: ["accepted"],
        unsupportedContentTypes: []
      })
    );
    const providerLoad = vi.fn(async () => ({
      fingerprint: project.providerAdmissionFingerprint
    }) as ProviderAdmissionPlan);
    const harness = createHarness({
      mcp: { prepare, prepareProject },
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      projectAccessCurrent: true,
      providerAdmission: { load: providerLoad },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            return {
              finalProviderResponsePreview: {},
              finalText: "Recovered Project MCP",
              usage: { inputTokens: 2, outputTokens: 2, reasoningTokens: 0 }
            };
          }
        }
      }
    });
    installCheckpointState(harness, {
      ...checkpointedRun({
        calls: [persistedRecoveryCall()],
        phase: "tools_pending"
      }),
      project
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(prepare).not.toHaveBeenCalled();
    expect(prepareProject).toHaveBeenCalledWith(["server-1"]);
    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(providerLoad).toHaveBeenCalledWith(expect.objectContaining({
      executionScope: "project",
      requiresClientToolCoexistence: true
    }));
    expect(harness.state.completed).toMatchObject({ finalText: "Recovered Project MCP" });
  });

  it("reuses a settled Anthropic Search and recovers usage recorded after the prior snapshot", async () => {
    const request = normalizedAnthropicSearchRequest();
    const selected = {
      ...request.searchPlan!.options[0]!,
      modelId: "search-model-1",
      optionId: "search-option-1",
      providerModelId: "search-model-row-1",
      revisionId: "search-revision-1",
      searchStrategyRowId: "search-strategy-row-1"
    };
    const settledExecution: SearchExecutionEvidence = {
      displayName: "Anthropic Web Search",
      invocationId: "provider-call-1:search-option-1",
      modelId: selected.modelId,
      optionId: selected.optionId,
      provider: selected.provider,
      revisionId: selected.revisionId,
      findings: "settled findings",
      sources: [{
        rank: 1,
        title: "Settled source",
        url: "https://example.com/settled-source"
      }],
      status: "complete",
      usage: { inputTokens: 5, outputTokens: 6, reasoningTokens: 0 }
    };
    const settledResult = snapshotToolExecutionResult({
      callId: "provider-call-1",
      content: searchToolResultContent([settledExecution]),
      name: "search_engine_1",
      rawPreview: {
        searchExecutions: [settledExecution],
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete",
      usage: { inputTokens: 5, outputTokens: 6, reasoningTokens: 0 }
    }, 32_000);
    if (!settledResult) throw new Error("invalid_settled_search_fixture");
    const settledCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall("complete"),
      arguments: { query: "settled query" },
      mcpBinding: null,
      result: settledResult,
      toolName: "search_engine_1"
    };
    const search = vi.fn<ProviderSearchAdapter["search"]>();
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream() {
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered answer",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      providers: { anthropic: adapter, openai: adapter },
      searchProviders: {
        anthropic: { buildRequestPreview: () => ({}), search }
      }
    });
    installCheckpointState(harness, {
      ...checkpointedRun({
        calls: [settledCall],
        phase: "tools_pending",
        providerToolMessages: [{
          arguments: "{\"query\":\"settled query\"}",
          call_id: "provider-call-1",
          name: "search_engine_1",
          type: "function_call"
        }]
      }),
      normalizedRequest: {
        ...request,
        searchPlan: { mode: "model_choice", options: [selected] }
      }
    }, [{
      modelId: selected.modelId!,
      provider: selected.provider,
      recordedAt: "2026-07-12T09:00:00.000Z",
      usage: { inputTokens: 4, outputTokens: 5, reasoningTokens: 0 }
    }]);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(search).not.toHaveBeenCalled();
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered answer",
      usage: { inputTokens: 11, outputTokens: 14, totalTokens: 25 },
      usageAttributions: expect.arrayContaining([expect.objectContaining({
        modelId: selected.modelId,
        provider: selected.provider,
        usage: expect.objectContaining({ inputTokens: 9, outputTokens: 11 })
      })])
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("aborts an in-flight MCP call owned by checkpoint recovery", async () => {
    const callStarted = deferred();
    const recoveryRegistry = registry();
    let observedAbort = false;
    const runtimeCall = vi.fn(async (input: { signal?: AbortSignal }) => {
      callStarted.resolve();
      return new Promise<never>((_resolve, reject) => {
        const abort = () => {
          observedAbort = true;
          const error = new Error("recovered MCP call aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (input.signal?.aborted) abort();
        else input.signal?.addEventListener("abort", abort, { once: true });
      });
    });
    const harness = createHarness({
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            return providerResult;
          }
        }
      },
      registry: recoveryRegistry
    });
    installCheckpointState(
      harness,
      checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" })
    );

    const recovery = refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await callStarted.promise;
    expect(recoveryRegistry.has(runId)).toBe(true);
    expect(recoveryRegistry.abort(runId)).toBe(true);
    await recovery;

    expect(observedAbort).toBe(true);
    expect(harness.state.completed).toBeNull();
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("hydrates image and native PDF bytes before a recovered continuation", async () => {
    const requests: ProviderRunRequest[] = [];
    const getObject = vi.fn(async (storageKey: string) => ({
      body: Buffer.from(storageKey === "image-key" ? "image-bytes" : "pdf-bytes"),
      contentType: storageKey === "image-key" ? "image/png" : "application/pdf",
      storageKey
    }));
    const harness = createHarness({
      mcpRuntime: {
        callTool: async () => ({
          isError: false,
          structuredContent: null,
          text: ["remembered"],
          unsupportedContentTypes: []
        }),
        ensureAcceptedGeneration: async () => true
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream(request) {
            requests.push(request);
            return providerResult;
          }
        }
      },
      storage: { getObject }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        attachmentIds: ["image-1", "pdf-1"],
        content: {
          blocks: [
            ...base.normalizedRequest.content.blocks,
            { attachmentId: "image-1", type: "image" },
            { attachmentId: "pdf-1", type: "attachment" }
          ]
        },
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          nativePdfInput: true,
          vision: true
        }
      }
    });
    harness.repository.loadAttachments = async () => [
      {
        byteSize: 11,
        checksum: null,
        extractedText: null,
        fileName: "diagram.png",
        id: "image-1",
        kind: "image",
        metadata: { image: { height: 10, width: 10 } },
        mimeType: "image/png",
        processingErrorCode: null,
        status: "ready",
        storageKey: "image-key"
      },
      {
        byteSize: 9,
        checksum: createHash("sha256").update(Buffer.from("pdf-bytes")).digest("hex"),
        extractedText: null,
        fileName: "document.pdf",
        id: "pdf-1",
        kind: "pdf",
        metadata: { pdf: { pageCount: 1 } },
        mimeType: "application/pdf",
        processingErrorCode: null,
        status: "ready",
        storageKey: "pdf-key"
      }
    ];

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(getObject).toHaveBeenCalledTimes(2);
    expect(requests[0]?.attachments).toEqual([
      expect.objectContaining({
        dataUrl: `data:image/png;base64,${Buffer.from("image-bytes").toString("base64")}`,
        id: "image-1"
      }),
      expect.objectContaining({
        base64Data: Buffer.from("pdf-bytes").toString("base64"),
        id: "pdf-1"
      })
    ]);
  });

  it("reapplies the shared attachment preflight before recovery storage or provider I/O", async () => {
    const getObject = vi.fn();
    const providerStream = vi.fn();
    const harness = createHarness({
      attachmentLimits: {
        maxCount: 20,
        maxEncodedBytes: 1_000,
        maxMaterializedBytes: 10,
        readConcurrency: 2
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            providerStream();
            return providerResult;
          }
        }
      },
      storage: { getObject }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        attachmentIds: ["image-1"],
        content: {
          blocks: [
            ...base.normalizedRequest.content.blocks,
            { attachmentId: "image-1", type: "image" }
          ]
        },
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          vision: true
        }
      }
    });
    harness.repository.loadAttachments = async () => [
      {
        byteSize: 11,
        checksum: null,
        extractedText: null,
        fileName: "diagram.png",
        id: "image-1",
        kind: "image",
        metadata: { image: { height: 10, width: 10 } },
        mimeType: "image/png",
        processingErrorCode: null,
        status: "ready",
        storageKey: "image-key"
      }
    ];

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(getObject).not.toHaveBeenCalled();
    expect(providerStream).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: {
          code: "attachment_materialization_limit_exceeded",
          message: "Selected attachments require 11 source bytes; the limit is 10."
        }
      })
    ]);
  });

  it.each([
    {
      attachmentIds: ["one", "two"],
      blocks: [
        { attachmentId: "one", type: "image" },
        { attachmentId: "two", type: "image" }
      ],
      code: "attachment_count_limit_exceeded",
      label: "count overflow",
      maxCount: 1
    },
    {
      attachmentIds: [],
      blocks: Array.from({ length: 257 }, () => ({ text: "x", type: "text" })),
      code: "content_block_limit_exceeded",
      label: "content-block overflow",
      maxCount: 20
    },
    {
      attachmentIds: ["persisted-only"],
      blocks: [{ text: "missing attachment block", type: "text" }],
      code: "attachment_reference_invalid",
      label: "persisted/content mismatch",
      maxCount: 20
    }
  ])("rejects a recovered $label before attachment or provider I/O", async ({
    attachmentIds,
    blocks,
    code,
    maxCount
  }) => {
    const providerStream = vi.fn();
    const harness = createHarness({
      attachmentLimits: {
        maxCount,
        maxEncodedBytes: 1_000,
        maxMaterializedBytes: 1_000,
        readConcurrency: 2
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            providerStream();
            return providerResult;
          }
        }
      }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        attachmentIds,
        content: { blocks }
      }
    });
    const loadAttachments = vi.fn(async () => []);
    harness.repository.loadAttachments = loadAttachments;

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(loadAttachments).not.toHaveBeenCalled();
    expect(providerStream).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code }) })
    ]);
  });

  it.each([
    {
      body: Buffer.alloc(3),
      code: "attachment_encoded_size_limit_exceeded",
      expectedReads: 0,
      storageError: null,
      limits: {
        maxCount: 20,
        maxEncodedBytes: 25,
        maxMaterializedBytes: 1_000,
        readConcurrency: 2
      }
    },
    {
      body: Buffer.alloc(2),
      code: "attachment_object_size_mismatch",
      expectedReads: 1,
      storageError: null,
      limits: {
        maxCount: 20,
        maxEncodedBytes: 1_000,
        maxMaterializedBytes: 1_000,
        readConcurrency: 2
      }
    },
    {
      body: Buffer.alloc(3),
      code: "attachment_object_read_failed",
      expectedReads: 1,
      limits: {
        maxCount: 20,
        maxEncodedBytes: 1_000,
        maxMaterializedBytes: 1_000,
        readConcurrency: 2
      },
      storageError: "ENOENT /private/bucket/image-key"
    }
  ])("preserves $code during recovery parity", async ({
    body,
    code,
    expectedReads,
    limits: attachmentLimits,
    storageError
  }) => {
    const getObject = vi.fn(async (storageKey: string) => {
      if (storageError) throw new Error(storageError);
      return {
        body,
        contentType: "image/png",
        storageKey
      };
    });
    const providerStream = vi.fn();
    const harness = createHarness({
      attachmentLimits,
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            providerStream();
            return providerResult;
          }
        }
      },
      storage: { getObject }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        attachmentIds: ["image-1"],
        content: {
          blocks: [
            ...base.normalizedRequest.content.blocks,
            { attachmentId: "image-1", type: "image" }
          ]
        },
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          vision: true
        }
      }
    });
    harness.repository.loadAttachments = async () => [{
      byteSize: 3,
      checksum: null,
      extractedText: null,
      fileName: "diagram.png",
      id: "image-1",
      kind: "image",
      metadata: {},
      mimeType: "image/png",
      processingErrorCode: null,
      status: "ready",
      storageKey: "image-key"
    }];

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(getObject).toHaveBeenCalledTimes(expectedReads);
    expect(providerStream).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code }) })
    ]);
    if (storageError) {
      expect(JSON.stringify(harness.state.recoveredErrors)).not.toContain(storageError);
      expect(harness.state.recoveredErrors[0]?.error.message)
        .toBe("An attachment object could not be read.");
    }
  });

  it("treats cancellation during recovered attachment I/O as cancellation, not failure", async () => {
    const readStarted = deferred();
    const recoveryRegistry = registry();
    const providerStream = vi.fn();
    const getObject = vi.fn((
      _storageKey: string,
      options?: { signal?: AbortSignal }
    ) => new Promise<never>((_resolve, reject) => {
      readStarted.resolve();
      const abort = () => reject(options?.signal?.reason);
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
    }));
    const harness = createHarness({
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            providerStream();
            return providerResult;
          }
        }
      },
      registry: recoveryRegistry,
      storage: { getObject }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        attachmentIds: ["image-1"],
        content: {
          blocks: [
            ...base.normalizedRequest.content.blocks,
            { attachmentId: "image-1", type: "image" }
          ]
        },
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          vision: true
        }
      }
    });
    harness.repository.loadAttachments = async () => [{
      byteSize: 3,
      checksum: null,
      extractedText: null,
      fileName: "diagram.png",
      id: "image-1",
      kind: "image",
      metadata: {},
      mimeType: "image/png",
      processingErrorCode: null,
      status: "ready",
      storageKey: "image-key"
    }];

    const recovery = refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await readStarted.promise;
    expect(recoveryRegistry.abort(runId)).toBe(true);
    await recovery;

    expect(providerStream).not.toHaveBeenCalled();
    expect(harness.state.completed).toBeNull();
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("continues an ordinary recovered tool loop through a second tool round", async () => {
    const requests: ProviderRunRequest[] = [];
    const runtimeCall = vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: [`result-${runtimeCall.mock.calls.length}`],
      unsupportedContentTypes: []
    }));
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            finalProviderResponsePreview: {},
            finalText: "",
            providerResponseId: "response-tool-2",
            providerToolCallMessage: [{
              arguments: "{\"value\":\"beta\"}",
              call_id: "provider-call-2",
              name: recoveryToolName,
              type: "function_call"
            }],
            toolCalls: [{
              arguments: { value: "beta" },
              id: "provider-call-2",
              name: recoveryToolName
            }],
            usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0 }
          };
        }
        return {
          finalProviderResponsePreview: {},
          finalText: "two rounds complete",
          providerResponseId: "response-final",
          usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    const checkpointState = installCheckpointState(
      harness,
      checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" })
    );

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.previousProviderResponseId).toBeUndefined();
    expect(requests[0]).toMatchObject({
      parallelToolCalls: true,
      toolChoice: "auto",
      tools: [expect.objectContaining({
        capability: "mcp",
        name: recoveryToolName
      })]
    });
    expect(requests[0]?.providerToolMessages).toEqual([
      expect.objectContaining({ call_id: "provider-call-1", type: "function_call" }),
      expect.objectContaining({ call_id: "provider-call-1", type: "function_call_output" })
    ]);
    expect(requests[1]?.providerToolMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ call_id: "provider-call-2", type: "function_call" }),
      expect.objectContaining({ call_id: "provider-call-2", type: "function_call_output" })
    ]));
    expect(checkpointState.calls()).toHaveLength(2);
    expect(harness.state.completed).toMatchObject({ finalText: "two rounds complete" });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("restores an Auto MCP catalog and its exact discovered tools without rediscovery", async () => {
    const requests: ProviderRunRequest[] = [];
    const snapshot = normalizedToolRequest().mcp!;
    const prepare = vi.fn<NonNullable<RunRecoveryDeps["mcp"]>["prepare"]>(async () => ({
      bindings: [{
        fingerprint: recoveryFingerprint,
        runtimeGenerationId: "generation-1",
        serverId: "server-1"
      }],
      ok: true,
      snapshot
    }));
    const materialize = vi.fn<NonNullable<
      NonNullable<RunRecoveryDeps["mcp"]>["materialize"]
    >>(async () => ({ bindings: [], ok: true, snapshot: { servers: [], tools: [], version: 1 } }));
    const route = vi.fn<NonNullable<
      NonNullable<RunRecoveryDeps["mcp"]>["router"]>["route"]
    >(async () => ({ toolNames: [], usageAttribution: null }));
    const runtimeCall = vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: ["remembered"],
      unsupportedContentTypes: []
    }));
    const harness = createHarness({
      mcp: { materialize, prepare, router: { route } },
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream(request) {
            requests.push(request);
            return {
              finalProviderResponsePreview: {},
              finalText: "Recovered Auto MCP answer",
              usage: { inputTokens: 2, outputTokens: 2, reasoningTokens: 0 }
            };
          }
        }
      }
    });
    const appendEpoch = vi.fn(async () => null);
    harness.repository.appendMcpDiscoveryEpoch = appendEpoch;
    const durable = checkpointedRun({
      calls: [persistedRecoveryCall()],
      phase: "tools_pending"
    });
    installCheckpointState(harness, {
      ...durable,
      normalizedRequest: {
        ...durable.normalizedRequest,
        mcpDiscovery: {
          catalog: {
            servers: [{
              description: "Store durable memories",
              namespace: "memory",
              revisionId: "revision-1",
              serverId: "server-1",
              serverName: "Memory",
              tools: [{
                description: "Remember a value",
                namespacedName: recoveryToolName,
                originalName: "remember"
              }]
            }],
            version: 1
          },
          epochs: [{
            epoch: 1,
            goal: "remember this",
            modelRunToolCallId: "historical-find-tools-call",
            roundIndex: 0,
            toolIds: [recoveryToolName]
          }],
          version: 2
        }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.mcpDiscovery?.catalog.servers[0]?.tools[0]).not.toHaveProperty(
      "inputSchema"
    );
    expect(requests[0]?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: MCP_FIND_TOOLS_NAME }),
      expect.objectContaining({ name: recoveryToolName })
    ]));
    expect(runtimeCall).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(materialize).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(appendEpoch).not.toHaveBeenCalled();
    expect(harness.state.completed).toMatchObject({ finalText: "Recovered Auto MCP answer" });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("semantically routes a fresh recovered Auto discovery call and attributes its usage", async () => {
    const requests: ProviderRunRequest[] = [];
    const snapshot = normalizedToolRequest().mcp!;
    const catalog = {
      servers: [{
        description: "Store durable memories",
        namespace: "memory",
        revisionId: "revision-1",
        serverId: "server-1",
        serverName: "Memory",
        tools: [{
          arguments: [],
          description: "Remember a value",
          namespacedName: recoveryToolName,
          originalName: "remember"
        }]
      }],
      version: 1 as const
    };
    const route = vi.fn(async () => ({
      toolNames: [recoveryToolName],
      usageAttribution: {
        modelId: "router-model",
        provider: "openai",
        usage: { inputTokens: 7, outputTokens: 2, reasoningTokens: 0 }
      }
    }));
    const materialize = vi.fn(async () => ({
      bindings: [{
        fingerprint: recoveryFingerprint,
        runtimeGenerationId: "generation-1",
        serverId: "server-1"
      }],
      ok: true as const,
      snapshot
    }));
    const discovery = {
      catalog,
      epochs: [{
        epoch: 1,
        goal: "remember this detail",
        modelRunToolCallId: "stored-find-tools-call",
        roundIndex: 1,
        toolIds: [recoveryToolName]
      }],
      version: 2 as const
    };
    const harness = createHarness({
      mcp: {
        materialize,
        prepare: async () => ({
          bindings: [],
          ok: true,
          snapshot: { servers: [], tools: [], version: 1 }
        }),
        router: { route }
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream(request) {
            requests.push(request);
            return {
              finalProviderResponsePreview: {},
              finalText: "Recovered semantic discovery",
              usage: { inputTokens: 3, outputTokens: 1, reasoningTokens: 0 }
            };
          }
        }
      }
    });
    const appendEpoch = vi.fn(async () => ({ discovery, snapshot }));
    harness.repository.appendMcpDiscoveryEpoch = appendEpoch;
    const findToolsCall: PersistedToolLoopCall = {
      arguments: { goal: "remember this detail" },
      completedAt: null,
      id: "stored-find-tools-call",
      mcpBinding: null,
      ordinal: 0,
      providerCallId: "provider-find-tools-call",
      result: null,
      roundIndex: 1,
      startedAt: null,
      state: "pending",
      toolName: MCP_FIND_TOOLS_NAME
    };
    const durable = checkpointedRun({
      calls: [findToolsCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: JSON.stringify({ goal: "remember this detail" }),
        call_id: "provider-find-tools-call",
        name: MCP_FIND_TOOLS_NAME,
        type: "function_call"
      }]
    });
    installCheckpointState(harness, {
      ...durable,
      normalizedRequest: {
        ...durable.normalizedRequest,
        mcp: { servers: [], tools: [], version: 1 },
        mcpDiscovery: {
          catalog,
          epochs: [],
          version: 2
        }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(route).toHaveBeenCalledWith(expect.objectContaining({
      activeToolNames: new Set(),
      catalog,
      goal: "remember this detail",
      limit: 5
    }));
    expect(materialize).toHaveBeenCalledWith(userId, [{
      namespacedName: recoveryToolName,
      revisionId: "revision-1",
      serverId: "server-1"
    }]);
    expect(appendEpoch).toHaveBeenCalledWith(expect.objectContaining({
      goal: "remember this detail",
      modelRunToolCallId: "stored-find-tools-call",
      roundIndex: 1,
      runId,
      userId
    }));
    expect(requests[0]?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: recoveryToolName })
    ]));
    expect(harness.state.completed).toMatchObject({
      usageAttributions: expect.arrayContaining([expect.objectContaining({
        modelId: "router-model",
        provider: "openai",
        usage: expect.objectContaining({ inputTokens: 7, outputTokens: 2 })
      })])
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("replays a checkpointed running discovery call without rerouting or materializing", async () => {
    const snapshot = normalizedToolRequest().mcp!;
    const catalog = {
      servers: [{
        description: "Store durable memories",
        namespace: "memory",
        revisionId: "revision-1",
        serverId: "server-1",
        serverName: "Memory",
        tools: [{
          arguments: [],
          description: "Remember a value",
          namespacedName: recoveryToolName,
          originalName: "remember"
        }]
      }],
      version: 1 as const
    };
    const route = vi.fn(async () => { throw new Error("must not reroute"); });
    const materialize = vi.fn(async () => ({ bindings: [], ok: true as const, snapshot }));
    const harness = createHarness({
      mcp: {
        materialize,
        prepare: async () => ({ bindings: [], ok: true, snapshot }),
        router: { route }
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            return {
              finalProviderResponsePreview: {},
              finalText: "Recovered checkpointed discovery",
              usage: { inputTokens: 2, outputTokens: 2, reasoningTokens: 0 }
            };
          }
        }
      }
    });
    const appendEpoch = vi.fn(async () => null);
    harness.repository.appendMcpDiscoveryEpoch = appendEpoch;
    const findToolsCall: PersistedToolLoopCall = {
      arguments: { goal: "remember this detail" },
      completedAt: null,
      id: "stored-checkpointed-find-tools-call",
      mcpBinding: null,
      ordinal: 0,
      providerCallId: "provider-checkpointed-find-tools-call",
      result: null,
      roundIndex: 1,
      startedAt: "2026-07-12T09:00:30.000Z",
      state: "running",
      toolName: MCP_FIND_TOOLS_NAME
    };
    const durable = checkpointedRun({
      calls: [findToolsCall],
      phase: "tools_running",
      providerToolMessages: [{
        arguments: JSON.stringify({ goal: "remember this detail" }),
        call_id: "provider-checkpointed-find-tools-call",
        name: MCP_FIND_TOOLS_NAME,
        type: "function_call"
      }]
    });
    installCheckpointState(harness, {
      ...durable,
      normalizedRequest: {
        ...durable.normalizedRequest,
        mcp: snapshot,
        mcpDiscovery: {
          catalog,
          epochs: [{
            epoch: 1,
            goal: "remember this detail",
            modelRunToolCallId: "stored-checkpointed-find-tools-call",
            roundIndex: 1,
            toolIds: [recoveryToolName]
          }],
          version: 2
        }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(route).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(appendEpoch).not.toHaveBeenCalled();
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered checkpointed discovery"
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("settles a recovered router failure with the safe public discovery error", async () => {
    const rawFailure = "PRIVATE_RECOVERY_ROUTER_FAILURE";
    const route = vi.fn(async () => { throw new Error(rawFailure); });
    const materialize = vi.fn(async () => ({
      bindings: [],
      ok: true as const,
      snapshot: { servers: [], tools: [], version: 1 as const }
    }));
    const harness = createHarness({
      mcp: {
        materialize,
        prepare: materialize,
        router: { route }
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            throw new Error("answer provider must not run after discovery failure");
          }
        }
      }
    });
    const appendEpoch = vi.fn(async () => null);
    harness.repository.appendMcpDiscoveryEpoch = appendEpoch;
    const findToolsCall: PersistedToolLoopCall = {
      arguments: { goal: "create an issue" },
      completedAt: null,
      id: "stored-failing-find-tools-call",
      mcpBinding: null,
      ordinal: 0,
      providerCallId: "provider-failing-find-tools-call",
      result: null,
      roundIndex: 1,
      startedAt: null,
      state: "pending",
      toolName: MCP_FIND_TOOLS_NAME
    };
    const durable = checkpointedRun({
      calls: [findToolsCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: JSON.stringify({ goal: "create an issue" }),
        call_id: "provider-failing-find-tools-call",
        name: MCP_FIND_TOOLS_NAME,
        type: "function_call"
      }]
    });
    const checkpointState = installCheckpointState(harness, {
      ...durable,
      normalizedRequest: {
        ...durable.normalizedRequest,
        mcp: { servers: [], tools: [], version: 1 },
        mcpDiscovery: {
          catalog: { servers: [], version: 1 },
          epochs: [],
          version: 2
        }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.recoveredErrors).toEqual([expect.objectContaining({
      error: {
        code: "mcp_auto_discovery_unavailable",
        message: "Automatic tool discovery is unavailable."
      }
    })]);
    expect(JSON.stringify(harness.state.recoveredErrors)).not.toContain(rawFailure);
    expect(checkpointState.calls()).toEqual([
      expect.objectContaining({ state: "error", toolName: MCP_FIND_TOOLS_NAME })
    ]);
    expect(materialize).not.toHaveBeenCalled();
    expect(appendEpoch).not.toHaveBeenCalled();
  });

  it("re-budgets the retained tool transcript before a recovered provider continuation", async () => {
    const stream = vi.fn();
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        stream(request);
        return providerResult;
      }
    };
    const harness = createHarness({
      mcpRuntime: {
        callTool: async () => ({
          isError: false,
          structuredContent: null,
          text: ["large recovered result ".repeat(200)],
          unsupportedContentTypes: []
        }),
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        context: {
          messages: [{
            content: { blocks: [{ text: "remember", type: "text" }] },
            id: "current-message",
            role: "user"
          }],
          mode: "branch_path"
        },
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          contextWindow: 500,
          defaultMaxOutputTokens: 0
        }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "context_too_large" }) })
    ]);
  });

  it("claims pending calls, reuses persisted usage, and does not double-count the completed round", async () => {
    const requests: ProviderRunRequest[] = [];
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      result: {
        finalProviderResponsePreview: {},
        finalText: "",
        providerResponseId: "response-tool-1",
        toolCalls: [{ arguments: {}, id: "provider-call-1", name: recoveryToolName }],
        usage: { inputTokens: 99, outputTokens: 99, reasoningTokens: 0 }
      },
      status: "completed",
      terminal: true
    }));
    const runtimeCall = vi.fn(async () => ({
      isError: false,
      structuredContent: { stored: true },
      text: [],
      unsupportedContentTypes: []
    }));
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      refresh,
      async *stream(request) {
        requests.push(request);
        return {
          finalProviderResponsePreview: {},
          finalText: "done",
          providerResponseId: "response-final",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    const checkpointState = installCheckpointState(
      harness,
      checkpointedRun({
        answerRoundUsage: [{
          completeness: "terminal",
          roundIndex: 1,
          usage: {
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            inputTokens: 7,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 8
          }
        }],
        calls: [persistedRecoveryCall()],
        phase: "tools_pending"
      }),
      [{
        modelId: "gpt-test",
        provider: "openai",
        recordedAt: "2026-07-12T09:00:00.000Z",
        usage: { inputTokens: 7, outputTokens: 1, reasoningTokens: 0 }
      }]
    );

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).not.toHaveBeenCalled();
    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(requests[0]?.previousProviderResponseId).toBeUndefined();
    expect(harness.state.completed).toMatchObject({
      usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
      usageAttributions: [{
        modelId: "gpt-test",
        provider: "openai",
        usage: expect.objectContaining({ inputTokens: 9, outputTokens: 4 })
      }]
    });
    expect(checkpointState.checkpoint()).toMatchObject({
      answerRoundUsage: [
        expect.objectContaining({ completeness: "terminal", roundIndex: 1 }),
        expect.objectContaining({ completeness: "terminal", roundIndex: 2 })
      ],
      phase: "provider_running",
      roundIndex: 2,
      version: 2
    });
  });

  it("replaces partial later-round usage without dropping same-model tool usage", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      result: {
        finalProviderResponsePreview: {},
        finalText: "Recovered after round two",
        providerResponseId: "response-round-2",
        usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0, totalTokens: 5 }
      },
      status: "completed",
      terminal: true
    }));
    const harness = createHarness({
      providers: { openai: providerWithRefresh(refresh) }
    });
    const checkpointState = installCheckpointState(harness, checkpointedRun({
      answerRoundUsage: [
        {
          completeness: "terminal",
          roundIndex: 1,
          usage: {
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            inputTokens: 7,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 8
          }
        },
        {
          completeness: "partial",
          roundIndex: 2,
          usage: {
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            inputTokens: 2,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 3
          }
        }
      ],
      phase: "provider_running",
      providerResponseId: "response-round-2",
      providerToolMessages: [],
      roundIndex: 2
    }), [{
      // The grouped row also includes 3 input and 4 output tokens consumed by
      // a tool which intentionally uses the same provider/model as the answer.
      modelId: "gpt-test",
      provider: "openai",
      recordedAt: "2026-07-12T09:00:00.000Z",
      usage: { inputTokens: 12, outputTokens: 6, reasoningTokens: 0, totalTokens: 18 }
    }]);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.state.completed).toMatchObject({
      estimatedCostMicros: 280,
      finalText: "Recovered after round two",
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      usageAttributions: [{
        modelId: "gpt-test",
        provider: "openai",
        estimatedCostMicros: 280,
        usage: expect.objectContaining({ inputTokens: 12, outputTokens: 8, totalTokens: 20 })
      }]
    });
    expect(checkpointState.checkpoint()).toMatchObject({
      answerRoundUsage: [
        expect.objectContaining({ completeness: "terminal", roundIndex: 1 }),
        expect.objectContaining({
          completeness: "terminal",
          roundIndex: 2,
          usage: expect.objectContaining({ inputTokens: 2, outputTokens: 3, totalTokens: 5 })
        })
      ],
      version: 2
    });
  });

  it("fails closed when answer-round usage exceeds the persisted aggregate", async () => {
    const refresh = vi.fn();
    const harness = createHarness({
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          refresh,
          async *stream() {
            return providerResult;
          }
        }
      }
    });
    installCheckpointState(harness, checkpointedRun({
      answerRoundUsage: [{
        completeness: "partial",
        roundIndex: 1,
        usage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 9,
          outputTokens: 3,
          reasoningTokens: 0,
          totalTokens: 12
        }
      }],
      phase: "provider_running",
      providerResponseId: "response-tool-1"
    }), [{
      modelId: "gpt-test",
      provider: "openai",
      recordedAt: "2026-07-12T09:00:00.000Z",
      usage: { inputTokens: 4, outputTokens: 2, reasoningTokens: 0, totalTokens: 6 }
    }]);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).not.toHaveBeenCalled();
    expect(harness.state.completed).toBeNull();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: "tool_loop_usage_evidence_invalid" }),
        usageAttributions: []
      })
    ]);
  });

  it("never repeats a call left running across a process crash", async () => {
    const runtimeCall = vi.fn();
    const harness = createHarness({
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            return providerResult;
          }
        }
      }
    });
    installCheckpointState(
      harness,
      checkpointedRun({ calls: [persistedRecoveryCall("running")], phase: "tools_running" })
    );

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: "tool_call_outcome_unknown" })
      })
    ]);
  });

  it("fails a checkpointed provider round without a durable native handle actionably", async () => {
    const stream = vi.fn();
    const harness = createHarness({
      controls: [control({ providerResponseId: null })],
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          stream: stream as ProviderAdapter["stream"]
        }
      }
    });
    installCheckpointState(
      harness,
      checkpointedRun({ phase: "provider_running", providerResponseId: null })
    );

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: {
          code: "tool_loop_provider_round_outcome_unknown",
          message: "The model round stopped before a durable provider response ID was saved and was not repeated."
        }
      })
    ]);
  });
});
