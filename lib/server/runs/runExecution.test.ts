import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import {
  MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE,
  MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE
} from "../../contracts/runs";
import {
  GROUNDED_LIVE_ONLY_PLACEHOLDER
} from "../../domain/grounding";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ResolvedEntitlements } from "../auth/entitlements";
import { McpClientSessionError } from "../mcp/clientSession";
import type { McpDiscoveryState, McpRunPlanSnapshot } from "../mcp/runPlan";
import { mcpRunTools } from "../mcp/toolExecutor";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import { buildOpenAIResponsesRequestPreview } from "../providers/openaiResponsesRequest";
import { buildOpenRouterChatRequestPreview } from "../providers/openRouterChatRequest";
import { ProviderRequestTimeoutError } from "../providers/network";
import { PERSONAL_CONTEXT_HEADING } from "../providers/personalContext";
import { ProviderStreamTooLargeError } from "../providers/streamSafety";
import type {
  NormalizedRunRequest,
  ProviderAdapter,
  ProviderRunRequest,
  ProviderRunResult,
  ProviderSearchAdapter,
  ProviderSearchRequest
} from "../providers/types";
import {
  activeRunControllerRegistry,
  createRunExecutionResponse,
  type RunExecutionInput,
  type RunExecutionRepository
} from "./runExecution";
import { activeRunControllersForTest } from "@/tests/support/runExecution";
import type { MaterializedPreparedRunData } from "./runPreparation";
import type {
  FocusedKnowledgeRecoveryScope,
  ProjectRunAdmission,
  RunChatUpdateRecord,
  RunRepository
} from "./runRepositoryContract";
import type { PersistedToolLoopCall } from "./toolLoopPersistence";
import { parsePersistedToolExecutionResult } from "./toolExecutionPersistence";
import { knowledgeRetrievalTool, type KnowledgeToolExecutor } from "../knowledge/toolExecutor";
import {
  createKnowledgeFocusedRequest,
  type KnowledgeFocusedRequestV1
} from "../knowledge/focusedRequest";
import type { MemoryToolEgressReceiptService } from "../memory/egress/receipts";
import {
  KNOWLEDGE_FOCUSED_OPERATION_NAME,
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  type KnowledgeRetrievalEvidence
} from "../knowledge/retrievalTypes";
import { knowledgeToolResultContent, knowledgeToolResultText } from "../knowledge/toolResult";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../knowledge/knowledgeBudget";
import {
  KnowledgeAnswerContractError,
  type KnowledgeGroundingResult
} from "../knowledge/grounding";
import {
  KNOWLEDGE_INSUFFICIENT_MESSAGE,
  KNOWLEDGE_SEARCH_UNAVAILABLE_MESSAGE
} from "../knowledge/answerGroundingV5";
import { KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21 } from
  "../knowledge/answerGroundingV21";
import { KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21 } from
  "../knowledge/answerGroundingSelectorV21";
import { KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION } from
  "../knowledge/coverageScopeV6";
import { KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION } from
  "../knowledge/coverageScopeCompletenessV1";
import { KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_OPERATION } from
  "../knowledge/coverageScopeClosureV2";
import type { KnowledgeRunFinalizationEnvelope } from "../knowledge/evidenceRepository";
import type {
  KnowledgeProviderDispatchLifecycle,
  PreparedKnowledgeProviderDispatch
} from "../knowledge/providerDispatchLifecycle";
import {
  knowledgeAnsweringRequestSnapshot,
  KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT,
  planKnowledgeAnswering
} from "../knowledge/fullContext";
import {
  knowledgeEvidenceMessageFromDispatchDraft,
  withAutomaticKnowledgeEvidence
} from "../knowledge/automaticEvidence";

type CompleteRunInput = Parameters<RunRepository["completeRun"]>[0];
type CreateSearchRunInput = Parameters<RunRepository["createSearchRun"]>[0];
type RecordRunUsageEventsInput = Parameters<RunRepository["recordRunUsageEvents"]>[0];
type FailedRun = {
  assistantMessageId: string;
  error: { code: string; message: string };
  options?: Readonly<{ recoveryTerminal?: boolean }>;
  runId: string;
};
type GroundedMark = Parameters<RunRepository["markAssistantMessageGroundedLiveOnly"]>[0];
type ProjectAccessCheck = Parameters<NonNullable<RunRepository["isProjectRunAccessCurrent"]>>[0];

type RepositoryOptions = Readonly<{
  chatUpdate?: RunChatUpdateRecord | null;
  completionWins?: boolean;
  entitlements?: ResolvedEntitlements;
  failureWins?: boolean;
  groundingError?: Error;
  groundingResult?: KnowledgeGroundingResult | null;
  projectAccessCurrent?: boolean | (() => boolean);
  runStatus?: string;
  searchStrategyEnabled?: boolean;
  responseIdPublication?: "cancelled" | "published" | "terminal";
  usagePersistenceError?: Error;
}>;

function usage(inputTokens = 2, outputTokens = 3, reasoningTokens = 1): ModelRunUsage {
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens
  };
}

function knowledgeFinalizationEnvelope(
  grounding: KnowledgeGroundingResult
): KnowledgeRunFinalizationEnvelope {
  return { grounding };
}

function structuralGroundingResult(
  finalText: string,
  outcome: KnowledgeGroundingResult["outcome"] = "answered"
): KnowledgeGroundingResult {
  return {
    finalAnswerHash: "a".repeat(64),
    finalText,
    originalAnswerHash: "b".repeat(64),
    outcome,
    receiptHash: "c".repeat(64),
    sessionId: "knowledge-session-1",
    version: 5
  };
}

function providerResult(overrides: Partial<ProviderRunResult> = {}): ProviderRunResult {
  return {
    finalProviderResponsePreview: { response: "safe" },
    finalText: "Final answer",
    usage: usage(),
    ...overrides
  };
}

function plannedCoverageOutput(description = "The requested answer.") {
  return {
    dimensions: [{ description, id: "D1" }],
    version: 1
  } as const;
}

function plannedDraftOutput(text: string) {
  return {
    claims: [{ citationHints: ["K1"], text }],
    version: 1
  } as const;
}

function plannedSelectorOutput() {
  return {
    claims: [{ id: "C1", supportHandles: ["K1"], verdict: "supported" }],
    coverage: [{ id: "D1", status: "covered", supportIds: ["C1"] }],
    extractIds: [],
    insufficientReason: "not_applicable",
    version: 1
  } as const;
}

function plannedScopeV6Output() {
  return {
    evidenceUnits: [{
      findings: [{
        description: "The requested answer.",
        evidenceAtomIds: ["A1"],
        requestAnchor: "Q1"
      }],
      handle: "K1"
    }],
    jointFindings: [],
    unsupportedDimensions: [],
    version: 6
  } as const;
}

function plannedScopeClosureOutput() {
  return {
    decisions: [{ id: "D1", status: "closed" }],
    version: 2
  } as const;
}

function plannedCurrentKnowledgeOutput(call: number, text: string) {
  if (call === 1) return plannedDraftOutput(text);
  if (call === 2) return plannedScopeV6Output();
  if (call === 3) return { additions: [], version: 1 } as const;
  if (call === 4) return plannedSelectorOutput();
  if (call === 5) return plannedScopeClosureOutput();
  throw new Error("current_knowledge_operation_fixture_invalid");
}

const CURRENT_KNOWLEDGE_OPERATION_NAMES = [
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_COVERAGE_SCOPE_V6_OPERATION,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V21,
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_V2_OPERATION
] as const;

function projectAdmission(): ProjectRunAdmission {
  return {
    accessRevision: 3,
    assistantBindings: [],
    defaults: {
      assistantId: null,
      controlValues: {},
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpMode: "off",
      providerModelId: "fake-qsa",
      searchPlan: { mode: "all_selected", optionIds: [] }
    },
    instructions: "Shared instructions",
    instructionsRevision: 2,
    knowledgeBaseIds: [],
    mcpServerIds: [],
    memoryEnabled: false,
    memoryItems: [],
    memoryRevision: 1,
    modelIds: ["fake-qsa"],
    policy: { externalToolsEnabled: true },
    policyRevision: 4,
    projectId: "project-1",
    executionScope: "project",
    role: "CONTRIBUTOR",
    searchOptionIds: []
  };
}

function knowledgeEvidence(): KnowledgeRetrievalEvidence {
  const draft: KnowledgeRetrievalEvidence = {
    bases: [{
      baseContentRevision: 1,
      baseName: "Private base",
      candidateCount: 1,
      indexedContentRevision: 1,
      indexGenerationId: "generation-1",
      knowledgeBaseId: "base-1",
      ordinal: 0,
      state: "ready",
      targetDimension: 1024,
      vectorSpaceFingerprint: "a".repeat(64)
    }],
    candidateCount: 1,
    candidateLimit: 40,
    durationMs: 12,
    embeddingExecutions: [{
      bindingOrdinals: [0],
      durationMs: 4,
      inputTokens: 7,
      modelId: "embedding-v1",
      provider: "openai_compatible",
      providerModelId: "embedding-deployment-1",
      requestId: null,
      status: "complete",
      totalTokens: 7
    }],
    fusion: "rrf_k60",
    invocationOrdinal: 1,
    outcome: "complete",
    providerText: "pending",
    query: "private corpus query",
    resultLimit: 8,
    results: [{
      annRank: 1,
      baseName: "Private base",
      bindingOrdinal: 0,
      chunkId: "chunk-1",
      chunkIndex: 0,
      documentId: "document-1",
      documentVersionId: "version-1",
      documentVersionNumber: 1,
      fileName: "private.pdf",
      ftsRank: 1,
      ftsScore: 0.5,
      fusedScore: 2 / 61,
      handle: "K1",
      includedText: "Bounded private passage",
      includedTextBytes: Buffer.byteLength("Bounded private passage", "utf8"),
      knowledgeBaseId: "base-1",
      page: 2,
      sourceAlias: "S1",
      sourceArtifactId: "artifact-1",
      sourceName: "Private source",
      sourceTextBytes: Buffer.byteLength("Bounded private passage", "utf8"),
      textTruncated: false,
      vectorDistance: 0.1,
      vectorScore: 0.9
    }],
    scopeAliases: [{ alias: "S1", kind: "source", label: "Private source" }],
    version: KNOWLEDGE_RESULT_VERSION
  };
  return { ...draft, providerText: knowledgeToolResultText(draft) };
}

function emptyKnowledgeEvidence(): KnowledgeRetrievalEvidence {
  const complete = knowledgeEvidence();
  const draft: KnowledgeRetrievalEvidence = {
    ...complete,
    bases: complete.bases.map((base) => ({
      ...base,
      candidateCount: 0,
      state: "empty"
    })),
    candidateCount: 0,
    outcome: "base_empty",
    providerText: "pending",
    results: []
  };
  return { ...draft, providerText: knowledgeToolResultText(draft) };
}

function searchUnavailableKnowledgeEvidence(): KnowledgeRetrievalEvidence {
  const complete = knowledgeEvidence();
  const draft: KnowledgeRetrievalEvidence = {
    ...complete,
    bases: [],
    candidateCount: 0,
    candidateLimit: 64,
    failureCode: "knowledge_search_backend_unavailable",
    fusion: "weighted_rrf_v2",
    operation: "automatic_search",
    outcome: "search_unavailable",
    providerText: "pending",
    query: "knowledge_search_unavailable",
    resultLimit: 16,
    results: [],
    scopeAliases: undefined
  };
  return { ...draft, providerText: knowledgeToolResultText(draft) };
}

function hostedSearchPlan(
  optionId: string,
  provider: "gemini" | "openai" = "openai"
): NormalizedRunRequest["searchPlan"] {
  return {
    mode: "model_choice",
    options: [{
      adapterKind: "answer_provider_hosted",
      config: {},
      credentialMode: "answer_provider",
      displayName: provider === "gemini" ? "Google Search" : "OpenAI Web Search",
      executionModes: ["model_choice"],
      modelId: null,
      optionId,
      protocol: provider === "gemini" ? "gemini_google_search" : "openai_responses_web_search",
      provider,
      providerModelId: null,
      revisionId: `revision:${optionId}`,
      searchStrategyRowId: `route:${optionId}`
    }]
  };
}

function providerClientSearchPlan(input: Readonly<{
  modelId: string;
  optionId: string;
  protocol: "anthropic_web_search" | "gemini_google_search" | "openrouter_perplexity_chat";
  provider: "anthropic" | "gemini" | "openrouter";
}>): NormalizedRunRequest["searchPlan"] {
  return {
    mode: "model_choice",
    options: [{
      adapterKind: "provider_model_client",
      config: {
        maxOutputTokens: 8192,
        maxResults: 8,
        maxSearchCallsPerAnswer: 3,
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
        reasoningPolicy: "lowest_supported",
        timeoutMs: 300_000
      },
      credentialMode: "provider_model",
      displayName: "Client Search",
      executionModes: ["all_selected", "model_choice"],
      modelId: input.modelId,
      optionId: input.optionId,
      protocol: input.protocol,
      provider: input.provider,
      providerModelId: `provider-model:${input.optionId}`,
      revisionId: `revision:${input.optionId}`,
      searchStrategyRowId: `route:${input.optionId}`
    }]
  };
}

function perplexityClientSearchPlan(): NormalizedRunRequest["searchPlan"] {
  return providerClientSearchPlan({
    modelId: "perplexity/sonar-pro-search",
    optionId: "perplexity-tool-search",
    protocol: "openrouter_perplexity_chat",
    provider: "openrouter"
  });
}

function executionAdmissionPlan(input: Readonly<{
  capabilities: NormalizedRunRequest["modelCapabilities"];
  modelId: string;
  provider: string;
  searchPlan: NormalizedRunRequest["searchPlan"];
}>): ProviderAdmissionPlan {
  const fake = input.provider === "fake";
  const answer: ProviderAdmissionPlan["answer"] = fake
    ? {
        credentialSource: "default",
        modelConfiguration: {
          adapterKind: "fake",
          capabilities: input.capabilities,
          defaultParams: {}
        },
        snapshot: {
          connection: {
            allowPrivateNetwork: true,
            apiRoot: "http://127.0.0.1",
            authenticationMode: "none",
            responseTimeoutMs: 300_000
          },
          connectionDisplayName: input.provider,
          connectionId: input.provider,
          credentialId: null,
          credentialVersionId: null,
          model: {
            adapterKind: "fake",
            capabilities: input.capabilities,
            defaultParams: {},
            upstreamModelId: input.modelId
          },
          modelDisplayName: input.modelId,
          providerFamily: input.provider,
          providerModelId: input.modelId,
          version: 1
        }
      }
    : {
        credentialSource: "default",
        modelConfiguration: {
          adapterKind: "openai_responses_native",
          capabilities: input.capabilities,
          defaultParams: {}
        },
        snapshot: {
          connection: {
            allowPrivateNetwork: false,
            apiRoot: "https://provider.example.test/v1",
            authenticationMode: "bearer",
            responseTimeoutMs: 300_000
          },
          connectionDisplayName: input.provider,
          connectionId: input.provider,
          credentialId: `credential:${input.provider}`,
          credentialVersionId: `credential-version:${input.provider}`,
          model: {
            adapterKind: "openai_responses_native",
            answerSelectable: true,
            capabilities: input.capabilities,
            defaultParams: {},
            modelClass: "answer",
            upstreamModelId: input.modelId
          },
          modelDisplayName: input.modelId,
          providerFamily: input.provider,
          providerModelId: input.modelId,
          version: 1
        }
      };

  return {
    answer,
    fingerprint: "f".repeat(64),
    requestedSearchPlan: {
      mode: input.searchPlan.mode,
      optionIds: input.searchPlan.options.map((option) => option.optionId)
    },
    searches: [],
    selection: {
      providerConnectionId: input.provider,
      providerModelId: input.modelId
    },
    userId: "user-1"
  };
}

function preparedData(input: Readonly<{
  chatId?: string;
  contextTruncation?: ContextTruncationSummary | null;
  knowledgeBaseIds?: string[];
  knowledgeFocusedRequest?: KnowledgeFocusedRequestV1;
  knowledgeUnavailable?: boolean;
  memoryActions?: boolean;
  memoryHistory?: boolean;
  mcpDiscovery?: McpDiscoveryState;
  mcp?: McpRunPlanSnapshot;
  modelId?: string;
  project?: ProjectRunAdmission;
  provider?: string;
  searchPlan?: NormalizedRunRequest["searchPlan"];
  toolMode?: "auto" | "none";
  toolCalling?: boolean;
}> = {}): MaterializedPreparedRunData {
  const provider = input.provider ?? "fake";
  const modelId = input.modelId ?? "fake-qsa";
  const searchPlan = input.searchPlan ?? { mode: "all_selected" as const, options: [] };
  const chatId = input.chatId ?? "chat-1";
  const content = textMessageContent("Current question");
  const normalizedRequest: NormalizedRunRequest = {
    attachmentIds: [],
    chatId,
    content,
    context: {
      messages: [
        {
          content,
          id: "current-user-message",
          role: "user"
        }
      ],
      mode: "branch_path"
    },
    modelCapabilities: {
      backgroundStreaming: true,
      contextWindow: 32_768,
      defaultMaxOutputTokens: 512,
      nativeBackground: true,
      nativePdfInput: false,
      nativeSearch: false,
      parallelToolCalls: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: input.toolCalling ?? true,
      vision: true
    },
    knowledgePlan: input.knowledgeBaseIds?.length
      ? {
          baseIds: input.knowledgeBaseIds,
          mode: "explicit",
          sourceIds: [],
          version: 1
        }
      : { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    ...(input.knowledgeFocusedRequest
      ? { knowledgeFocusedRequest: input.knowledgeFocusedRequest }
      : {}),
    toolMode: input.toolMode ?? "auto",
    ...(input.memoryActions
      ? { memoryActionTools: { version: "model-driven-v2" as const } }
      : {}),
    ...(input.memoryHistory
      ? { memoryHistoryTool: { maxCalls: 2 as const, pageSize: 20 as const } }
      : {}),
    ...(input.mcpDiscovery ? { mcpDiscovery: input.mcpDiscovery } : {}),
    ...(input.mcp ? { mcp: input.mcp } : {}),
    modelId,
    params: {},
    prompt: {
      developer: "Answer directly.",
      system: null
    },
    provider,
    searchPlan
  };
  const knowledgeAdmissionPlan = input.knowledgeBaseIds?.length
    ? {
        bindings: input.knowledgeUnavailable ? [] : input.knowledgeBaseIds.map((knowledgeBaseId, ordinal) => ({
          baseContentRevision: 1,
          embeddingCredentialSource: "default" as const,
          embeddingExecutionSnapshot: {} as never,
          embeddingProviderModelId: "embedding-v1",
          includeWholeBase: true,
          indexedContentRevision: 1,
          indexGenerationId: `generation-${ordinal + 1}`,
          knowledgeBaseId,
          ordinal,
          selectedSourceIds: [],
          targetDimension: 1024 as const,
          vectorSpaceFingerprint: "a".repeat(64)
        })),
        budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
        exclusions: input.knowledgeUnavailable
          ? [{ count: input.knowledgeBaseIds.length, reason: "not_ready" as const, resourceType: "base" as const }]
          : [],
        fingerprint: "b".repeat(64),
        knowledgePlan: normalizedRequest.knowledgePlan,
        resolvedSourceCount: 0,
        userId: "user-1"
      }
    : null;

  return {
    contextTruncation: input.contextTruncation ?? null,
    defaults: {
      controlDefaults: {},
      modelId,
      provider,
      searchPlan: {
        mode: searchPlan.mode,
        optionIds: searchPlan.options.map((option) => option.optionId)
      },
      userId: "user-1"
    },
    expectedActiveLeafId: "prior-user-message",
    ...(knowledgeAdmissionPlan ? { knowledgeAdmissionPlan } : {}),
    normalizedRequest,
    providerAdmissionPlan: executionAdmissionPlan({
      capabilities: normalizedRequest.modelCapabilities,
      modelId,
      provider,
      searchPlan
    }),
    providerRequest: {
      ...normalizedRequest,
      attachments: []
    },
    providerRequestPreview: {},
    ...(input.project ? { project: input.project } : {}),
    sourceKind: "send"
  };
}

function focusedKnowledgePreparedData(): MaterializedPreparedRunData {
  const knowledgeFocusedRequest = createKnowledgeFocusedRequest({
    currentUserMessage: "Current question"
  });
  if (!knowledgeFocusedRequest) throw new Error("focused_request_fixture_invalid");
  const prepared = preparedData({
    knowledgeBaseIds: ["base-1"],
    knowledgeFocusedRequest,
    modelId: "openai-answer-model",
    provider: "openai"
  });
  return {
    ...prepared,
    providerRequest: {
      ...prepared.providerRequest,
      toolChoice: "auto",
      tools: [knowledgeRetrievalTool]
    }
  };
}

function focusedCanonicalSourcePreparedData(
  executionScope: "personal" | "project"
): MaterializedPreparedRunData {
  const prepared = focusedKnowledgePreparedData();
  const knowledgePlan = {
    baseIds: [],
    mode: "explicit" as const,
    sourceIds: ["source-1"],
    version: 1 as const
  };
  const knowledgeAdmissionPlan = {
    ...prepared.knowledgeAdmissionPlan!,
    bindings: [],
    knowledgePlan,
    profiles: [{
      embeddingCredentialSource: "default" as const,
      embeddingExecutionSnapshot: {} as never,
      embeddingProviderModelId: "embedding-v1",
      ordinal: 0,
      profileRevisionId: "profile-revision-1",
      targetDimension: 1024,
      vectorSpaceFingerprint: "a".repeat(64)
    }],
    resolvedSourceCount: 1,
    sources: [{
      approxTokens: 1_200,
      authority: {
        knowledgeBaseIds: [],
        owner: false,
        projectId: executionScope === "project" ? "project-1" : null
      },
      baseProvenance: [],
      directSelected: true,
      ordinal: 0,
      passageCount: 6,
      privateLabels: {
        fileName: "private.pdf",
        sourceName: "Private source"
      },
      profileOrdinal: 0,
      profileRevisionId: "profile-revision-1",
      selectionProvenance: ["explicit_source" as const],
      sourceAlias: "S1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      sourceVersionId: "version-1",
      sourceVersionNumber: 1
    }],
    ...(executionScope === "project"
      ? { executionScope: "project" as const, projectId: "project-1" }
      : {})
  };
  return {
    ...prepared,
    knowledgeAdmissionPlan,
    normalizedRequest: {
      ...prepared.normalizedRequest,
      knowledgePlan
    },
    providerRequest: {
      ...prepared.providerRequest,
      knowledgePlan
    },
    ...(executionScope === "project" ? { project: projectAdmission() } : {})
  };
}

function fullContextKnowledgePreparedData(): MaterializedPreparedRunData {
  const prepared = focusedCanonicalSourcePreparedData("personal");
  const admission = {
    ...prepared.knowledgeAdmissionPlan!,
    answerPolicy: {
      fullContextThresholdBasisPoints: 7_000 as const,
      maximumKnowledgeSearches: 12,
      revision: 1,
      version: 1 as const
    },
    sources: prepared.knowledgeAdmissionPlan!.sources!.map((source) => ({
      ...source,
      approxTokens: 8,
      passageCount: 1
    }))
  };
  const plan = planKnowledgeAnswering({
    admissionPlan: admission,
    passages: [{
      baseName: "Health",
      contentHash: "c".repeat(64),
      documentContext: null,
      headingPath: ["Lipid panel"],
      page: 1,
      pageEnd: 1,
      passageId: "passage-1",
      passageOrdinal: 0,
      sectionId: "section-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      sourceOrdinal: 0,
      sourceVersionId: "version-1",
      sourceVersionNumber: 1,
      text: "Total cholesterol 5.3 mmol/L",
      tokenCount: 8
    }],
    request: prepared.providerRequest
  });
  if (plan.route !== KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT) {
    throw new Error("full_context_fixture_invalid");
  }
  const normalizedRequest: NormalizedRunRequest = {
    ...prepared.normalizedRequest,
    context: withAutomaticKnowledgeEvidence(
      prepared.providerRequest,
      knowledgeEvidenceMessageFromDispatchDraft(plan.dispatchDraft)
    ).context,
    knowledgeAnswering: knowledgeAnsweringRequestSnapshot(plan),
    prompt: {
      ...prepared.normalizedRequest.prompt,
      knowledgeAnswerDraftContract: 8,
      knowledgeGroundedSelectorContract: 6
    }
  };
  return {
    ...prepared,
    knowledgeAdmissionPlan: { ...admission, answeringPlan: plan },
    normalizedRequest,
    providerRequest: withAutomaticKnowledgeEvidence(
      { ...normalizedRequest, attachments: [], toolChoice: "none", tools: undefined },
      knowledgeEvidenceMessageFromDispatchDraft(plan.dispatchDraft)
    )
  };
}

function focusedKnowledgeExecutor(
  evidence = knowledgeEvidence(),
  onExecute?: () => void
) {
  const execute = vi.fn<KnowledgeToolExecutor["execute"]>(async (call) => {
    onExecute?.();
    return {
      callId: call.id,
      content: knowledgeToolResultContent(evidence),
      name: call.name,
      rawPreview: {
        knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION,
        knowledgeRetrieval: evidence,
        providerCall: true
      },
      status: "complete",
      usage: usage(7, 0, 0)
    };
  });
  const executor: KnowledgeToolExecutor = {
    accepts: (name) => name === KNOWLEDGE_FOCUSED_OPERATION_NAME,
    capability: "knowledge",
    execute,
    tool: knowledgeRetrievalTool
  };
  return { execute, executor };
}

function toolLoopKnowledgeExecutor(evidence = knowledgeEvidence()) {
  const execute = vi.fn<KnowledgeToolExecutor["execute"]>(async (call) => ({
    callId: call.id,
    content: knowledgeToolResultContent(evidence),
    name: call.name,
    rawPreview: {
      knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION,
      knowledgeRetrieval: evidence,
      providerCall: true
    },
    status: evidence.outcome === "search_unavailable" ? "error" : "complete"
  }));
  const executor: KnowledgeToolExecutor = {
    accepts: (name) => name === KNOWLEDGE_SEARCH_TOOL_NAME,
    capability: "knowledge",
    execute,
    preflight: vi.fn(async () => ({ kind: "admitted" as const })),
    tool: knowledgeRetrievalTool,
    tools: [knowledgeRetrievalTool]
  };
  return { execute, executor };
}

function createAdapter(
  stream: ProviderAdapter["stream"],
  previewRequests: ProviderRunRequest[] = []
): ProviderAdapter {
  return {
    buildRequestPreview(request) {
      previewRequests.push(request);
      return {
        modelId: request.modelId,
        providerToolMessageCount: request.providerToolMessages?.length ?? 0,
        toolChoice: request.toolChoice ?? null
      };
    },
    stream
  };
}

function chatUpdate(): RunChatUpdateRecord {
  return {
    chat: {
      activeLeafMessageId: "assistant-1",
      contextStats: { approximateActiveBranchInputTokens: 37 },
      createdAt: new Date("2026-07-12T10:00:00.000Z"),
      defaultModelId: "fake-qsa",
      defaultProvider: "fake",
      folderId: null,
      id: "chat-1",
      messageCount: 2,
      pinned: false,
      title: "Question",
      updatedAt: new Date("2026-07-12T10:01:00.000Z"),
      usageStats: null
    },
    messages: [
      {
        content: textMessageContent("Current question"),
        createdAt: new Date("2026-07-12T10:00:00.000Z"),
        id: "user-message-1",
        modelId: null,
        parentMessageId: null,
        provider: null,
        role: "user",
        status: "complete"
      },
      {
        content: textMessageContent("Final answer"),
        createdAt: new Date("2026-07-12T10:00:01.000Z"),
        id: "assistant-1",
        modelId: "fake-qsa",
        modelRunId: "run-1",
        parentMessageId: "user-message-1",
        provider: "fake",
        role: "assistant",
        status: "complete"
      }
    ]
  };
}

function createRepository(options: RepositoryOptions = {}) {
  const assistantTexts: string[] = [];
  const completeRuns: CompleteRunInput[] = [];
  const failedRuns: FailedRun[] = [];
  const groundingAnswers: string[] = [];
  const groundedMarks: GroundedMark[] = [];
  const persistedEvents: { event: ModelRunSseEvent; runId: string; sequence: number }[] = [];
  const providerResponseIds: string[] = [];
  const providerRequestPreviews: Record<string, unknown>[] = [];
  const projectAccessChecks: ProjectAccessCheck[] = [];
  const recordedRunUsageEvents: RecordRunUsageEventsInput[] = [];
  const searchRuns: CreateSearchRunInput[] = [];
  const toolCalls = new Map<string, PersistedToolLoopCall>();
  let durableProviderResponsePreview: Record<string, unknown> | null = null;
  let toolCallSequence = 0;
  let chatUpdateLoads = 0;
  const repository: RunExecutionRepository = {
    async advanceToolLoopCallBatch() {
      return "advanced";
    },
    async appendAssistantText(_assistantMessageId, text) {
      assistantTexts.push(text);
    },
    async appendRunOutputEvent(runId, event) {
      const sequence = persistedEvents.length;
      persistedEvents.push({ event, runId, sequence });
    },
    async beginToolLoopProviderRound() {
      return "started";
    },
    async cancelPendingToolLoopCalls() {
      let cancelled = 0;
      for (const [id, call] of toolCalls) {
        if (call.state !== "pending") continue;
        toolCalls.set(id, { ...call, completedAt: new Date().toISOString(), state: "cancelled" });
        cancelled += 1;
      }
      return cancelled;
    },
    async claimAutomaticKnowledgeCall({ callId }) {
      const call = toolCalls.get(callId);
      if (!call) return { kind: "not_found" };
      if (call.state === "running") return { call, kind: "ambiguous" };
      if (call.state === "cancelled") return { call, kind: "cancelled" };
      if (call.state === "complete" || call.state === "error") return { call, kind: "settled" };
      const claimed = { ...call, startedAt: new Date().toISOString(), state: "running" as const };
      toolCalls.set(callId, claimed);
      return { call: claimed, kind: "claimed" };
    },
    async claimToolLoopCall({ callId }) {
      const call = toolCalls.get(callId);
      if (!call) return { kind: "not_found" };
      if (call.state === "running") return { call, kind: "ambiguous" };
      if (call.state === "cancelled") return { call, kind: "cancelled" };
      if (call.state === "complete" || call.state === "error") return { call, kind: "settled" };
      const claimed = { ...call, startedAt: new Date().toISOString(), state: "running" as const };
      toolCalls.set(callId, claimed);
      return { call: claimed, kind: "claimed" };
    },
    async completeRun(input) {
      completeRuns.push(input);
      if (options.completionWins === false) {
        return false;
      }
      for (const event of input.outputEvents ?? []) {
        persistedEvents.push({ event, runId: input.runId, sequence: persistedEvents.length });
      }
      return true;
    },
    async createSearchRun(input) {
      searchRuns.push(input);
    },
    async failRun(runId, assistantMessageId, error, failureOptions) {
      if (options.failureWins === false) {
        return false;
      }
      failedRuns.push({
        assistantMessageId,
        error,
        ...(failureOptions ? { options: failureOptions } : {}),
        runId
      });
      return true;
    },
    async getChatUpdateForRun() {
      chatUpdateLoads += 1;
      return options.chatUpdate ?? null;
    },
    async getRunControlForUser(runId) {
      return {
        assistantMessageId: "assistant-1",
        chatId: "chat-1",
        id: runId,
        modelId: "fake-qsa",
        provider: "fake",
        providerResponseId: null,
        status: options.runStatus ?? "streaming"
      };
    },
    async groundKnowledgeAnswer({ answer }) {
      groundingAnswers.push(answer);
      if (options.groundingError) throw options.groundingError;
      return options.groundingResult
        ? knowledgeFinalizationEnvelope(options.groundingResult)
        : null;
    },
    async groundKnowledgeAnswerV5() {
      if (options.groundingError) throw options.groundingError;
      if (!options.groundingResult) {
        throw new Error("knowledge_grounding_fixture_missing");
      }
      return knowledgeFinalizationEnvelope(options.groundingResult);
    },
    async groundKnowledgeAnswerV21() {
      if (options.groundingError) throw options.groundingError;
      if (!options.groundingResult) {
        throw new Error("knowledge_grounding_fixture_missing");
      }
      return knowledgeFinalizationEnvelope(options.groundingResult);
    },
    async isProjectRunAccessCurrent(input) {
      projectAccessChecks.push(input);
      return typeof options.projectAccessCurrent === "function"
        ? options.projectAccessCurrent()
        : options.projectAccessCurrent ?? true;
    },
    async isSearchStrategyEnabled() {
      return options.searchStrategyEnabled ?? true;
    },
    async loadEntitlements() {
      return (
        options.entitlements ?? {
          modelKeys: new Set<string>(),
          providerKeys: new Set(["fake", "openai", "openrouter"]),
          searchStrategies: new Set(["openai-native-web-search", "perplexity-tool-search"])
        }
      );
    },
    async loadModelPricing() {
      return null;
    },
    async markAssistantMessageGroundedLiveOnly(input) {
      groundedMarks.push(input);
      assistantTexts.splice(0);
      persistedEvents.splice(0);
      return true;
    },
    async persistToolLoopCallBatch(input) {
      const calls = input.calls.map((call) => {
        const existing = [...toolCalls.values()].find((entry) =>
          entry.roundIndex === input.roundIndex && entry.providerCallId === call.providerCallId
        );
        if (existing) return existing;
        const id = `persisted-tool-call-${++toolCallSequence}`;
        const persisted: PersistedToolLoopCall = {
          arguments: call.arguments,
          completedAt: null,
          id,
          mcpBinding: call.runtimeGenerationFingerprint ? {
            id: `binding-${id}`,
            runtimeGenerationFingerprint: call.runtimeGenerationFingerprint,
            runtimeGenerationId: `generation-${call.runtimeGenerationFingerprint}`
          } : null,
          ordinal: call.ordinal,
          providerCallId: call.providerCallId,
          result: null,
          roundIndex: input.roundIndex,
          startedAt: null,
          state: "pending",
          toolName: call.toolName
        };
        toolCalls.set(id, persisted);
        return persisted;
      });
      return { calls, kind: "persisted" };
    },
    async prepareAutomaticKnowledgeCallBatch(input) {
      const calls = input.calls.map((call) => {
        const existing = [...toolCalls.values()].find((entry) =>
          entry.roundIndex === 0 && entry.providerCallId === call.providerCallId
        );
        if (existing) return existing;
        const id = `persisted-tool-call-${++toolCallSequence}`;
        const persisted: PersistedToolLoopCall = {
          arguments: call.arguments,
          completedAt: null,
          id,
          mcpBinding: null,
          ordinal: call.ordinal,
          providerCallId: call.providerCallId,
          result: null,
          roundIndex: 0,
          startedAt: null,
          state: "pending",
          toolName: KNOWLEDGE_FOCUSED_OPERATION_NAME
        };
        toolCalls.set(id, persisted);
        return persisted;
      });
      return { calls, kind: "prepared" };
    },
    async recordRunUsageEvents(input) {
      if (options.usagePersistenceError) {
        throw options.usagePersistenceError;
      }
      recordedRunUsageEvents.push(input);
      if (input.usageAccountedToolCallIds) {
        const accounted = new Set(input.usageAccountedToolCallIds);
        for (const [id, call] of toolCalls) {
          if (accounted.has(id)) {
            toolCalls.set(id, { ...call, usageAccountedAt: new Date().toISOString() });
          }
        }
      }
      return true;
    },
    async resetToolLoopAssistantDraft() {
      return true;
    },
    async markRunAnswerStarted() {
      return undefined;
    },
    async settleToolLoopCall({ callId, result, state }) {
      const call = toolCalls.get(callId);
      if (!call) return "not_found";
      if (call.state === "complete" || call.state === "error") return "reused";
      if (call.state !== "running") return "conflict";
      toolCalls.set(callId, {
        ...call,
        completedAt: new Date().toISOString(),
        result,
        state
      });
      return "settled";
    },
    async updateRunProviderResponseId(_runId, providerResponseId) {
      providerResponseIds.push(providerResponseId);
      return options.responseIdPublication ?? "published";
    }
  };

  return {
    assistantTexts,
    completeRuns,
    get durableProviderResponsePreview() {
      return durableProviderResponsePreview;
    },
    failedRuns,
    groundingAnswers,
    groundedMarks,
    get chatUpdateLoads() {
      return chatUpdateLoads;
    },
    persistedEvents,
    projectAccessChecks,
    providerRequestPreviews,
    providerResponseIds,
    recordedRunUsageEvents,
    repository,
    searchRuns,
    toolCalls
  };
}

function executionInput(input: Readonly<{
  adapter: ProviderAdapter;
  knowledgeAdmission?: RunExecutionInput["knowledgeAdmission"];
  knowledgeExecutor?: KnowledgeToolExecutor;
  knowledgeProviderDispatch?: KnowledgeProviderDispatchLifecycle;
  memoryEgress?: MemoryToolEgressReceiptService;
  mcp?: RunExecutionInput["mcp"];
  mcpRuntime?: RunExecutionInput["mcpRuntime"];
  prepared?: MaterializedPreparedRunData;
  providerAdmission?: RunExecutionInput["providerAdmission"];
  repository: RunExecutionRepository;
  runId?: string;
  searchAdapter?: ProviderSearchAdapter;
  searchRuntimes?: RunExecutionInput["searchRuntimes"];
  structuredOutputAdapter?: RunExecutionInput["structuredOutputAdapter"];
}>): RunExecutionInput {
  const prepared = input.prepared ?? preparedData();
  const searchRuntimes = input.searchRuntimes ?? (input.searchAdapter
    ? Object.fromEntries(prepared.normalizedRequest.searchPlan.options.map((option) => [
        option.optionId,
        {
          adapter: input.adapter,
          responseTimeoutMs: 300_000,
          searchAdapter: input.searchAdapter
        }
      ]))
    : undefined);
  return {
    adapter: input.adapter,
    created: {
      assistantMessageId: "assistant-1",
      runId: input.runId ?? "run-1",
      userMessageId: "user-message-1"
    },
    prepared,
    repository: input.repository,
    ...(input.knowledgeAdmission ? { knowledgeAdmission: input.knowledgeAdmission } : {}),
    ...(input.knowledgeExecutor ? { knowledgeExecutor: input.knowledgeExecutor } : {}),
    ...(input.knowledgeProviderDispatch
      ? { knowledgeProviderDispatch: input.knowledgeProviderDispatch }
      : {}),
    ...(input.memoryEgress ? { memoryEgress: input.memoryEgress } : {}),
    ...(input.mcp ? { mcp: input.mcp } : {}),
    ...(input.mcpRuntime ? { mcpRuntime: input.mcpRuntime } : {}),
    ...(input.providerAdmission ? { providerAdmission: input.providerAdmission } : {}),
    ...(searchRuntimes ? { searchRuntimes } : {}),
    ...(input.structuredOutputAdapter
      ? { structuredOutputAdapter: input.structuredOutputAdapter }
      : {}),
    userId: "user-1"
  };
}

function createKnowledgeProviderDispatchRecorder(order: string[] = []) {
  const prepared = Object.freeze({
    marker: "prepared-knowledge-provider-dispatch"
  }) as unknown as PreparedKnowledgeProviderDispatch;
  const prepare = vi.fn<KnowledgeProviderDispatchLifecycle["prepare"]>(async () => {
    order.push("prepare");
    return prepared;
  });
  const dispatch = vi.fn<KnowledgeProviderDispatchLifecycle["dispatch"]>(async (value) => {
    expect(value).toBe(prepared);
    order.push("dispatch");
  });
  const settle = vi.fn<KnowledgeProviderDispatchLifecycle["settle"]>(async (value) => {
    expect(value).toBe(prepared);
    order.push("settle");
  });
  const release = vi.fn<KnowledgeProviderDispatchLifecycle["release"]>(async (value) => {
    expect(value).toBe(prepared);
    order.push("release");
  });
  const markAmbiguous = vi.fn<KnowledgeProviderDispatchLifecycle["markAmbiguous"]>(
    async (value) => {
      expect(value).toBe(prepared);
      order.push("ambiguous");
    }
  );
  const inspect = vi.fn<KnowledgeProviderDispatchLifecycle["inspect"]>(async () => null);
  const recover = vi.fn<KnowledgeProviderDispatchLifecycle["recover"]>(async () => ({
    kind: "not_found"
  }));
  return {
    lifecycle: {
      dispatch,
      inspect,
      markAmbiguous,
      prepare,
      recover,
      release,
      settle
    },
    markAmbiguous,
    order,
    prepare,
    release,
    settle
  } satisfies Readonly<{
    lifecycle: KnowledgeProviderDispatchLifecycle;
    markAmbiguous: typeof markAmbiguous;
    order: string[];
    prepare: typeof prepare;
    release: typeof release;
    settle: typeof settle;
  }>;
}

function createMemoryEgressRecorder() {
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
  const recoveredTools: Parameters<
    MemoryToolEgressReceiptService["settleRecoveredToolDispatch"]
  >[0][] = [];
  let ordinal = 0;
  const service: MemoryToolEgressReceiptService = {
    async beginDispatch(input) {
      began.push(input);
      ordinal += 1;
      return { id: `egress-${ordinal}`, requestOrdinal: ordinal };
    },
    async recordBlockedDispatch(input) {
      blocked.push(input);
      ordinal += 1;
      return { id: `egress-${ordinal}`, requestOrdinal: ordinal };
    },
    async settleRecoveredProviderDispatch(input) {
      recovered.push(input);
      return true;
    },
    async settleRecoveredToolDispatch(input) {
      recoveredTools.push(input);
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
  return { began, blocked, completed, failed, recovered, recoveredTools, service };
}

function parseSse(text: string): ModelRunSseEvent[] {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const type = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
      const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);
      if (!type || !data) {
        throw new Error(`Invalid SSE chunk: ${chunk}`);
      }

      return {
        data: JSON.parse(data) as unknown,
        type
      } as ModelRunSseEvent;
    });
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

describe("run execution", () => {
  beforeEach(() => {
    activeRunControllersForTest().clear();
  });

  afterEach(() => {
    activeRunControllersForTest().clear();
    vi.restoreAllMocks();
  });

  it("refuses PREPARING dispatch before any provider or start event", async () => {
    const repository = createRepository({ runStatus: "preparing" });
    let providerCalls = 0;
    const adapter = createAdapter(async function* () {
      providerCalls += 1;
      return providerResult();
    });

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      repository: repository.repository
    })).text());

    expect(providerCalls).toBe(0);
    expect(repository.persistedEvents.some(({ event }) => event.type === "run_start"))
      .toBe(false);
    expect(repository.failedRuns).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: {
          code: "memory_preparing_run_not_finalized",
          message: "Run is not finalized for provider dispatch"
        },
        runId: "run-1"
      }
    ]);
    expect(events.at(-1)).toMatchObject({
      data: { code: "memory_preparing_run_not_finalized" },
      type: "error"
    });
  });

  it("fails stale Project access before provider I/O or streaming starts", async () => {
    const repository = createRepository({ projectAccessCurrent: false });
    let providerCalls = 0;
    const adapter = createAdapter(async function* () {
      providerCalls += 1;
      return providerResult();
    });

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      prepared: preparedData({ project: projectAdmission() }),
      repository: repository.repository
    })).text());

    expect(providerCalls).toBe(0);
    expect(repository.projectAccessChecks).toEqual([{
      accessRevision: 3,
      instructionsRevision: 2,
      memoryRevision: 1,
      policyRevision: 4,
      projectId: "project-1",
      userId: "user-1"
    }]);
    expect(repository.completeRuns).toHaveLength(0);
    expect(repository.persistedEvents.some(({ event }) => event.type === "run_start"))
      .toBe(false);
    expect(repository.failedRuns).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "project_access_changed",
        message: "Project access changed during the run"
      },
      runId: "run-1"
    }]);
    expect(events.at(-1)).toMatchObject({
      data: { code: "project_access_changed" },
      type: "error"
    });
  });

  it("stops Project stream output when access changes during the provider response", async () => {
    let accessCurrent = true;
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const repository = createRepository({ projectAccessCurrent: () => accessCurrent });
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "Visible" }, type: "token" };
      accessCurrent = false;
      now += 300;
      yield { data: { delta: "Hidden" }, type: "token" };
      return providerResult({ finalText: "VisibleHidden" });
    });

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      prepared: preparedData({ project: projectAdmission() }),
      repository: repository.repository
    })).text());

    expect(events.filter((event) => event.type === "token")).toEqual([
      { data: { delta: "Visible" }, type: "token" }
    ]);
    expect(repository.assistantTexts).toEqual(["Visible"]);
    expect(repository.completeRuns).toHaveLength(0);
    expect(repository.failedRuns.at(-1)?.error.code).toBe("project_access_changed");
    expect(events.at(-1)).toMatchObject({
      data: { code: "project_access_changed" },
      type: "error"
    });
  });

  it("fails Project provider authority drift before outbound provider I/O", async () => {
    const repository = createRepository();
    const prepared = preparedData({ project: projectAdmission() });
    const load = vi.fn(async () => ({
      ...prepared.providerAdmissionPlan,
      fingerprint: "0".repeat(64)
    }));
    let providerCalls = 0;
    const adapter = createAdapter(async function* () {
      providerCalls += 1;
      return providerResult();
    });

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      prepared,
      providerAdmission: { load },
      repository: repository.repository
    })).text());

    expect(load).toHaveBeenCalledWith({
      executionScope: "project",
      providerConnectionId: "fake",
      providerModelId: "fake-qsa",
      searchPlan: { mode: "all_selected", optionIds: [] },
      userId: "user-1"
    });
    expect(providerCalls).toBe(0);
    expect(repository.failedRuns.at(-1)?.error.code).toBe("model_not_available");
    expect(events.at(-1)).toMatchObject({
      data: { code: "model_not_available" },
      type: "error"
    });
  });

  it("rechecks search enablement immediately before dispatch and fails without calling the provider", async () => {
    const repository = createRepository({ searchStrategyEnabled: false });
    let providerCalls = 0;
    const adapter = createAdapter(async function* () {
      providerCalls += 1;
      return providerResult();
    });
    const response = createRunExecutionResponse(
      executionInput({
        adapter,
        prepared: preparedData({
          provider: "openai",
          searchPlan: hostedSearchPlan("openai-native-web-search")
        }),
        repository: repository.repository
      })
    );

    const events = parseSse(await response.text());

    expect(providerCalls).toBe(0);
    expect(repository.completeRuns).toHaveLength(0);
    expect(repository.failedRuns).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: {
          code: "search_strategy_not_available",
          message: "The selected search destination is no longer available."
        },
        runId: "run-1"
      }
    ]);
    expect(events.at(-1)).toEqual({
      data: {
        code: "search_strategy_not_available",
        message: "The selected search destination is no longer available."
      },
      type: "error"
    });
  });

  it("rechecks model access with the accepted database binding rather than runtime names", async () => {
    const prepared = preparedData();
    prepared.providerAdmissionPlan = {
      ...prepared.providerAdmissionPlan,
      selection: {
        providerConnectionId: "connection-row-1",
        providerModelId: "model-row-1"
      }
    };
    const repository = createRepository({
      entitlements: {
        modelKeys: new Set(["connection-row-1:model-row-1"]),
        providerKeys: new Set<string>(),
        searchStrategies: new Set<string>()
      }
    });
    let providerCalls = 0;
    const adapter = createAdapter(async function* () {
      providerCalls += 1;
      return providerResult();
    });

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      prepared,
      repository: repository.repository
    })).text());

    expect(providerCalls).toBe(1);
    expect(repository.completeRuns).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });

  it.each([
    {
      expectedCode: "model_not_available",
      expectedMessage: "The selected model is no longer available",
      options: {
        entitlements: {
          modelKeys: new Set<string>(),
          providerKeys: new Set<string>(),
          searchStrategies: new Set<string>()
        }
      },
      prepared: preparedData()
    },
    {
      expectedCode: "search_strategy_not_available",
      expectedMessage: "The selected search destination is no longer available.",
      options: {
        entitlements: {
          modelKeys: new Set<string>(),
          providerKeys: new Set(["openai"]),
          searchStrategies: new Set<string>()
        }
      },
      prepared: preparedData({
        provider: "openai",
        searchPlan: hostedSearchPlan("openai-native-web-search")
      })
    }
  ])(
    "fails with $expectedCode when dispatch access changed after preparation",
    async ({ expectedCode, expectedMessage, options, prepared }) => {
      const repository = createRepository(options);
      let providerCalls = 0;
      const adapter = createAdapter(async function* () {
        providerCalls += 1;
        return providerResult();
      });
      const response = createRunExecutionResponse(
        executionInput({
          adapter,
          prepared,
          repository: repository.repository
        })
      );

      const events = parseSse(await response.text());

      expect(providerCalls).toBe(0);
      expect(repository.completeRuns).toHaveLength(0);
      expect(repository.failedRuns).toEqual([
        {
          assistantMessageId: "assistant-1",
          error: {
            code: expectedCode,
            message: expectedMessage
          },
          runId: "run-1"
        }
      ]);
      expect(events.at(-1)).toEqual({
        data: {
          code: expectedCode,
          message: expectedMessage
        },
        type: "error"
      });
    }
  );

  it("dispatches entitled runs in different chats without a user-wide execution gate", async () => {
    const repository = createRepository();
    const bothStarted = deferred<void>();
    let providerStarts = 0;
    const adapter = createAdapter(async function* () {
      providerStarts += 1;
      if (providerStarts === 2) {
        bothStarted.resolve();
      }
      await bothStarted.promise;
      return providerResult();
    });
    const responses = [
      createRunExecutionResponse(
        executionInput({
          adapter,
          prepared: preparedData({ chatId: "chat-a" }),
          repository: repository.repository,
          runId: "run-a"
        })
      ),
      createRunExecutionResponse(
        executionInput({
          adapter,
          prepared: preparedData({ chatId: "chat-b" }),
          repository: repository.repository,
          runId: "run-b"
        })
      )
    ];

    await Promise.all(responses.map((response) => response.text()));

    expect(providerStarts).toBe(2);
    expect(repository.completeRuns.map((run) => run.runId).sort()).toEqual(["run-a", "run-b"]);
  });

  it("preserves SSE order, batches durable text, and persists only reloadable output artifacts", async () => {
    const truncation: ContextTruncationSummary = {
      approxDroppedTokens: 10,
      approxFinalTokens: 20,
      approxOriginalTokens: 30,
      budgetTokens: 100,
      contextWindow: 200,
      droppedMessages: 2,
      keptMessages: 1,
      maxOutputTokens: 80,
      safetyMarginTokens: 20
    };
    const repository = createRepository({ chatUpdate: chatUpdate() });
    const adapter = createAdapter(async function* () {
      for (let index = 0; index < 33; index += 1) {
        yield { data: { delta: "x" }, type: "token" };
      }
      yield {
        data: { artifactType: "summary", payload: { responseId: "response-1" } },
        type: "artifact"
      };
      yield {
        data: { artifactType: "reasoning", payload: { text: "brief" } },
        type: "artifact"
      };
      return providerResult({ providerResponseId: "response-1" });
    });

    const response = createRunExecutionResponse(
      executionInput({
        adapter,
        prepared: preparedData({ contextTruncation: truncation }),
        repository: repository.repository
      })
    );
    const events = parseSse(await response.text());
    const eventTypes = events.map((event) => event.type);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(eventTypes).toEqual([
      "run_start",
      "message_start",
      "artifact",
      ...Array.from({ length: 33 }, () => "token"),
      "artifact",
      "artifact",
      "usage",
      "chat_update",
      "done"
    ]);
    expect(events[2]).toEqual({
      data: { artifactType: "context_truncated", payload: truncation },
      type: "artifact"
    });
    expect(repository.persistedEvents.map(({ event }) => event.type)).toEqual(["artifact"]);
    expect(
      repository.persistedEvents
        .filter(({ event }) => event.type === "token")
        .map(({ event }) => (event.type === "token" ? event.data.delta : ""))
    ).toEqual([]);
    expect(repository.assistantTexts).toEqual(["x".repeat(32), "x".repeat(33)]);
    expect(repository.providerResponseIds).toEqual(["response-1"]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.chatUpdateLoads).toBe(1);
    expect(events.find((event) => event.type === "chat_update")).toMatchObject({
      data: {
        chat: {
          contextStats: { approximateActiveBranchInputTokens: 37 }
        },
        messages: expect.arrayContaining([
          expect.objectContaining({ id: "assistant-1" })
        ])
      }
    });
    expect(repository.persistedEvents.some(({ event }) => event.type === "chat_update")).toBe(false);
    expect(eventTypes.slice(-3)).toEqual(["usage", "chat_update", "done"]);
    expect(activeRunControllerRegistry.has("run-1")).toBe(false);
  });

  it("pins the friendly custom source identity onto live hosted Search artifacts", async () => {
    const optionId = "custom-web-search:connection-custom";
    const base = preparedData({
      provider: "connection-custom"
    });
    const searchPlan = {
      mode: "model_choice" as const,
      options: [{
        adapterKind: "answer_provider_hosted" as const,
        config: {},
        credentialMode: "answer_provider" as const,
        displayName: "Company Gateway Search",
        executionModes: ["model_choice" as const],
        modelId: null,
        optionId,
        protocol: "openai_responses_web_search" as const,
        provider: "connection-custom",
        providerModelId: null,
        revisionId: "revision-hosted",
        searchStrategyRowId: "route-hosted"
      }]
    };
    const personalContext = {
      approxTokens: 8,
      itemCount: 1,
      memoryGeneration: 2,
      memoryRevision: 3,
      mode: "prefetched" as const,
      text: `${PERSONAL_CONTEXT_HEADING}\nHosted coexistence memory`
    };
    const prepared: MaterializedPreparedRunData = {
      ...base,
      normalizedRequest: { ...base.normalizedRequest, personalContext, searchPlan },
      providerRequest: { ...base.providerRequest, personalContext, searchPlan }
    };
    const repository = createRepository({
      entitlements: {
        modelKeys: new Set<string>(),
        providerKeys: new Set(["connection-custom"]),
        searchStrategies: new Set([optionId])
      }
    });
    const dispatched: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      dispatched.push(request);
      yield {
        data: {
          artifactType: "search",
          payload: {
            id: "ws_custom",
            status: "completed",
            type: "web_search_call"
          }
        },
        type: "artifact"
      };
      return providerResult();
    });
    const egress = createMemoryEgressRecorder();

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      memoryEgress: egress.service,
      prepared,
      repository: repository.repository
    })).text());
    const searchEvent = events.find((event) =>
      event.type === "artifact" && event.data.artifactType === "search");

    expect(searchEvent).toEqual({
      data: {
        artifactType: "search",
        payload: {
          id: "ws_custom",
          status: "completed",
          type: "web_search_call"
        },
        searchDisplayName: "Company Gateway Search",
        searchStrategy: optionId
      },
      type: "artifact"
    });
    expect(repository.persistedEvents).toEqual([]);
    expect(dispatched).toEqual([
      expect.objectContaining({
        personalContext: expect.objectContaining({ text: personalContext.text }),
        searchPlan
      })
    ]);
    expect(egress.began).toEqual([
      expect.objectContaining({
        destinationKind: "answer_provider",
        mode: "PROVIDER_REQUEST"
      })
    ]);
    expect(egress.completed).toEqual(["egress-1"]);
  });

  it("keeps grounded output live while persisting only provenance, usage, and a neutral placeholder", async () => {
    const persistedChatUpdate = chatUpdate();
    persistedChatUpdate.messages[1]!.content = textMessageContent(GROUNDED_LIVE_ONLY_PLACEHOLDER);
    const repository = createRepository({
      chatUpdate: persistedChatUpdate,
      entitlements: {
        modelKeys: new Set<string>(),
        providerKeys: new Set(["gemini"]),
        searchStrategies: new Set(["gemini-google-search"])
      }
    });
    const adapter = createAdapter(async function* () {
      for (let index = 0; index < 33; index += 1) {
        yield { data: { delta: "pre-marker-secret" }, type: "token" };
      }
      yield {
        data: {
          citations: [],
          provider: "gemini",
          runSearch: { callCount: 1, queryCount: 1 },
          suggestionsHtml: "<div>suggestion-secret</div>"
        },
        type: "grounding_display"
      };
      yield {
        data: {
          artifactType: "citation",
          payload: { title: "citation-secret", url: "https://source.example/secret" }
        },
        type: "artifact"
      };
      yield { data: { delta: "Live grounded answer" }, type: "token" };
      return providerResult({
        finalProviderResponsePreview: {
          citation: "https://source.example/secret",
          searchSuggestionsHtml: "<div>suggestion-secret</div>"
        },
        finalText: "Live grounded answer"
      });
    });

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      prepared: preparedData({
        modelId: "gemini-3.6-flash",
        provider: "gemini",
        searchPlan: hostedSearchPlan("gemini-google-search", "gemini")
      }),
      repository: repository.repository
    })).text());

    expect(repository.groundedMarks).toHaveLength(1);
    expect(repository.groundedMarks[0]).toMatchObject({
      assistantMessageId: "assistant-1",
      provider: "gemini",
      runId: "run-1",
      strategy: "gemini-google-search"
    });
    expect(repository.assistantTexts).toEqual([]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.completeRuns[0]?.finalText).toBe(GROUNDED_LIVE_ONLY_PLACEHOLDER);
    expect(repository.completeRuns[0]).not.toHaveProperty("finalProviderResponsePreview");
    expect(repository.durableProviderResponsePreview).toBeNull();
    expect(repository.persistedEvents).toEqual([]);
    const persisted = JSON.stringify({
      assistantTexts: repository.assistantTexts,
      completeRuns: repository.completeRuns,
      events: repository.persistedEvents,
      providerRequestPreviews: repository.providerRequestPreviews,
      providerResponsePreview: repository.durableProviderResponsePreview
    });
    expect(persisted).not.toContain("suggestion-secret");
    expect(persisted).not.toContain("citation-secret");
    expect(persisted).not.toContain("source.example");
    expect(persisted).not.toContain("Live grounded answer");
    expect(persisted).not.toContain("pre-marker-secret");

    const liveChatUpdate = events.find((event) => event.type === "chat_update");
    expect(JSON.stringify(liveChatUpdate)).toContain("Live grounded answer");
    expect(JSON.stringify(liveChatUpdate)).not.toContain(GROUNDED_LIVE_ONLY_PLACEHOLDER);
    const groundingIndex = events.findIndex((event) => event.type === "grounding_display");
    const liveAnswerIndex = events.findIndex(
      (event) => event.type === "token" && event.data.delta === "Live grounded answer"
    );
    expect(groundingIndex).toBeGreaterThan(-1);
    expect(liveAnswerIndex).toBeGreaterThan(groundingIndex);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("keeps failed grounded partial output transient and leaves no durable provider content", async () => {
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield {
        data: {
          citations: [{
            endIndex: 8,
            startIndex: 0,
            title: "failed-citation-secret",
            url: "https://failed-source.example/secret"
          }],
          provider: "gemini",
          runSearch: { callCount: 1, queryCount: 1 },
          suggestionsHtml: "<div>failed-suggestion-secret</div>"
        },
        type: "grounding_display"
      };
      yield { data: { delta: "failed grounded partial" }, type: "token" };
      throw new Error("grounded_stream_failed");
    });

    const events = parseSse(
      await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text()
    );

    expect(repository.groundedMarks).toHaveLength(1);
    expect(repository.assistantTexts).toEqual([]);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.failedRuns).toHaveLength(1);
    expect(repository.durableProviderResponsePreview).toBeNull();
    expect(repository.persistedEvents).toEqual([]);
    const persisted = JSON.stringify({
      assistantTexts: repository.assistantTexts,
      events: repository.persistedEvents,
      providerRequestPreviews: repository.providerRequestPreviews,
      providerResponsePreview: repository.durableProviderResponsePreview
    });
    expect(persisted).not.toContain("failed grounded partial");
    expect(persisted).not.toContain("failed-suggestion-secret");
    expect(persisted).not.toContain("failed-citation-secret");
    expect(persisted).not.toContain("failed-source.example");
    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "grounding_display",
      "token",
      "error"
    ]);
  });

  it("streams terminal frames after durable completion without persisting a timeline", async () => {
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "answer" }, type: "token" };
      return providerResult({ finalText: "answer" });
    });

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, repository: repository.repository })
      ).text()
    );

    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.failedRuns).toHaveLength(0);
    expect(repository.persistedEvents).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token",
      "usage",
      "done"
    ]);
    expect(repository.persistedEvents).toEqual([]);
  });

  it("flushes partial text and records failure without persisting a timeline", async () => {
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "partial" }, type: "token" };
      yield { data: usage(7, 2, 0), type: "usage" };
      throw new Error("openrouter_stream_truncated");
    });

    const events = parseSse(
      await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text()
    );

    expect(events.map((event) => event.type)).toEqual(["run_start", "message_start", "token", "error"]);
    expect(repository.assistantTexts).toEqual(["partial"]);
    expect(repository.persistedEvents).toEqual([]);
    expect(repository.failedRuns).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: { code: "provider_stream_failed", message: "openrouter_stream_truncated" },
        runId: "run-1"
      }
    ]);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.recordedRunUsageEvents[0]?.usageAttributions).toMatchObject([
      {
        modelId: "fake-qsa",
        provider: "fake",
        usage: {
          inputTokens: 7,
          outputTokens: 2,
          totalTokens: 9
        }
      }
    ]);
    expect(repository.persistedEvents.some(({ event }) => event.type === "usage" || event.type === "done")).toBe(false);
  });

  it("settles a stream safety failure terminally with exact safe classification and partial text", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "partial" }, type: "token" };
      yield { data: usage(7, 2, 0), type: "usage" };
      throw new ProviderStreamTooLargeError({
        maxBytes: 64,
        observedBytes: 65,
        snapshot: { durationMs: 123, totalStreamBytes: 65 }
      });
    });

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, repository: repository.repository })
      ).text()
    );

    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token",
      "error"
    ]);
    expect(events.at(-1)).toEqual({
      data: {
        code: "provider_stream_too_large",
        message: "The provider stream exceeded a safety limit."
      },
      type: "error"
    });
    expect(repository.assistantTexts).toEqual(["partial"]);
    expect(repository.failedRuns).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "provider_stream_too_large",
        message: "The provider stream exceeded a safety limit."
      },
      options: { recoveryTerminal: true },
      runId: "run-1"
    }]);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.persistedEvents.some(({ event }) =>
      event.type === "usage" || event.type === "done"
    )).toBe(false);
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toMatchObject({
      code: "provider_stream_too_large",
      durationMs: 123,
      limit: 64,
      observed: 65,
      termination: "total_limit",
      totalStreamBytes: 65
    });
    warning.mockRestore();
  });

  it("persists a configured provider deadline as the primary terminal failure", async () => {
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "partial" }, type: "token" };
      throw new ProviderRequestTimeoutError(500_000);
    });

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, repository: repository.repository })
      ).text()
    );

    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token",
      "error"
    ]);
    expect(events.at(-1)).toEqual({
      data: {
        code: "provider_request_timed_out",
        message: "Provider response exceeded the configured 500-second timeout."
      },
      type: "error"
    });
    expect(repository.assistantTexts).toEqual(["partial"]);
    expect(repository.failedRuns).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "provider_request_timed_out",
        message: "Provider response exceeded the configured 500-second timeout."
      },
      options: { recoveryTerminal: true },
      runId: "run-1"
    }]);
    expect(repository.completeRuns).toEqual([]);
  });

  it("keeps upstream timeout text eligible for outcome-unknown recovery", async () => {
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "partial" }, type: "token" };
      yield {
        data: { artifactType: "summary", payload: { responseId: "response-1" } },
        type: "artifact"
      };
      throw new Error(
        "upstream connect error or disconnect/reset before headers: connection timeout"
      );
    });

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, repository: repository.repository })
      ).text()
    );

    expect(events.at(-1)).toEqual({
      data: {
        code: "provider_stream_failed",
        message: "upstream connect error or disconnect/reset before headers: connection timeout"
      },
      type: "error"
    });
    expect(repository.providerResponseIds).toEqual(["response-1"]);
    expect(repository.failedRuns).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "provider_stream_failed",
        message: "upstream connect error or disconnect/reset before headers: connection timeout"
      },
      runId: "run-1"
    }]);
  });

  it("persists an ordinary failed provider draft without executing absent tool calls", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let answerRounds = 0;
    const repository = createRepository({
      usagePersistenceError: new Error("usage_persistence_unavailable")
    });
    const adapter = createAdapter(async function* () {
      answerRounds += 1;
      yield { data: { delta: "unsafe round partial" }, type: "token" };
      yield { data: usage(4, 2, 0), type: "usage" };
      throw new ProviderStreamTooLargeError({
        maxBytes: 128,
        observedBytes: 129,
        snapshot: { durationMs: 20, totalStreamBytes: 129 }
      });
    });
    const search = vi.fn<ProviderSearchAdapter["search"]>();
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      search
    };

    const events = parseSse(
      await createRunExecutionResponse(executionInput({
        adapter,
        prepared: preparedData({
          modelId: "openai-answer-model",
          provider: "openai",
          searchPlan: perplexityClientSearchPlan()
        }),
        repository: repository.repository,
        searchAdapter
      })).text()
    );

    expect(answerRounds).toBe(1);
    expect(search).not.toHaveBeenCalled();
    expect(repository.toolCalls.size).toBe(0);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.assistantTexts).toEqual(["unsafe round partial"]);
    expect(repository.failedRuns).toEqual([expect.objectContaining({
      error: {
        code: "provider_stream_too_large",
        message: "The provider stream exceeded a safety limit."
      },
      options: { recoveryTerminal: true }
    })]);
    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token",
      "error"
    ]);
    expect(events.at(-1)).toMatchObject({
      data: {
        code: "provider_stream_too_large",
        message: "The provider stream exceeded a safety limit."
      },
      type: "error"
    });
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toMatchObject({
      durationMs: 20,
      limit: 128,
      observed: 129,
      totalStreamBytes: 129
    });
    warning.mockRestore();
  });

  it("does not append an error when durable cancellation wins before failure settlement", async () => {
    const repository = createRepository({ failureWins: false });
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "accepted before cancellation" }, type: "token" };
      throw new Error("provider_failed_after_cancel");
    });

    const events = parseSse(
      await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text()
    );

    expect(repository.failedRuns).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["run_start", "message_start", "token"]);
    expect(repository.persistedEvents).toEqual([]);
  });

  it("suppresses usage, chat_update, and done when status-guarded completion loses", async () => {
    const repository = createRepository({ chatUpdate: chatUpdate(), completionWins: false });
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "answer" }, type: "token" };
      return providerResult();
    });

    const events = parseSse(
      await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text()
    );

    expect(events.map((event) => event.type)).toEqual(["run_start", "message_start", "token"]);
    expect(repository.persistedEvents).toEqual([]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.recordedRunUsageEvents).toHaveLength(1);
    expect(repository.recordedRunUsageEvents[0]?.usageAttributions).toMatchObject([
      {
        modelId: "fake-qsa",
        provider: "fake",
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5
        }
      }
    ]);
    expect(repository.chatUpdateLoads).toBe(0);
    expect(repository.failedRuns).toEqual([]);
  });

  it("aborts the active provider, flushes accepted tokens, and leaves cancellation persistence external", async () => {
    const waitingForAbort = deferred<AbortSignal>();
    const repository = createRepository();
    const adapter = createAdapter(async function* (_request, options) {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("missing_abort_signal");
      }

      yield { data: { delta: "before-abort" }, type: "token" };
      waitingForAbort.resolve(signal);
      await new Promise<void>((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error("provider_run_aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal.aborted) {
          rejectAbort();
          return;
        }
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
      throw new Error("unreachable");
    });
    const response = createRunExecutionResponse(executionInput({ adapter, repository: repository.repository }));

    const signal = await waitingForAbort.promise;
    expect(signal.aborted).toBe(false);
    expect(activeRunControllerRegistry.ids()).toEqual(["run-1"]);
    expect(activeRunControllerRegistry.abort("run-1")).toBe(true);
    expect(activeRunControllerRegistry.has("run-1")).toBe(false);
    expect(activeRunControllerRegistry.abort("run-1")).toBe(false);

    const events = parseSse(await response.text());
    expect(events.map((event) => event.type)).toEqual(["run_start", "message_start", "token"]);
    expect(repository.assistantTexts).toEqual(["before-abort"]);
    expect(repository.failedRuns).toEqual([]);
    expect(repository.completeRuns).toEqual([]);
  });

  it("cancels a provider response discovered after durable cancellation without publishing it to the terminal run", async () => {
    const repository = createRepository({ responseIdPublication: "cancelled" });
    const providerCancels: string[] = [];
    const adapter = createAdapter(async function* () {
      yield {
        data: {
          artifactType: "summary",
          payload: {
            responseId: "response-late",
            status: "in_progress"
          }
        },
        type: "artifact"
      };
      return providerResult();
    });
    adapter.cancel = async (providerResponseId) => {
      providerCancels.push(providerResponseId);
      return { status: "cancelled" };
    };

    const response = createRunExecutionResponse(
      executionInput({ adapter, repository: repository.repository })
    );
    await response.text();

    expect(repository.providerResponseIds).toEqual(["response-late"]);
    expect(providerCancels).toEqual(["response-late"]);
    expect(repository.completeRuns).toHaveLength(0);
    expect(repository.failedRuns).toHaveLength(0);
    expect(repository.persistedEvents).toEqual([]);
  });

  it("keeps execution and durable finalization alive after the SSE consumer disconnects", async () => {
    const providerStarted = deferred<void>();
    const releaseProvider = deferred<void>();
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      providerStarted.resolve();
      await releaseProvider.promise;
      yield { data: { delta: "finished without consumer" }, type: "token" };
      return providerResult({ finalText: "finished without consumer" });
    });
    const response = createRunExecutionResponse(executionInput({ adapter, repository: repository.repository }));
    await providerStarted.promise;

    const cancellation = response.body?.cancel();
    releaseProvider.resolve();
    await cancellation;
    await expect.poll(() => repository.completeRuns.length).toBe(1);

    expect(repository.assistantTexts).toEqual(["finished without consumer"]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.persistedEvents).toEqual([]);
    expect(repository.failedRuns).toEqual([]);
    await expect.poll(() => activeRunControllerRegistry.has("run-1")).toBe(false);
  });

  it("keeps a replacement controller when an older execution with the same run id exits", async () => {
    const release = deferred<void>();
    const waiting = deferred<void>();
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "answer" }, type: "token" };
      waiting.resolve();
      await release.promise;
      return providerResult();
    });
    const response = createRunExecutionResponse(executionInput({ adapter, repository: repository.repository }));
    await waiting.promise;
    const original = activeRunControllersForTest().get("run-1");
    const replacement = new AbortController();
    activeRunControllersForTest().set("run-1", replacement);
    release.resolve();

    await response.text();
    expect(original).toBeDefined();
    expect(activeRunControllersForTest().get("run-1")).toBe(replacement);
  });

  it("runs a no-tool Perplexity strategy round without creating a SearchRun", async () => {
    const requests: ProviderRunRequest[] = [];
    const previewRequests: ProviderRunRequest[] = [];
    let searches = 0;
    const repository = createRepository();
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      yield { data: { delta: "Direct answer" }, type: "token" };
      return providerResult({ finalText: "Direct answer" });
    }, previewRequests);
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search() {
        searches += 1;
        throw new Error("unexpected_search");
      }
    };
    const prepared = preparedData({
      modelId: "openai-answer-model",
      provider: "openai",
      searchPlan: perplexityClientSearchPlan()
    });

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, prepared, repository: repository.repository, searchAdapter })
      ).text()
    );

    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token",
      "usage",
      "done"
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      toolChoice: "auto"
    });
    expect(requests[0]?.forceNonStreaming).toBeUndefined();
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["search_engine_1"]);
    expect(previewRequests).toHaveLength(0);
    expect(repository.providerRequestPreviews).toEqual([]);
    expect(repository.searchRuns).toEqual([]);
    expect(searches).toBe(0);
  });

  it("streams directly when tools none preserves an accepted MCP plan", async () => {
    const mcp: McpRunPlanSnapshot = {
      servers: [{
        fingerprint: "fingerprint-suppressed",
        revisionId: "revision-suppressed",
        serverId: "server-suppressed",
        serverName: "Suppressed"
      }],
      tools: [{
        definitionHash: "d".repeat(64),
        description: "A retained but suppressed tool",
        inputSchema: { type: "object" },
        name: "lookup",
        namespacedName: "mcp_suppressed_lookup_a",
        originalName: "lookup",
        serverId: "server-suppressed",
        serverName: "Suppressed"
      }],
      version: 1
    };
    const requests: ProviderRunRequest[] = [];
    const repository = createRepository();
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      return providerResult({ finalText: "Direct answer with tools suppressed" });
    });

    await createRunExecutionResponse(executionInput({
      adapter,
      prepared: preparedData({ mcp, toolMode: "none" }),
      repository: repository.repository
    })).text();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.mcp).toEqual(mcp);
    expect(requests[0]?.tools).toBeUndefined();
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.failedRuns).toHaveLength(0);
  });

  it.each([
    ["action", { memoryActions: true }],
    ["history", { memoryHistory: true }]
  ] as const)("terminalizes a persisted answer-model Memory %s contract before dispatch", async (
    _kind,
    legacyRequest
  ) => {
    const repository = createRepository();
    const providerRequests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      return providerResult({ finalText: "must not dispatch" });
    });

    await createRunExecutionResponse(executionInput({
      adapter,
      prepared: preparedData({
        ...legacyRequest,
        modelId: "openai-answer-model",
        provider: "openai"
      }),
      repository: repository.repository
    })).text();

    expect(providerRequests).toEqual([]);
    expect(repository.toolCalls.size).toBe(0);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.failedRuns).toEqual([expect.objectContaining({
      error: {
        code: "memory_answer_model_tools_retired",
        message: "This run uses a retired answer-model Memory tool contract."
      },
      options: { recoveryTerminal: true }
    })]);
  });

  it("runs one focused retrieval followed by the current hidden grounding pipeline", async () => {
    const finalText = "Supported answer [K1]";
    const repository = createRepository({
      groundingResult: structuralGroundingResult(finalText)
    });
    const { execute, executor } = focusedKnowledgeExecutor();
    const dispatch = createKnowledgeProviderDispatchRecorder();
    const providerRequests: ProviderRunRequest[] = [];
    let providerCallCount = 0;
    const adapter = createAdapter(async function* (request) {
      providerCallCount += 1;
      providerRequests.push(request);
      const providerText = JSON.stringify(plannedCurrentKnowledgeOutput(
        providerCallCount,
        "Supported answer"
      ));
      yield { data: { delta: providerText }, type: "token" };
      return providerResult({ finalText: providerText });
    });

    const body = await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      knowledgeProviderDispatch: dispatch.lifecycle,
      prepared: focusedKnowledgePreparedData(),
      repository: repository.repository
    })).text();
    const events = parseSse(body);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      arguments: createKnowledgeFocusedRequest({ currentUserMessage: "Current question" }),
      name: KNOWLEDGE_FOCUSED_OPERATION_NAME
    });
    expect(repository.failedRuns).toEqual([]);
    expect(providerCallCount).toBe(5);
    expect(providerRequests).toHaveLength(5);
    expect(providerRequests.every((request) => request.tools === undefined &&
      request.toolChoice === "none" && request.context === undefined)).toBe(true);
    expect(providerRequests[0]?.prompt.system).toContain(
      '<aiqsa_knowledge_answer_draft_contract version="21">'
    );
    expect(providerRequests[1]?.prompt.system).toContain(
      '<aiqsa_knowledge_coverage_scope_contract version="6">'
    );
    expect(providerRequests[3]?.prompt.system).toContain(
      '<aiqsa_knowledge_grounded_selector_contract version="21">'
    );
    expect(repository.groundingAnswers).toEqual([]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.completeRuns[0]).toMatchObject({
      finalText,
      knowledgeGrounding: {
        grounding: { finalText, outcome: "answered", version: 5 }
      }
    });
    expect(repository.completeRuns[0]?.knowledgeGrounding).not.toHaveProperty("semanticShadow");
    expect(events.filter((event) => event.type === "token")).toEqual([{
      data: { delta: finalText },
      type: "token"
    }]);
    expect(body).not.toContain("\"decision\":\"select_claims\"");
    expect(dispatch.prepare.mock.calls.map(([call]) => call.purpose))
      .toEqual(CURRENT_KNOWLEDGE_OPERATION_NAMES);
    expect(dispatch.order).toEqual(CURRENT_KNOWLEDGE_OPERATION_NAMES.flatMap(() =>
      ["prepare", "dispatch", "settle"]));
  });

  it("answers from a complete small corpus with zero Knowledge searches", async () => {
    const finalText = "Total cholesterol is 5.3 mmol/L [K1].";
    const repository = createRepository({
      groundingResult: structuralGroundingResult(finalText)
    });
    const dispatch = createKnowledgeProviderDispatchRecorder();
    const requests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      const providerText = JSON.stringify(plannedCurrentKnowledgeOutput(
        requests.length,
        "Total cholesterol is 5.3 mmol/L"
      ));
      yield { data: { delta: providerText }, type: "token" };
      return providerResult({ finalText: providerText });
    });

    const body = await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeProviderDispatch: dispatch.lifecycle,
      prepared: fullContextKnowledgePreparedData(),
      repository: repository.repository
    })).text();
    const events = parseSse(body);

    expect(requests).toHaveLength(5);
    expect(requests.every((request) => request.tools === undefined &&
      request.toolChoice === "none" && request.context === undefined)).toBe(true);
    expect(dispatch.prepare).toHaveBeenCalledWith(expect.objectContaining({
      evidenceBindings: [expect.objectContaining({
        dispatchEvidenceId: expect.stringContaining("full-context-"),
        evidenceItemId: expect.any(String)
      })]
    }));
    expect(repository.toolCalls.size).toBe(0);
    expect(repository.groundingAnswers).toEqual([]);
    expect(events.filter((event) => event.type === "token")).toEqual([{
      data: { delta: finalText },
      type: "token"
    }]);
    expect(body).not.toContain("\"decision\":\"select_claims\"");
    expect(dispatch.order).toEqual(CURRENT_KNOWLEDGE_OPERATION_NAMES.flatMap(() =>
      ["prepare", "dispatch", "settle"]));
  });

  it.each([
    ["Base authority", "base"],
    ["direct Source publication", "direct"],
    ["Project Source binding", "project"]
  ] as const)(
    "blocks answer-provider egress when %s is revoked after the focused manifest is prepared",
    async (_label, scope) => {
      const prepared = scope === "base"
        ? focusedKnowledgePreparedData()
        : focusedCanonicalSourcePreparedData(scope === "project" ? "project" : "personal");
      const admitted = prepared.knowledgeAdmissionPlan!;
      const order: string[] = [];
      const { execute, executor } = focusedKnowledgeExecutor(
        knowledgeEvidence(),
        () => order.push("retrieve")
      );
      const dispatch = createKnowledgeProviderDispatchRecorder(order);
      let authorizationChecks = 0;
      const persistedScope: FocusedKnowledgeRecoveryScope = {
        bindings: admitted.bindings,
        exclusions: admitted.exclusions,
        knowledgePlan: admitted.knowledgePlan,
        profiles: admitted.profiles ?? [],
        sources: admitted.sources ?? []
      };
      const authorizeSnapshot = vi.fn<NonNullable<NonNullable<
        RunExecutionInput["knowledgeAdmission"]>["authorizeSnapshot"]>>(
        async (request) => {
          authorizationChecks += 1;
          order.push(authorizationChecks === 1
            ? "authorize-retrieval"
            : "authorize-answer");
          expect(request).toEqual({
            ...(scope === "project"
              ? { executionScope: "project", projectId: "project-1" }
              : {}),
            snapshot: persistedScope,
            userId: "user-1"
          });
          return authorizationChecks === 1;
        }
      );
      const repository = createRepository();
      const loadScope = vi.fn(async () => persistedScope);
      repository.repository.loadFocusedKnowledgeRecoveryScope = loadScope;
      const providerCall = vi.fn(async function* () {
        return providerResult();
      });
      const adapter = createAdapter(providerCall);

      const events = parseSse(await createRunExecutionResponse(executionInput({
        adapter,
        knowledgeAdmission: {
          authorizeSnapshot,
          load: vi.fn(async () => admitted)
        },
        knowledgeExecutor: executor,
        knowledgeProviderDispatch: dispatch.lifecycle,
        prepared,
        repository: repository.repository
      })).text());

      expect(execute).toHaveBeenCalledOnce();
      expect(loadScope).toHaveBeenCalledTimes(2);
      expect(authorizeSnapshot).toHaveBeenCalledTimes(2);
      expect(providerCall).not.toHaveBeenCalled();
      expect(order).toEqual([
        "authorize-retrieval",
        "retrieve",
        "prepare",
        "authorize-answer",
        "release"
      ]);
      expect(repository.completeRuns).toEqual([]);
      expect(repository.failedRuns).toEqual([
        expect.objectContaining({
          error: {
            code: "knowledge_answer_failed",
            message: "The Knowledge answer provider failed."
          },
          options: { recoveryTerminal: true }
        })
      ]);
      expect(events.at(-1)).toEqual({
        data: {
          code: "knowledge_answer_failed",
          message: "The Knowledge answer provider failed."
        },
        type: "error"
      });
    }
  );

  it("terminalizes focused zero-candidate retrieval without answer-provider I/O", async () => {
    const repository = createRepository();
    const { execute, executor } = focusedKnowledgeExecutor(emptyKnowledgeEvidence());
    const dispatch = createKnowledgeProviderDispatchRecorder();
    const providerCall = vi.fn(async function* () {
      return providerResult();
    });
    const adapter = createAdapter(providerCall);

    await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      knowledgeProviderDispatch: dispatch.lifecycle,
      prepared: focusedKnowledgePreparedData(),
      repository: repository.repository
    })).text();

    expect(execute).toHaveBeenCalledOnce();
    expect(providerCall).not.toHaveBeenCalled();
    expect(repository.completeRuns).toEqual([]);
    expect(repository.failedRuns).toEqual([
      expect.objectContaining({
        error: {
          code: "no_retrieval_candidates",
          message: "No retrieval candidates were found in the ready Knowledge documents."
        },
        options: { recoveryTerminal: true }
      })
    ]);
    expect(dispatch.prepare).not.toHaveBeenCalled();
  });

  it("settles a scope provider failure without retrying the failed stage", async () => {
    const repository = createRepository();
    const { execute, executor } = focusedKnowledgeExecutor();
    const dispatch = createKnowledgeProviderDispatchRecorder();
    let providerCallCount = 0;
    const adapter = createAdapter(async function* () {
      providerCallCount += 1;
      if (providerCallCount === 1) return providerResult({
        finalText: JSON.stringify(plannedDraftOutput("Supported answer"))
      });
      throw new Error("private_provider_failure");
    });

    await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      knowledgeProviderDispatch: dispatch.lifecycle,
      prepared: focusedKnowledgePreparedData(),
      repository: repository.repository
    })).text();

    expect(execute).toHaveBeenCalledOnce();
    expect(providerCallCount).toBe(2);
    expect(repository.groundingAnswers).toEqual([]);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.failedRuns).toEqual([
      expect.objectContaining({
        error: {
          code: "knowledge_answer_failed",
          message: "The Knowledge answer provider failed."
        }
      })
    ]);
    expect(JSON.stringify(repository.failedRuns)).not.toContain("private_provider_failure");
    expect(dispatch.order).toEqual([
      "prepare", "dispatch", "settle",
      "prepare", "dispatch", "settle"
    ]);
  });

  it("settles a focused retrieval deadline as a technical retrieval failure", async () => {
    const repository = createRepository();
    const timeout = new Error("local_retrieval_deadline");
    timeout.name = "AbortError";
    const execute = vi.fn<KnowledgeToolExecutor["execute"]>(async () => {
      throw timeout;
    });
    const executor: KnowledgeToolExecutor = {
      accepts: (name) => name === KNOWLEDGE_FOCUSED_OPERATION_NAME,
      capability: "knowledge",
      execute,
      tool: knowledgeRetrievalTool
    };
    let providerCallCount = 0;
    const adapter = createAdapter(async function* () {
      providerCallCount += 1;
      return providerResult();
    });

    await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      prepared: focusedKnowledgePreparedData(),
      repository: repository.repository
    })).text();

    expect(execute).toHaveBeenCalledOnce();
    expect(providerCallCount).toBe(0);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.failedRuns).toEqual([
      expect.objectContaining({
        error: {
          code: "knowledge_retrieval_failed",
          message: "Knowledge retrieval failed."
        }
      })
    ]);
    expect([...repository.toolCalls.values()]).toEqual([
      expect.objectContaining({ result: expect.anything(), state: "error" })
    ]);
  });

  it("settles a focused scope deadline as a bounded failure marker", async () => {
    const repository = createRepository();
    const { executor } = focusedKnowledgeExecutor();
    const dispatch = createKnowledgeProviderDispatchRecorder();
    let providerCallCount = 0;
    const adapter = createAdapter(async function* () {
      providerCallCount += 1;
      if (providerCallCount === 1) return providerResult({
        finalText: JSON.stringify(plannedDraftOutput("Supported answer"))
      });
      const timeout = new Error("local_answer_deadline");
      timeout.name = "AbortError";
      throw timeout;
    });

    await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      knowledgeProviderDispatch: dispatch.lifecycle,
      prepared: focusedKnowledgePreparedData(),
      repository: repository.repository
    })).text();

    expect(providerCallCount).toBe(2);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.failedRuns).toEqual([
      expect.objectContaining({
        error: {
          code: "knowledge_answer_failed",
          message: "The Knowledge answer provider failed."
        }
      })
    ]);
    expect(dispatch.order).toEqual([
      "prepare", "dispatch", "settle",
      "prepare", "dispatch", "settle"
    ]);
  });

  it.each([
    {
      code: "knowledge_answer_contract_failed" as const,
      providerText: "AIQSA_KB_STATUS=ANSWERED\nUncited answer"
    },
    {
      code: "knowledge_citation_contract_failed" as const,
      providerText: "AIQSA_KB_STATUS=ANSWERED\nUnknown citation [K99]"
    }
  ])("fails current deterministic finalization with $code and does not repair or retry", async ({
    code,
    providerText
  }) => {
    const repository = createRepository({
      groundingError: new KnowledgeAnswerContractError(code, code)
    });
    const { execute, executor } = focusedKnowledgeExecutor();
    const dispatch = createKnowledgeProviderDispatchRecorder();
    let providerCallCount = 0;
    const adapter = createAdapter(async function* () {
      providerCallCount += 1;
      return providerResult({
        finalText: JSON.stringify(plannedCurrentKnowledgeOutput(
          providerCallCount,
          providerText
        ))
      });
    });

    await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      knowledgeProviderDispatch: dispatch.lifecycle,
      prepared: focusedKnowledgePreparedData(),
      repository: repository.repository
    })).text();

    expect(execute).toHaveBeenCalledOnce();
    expect(providerCallCount).toBe(5);
    expect(repository.groundingAnswers).toEqual([]);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.failedRuns).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code })
      })
    ]);
    expect(dispatch.order).toEqual(CURRENT_KNOWLEDGE_OPERATION_NAMES.flatMap(() =>
      ["prepare", "dispatch", "settle"]));
  });

  it("settles parallel Knowledge and Search calls before one continuation", async () => {
    const providerRequests: ProviderRunRequest[] = [];
    const repository = createRepository({
      groundingResult: structuralGroundingResult("Combined answer [K1].")
    });
    const { execute, executor } = toolLoopKnowledgeExecutor();
    const egress = createMemoryEgressRecorder();
    const dispatch = createKnowledgeProviderDispatchRecorder();
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [
            {
              arguments: { query: "private retention policy" },
              id: "knowledge-call-1",
              name: KNOWLEDGE_SEARCH_TOOL_NAME
            },
            {
              arguments: { query: "current public retention policy" },
              id: "search-call-1",
              name: "search_engine_1"
            }
          ]
        });
      }
      if (providerRequests.length === 2) {
        return providerResult({ finalText: "AIQSA_KNOWLEDGE_RETRIEVAL_COMPLETE" });
      }
      return providerResult({
        finalText: JSON.stringify(plannedCurrentKnowledgeOutput(
          providerRequests.length - 2,
          "Combined answer"
        ))
      });
    });
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search() {
        return {
          artifacts: [],
          finalProviderResponsePreview: {},
          findings: "Current web evidence",
          providerResponseId: "search-response-1",
          requestPreview: {},
          sources: [],
          usage: usage(1, 0, 0)
        };
      }
    };
    const prepared = preparedData({
      knowledgeBaseIds: ["base-1"],
      modelId: "openai-answer-model",
      provider: "openai",
      searchPlan: perplexityClientSearchPlan()
    });

    await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      knowledgeProviderDispatch: dispatch.lifecycle,
      memoryEgress: egress.service,
      prepared,
      repository: repository.repository,
      searchAdapter
    })).text();

    expect(execute).toHaveBeenCalledOnce();
    expect(repository.searchRuns).toHaveLength(1);
    expect(providerRequests).toHaveLength(7);
    expect(providerRequests[1]?.providerToolMessages).toHaveLength(4);
    expect(JSON.stringify(providerRequests[1]?.providerToolMessages)).toContain(
      "Bounded private passage"
    );
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.failedRuns).toEqual([]);
    expect(egress.began.some((receipt) => receipt.destinationKind === "knowledge"))
      .toBe(true);
  });

  it("supports a sequential Knowledge then Search tool chain", async () => {
    const providerRequests: ProviderRunRequest[] = [];
    const repository = createRepository({
      groundingResult: structuralGroundingResult("Sequential answer [K1].")
    });
    const { executor } = toolLoopKnowledgeExecutor();
    const dispatch = createKnowledgeProviderDispatchRecorder();
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [{
            arguments: { query: "private policy" },
            id: "knowledge-call-1",
            name: KNOWLEDGE_SEARCH_TOOL_NAME
          }]
        });
      }
      if (providerRequests.length === 2) {
        return providerResult({
          finalText: "",
          toolCalls: [{
            arguments: { query: "public policy" },
            id: "search-call-1",
            name: "search_engine_1"
          }]
        });
      }
      if (providerRequests.length === 3) {
        return providerResult({ finalText: "AIQSA_KNOWLEDGE_RETRIEVAL_COMPLETE" });
      }
      return providerResult({
        finalText: JSON.stringify(plannedCurrentKnowledgeOutput(
          providerRequests.length - 3,
          "Sequential answer"
        ))
      });
    });
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search() {
        return {
          artifacts: [],
          finalProviderResponsePreview: {},
          findings: "Public result",
          providerResponseId: "search-response-1",
          requestPreview: {},
          sources: [],
          usage: usage(1, 0, 0)
        };
      }
    };

    await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      knowledgeProviderDispatch: dispatch.lifecycle,
      prepared: preparedData({
        knowledgeBaseIds: ["base-1"],
        modelId: "openai-answer-model",
        provider: "openai",
        searchPlan: perplexityClientSearchPlan()
      }),
      repository: repository.repository,
      searchAdapter
    })).text();

    expect(providerRequests).toHaveLength(8);
    expect(repository.searchRuns).toHaveLength(1);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.failedRuns).toEqual([]);
  });

  it("maps automatic RAG synthesis failures to the safe Knowledge boundary", async () => {
    const internalFailure = "knowledge_grounded_selector_result_invalid";
    const repository = createRepository({ groundingError: new Error(internalFailure) });
    const { executor } = toolLoopKnowledgeExecutor();
    const dispatch = createKnowledgeProviderDispatchRecorder();
    const providerRequests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [{
            arguments: { query: "private corpus query" },
            id: "knowledge-call-1",
            name: KNOWLEDGE_SEARCH_TOOL_NAME
          }]
        });
      }
      if (providerRequests.length === 2) {
        return providerResult({ finalText: "AIQSA_KNOWLEDGE_RETRIEVAL_COMPLETE" });
      }
      return providerResult({
        finalText: JSON.stringify(plannedCurrentKnowledgeOutput(
          providerRequests.length - 2,
          "Supported answer"
        ))
      });
    });

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      knowledgeProviderDispatch: dispatch.lifecycle,
      prepared: preparedData({
        knowledgeBaseIds: ["base-1"],
        modelId: "openai-answer-model",
        provider: "openai"
      }),
      repository: repository.repository
    })).text());

    expect(providerRequests).toHaveLength(7);
    expect(repository.completeRuns).toEqual([]);
    expect(repository.failedRuns).toEqual([
      expect.objectContaining({
        error: {
          code: "knowledge_answer_failed",
          message: "The Knowledge answer provider failed."
        },
        options: { recoveryTerminal: true }
      })
    ]);
    expect(events.at(-1)).toEqual({
      data: {
        code: "knowledge_answer_failed",
        message: "The Knowledge answer provider failed."
      },
      type: "error"
    });
    expect(JSON.stringify({ events, failedRuns: repository.failedRuns }))
      .not.toContain(internalFailure);
  });

  it("durably settles a local Knowledge deadline before continuing the tool loop", async () => {
    const finalText = "Knowledge retrieval was unavailable.";
    const repository = createRepository({
      groundingResult: structuralGroundingResult(finalText)
    });
    const deadline = new Error("knowledge_retrieval_aborted");
    deadline.name = "AbortError";
    const { executor: baseExecutor } = toolLoopKnowledgeExecutor();
    const execute = vi.fn<KnowledgeToolExecutor["execute"]>(async () => {
      throw deadline;
    });
    const executor: KnowledgeToolExecutor = { ...baseExecutor, execute };
    const providerRequests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      return providerRequests.length === 1
        ? providerResult({
            finalText: "",
            toolCalls: [{
              arguments: { query: "bounded private lookup" },
              id: "knowledge-deadline-call-1",
              name: KNOWLEDGE_SEARCH_TOOL_NAME
            }]
          })
        : providerResult({ finalText });
    });

    await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      prepared: preparedData({
        knowledgeBaseIds: ["base-1"],
        modelId: "openai-answer-model",
        provider: "openai"
      }),
      repository: repository.repository
    })).text();

    expect(execute).toHaveBeenCalledOnce();
    expect(providerRequests).toHaveLength(2);
    expect(JSON.stringify(providerRequests[1]?.providerToolMessages))
      .toContain("knowledge_retrieval_failed");
    expect([...repository.toolCalls.values()]).toEqual([
      expect.objectContaining({ result: expect.anything(), state: "error" })
    ]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.failedRuns).toEqual([]);
  });

  it("durably settles a classified Knowledge outage and exposes only its safe result", async () => {
    const repository = createRepository();
    const { execute, executor } = toolLoopKnowledgeExecutor(
      searchUnavailableKnowledgeEvidence()
    );
    const providerRequests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      return providerRequests.length === 1
        ? providerResult({
            finalText: "",
            toolCalls: [{
              arguments: { query: "private outage query" },
              id: "knowledge-unavailable-call-1",
              name: KNOWLEDGE_SEARCH_TOOL_NAME
            }]
          })
        : providerResult({ finalText: "Untrusted answer after the failed lookup." });
    });

    await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      prepared: preparedData({
        knowledgeBaseIds: ["base-1"],
        modelId: "openai-answer-model",
        provider: "openai"
      }),
      repository: repository.repository
    })).text();

    expect(execute).toHaveBeenCalledOnce();
    expect(providerRequests).toHaveLength(2);
    const continuation = JSON.stringify(providerRequests[1]?.providerToolMessages);
    expect(continuation).toContain(
      "Knowledge search is temporarily unavailable. Do not infer or invent an answer from Knowledge."
    );
    expect(continuation).not.toContain("knowledge_search_backend_unavailable");
    expect([...repository.toolCalls.values()]).toEqual([
      expect.objectContaining({ result: expect.anything(), state: "error" })
    ]);
    expect(repository.completeRuns).toEqual([
      expect.objectContaining({ finalText: KNOWLEDGE_SEARCH_UNAVAILABLE_MESSAGE })
    ]);
    expect(repository.failedRuns).toEqual([]);
  });

  it("continues after a completed zero-candidate Knowledge result", async () => {
    const repository = createRepository({
      groundingResult: structuralGroundingResult("No matching private passage was required.")
    });
    const { executor } = toolLoopKnowledgeExecutor(emptyKnowledgeEvidence());
    let providerCalls = 0;
    const adapter = createAdapter(async function* () {
      providerCalls += 1;
      return providerCalls === 1
        ? providerResult({
            finalText: "",
            toolCalls: [{
              arguments: { query: "missing private fact" },
              id: "knowledge-call-1",
              name: KNOWLEDGE_SEARCH_TOOL_NAME
            }]
          })
        : providerResult({ finalText: "No matching private passage was required." });
    });

    await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      prepared: preparedData({
        knowledgeBaseIds: ["base-1"],
        modelId: "openai-answer-model",
        provider: "openai"
      }),
      repository: repository.repository
    })).text();

    expect(providerCalls).toBe(2);
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.failedRuns).toEqual([]);
  });

  it("executes a Perplexity tool call, persists search evidence, and synthesizes with aggregate usage", async () => {
    const providerRequests: ProviderRunRequest[] = [];
    const previewRequests: ProviderRunRequest[] = [];
    const searchRequests: ProviderSearchRequest[] = [];
    const repository = createRepository();
    const adapter: ProviderAdapter = {
      buildRequestPreview(request) {
        previewRequests.push(request);
        return buildOpenAIResponsesRequestPreview(request);
      },
      async *stream(request) {
        providerRequests.push(request);
        if (providerRequests.length === 1) {
          yield { data: { artifactType: "reasoning", payload: { text: "Need current data" } }, type: "artifact" };
          yield { data: { delta: "discarded draft" }, type: "token" };
          yield { data: usage(1, 2, 0), type: "usage" };
          return providerResult({
            finalText: "",
            providerToolCallMessage: [{
              arguments: "{\"query\":\"TOOL_ARGUMENT_CANARY\"}",
              call_id: "tool-call-1",
              encrypted_content: "ENCRYPTED_CONTINUATION_CANARY",
              name: "search_engine_1",
              signature: "PROVIDER_SIGNATURE_CANARY",
              type: "function_call"
            }],
            toolCalls: [
              {
                arguments: { query: "latest AIQSA news" },
                id: "tool-call-1",
              name: "search_engine_1"
              }
            ],
            usage: usage(1, 2, 0)
          });
        }

        yield { data: { delta: "Sourced answer" }, type: "token" };
        return providerResult({ finalText: "Sourced answer", usage: usage(5, 6, 1) });
      }
    };
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search(request) {
        searchRequests.push(request);
        return {
          artifacts: [
            {
              data: { artifactType: "search", payload: { query: "latest AIQSA news" } },
              type: "artifact"
            }
          ],
          finalProviderResponsePreview: { search: "safe" },
          findings: "Search findings",
          providerResponseId: "search-response-1",
          requestPreview: { query: "latest AIQSA news" },
          sources: [{ rank: 1, title: "Search source", url: "https://example.com/search" }],
          usage: usage(3, 4, 0)
        };
      }
    };
    const prepared = preparedData({
      modelId: "openai-answer-model",
      provider: "openai",
      searchPlan: perplexityClientSearchPlan()
    });

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, prepared, repository: repository.repository, searchAdapter })
      ).text()
    );

    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "artifact",
      "token",
      "artifact",
      "message_reset",
      "token",
      "usage",
      "done"
    ]);
    expect(
      events
        .filter((event) => event.type === "artifact")
        .map((event) => (event.type === "artifact" ? event.data.artifactType : ""))
    ).toEqual(["reasoning", "tool_call"]);
    expect(events.some((event) =>
      event.type === "token" && event.data.delta === "discarded draft"
    )).toBe(true);
    expect(events.some((event) => event.type === "message_reset")).toBe(true);
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[1]?.providerToolMessages).toHaveLength(2);
    expect(previewRequests).toHaveLength(0);
    expect(repository.providerRequestPreviews).toEqual([]);
    const secondTransportJson = JSON.stringify(providerRequests[1]);
    expect(secondTransportJson).toContain("TOOL_ARGUMENT_CANARY");
    expect(secondTransportJson).toContain("ENCRYPTED_CONTINUATION_CANARY");
    expect(secondTransportJson).toContain("Search findings");
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.query).toBe("latest AIQSA news");
    expect(searchRequests[0]?.searchPolicy).toMatchObject({
      modelId: "perplexity/sonar-pro-search",
      provider: "openrouter",
      strategyId: "perplexity-tool-search"
    });
    expect(repository.searchRuns).toHaveLength(1);
    expect(repository.searchRuns[0]).toMatchObject({
      artifacts: {
        sources: [{ rank: 1, title: "Search source", url: "https://example.com/search" }]
      },
      modelId: "perplexity/sonar-pro-search",
      modelRunId: "run-1",
      provider: "openrouter",
      status: "complete",
      strategyId: "perplexity-tool-search"
    });
    expect(JSON.stringify(repository.searchRuns)).not.toContain("latest AIQSA news");
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.completeRuns[0]?.usage).toMatchObject({
      inputTokens: 9,
      outputTokens: 12,
      reasoningTokens: 1,
      totalTokens: 21
    });
    expect(repository.completeRuns[0]?.usageAttributions).toEqual([
      {
        estimatedCostMicros: null,
        modelId: "openai-answer-model",
        provider: "openai",
        usage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 6,
          outputTokens: 8,
          reasoningTokens: 1,
          totalTokens: 14
        }
      },
      {
        estimatedCostMicros: null,
        modelId: "perplexity/sonar-pro-search",
        provider: "openrouter",
        usage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 3,
          outputTokens: 4,
          reasoningTokens: 0,
          totalTokens: 7
        }
      }
    ]);
  });

  it("persists a redacted OpenRouter tool-round preview without changing its transport transcript", async () => {
    const providerRequests: ProviderRunRequest[] = [];
    const repository = createRepository();
    const adapter: ProviderAdapter = {
      buildRequestPreview: buildOpenRouterChatRequestPreview,
      async *stream(request) {
        providerRequests.push(request);
        if (providerRequests.length === 1) {
          return providerResult({
            finalText: "",
            providerToolCallMessage: {
              content: null,
              opaque_message_field: "OPENROUTER_MESSAGE_FIELD_CANARY",
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: "{\"query\":\"OPENROUTER_ARGUMENT_CANARY\"}",
                    name: "search_engine_1",
                    opaque_function_field: "OPENROUTER_FUNCTION_FIELD_CANARY"
                  },
                  id: "tool-call-1",
                  opaque_call_field: "OPENROUTER_CALL_FIELD_CANARY",
                  type: "function"
                }
              ]
            },
            toolCalls: [
              {
                arguments: { query: "latest AIQSA news" },
                id: "tool-call-1",
              name: "search_engine_1"
              }
            ]
          });
        }

        yield { data: { delta: "Sourced answer" }, type: "token" };
        return providerResult({ finalText: "Sourced answer" });
      }
    };
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search() {
        return {
          artifacts: [],
          finalProviderResponsePreview: { search: "safe" },
          findings: "OPENROUTER_TOOL_OUTPUT_CANARY",
          providerResponseId: "search-response-1",
          requestPreview: { status: "redacted" },
          sources: [{ rank: 1, title: "Search source", url: "https://example.com/search" }],
          usage: usage(1, 1, 0)
        };
      }
    };
    const prepared = preparedData({
      modelId: "openrouter-answer-model",
      provider: "openrouter",
      searchPlan: perplexityClientSearchPlan()
    });

    await createRunExecutionResponse(
      executionInput({ adapter, prepared, repository: repository.repository, searchAdapter })
    ).text();

    expect(providerRequests).toHaveLength(2);
    expect(repository.providerRequestPreviews).toEqual([]);
    const transportJson = JSON.stringify(providerRequests[1]?.providerToolMessages);
    for (const canary of [
      "OPENROUTER_MESSAGE_FIELD_CANARY",
      "OPENROUTER_ARGUMENT_CANARY",
      "OPENROUTER_FUNCTION_FIELD_CANARY",
      "OPENROUTER_CALL_FIELD_CANARY",
      "OPENROUTER_TOOL_OUTPUT_CANARY"
    ]) {
      expect(transportJson).toContain(canary);
    }
  });

  it("persists normalized Gemini client findings and reuses them in foreground continuation", async () => {
    const providerRequests: ProviderRunRequest[] = [];
    const searchRequests: ProviderSearchRequest[] = [];
    const repository = createRepository({
      entitlements: {
        modelKeys: new Set<string>(),
        providerKeys: new Set(["anthropic"]),
        searchStrategies: new Set(["gemini-google-search"])
      }
    });
    const answerAdapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [{
            arguments: { query: "weather in Valencia" },
            id: "gemini-search-call-1",
            name: "search_engine_1"
          }],
          usage: usage(2, 1, 0)
        });
      }
      yield { data: { delta: "It is sunny." }, type: "token" };
      return providerResult({ finalText: "It is sunny.", usage: usage(5, 4, 0) });
    });
    const geminiSearchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: (request) => ({
        modelId: request.searchPolicy.modelId,
        queryCharacters: request.query.length,
        store: false
      }),
      async search(request) {
        searchRequests.push(request);
        return {
          artifacts: [{
            data: {
              artifactType: "search",
              payload: {
                id: "gemini-google-search-1",
                queries: [request.query],
                status: "completed",
                type: "google_search_call"
              }
            },
            type: "artifact"
          }],
          finalProviderResponsePreview: {
            rawBodyCanary: "RAW_GEMINI_BODY_CANARY",
            searchSuggestionsHtml: "<div>RAW_SUGGESTIONS_CANARY</div>",
            thoughtSignature: "RAW_SIGNATURE_CANARY"
          },
          findings: "Valencia is sunny and 29 °C.",
          providerResponseId: "gemini-interaction-1",
          requestPreview: {
            modelId: "gemini-3.6-flash",
            queryCharacters: request.query.length,
            store: false
          },
          sources: [{
            rank: 1,
            title: "Valencia weather",
            url: "https://weather.example.test/valencia"
          }],
          usage: usage(3, 4, 1)
        };
      }
    };
    const base = preparedData({
      modelId: "claude-opus-5",
      provider: "anthropic",
      searchPlan: providerClientSearchPlan({
        modelId: "gemini-3.6-flash",
        optionId: "gemini-google-search",
        protocol: "gemini_google_search",
        provider: "gemini"
      })
    });
    const searchPlan = {
      mode: "model_choice" as const,
      options: [{
        adapterKind: "provider_model_client" as const,
        config: {
          maxOutputTokens: 4_096,
          maxResults: 8,
          maxSearchCallsPerAnswer: 2,
          modelCapabilities: {
            nativePdfInput: false,
            nativeSearch: true,
            pdf: true,
            reasoning: true,
            streaming: true,
            toolCalling: true,
            vision: true
          },
          modelDefaultParams: {},
          queryMaxCharacters: 500,
          reasoningPolicy: "lowest_supported",
          timeoutMs: 300_000
        },
        credentialMode: "provider_model" as const,
        displayName: "Google Search",
        executionModes: ["all_selected" as const, "model_choice" as const],
        kind: "gemini_google_search",
        modelId: "gemini-3.6-flash",
        optionId: "gemini-google-search",
        protocol: "gemini_google_search" as const,
        provider: "gemini",
        providerModelId: "gemini-search-deployment",
        revisionId: "gemini-search-revision-1",
        searchStrategyRowId: "gemini-search-client-route"
      }]
    };
    const normalizedRequest = { ...base.normalizedRequest, searchPlan };
    const prepared: MaterializedPreparedRunData = {
      ...base,
      normalizedRequest,
      providerRequest: { ...base.providerRequest, searchPlan }
    };

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter: answerAdapter,
      prepared,
      repository: repository.repository,
      searchRuntimes: {
        "gemini-google-search": {
          adapter: answerAdapter,
          responseTimeoutMs: 300_000,
          searchAdapter: geminiSearchAdapter
        }
      }
    })).text());

    expect(events.at(-1)).toMatchObject({ data: { status: "complete" }, type: "done" });
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
    expect(JSON.stringify(searchRequests[0])).not.toContain("Current question");
    expect(providerRequests).toHaveLength(2);
    expect(JSON.stringify(providerRequests[1]?.providerToolMessages))
      .toContain("Valencia is sunny and 29 °C.");
    const settledCall = [...repository.toolCalls.values()][0];
    if (!settledCall?.result) throw new Error("expected settled Search checkpoint");
    const settledJson = JSON.stringify(settledCall.result);
    expect(settledJson).toContain('"aiqsaType":"search_result"');
    expect(settledJson.split("Valencia is sunny and 29 °C.")).toHaveLength(2);
    expect(parsePersistedToolExecutionResult({
      id: settledCall.providerCallId,
      name: settledCall.toolName
    }, settledCall.result)?.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("Valencia is sunny and 29 °C."),
        type: "text"
      })
    ]);
    expect(repository.searchRuns).toEqual([
      expect.objectContaining({
        artifacts: expect.objectContaining({
          sources: [{
            rank: 1,
            title: "Valencia weather",
            url: "https://weather.example.test/valencia"
          }]
        }),
        invocationId: "gemini-search-call-1:gemini-google-search",
        modelId: "gemini-3.6-flash",
        provider: "gemini",
        searchRevisionId: "gemini-search-revision-1",
        status: "complete",
        strategyId: "gemini-google-search"
      })
    ]);
    const durableSearch = JSON.stringify(repository.searchRuns);
    expect(durableSearch).not.toContain("RAW_GEMINI_BODY_CANARY");
    expect(durableSearch).not.toContain("RAW_SUGGESTIONS_CANARY");
    expect(durableSearch).not.toContain("RAW_SIGNATURE_CANARY");
    expect(durableSearch).not.toContain("weather in Valencia");
    expect(durableSearch).not.toContain("Valencia is sunny and 29 °C.");
    expect(repository.completeRuns[0]?.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 9,
      reasoningTokens: 1,
      totalTokens: 19
    });
  });

  it("coexists with personal context while persisting normalized client Search evidence", async () => {
    const providerRequests: ProviderRunRequest[] = [];
    const searchRequests: ProviderSearchRequest[] = [];
    const repository = createRepository({
      entitlements: {
        modelKeys: new Set<string>(),
        providerKeys: new Set(["openai"]),
        searchStrategies: new Set(["anthropic-web-search"])
      }
    });
    const answerAdapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [{
            arguments: { query: "current run evidence" },
            id: "anthropic-search-call-1",
            name: "search_engine_1"
          }],
          usage: usage(2, 1, 0)
        });
      }
      yield { data: { delta: "Sourced answer." }, type: "token" };
      return providerResult({ finalText: "Sourced answer.", usage: usage(5, 4, 0) });
    });
    const anthropicSearchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: (request) => ({
        maxOutputTokens: request.searchPolicy.provider === "openrouter"
          ? request.searchPolicy.controls.maxOutputTokens.defaultValue
          : request.searchPolicy.maxOutputTokens,
        modelId: request.searchPolicy.modelId,
        protocol: "anthropic_web_search",
        queryCharacters: request.query.length,
        tool: "web_search_20250305"
      }),
      async search(request) {
        searchRequests.push(request);
        return {
          artifacts: [{
            data: {
              artifactType: "search",
              payload: {
                action: { queries: [request.query], type: "search" },
                encrypted_content: "ENCRYPTED_CONTENT_CANARY",
                encrypted_index: "ENCRYPTED_INDEX_CANARY",
                id: "srvtoolu_client_search_1",
                provider: "anthropic",
                rawResultBody: "RAW_ANTHROPIC_RESULT_CANARY",
                status: "completed",
                type: "web_search_call",
                webSearchRequests: 2
              }
            },
            type: "artifact"
          }],
          finalProviderResponsePreview: {
            encrypted_content: "ENCRYPTED_CONTENT_CANARY",
            encrypted_index: "ENCRYPTED_INDEX_CANARY",
            rawResultBody: "RAW_ANTHROPIC_RESULT_CANARY"
          },
          findings: "The current run evidence is verified.",
          providerResponseId: "anthropic-message-search-1",
          requestPreview: {
            maxOutputTokens: 4_096,
            modelId: "claude-opus-5",
            queryCharacters: request.query.length,
            tool: "web_search_20250305"
          },
          sources: [{
            rank: 1,
            title: "Verified run source",
            url: "https://example.test/anthropic-search"
          }],
          usage: usage(3, 4, 1)
        };
      }
    };
    const base = preparedData({
      modelId: "gpt-answer-model",
      provider: "openai",
      searchPlan: providerClientSearchPlan({
        modelId: "claude-opus-5",
        optionId: "anthropic-web-search",
        protocol: "anthropic_web_search",
        provider: "anthropic"
      })
    });
    const personalContextText =
      `${PERSONAL_CONTEXT_HEADING}\nCLIENT_SEARCH_MEMORY_CANARY_5521`;
    const personalContext = {
      approxTokens: 10,
      itemCount: 1,
      memoryGeneration: 3,
      memoryRevision: 5,
      mode: "prefetched" as const,
      text: personalContextText
    };
    const searchPlan = {
      mode: "model_choice" as const,
      options: [{
        adapterKind: "provider_model_client" as const,
        config: {
          maxOutputTokens: 4_096,
          maxResults: 8,
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
          modelDefaultParams: {},
          queryMaxCharacters: 500,
          reasoningPolicy: "lowest_supported",
          timeoutMs: 300_000
        },
        credentialMode: "provider_model" as const,
        displayName: "Anthropic Web Search",
        executionModes: ["all_selected" as const, "model_choice" as const],
        kind: "provider_model_web_search",
        modelId: "claude-opus-5",
        optionId: "anthropic-web-search",
        protocol: "anthropic_web_search" as const,
        provider: "anthropic",
        providerModelId: "anthropic-search-deployment",
        revisionId: "anthropic-search-revision-1",
        searchStrategyRowId: "anthropic-search-client-route"
      }]
    };
    const prepared: MaterializedPreparedRunData = {
      ...base,
      normalizedRequest: { ...base.normalizedRequest, personalContext, searchPlan },
      providerRequest: { ...base.providerRequest, personalContext, searchPlan }
    };
    const egress = createMemoryEgressRecorder();

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter: answerAdapter,
      memoryEgress: egress.service,
      prepared,
      repository: repository.repository,
      searchRuntimes: {
        "anthropic-web-search": {
          adapter: answerAdapter,
          responseTimeoutMs: 300_000,
          searchAdapter: anthropicSearchAdapter
        }
      }
    })).text());

    expect(events.at(-1)).toMatchObject({ data: { status: "complete" }, type: "done" });
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]).toMatchObject({
      query: "current run evidence",
      searchPolicy: {
        maxOutputTokens: 4_096,
        modelId: "claude-opus-5",
        provider: "anthropic",
        reasoningPolicy: "lowest_supported",
        strategyId: "anthropic-web-search"
      },
      strategyId: "anthropic-web-search"
    });
    expect(JSON.stringify(searchRequests[0])).not.toContain("Current question");
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests).toEqual([
      expect.objectContaining({
        personalContext: expect.objectContaining({ text: personalContextText })
      }),
      expect.objectContaining({
        personalContext: expect.objectContaining({ text: personalContextText })
      })
    ]);
    expect(JSON.stringify(providerRequests[1]?.providerToolMessages))
      .toContain("The current run evidence is verified.");
    expect(egress.began.map((entry) => ({
      destinationKind: entry.destinationKind,
      mode: entry.mode,
      tool: entry.modelRunToolCallId ?? null
    }))).toEqual([
      { destinationKind: "answer_provider", mode: "PROVIDER_REQUEST", tool: null },
      { destinationKind: "search", mode: "TOOL_CALL", tool: "persisted-tool-call-1" },
      { destinationKind: "answer_provider", mode: "PROVIDER_REQUEST", tool: null }
    ]);
    expect(egress.completed).toEqual(["egress-1", "egress-2", "egress-3"]);
    expect(JSON.stringify(egress.began)).not.toContain("CLIENT_SEARCH_MEMORY_CANARY_5521");
    expect(repository.searchRuns).toEqual([
      expect.objectContaining({
        artifacts: expect.objectContaining({
          sources: [{
            rank: 1,
            title: "Verified run source",
            url: "https://example.test/anthropic-search"
          }]
        }),
        invocationId: "anthropic-search-call-1:anthropic-web-search",
        modelId: "claude-opus-5",
        provider: "anthropic",
        searchRevisionId: "anthropic-search-revision-1",
        status: "complete",
        strategyId: "anthropic-web-search"
      })
    ]);
    expect(JSON.stringify(repository.searchRuns)).not.toContain("providerOperations");
    expect(JSON.stringify(repository.searchRuns)).not.toContain("current run evidence");
    expect(repository.completeRuns[0]?.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 9,
      reasoningTokens: 1,
      totalTokens: 19
    });
    expect(repository.completeRuns[0]?.usageAttributions).toEqual([
      expect.objectContaining({
        modelId: "gpt-answer-model",
        provider: "openai",
        usage: expect.objectContaining({
          inputTokens: 7,
          outputTokens: 5,
          reasoningTokens: 0,
          totalTokens: 12
        })
      }),
      expect.objectContaining({
        modelId: "claude-opus-5",
        provider: "anthropic",
        usage: expect.objectContaining({
          inputTokens: 3,
          outputTokens: 4,
          reasoningTokens: 1,
          totalTokens: 7
        })
      })
    ]);
    const durable = JSON.stringify({
      completeRuns: repository.completeRuns,
      persistedEvents: repository.persistedEvents,
      providerRequestPreviews: repository.providerRequestPreviews,
      searchRuns: repository.searchRuns,
      toolCalls: [...repository.toolCalls.values()]
    });
    expect(durable).not.toContain("ENCRYPTED_CONTENT_CANARY");
    expect(durable).not.toContain("ENCRYPTED_INDEX_CANARY");
    expect(durable).not.toContain("RAW_ANTHROPIC_RESULT_CANARY");
  });

  it("discovers, checkpoints, and exposes only a relevant MCP schema on the next round", async () => {
    const namespacedName = "mcp_jira_create_issue_auto";
    const fingerprint = "fingerprint-auto";
    const snapshot: McpRunPlanSnapshot = {
      servers: [{
        fingerprint,
        revisionId: "revision-jira",
        serverId: "server-jira",
        serverName: "Jira"
      }],
      tools: [{
        definitionHash: "a".repeat(64),
        description: "Create a Jira issue",
        inputSchema: {
          properties: { title: { type: "string" } },
          required: ["title"],
          type: "object"
        },
        name: "create_issue",
        namespacedName,
        originalName: "create_issue",
        serverId: "server-jira",
        serverName: "Jira"
      }],
      version: 1
    };
    const discovery: McpDiscoveryState = {
      catalog: {
        servers: [{
          description: "Issue tracking",
          namespace: "jira",
          revisionId: "revision-jira",
          serverId: "server-jira",
          serverName: "Jira",
          tools: [{
            description: "Create a Jira issue",
            namespacedName,
            originalName: "create_issue"
          }]
        }],
        version: 1
      },
      epochs: [],
      version: 2
    };
    const basePrepared = preparedData({
      mcpDiscovery: discovery,
      modelId: "gpt-tool-model",
      provider: "openai"
    });
    const prepared: MaterializedPreparedRunData = {
      ...basePrepared,
      providerRequest: {
        ...basePrepared.providerRequest,
        tools: [{
          capability: "mcp",
          description: "Find relevant tools",
          inputSchema: { type: "object" },
          name: "find_tools"
        }]
      }
    };
    const providerRequests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [{
            arguments: { goal: "create a Jira issue" },
            id: "find-call",
            name: "find_tools"
          }]
        });
      }
      if (providerRequests.length === 2) {
        return providerResult({
          finalText: "",
          toolCalls: [{
            arguments: { title: "Ship Auto discovery" },
            id: "jira-call",
            name: namespacedName
          }]
        });
      }
      return providerResult({ finalText: "Issue created" });
    });
    const repository = createRepository();
    const appendMcpDiscoveryEpoch = vi.fn<
      NonNullable<RunExecutionRepository["appendMcpDiscoveryEpoch"]>
    >(async (input) => {
      expect(providerRequests).toHaveLength(1);
      return {
        discovery: {
          ...discovery,
          epochs: [{
            epoch: 1,
            goal: input.goal,
            modelRunToolCallId: input.modelRunToolCallId,
            roundIndex: input.roundIndex,
            toolIds: [namespacedName]
          }]
        },
        snapshot
      };
    });
    const plan = {
      bindings: [{
        fingerprint,
        runtimeGenerationId: `generation-${fingerprint}`,
        serverId: "server-jira"
      }],
      ok: true as const,
      snapshot
    };
    const materialize = vi.fn(async () => plan);
    const prepare = vi.fn(async () => plan);
    const route = vi.fn(async () => ({
      toolNames: [namespacedName],
      usageAttribution: {
        modelId: "gpt-router",
        provider: "openai",
        usage: { inputTokens: 7, outputTokens: 2, reasoningTokens: 0 }
      }
    }));
    const callTool = vi.fn(async () => ({
      isError: false,
      structuredContent: { issue: "AIQSA-42" },
      text: ["Created AIQSA-42"],
      unsupportedContentTypes: [] as string[]
    }));

    await createRunExecutionResponse(executionInput({
      adapter,
      mcp: { materialize, prepare, router: { route } },
      mcpRuntime: {
        callTool,
        async ensureAcceptedGeneration() { return true; }
      },
      prepared,
      repository: {
        ...repository.repository,
        appendMcpDiscoveryEpoch
      }
    })).text();

    expect(providerRequests).toHaveLength(3);
    expect(providerRequests[0]?.tools?.map((tool) => tool.name)).toEqual(["find_tools"]);
    expect(providerRequests[0]?.parallelToolCalls).toBe(false);
    expect(JSON.stringify(providerRequests[0]?.mcpDiscovery?.catalog)).not.toContain("inputSchema");
    expect(providerRequests[1]?.tools?.map((tool) => tool.name)).toEqual([
      "find_tools",
      namespacedName
    ]);
    expect(providerRequests[1]?.parallelToolCalls).toBe(true);
    expect(providerRequests[1]?.tools?.find((tool) => tool.name === namespacedName)?.inputSchema)
      .toEqual(snapshot.tools[0]?.inputSchema);
    expect(materialize).toHaveBeenCalledWith("user-1", [{
      namespacedName,
      revisionId: "revision-jira",
      serverId: "server-jira"
    }]);
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
    expect(appendMcpDiscoveryEpoch).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({
      generationId: `generation-${fingerprint}`,
      name: "create_issue"
    }));
    expect(repository.completeRuns[0]?.finalText).toBe("Issue created");
    expect(repository.completeRuns[0]?.usageAttributions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: "gpt-router",
        provider: "openai",
        usage: expect.objectContaining({ inputTokens: 7, outputTokens: 2 })
      })
    ]));
  });

  it("completes an Auto run without consulting the router when find_tools is not called", async () => {
    const discovery: McpDiscoveryState = {
      catalog: { servers: [], version: 1 },
      epochs: [],
      version: 2
    };
    const route = vi.fn(async () => {
      throw new Error("System Model is unavailable");
    });
    const materialize = vi.fn(async () => ({
      bindings: [],
      ok: true as const,
      snapshot: { servers: [], tools: [], version: 1 as const }
    }));
    const appendMcpDiscoveryEpoch = vi.fn(async () => null);
    const repository = createRepository();

    await createRunExecutionResponse(executionInput({
      adapter: createAdapter(async function* () {
        return providerResult({ finalText: "No integration was needed" });
      }),
      mcp: { materialize, prepare: materialize, router: { route } },
      prepared: preparedData({
        mcpDiscovery: discovery,
        modelId: "gpt-tool-model",
        provider: "openai"
      }),
      repository: { ...repository.repository, appendMcpDiscoveryEpoch }
    })).text();

    expect(route).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(appendMcpDiscoveryEpoch).not.toHaveBeenCalled();
    expect(repository.completeRuns[0]?.finalText).toBe("No integration was needed");
    expect(repository.failedRuns).toEqual([]);
  });

  it("fails an invoked Auto discovery with one safe public router error", async () => {
    const discovery: McpDiscoveryState = {
      catalog: { servers: [], version: 1 },
      epochs: [],
      version: 2
    };
    const rawFailure = "PRIVATE_SYSTEM_MODEL_ENDPOINT_FAILURE";
    const route = vi.fn(async () => { throw new Error(rawFailure); });
    const materialize = vi.fn(async () => ({
      bindings: [],
      ok: true as const,
      snapshot: { servers: [], tools: [], version: 1 as const }
    }));
    const appendMcpDiscoveryEpoch = vi.fn(async () => null);
    const repository = createRepository();

    await createRunExecutionResponse(executionInput({
      adapter: createAdapter(async function* () {
        return providerResult({
          finalText: "",
          toolCalls: [{
            arguments: { goal: "create an issue" },
            id: "provider-find-tools-failure",
            name: "find_tools"
          }]
        });
      }),
      mcp: { materialize, prepare: materialize, router: { route } },
      prepared: preparedData({
        mcpDiscovery: discovery,
        modelId: "gpt-tool-model",
        provider: "openai"
      }),
      repository: { ...repository.repository, appendMcpDiscoveryEpoch }
    })).text();

    expect(repository.failedRuns).toEqual([expect.objectContaining({
      error: {
        code: MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE,
        message: MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE
      }
    })]);
    expect(JSON.stringify(repository.failedRuns)).not.toContain(rawFailure);
    expect([...repository.toolCalls.values()]).toEqual([
      expect.objectContaining({ state: "error", toolName: "find_tools" })
    ]);
    expect(materialize).not.toHaveBeenCalled();
    expect(appendMcpDiscoveryEpoch).not.toHaveBeenCalled();
    expect(repository.completeRuns).toEqual([]);
  });

  it("fails Auto discovery without another model round when a selected MCP is not ready", async () => {
    const namespacedName = "mcp_catalog_check_quota";
    const discovery: McpDiscoveryState = {
      catalog: {
        servers: [{
          description: "Quota documentation",
          namespace: "catalog",
          revisionId: "revision-catalog",
          serverId: "server-catalog",
          serverName: "Catalog",
          tools: [{
            description: "Check a quota",
            namespacedName,
            originalName: "check_quota"
          }]
        }],
        version: 1
      },
      epochs: [],
      version: 2
    };
    const rawFailure = "PRIVATE_TOOLHIVE_STARTUP_FAILURE";
    const materialize = vi.fn(async () => ({
      code: "mcp_not_ready" as const,
      issues: [{ errorCode: rawFailure, name: "Catalog", readiness: "unavailable" as const }],
      ok: false as const
    }));
    const appendMcpDiscoveryEpoch = vi.fn(async () => null);
    const repository = createRepository();
    let providerRounds = 0;

    await createRunExecutionResponse(executionInput({
      adapter: createAdapter(async function* () {
        providerRounds += 1;
        if (providerRounds === 1) {
          return providerResult({
            finalText: "",
            toolCalls: [{
              arguments: { goal: "check an AWS quota" },
              id: "provider-find-tools-not-ready",
              name: "find_tools"
            }]
          });
        }
        return providerResult({ finalText: "This round must not run" });
      }),
      mcp: {
        materialize,
        prepare: materialize,
        router: {
          route: async () => ({ toolNames: [namespacedName], usageAttribution: null })
        }
      },
      prepared: preparedData({
        mcpDiscovery: discovery,
        modelId: "gpt-tool-model",
        provider: "openai"
      }),
      repository: { ...repository.repository, appendMcpDiscoveryEpoch }
    })).text();

    expect(providerRounds).toBe(1);
    expect(materialize).toHaveBeenCalledOnce();
    expect(appendMcpDiscoveryEpoch).not.toHaveBeenCalled();
    expect(repository.failedRuns).toEqual([expect.objectContaining({
      error: {
        code: MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE,
        message: MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE
      }
    })]);
    expect(JSON.stringify(repository.failedRuns)).not.toContain(rawFailure);
    expect(repository.completeRuns).toEqual([]);
  });

  it("coexists with MCP in one ordinary context and records provider and tool destinations", async () => {
    const canaries = {
      assistant: "ASSISTANT_MEMORY_CANARY_8421",
      attachment: "ATTACHMENT_TEXT_CANARY_8421",
      attachmentMetadata: "ATTACHMENT_METADATA_CANARY_8421",
      current: "CURRENT_DIRECT_USER_CANARY_8421",
      developer: "DEVELOPER_PROMPT_CANARY_8421",
      personal: "PERSONAL_CONTEXT_CANARY_8421",
      prior: "PRIOR_DIRECT_USER_CANARY_8421",
      providerTool: "PRIOR_PROVIDER_TOOL_CANARY_8421",
      system: "SYSTEM_PROMPT_CANARY_8421"
    };
    const namespacedName = "mcp_external_submit_a";
    const fingerprint = "fingerprint-egress";
    const mcp: McpRunPlanSnapshot = {
      servers: [{
        fingerprint,
        revisionId: "revision-egress",
        serverId: "server-egress",
        serverName: "External destination"
      }],
      tools: [{
        definitionHash: "e".repeat(64),
        description: "Submit an explicitly supplied value",
        inputSchema: { type: "object" },
        name: "submit",
        namespacedName,
        originalName: "submit",
        serverId: "server-egress",
        serverName: "External destination"
      }],
      version: 1
    };
    const basePrepared = preparedData({ mcp, modelId: "gpt-tool-model", provider: "openai" });
    const content = textMessageContent(canaries.current);
    const context: NonNullable<ProviderRunRequest["context"]> = {
      messages: [
        { content: textMessageContent(canaries.prior), id: "prior-direct-user", role: "user" },
        { content: textMessageContent(canaries.assistant), id: "prior-assistant", role: "assistant" },
        { content, id: "current-direct-user", role: "user" }
      ],
      mode: "branch_path"
    };
    const personalContextText = `${PERSONAL_CONTEXT_HEADING}\n${canaries.personal}`;
    const personalContext = {
      approxTokens: 12,
      itemCount: 1,
      memoryGeneration: 3,
      memoryRevision: 4,
      mode: "prefetched" as const,
      text: personalContextText
    };
    const prompt = {
      developer: canaries.developer,
      system: canaries.system
    };
    const providerRequest: ProviderRunRequest = {
      ...basePrepared.providerRequest,
      attachmentIds: ["attachment-egress"],
      attachments: [{
        byteSize: 64,
        extractedText: canaries.attachment,
        fileName: "private.txt",
        id: "attachment-egress",
        kind: "text",
        metadata: { marker: canaries.attachmentMetadata },
        mimeType: "text/plain",
        status: "ready"
      }],
      content,
      context,
      personalContext,
      prompt,
      providerToolMessages: [{ marker: canaries.providerTool }],
      tools: mcpRunTools(mcp)
    };
    const prepared: MaterializedPreparedRunData = {
      ...basePrepared,
      normalizedRequest: {
        ...basePrepared.normalizedRequest,
        attachmentIds: ["attachment-egress"],
        content,
        context,
        personalContext,
        prompt
      },
      providerRequest
    };
    const providerRequests: ProviderRunRequest[] = [];
    const previewRequests: ProviderRunRequest[] = [];
    const repository = createRepository();
    const egress = createMemoryEgressRecorder();
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        yield { data: { delta: "SUPPRESSED_PLANNER_DRAFT_CANARY" }, type: "token" };
        return providerResult({
          finalText: "",
          toolCalls: [{
            arguments: { value: "alpha" },
            id: "egress-call-1",
            name: namespacedName
          }],
          usage: usage(2, 1, 0)
        });
      }
      yield { data: { delta: "Safe synthesized answer" }, type: "token" };
      return providerResult({ finalText: "Safe synthesized answer", usage: usage(3, 2, 0) });
    }, previewRequests);
    const prepare = vi.fn<NonNullable<RunExecutionInput["mcp"]>["prepare"]>(
      async (_userId, options) => {
        expect(options).toEqual({ allowedServerIds: ["server-egress"] });
        return {
          bindings: [{
            fingerprint,
            runtimeGenerationId: `generation-${fingerprint}`,
            serverId: "server-egress"
          }],
          ok: true,
          snapshot: mcp
        };
      }
    );
    const callTool = vi.fn<NonNullable<RunExecutionInput["mcpRuntime"]>["callTool"]>(
      async ({ arguments: toolArguments, generationId, name }) => {
        expect(toolArguments).toEqual({ value: "alpha" });
        expect(generationId).toBe(`generation-${fingerprint}`);
        expect(name).toBe("submit");
        return {
          isError: false,
          structuredContent: { accepted: true },
          text: ["SAFE_MCP_RESULT"],
          unsupportedContentTypes: []
        };
      }
    );

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      memoryEgress: egress.service,
      mcp: { prepare },
      mcpRuntime: {
        callTool,
        async ensureAcceptedGeneration(generationId) {
          return generationId === `generation-${fingerprint}`;
        }
      },
      prepared,
      repository: repository.repository
    })).text());

    expect(providerRequests).toHaveLength(2);
    const planningWire = JSON.stringify(providerRequests[0]);
    for (const [name, marker] of Object.entries(canaries)) {
      if (name !== "providerTool") expect(planningWire).toContain(marker);
    }
    expect(planningWire).not.toContain(canaries.providerTool);
    expect(providerRequests[0]).toMatchObject({
      attachmentIds: ["attachment-egress"],
      personalContext: { text: personalContextText },
      toolChoice: "auto",
      tools: [{ capability: "mcp", name: namespacedName }]
    });

    expect(providerRequests[1]).toMatchObject({
      personalContext: { text: personalContextText },
      toolChoice: "auto",
      tools: [{ capability: "mcp", name: namespacedName }]
    });
    expect(JSON.stringify(providerRequests[1]?.providerToolMessages)).toContain("SAFE_MCP_RESULT");
    expect(callTool).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(events.some((event) =>
      event.type === "token" && event.data.delta.includes("SUPPRESSED_PLANNER_DRAFT_CANARY")
    )).toBe(true);

    expect(egress.began.map((entry) => ({
      destinationKind: entry.destinationKind,
      mode: entry.mode,
      tool: entry.modelRunToolCallId ?? null
    }))).toEqual([
      { destinationKind: "answer_provider", mode: "PROVIDER_REQUEST", tool: null },
      {
        destinationKind: "mcp",
        mode: "TOOL_CALL",
        tool: "persisted-tool-call-1"
      },
      { destinationKind: "answer_provider", mode: "PROVIDER_REQUEST", tool: null }
    ]);
    expect(egress.completed).toEqual(["egress-1", "egress-2", "egress-3"]);
    expect(egress.blocked).toEqual([]);
    expect(egress.failed).toEqual([]);
    const receiptEvidence = JSON.stringify(egress.began.map((entry) => ({
      destinationSnapshot: entry.destinationSnapshot,
      requestEvidence: entry.requestEvidence
    })));
    for (const marker of Object.values(canaries)) {
      expect(receiptEvidence).not.toContain(marker);
    }
    expect(previewRequests).toHaveLength(2);
    expect(repository.completeRuns[0]?.finalText).toBe("Safe synthesized answer");
  });

  it.each([
    {
      arguments: { password: "hunter2-secret-egress" },
      label: "structured argument",
      revoked: false
    },
    {
      arguments: { value: "harmless-revocation-value" },
      label: "destination revocation",
      revoked: true
    }
  ])("uses admin trust for $label while retaining immediate destination drift checks", async ({
    arguments: toolArguments,
    revoked
  }) => {
    const namespacedName = "mcp_external_submit_blocked";
    const fingerprint = "fingerprint-blocked";
    const mcp: McpRunPlanSnapshot = {
      servers: [{
        fingerprint,
        revisionId: "revision-blocked",
        serverId: "server-blocked",
        serverName: "Blocked destination"
      }],
      tools: [{
        definitionHash: "f".repeat(64),
        description: "Submit a direct value",
        inputSchema: { type: "object" },
        name: "submit",
        namespacedName,
        originalName: "submit",
        serverId: "server-blocked",
        serverName: "Blocked destination"
      }],
      version: 1
    };
    const basePrepared = preparedData({ mcp, modelId: "gpt-tool-model", provider: "openai" });
    const prepared: MaterializedPreparedRunData = {
      ...basePrepared,
      providerRequest: {
        ...basePrepared.providerRequest,
        tools: mcpRunTools(mcp)
      }
    };
    const providerRequests: ProviderRunRequest[] = [];
    const repository = createRepository();
    const egress = createMemoryEgressRecorder();
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [{ arguments: toolArguments, id: "blocked-call-1", name: namespacedName }]
        });
      }
      return providerResult({ finalText: "Dispatch stayed blocked" });
    });
    const prepare = vi.fn<NonNullable<RunExecutionInput["mcp"]>["prepare"]>(async () => {
      const liveFingerprint = revoked ? "changed-fingerprint" : fingerprint;
      return {
        bindings: [{
          fingerprint: liveFingerprint,
          runtimeGenerationId: `generation-${fingerprint}`,
          serverId: "server-blocked"
        }],
        ok: true,
        snapshot: {
          ...mcp,
          servers: mcp.servers.map((server) => ({ ...server, fingerprint: liveFingerprint }))
        }
      };
    });
    const callTool = vi.fn<NonNullable<RunExecutionInput["mcpRuntime"]>["callTool"]>(
      async () => ({
        isError: false,
        structuredContent: { accepted: true },
        text: ["accepted"],
        unsupportedContentTypes: []
      })
    );

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      memoryEgress: egress.service,
      mcp: { prepare },
      mcpRuntime: {
        callTool,
        async ensureAcceptedGeneration() {
          return true;
        }
      },
      prepared,
      repository: repository.repository
    })).text());

    expect(callTool).toHaveBeenCalledTimes(revoked ? 0 : 1);
    expect(egress.blocked).toEqual(revoked
      ? [expect.objectContaining({
          destinationKind: "mcp",
          errorCode: "memory_egress_destination_revoked",
          mode: "TOOL_CALL",
          modelRunToolCallId: "persisted-tool-call-1"
        })]
      : []);
    expect(egress.began.map((entry) => entry.mode)).toEqual(revoked
      ? ["PROVIDER_REQUEST", "PROVIDER_REQUEST"]
      : ["PROVIDER_REQUEST", "TOOL_CALL", "PROVIDER_REQUEST"]);
    expect(egress.completed).toEqual(revoked
      ? ["egress-1", "egress-3"]
      : ["egress-1", "egress-2", "egress-3"]);
    expect(egress.failed).toEqual([]);
    expect(prepare).toHaveBeenCalledOnce();
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[1]).toMatchObject({ toolChoice: "auto" });
    expect(repository.completeRuns[0]?.finalText).toBe("Dispatch stayed blocked");
    expect([...repository.toolCalls.values()][0]).toMatchObject({
      state: revoked ? "error" : "complete"
    });
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("routes tools from several MCP servers and executes one provider batch in parallel", async () => {
    const firstTool = "mcp_memory_lookup_a";
    const secondTool = "mcp_tasks_list_b";
    const mcp: McpRunPlanSnapshot = {
      servers: [
        {
          fingerprint: "fingerprint-memory",
          revisionId: "revision-memory",
          serverId: "server-memory",
          serverName: "Memory"
        },
        {
          fingerprint: "fingerprint-tasks",
          revisionId: "revision-tasks",
          serverId: "server-tasks",
          serverName: "Tasks"
        }
      ],
      tools: [
        {
          definitionHash: "a".repeat(64),
          description: "Look up memory",
          inputSchema: { type: "object" },
          name: "lookup",
          namespacedName: firstTool,
          originalName: "lookup",
          serverId: "server-memory",
          serverName: "Memory"
        },
        {
          definitionHash: "b".repeat(64),
          description: "List tasks",
          inputSchema: { type: "object" },
          name: "list",
          namespacedName: secondTool,
          originalName: "list",
          serverId: "server-tasks",
          serverName: "Tasks"
        }
      ],
      version: 1
    };
    const repository = createRepository();
    const providerRequests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        yield { data: { delta: "Checking both systems" }, type: "token" };
        return providerResult({
          finalText: "",
          toolCalls: [
            {
              arguments: { query: "AIQSA" },
              id: "memory-call",
              name: firstTool
            },
            { arguments: { project: "AIQSA" }, id: "tasks-call", name: secondTool }
          ],
          usage: usage(1, 1, 0)
        });
      }
      yield { data: { delta: "Combined answer" }, type: "token" };
      return providerResult({ finalText: "Combined answer", usage: usage(2, 2, 0) });
    });
    const release = deferred<void>();
    const bothStarted = deferred<void>();
    const calls: Array<{
      generationId: string;
      inputSchema: Record<string, unknown>;
      name: string;
    }> = [];
    let active = 0;
    let maxActive = 0;
    const mcpRuntime: NonNullable<RunExecutionInput["mcpRuntime"]> = {
      async callTool({ generationId, inputSchema, name }) {
        calls.push({ generationId, inputSchema, name });
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls.length === 2) bothStarted.resolve();
        await release.promise;
        active -= 1;
        return {
          isError: false,
          structuredContent: { generationId, name },
          text: [`${name} result`],
          unsupportedContentTypes: []
        };
      },
      async ensureAcceptedGeneration(generationId) {
        return generationId === "generation-fingerprint-memory" ||
          generationId === "generation-fingerprint-tasks";
      }
    };
    const responseBody = createRunExecutionResponse(executionInput({
      adapter,
      mcpRuntime,
      prepared: preparedData({ mcp, modelId: "gpt-tool-model", provider: "openai" }),
      repository: repository.repository
    })).text();

    await bothStarted.promise;
    release.resolve();
    const events = parseSse(await responseBody);

    expect(maxActive).toBe(2);
    expect(calls).toEqual([
      {
        generationId: "generation-fingerprint-memory",
        inputSchema: mcp.tools[0]?.inputSchema,
        name: "lookup"
      },
      {
        generationId: "generation-fingerprint-tasks",
        inputSchema: mcp.tools[1]?.inputSchema,
        name: "list"
      }
    ]);
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[0]?.tools?.map((tool) => tool.name)).toEqual([firstTool, secondTool]);
    expect(providerRequests[0]?.parallelToolCalls).toBe(true);
    expect(providerRequests[1]?.providerToolMessages).toHaveLength(4);
    expect(events.filter((event) => event.type === "message_reset")).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "summary",
          payload: { stage: "model", status: "waiting" }
        }),
        type: "artifact"
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "summary",
          payload: { count: 2, stage: "tools", status: "running" }
        }),
        type: "artifact"
      })
    ]));
    const toolCallEvent = events.find((event) =>
      event.type === "artifact" && event.data.artifactType === "tool_call"
    );
    expect(toolCallEvent).toMatchObject({
      data: {
        payload: {
          name: "lookup",
          round: 1,
          serverName: "Memory",
          status: "requested"
        }
      }
    });
    expect(repository.completeRuns[0]?.finalText).toBe("Combined answer");
  });

  it.each([
    { code: "mcp_initialize_response_too_large", operation: "initialize" },
    { code: "mcp_inventory_response_too_large", operation: "list_tools" },
    { code: "mcp_call_result_too_large", operation: "call_tool" },
    { code: "mcp_response_too_large", operation: "session" }
  ] as const)("keeps $code durable error evidence free of arguments and partial response data", async ({
    code,
    operation
  }) => {
    const argumentMarker = `private-argument-${code}`;
    const prohibitedMarkers = {
      body: `private-body-${code}`,
      credential: `private-credential-${code}`,
      endpoint: `private-endpoint-${code}`,
      headers: `private-headers-${code}`,
      parserDetail: `private-parser-detail-${code}`,
      partialResult: `private-partial-result-${code}`
    };
    const namespacedName = "mcp_overflow_lookup_a";
    const mcp: McpRunPlanSnapshot = {
      servers: [{
        fingerprint: "fingerprint-overflow",
        revisionId: "revision-overflow",
        serverId: "server-overflow",
        serverName: "Overflow fixture"
      }],
      tools: [{
        definitionHash: "c".repeat(64),
        description: "Return bounded evidence",
        inputSchema: { type: "object" },
        name: "lookup",
        namespacedName,
        originalName: "lookup",
        serverId: "server-overflow",
        serverName: "Overflow fixture"
      }],
      version: 1
    };
    const repository = createRepository();
    const providerRequests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      providerRequests.push(request);
      if (providerRequests.length === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [{
            arguments: { marker: argumentMarker },
            id: "overflow-call",
            name: namespacedName
          }],
          usage: usage(1, 1, 0)
        });
      }
      return providerResult({ finalText: "Safe completion", usage: usage(1, 1, 0) });
    });
    const overflow = new McpClientSessionError({ code, operation });
    for (const [key, value] of Object.entries(prohibitedMarkers)) {
      Object.defineProperty(overflow, key, { enumerable: true, value });
    }
    const mcpRuntime: NonNullable<RunExecutionInput["mcpRuntime"]> = {
      async callTool() {
        throw overflow;
      },
      async ensureAcceptedGeneration(generationId) {
        return generationId === "generation-fingerprint-overflow";
      }
    };

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      mcpRuntime,
      prepared: preparedData({ mcp, modelId: "gpt-tool-model", provider: "openai" }),
      repository: repository.repository
    })).text());

    const toolResultEvent = events.find((event) =>
      event.type === "artifact" && event.data.artifactType === "tool_result"
    );
    expect(toolResultEvent).toBeUndefined();
    for (const marker of Object.values(prohibitedMarkers)) {
      expect(JSON.stringify(events)).not.toContain(marker);
    }
    const settledCall = [...repository.toolCalls.values()][0];
    expect(settledCall).toMatchObject({
      arguments: { marker: argumentMarker },
      state: "error"
    });
    if (!settledCall?.result) throw new Error("expected persisted overflow result");
    expect(settledCall.result).toMatchObject({
      callId: "overflow-call",
      content: [{ text: `Tool failed: ${overflow.message}`, type: "text" }],
      name: namespacedName,
      rawPreview: {
        finalProviderResponsePreview: { code, error: overflow.message },
        requestPreview: {
          toolCall: { id: "overflow-call", name: namespacedName }
        }
      },
      status: "error",
      usage: usage(0, 0, 0)
    });
    const durableError = JSON.stringify(settledCall.result);
    expect(durableError).not.toContain(argumentMarker);
    for (const marker of Object.values(prohibitedMarkers)) {
      expect(durableError).not.toContain(marker);
    }
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[1]?.providerToolMessages).toEqual([
      {
        arguments: JSON.stringify({ marker: argumentMarker }),
        call_id: "overflow-call",
        name: namespacedName,
        status: "completed",
        type: "function_call"
      },
      {
        call_id: "overflow-call",
        output: `Tool failed: ${overflow.message}`,
        type: "function_call_output"
      }
    ]);
    const providerOutput = JSON.stringify(providerRequests[1]?.providerToolMessages?.[1]);
    expect(providerOutput).not.toContain(argumentMarker);
    for (const marker of Object.values(prohibitedMarkers)) {
      expect(JSON.stringify(providerRequests)).not.toContain(marker);
    }
  });

  it("retains completed and partial answer usage with Search when a later tool round fails", async () => {
    let answerRounds = 0;
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      answerRounds += 1;
      if (answerRounds === 1) {
        return providerResult({
          finalText: "",
          toolCalls: [
            {
              arguments: { query: "current sources" },
              id: "tool-call-1",
              name: "search_engine_1"
            }
          ],
          usage: usage(2, 1, 0)
        });
      }

      yield { data: usage(4, 1, 0), type: "usage" };
      throw new Error("later_answer_round_failed");
    });
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search() {
        return {
          artifacts: [],
          finalProviderResponsePreview: {},
          findings: "Search findings",
          requestPreview: {},
          sources: [{ rank: 1, title: "Search source", url: "https://example.com/search" }],
          usage: usage(3, 2, 0)
        };
      }
    };
    const prepared = preparedData({
      modelId: "openai-answer-model",
      provider: "openai",
      searchPlan: perplexityClientSearchPlan()
    });

    const events = parseSse(
      await createRunExecutionResponse(
        executionInput({ adapter, prepared, repository: repository.repository, searchAdapter })
      ).text()
    );

    expect(events.at(-1)).toMatchObject({
      data: {
        code: "provider_stream_failed",
        message: "later_answer_round_failed"
      },
      type: "error"
    });
    expect(repository.completeRuns).toEqual([]);
    expect(repository.recordedRunUsageEvents).toHaveLength(4);
    expect(repository.recordedRunUsageEvents[0]?.answerRoundUsage).toEqual({
      completeness: "terminal",
      roundIndex: 1,
      usage: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 2,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 3
      }
    });
    expect(repository.recordedRunUsageEvents[2]?.answerRoundUsage).toEqual({
      completeness: "partial",
      roundIndex: 2,
      usage: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 4,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 5
      }
    });
    expect(repository.recordedRunUsageEvents[0]?.usageAttributions).toHaveLength(1);
    expect(repository.recordedRunUsageEvents[1]?.usageAccountedToolCallIds).toEqual([
      "persisted-tool-call-1"
    ]);
    expect(repository.recordedRunUsageEvents[2]?.usageAccountedToolCallIds).toEqual([]);
    expect(repository.recordedRunUsageEvents[3]?.usageAccountedToolCallIds).toEqual([]);
    expect(repository.recordedRunUsageEvents.at(-1)?.usageAttributions).toEqual([
      {
        estimatedCostMicros: null,
        modelId: "openai-answer-model",
        provider: "openai",
        usage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 6,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 8
        }
      },
      {
        estimatedCostMicros: null,
        modelId: "perplexity/sonar-pro-search",
        provider: "openrouter",
        usage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 3,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 5
        }
      }
    ]);
  });
});
