import * as workspaceCheckpoints from "../workspace/checkpoints";
import { memoryToolObservations } from "@/tests/support/toolObservations";
import { workspaceCheckpointResult } from "../workspace/checkpointResult";
import * as workspaceImageViewer from "../workspace/directImageView";
import { prepareWorkspaceImages } from "../workspace/imageCapture";
import sharp from "sharp";
import { createHash } from "node:crypto";
const allowMcpTools: import("../mcp/toolAccess").McpToolAccessFilter = async (_userId, tools) => [...tools];
import { mcpAutoDiscoveryFailure, TOOL_SYNTHESIS_FAILURE } from "../../contracts/runs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import { sessionStatusTool } from "../tools/sessionStatus";
import { loadSkillTool, readSkillFileTool } from "../tools/skill";
import { freezeSkillManifest } from "../skills/runManifest";
import { artifactTool } from "../tools/artifact";
import { mixedToolsImagePlan, openRouterMixedTools } from "@/tests/support/openRouterTools";
import {
  MCP_AUTO_DISCOVERY_UNAVAILABLE_CODE,
  MCP_AUTO_DISCOVERY_UNAVAILABLE_MESSAGE
} from "../../contracts/runs";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ResolvedEntitlements } from "../auth/entitlements";
import { McpClientSessionError } from "../mcp/clientSession";
import { McpSemanticRouterError } from "../mcp/router";
import type { McpDiscoveryState, McpRunPlanSnapshot } from "../mcp/runPlan";
import { mcpRunTools } from "../mcp/toolExecutor";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import { buildOpenAIResponsesRequestPreview } from "../providers/openaiResponsesRequest";
import { buildOpenRouterChatRequest, buildOpenRouterChatRequestPreview } from "../providers/openRouterChatRequest";
import { createFetchOpenRouterChatClient, createOpenRouterChatAdapter } from "../providers/openRouterChat";
import { ProviderRequestTimeoutError } from "../providers/network";
import { ProviderSearchExecutionError } from "../providers/types";
import { PERSONAL_CONTEXT_HEADING } from "../providers/personalContext";
import { ProviderStreamTooLargeError } from "../providers/streamSafety";
import { runWithContext } from "../observability";
import { rememberDatabaseFailure } from "../observability/databaseFailure";
import { createPrismaRunRepository } from "./prismaRepository";
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
import { knowledgeRetrievalToolV2 } from "../knowledge/knowledgeTools";
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
import { KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V22, KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION_V3 } from
  "../knowledge/answerGroundingSnapshotV40";
import { KNOWLEDGE_COVERAGE_SCOPE_OPERATION_V7, KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION_V2 } from
  "../knowledge/coverageScopeV7";
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

import { chatTitleWork } from "@/tests/support/chatTitles";
import { createChatTitleWorker } from "../chats/titleGenerationWorker";
import { notifyRunFollowup } from "./runFollowupRegistry";
import type { RunFollowup } from "../../contracts/runFollowups";
import * as agentExecutor from "../agents/executor";
import { agentLimits } from "../agents/config";
import { DEFAULT_AGENT_POLICY } from "../../contracts/agentPolicy";
import { conversationContextPolicy } from "./contextCompactionContract";
import { decodeContextCompactionStatus, type ContextSummary } from "../../contracts/contextCompaction";

type CompleteRunInput = Parameters<RunRepository["completeRun"]>[0];
type CreateSearchRunInput = Parameters<RunRepository["createSearchRun"]>[0];
type RecordRunUsageEventsInput = Parameters<RunRepository["recordRunUsageEvents"]>[0];
type FailedRun = {
  assistantMessageId: string;
  error: { code: string; message: string };
  options?: Readonly<{ recoveryTerminal?: boolean }>;
  runId: string;
};
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
    coverage: [{ id: "D1", status: "covered", contributionIds: ["C1"] }],
    insufficientReason: "not_applicable",
    version: 2
  } as const;
}

function plannedScopeV7Output() {
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
    overflow: { pending: [], unparsedRemainder: false, version: 1 },
    version: 7
  } as const;
}

function plannedScopeClosureOutput() {
  return {
    decisions: [{ id: "D1", status: "closed" }],
    version: 3
  } as const;
}

function plannedCurrentKnowledgeOutput(call: number, text: string) {
  if (call === 1) return plannedDraftOutput(text);
  if (call === 2) return plannedScopeV7Output();
  if (call === 3) return { additions: [], overflow: { pending: [], unparsedRemainder: false, version: 1 }, version: 2 } as const;
  if (call === 4) return plannedSelectorOutput();
  if (call === 5) return plannedScopeClosureOutput();
  throw new Error("current_knowledge_operation_fixture_invalid");
}

const CURRENT_KNOWLEDGE_OPERATION_NAMES = [
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_COVERAGE_SCOPE_OPERATION_V7,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION_V2,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V22,
  KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION_V3
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
  toolBudgets?: NormalizedRunRequest["toolBudgets"];
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
    ...(input.toolBudgets ? { toolBudgets: input.toolBudgets } : {}),
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
  const publishedAnswers: CompleteRunInput[] = [];
  const completeRuns: CompleteRunInput[] = [];
  const failedRuns: FailedRun[] = [];
  const groundingAnswers: string[] = [];
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
    async loadCheckpointedToolLoopRun() { return null; },
    async advanceToolLoopCallBatch() {
      return "advanced";
    },
    async appendAssistantText(_assistantMessageId, text) {
      assistantTexts.push(text);
    },
    async appendRunOutputEvent(runId, event) {
      const sequence = persistedEvents.length;
      const published: typeof event = event.type === "artifact" && event.data.artifactType === "workspace_activity"
        ? { data: { artifactType: "workspace_activity", payload: { ...event.data.payload, sequence } }, type: "artifact" }
        : event;
      persistedEvents.push({ event: published, runId, sequence });
      return published;
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
    async publishRunAnswer(input) {
      publishedAnswers.push(input);
      for (const event of input.outputEvents ?? []) {
        persistedEvents.push({ event, runId: input.runId, sequence: persistedEvents.length });
      }
      return true;
    },
    async completeRun(input) {
      completeRuns.push(input);
      if (options.completionWins === false) {
        return false;
      }
      for (const event of publishedAnswers.length ? [] : input.outputEvents ?? []) {
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
    async groundKnowledgeEvidenceAnswer() {
      if (options.groundingError) throw options.groundingError;
      if (!options.groundingResult) throw Error("knowledge_grounding_fixture_missing");
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
          toolName: call.toolName,
          workspaceBindingId: call.workspace ? input.runId : null
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
      if ((input.usageAccountedToolCallIds ?? []).some((id) => {
        const call = toolCalls.get(id);
        return !call || !["complete", "error"].includes(call.state);
      })) return false;
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
    publishedAnswers,
    completeRuns,
    get durableProviderResponsePreview() {
      return durableProviderResponsePreview;
    },
    failedRuns,
    groundingAnswers,
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

function isContextEvent(event: ModelRunSseEvent) {
  return event.type === "artifact" && event.data.artifactType === "context_status";
}

// Most existing assertions concern answer output; context snapshots have separate coverage.
function parseSse(text: string, includeContext = false): ModelRunSseEvent[] {
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
    }).filter((event) => includeContext || !isContextEvent(event));
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

function captureRunObservation() {
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return {
    records: () => writer.mock.calls.flatMap(([chunk]) => {
      try { return [JSON.parse(String(chunk)) as Record<string, unknown>]; } catch { return []; }
    }),
    restore: () => writer.mockRestore()
  };
}

const completionWorkspace: NonNullable<NormalizedRunRequest["workspace"]> = {
  enabled: true, imageRef: "test-image", inboxIndexPath: "/workspace/inbox/index.json",
  internetEnabled: false, maxToolCalls: 20, maxToolRounds: 10, mcpVersion: "0.6.16",
  messageManifestPath: "/workspace/inbox/messages/message-1/manifest.json",
  outputDirectory: "/workspace/output/run-1", projectDirectory: "/workspace/project",
  runtimeVersion: "0.6.16", sessionId: "workspace-1", syncToolTimeoutSeconds: 5,
  toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 300
};

/** Hybrid MCP tool loop on an 8,192-token window: 6,861 estimated budget tokens. */
function compactionLoopFixture(input: Readonly<{
  historyTokens: number;
  resultChars: number;
  mutate?(request: NormalizedRunRequest): NormalizedRunRequest;
  onToolCall?(count: number): void;
  repository?: ReturnType<typeof createRepository>;
}>) {
  const repository = input.repository ?? createRepository();
  const observations = memoryToolObservations();
  const name = "mcp_synthetic_records";
  const mcp: McpRunPlanSnapshot = { version: 1,
    servers: [{ fingerprint: "a".repeat(64), revisionId: "synthetic-revision", serverId: "synthetic-server", serverName: "Records" }],
    tools: [{ definitionHash: "b".repeat(64), description: "Read records", inputSchema: { type: "object" },
      name: "records", namespacedName: name, originalName: "records", serverId: "synthetic-server", serverName: "Records" }] };
  const base = preparedData({ mcp, modelId: "gpt-tool-model", provider: "openai" });
  const messages = [
    { id: "old-history", role: "user" as const, content: textMessageContent(`OLD_HISTORY ${"h".repeat(input.historyTokens * 4)}`) },
    ...Array.from({ length: 4 }, (_, index) => ({ id: `recent-${index}`, role: index % 2 ? "user" as const : "assistant" as const,
      content: textMessageContent("Acknowledged.") })),
    ...base.normalizedRequest.context!.messages
  ];
  const hybrid: NormalizedRunRequest = {
    ...base.normalizedRequest,
    context: { mode: "branch_path", messages },
    contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current-user-message", messages, mode: "hybrid" }),
    modelCapabilities: { ...base.normalizedRequest.modelCapabilities, contextWindow: 8_192 },
    toolObservationVersion: 1
  };
  const normalizedRequest = input.mutate?.(hybrid) ?? hybrid;
  const prepared = { ...base, normalizedRequest, providerRequest: { ...normalizedRequest, attachments: [] } };
  const summaries: ProviderRunRequest[] = [];
  const answers: ProviderRunRequest[] = [];
  const adapter = createAdapter(async function* (request) {
    if (request.forceNonStreaming) {
      summaries.push(request);
      // A part cites only the references it carries.
      const output = JSON.stringify({ notes: "PRIVATE_NOTES old history condensed.",
        sourceRefs: JSON.stringify(request.content).includes("old-history") ? ["old-history"] : [] });
      yield { type: "token", data: { delta: output } };
      return providerResult({ finalText: output });
    }
    answers.push(request);
    if (answers.length < 3) {
      return providerResult({ finalText: "", toolCalls: [{ id: `read-${answers.length}`, name, arguments: {} }] });
    }
    yield { type: "token", data: { delta: "Done." } };
    return providerResult({ finalText: "Done." });
  });
  let toolCalls = 0;
  const callTool = vi.fn(async () => {
    toolCalls += 1;
    input.onToolCall?.(toolCalls);
    return { isError: false, structuredContent: null, text: [`RESULT_${toolCalls} ${"r".repeat(input.resultChars)}`],
      unsupportedContentTypes: [] };
  });
  const roundCheckpoints: Parameters<RunExecutionRepository["beginToolLoopProviderRound"]>[0][] = [];
  const batchCheckpoints: Parameters<RunExecutionRepository["persistToolLoopCallBatch"]>[0][] = [];
  const begin = repository.repository.beginToolLoopProviderRound;
  repository.repository.beginToolLoopProviderRound = async (value) => { roundCheckpoints.push(value); return begin(value); };
  const persist = repository.repository.persistToolLoopCallBatch;
  repository.repository.persistToolLoopCallBatch = async (value) => { batchCheckpoints.push(value); return persist(value); };
  const run = async () => parseSse(await createRunExecutionResponse({ ...executionInput({ adapter, prepared,
    repository: repository.repository, mcpRuntime: { callTool, ensureAcceptedGeneration: async () => true } }),
  observations: observations.service() }).text(), true);
  const compactionStatuses = () => repository.persistedEvents.flatMap(({ event }) => {
    const status = event.type === "artifact" && event.data.artifactType === "context_compaction"
      ? decodeContextCompactionStatus(event.data.payload) : null;
    return status ? [status] : [];
  });
  return { answers, batchCheckpoints, compactionStatuses, repository, roundCheckpoints, run, summaries };
}

function followupFixture(repository: RunExecutionRepository) {
  const entries: RunFollowup[] = [];
  let closed = false;
  const deliver = vi.fn(async (input: Parameters<NonNullable<RunExecutionRepository["followups"]>["deliver"]>[0]) => {
    if (closed || input.revision !== entries.length) return false;
    let first = true;
    entries.forEach((entry, index) => {
      if (entry.delivery !== "accepted") return;
      entries[index] = { ...entry, delivery: "delivered", ...(first && input.precedingText ? { precedingText: input.precedingText } : {}) };
      first = false;
    });
    return true;
  });
  repository.followups = {
    accept: vi.fn(), beginKnowledge: vi.fn(async () => 0), deliver,
    load: async () => ({ revision: entries.length, entries: entries.map(entry => ({ ...entry })) }),
    close: async ({ revision }) => {
      if (revision !== entries.length || entries.some(entry => entry.delivery !== "delivered")) return false;
      closed = true;
      return true;
    }
  };
  return { entries, deliver, get closed() { return closed; }, accept(text: string) {
    if (closed) throw new Error("fixture_followup_closed");
    entries.push({ id: `clarification-${entries.length + 1}`, ordinal: entries.length + 1, text,
      author: "Author", createdAt: new Date().toISOString(), delivery: "accepted" });
    notifyRunFollowup("run-1", entries.length);
  } };
}

describe("run execution", () => {
  it.each(["followup", "stop"] as const)("keeps %s available during initial context compaction", async mode => {
    const repository = createRepository();
    const followups = followupFixture(repository.repository);
    const base = preparedData({ provider: "openai", modelId: "gpt-tool-model" });
    const messages = [
      { id: "old", role: "user" as const, content: textMessageContent("Old synthetic fact. ".repeat(2_000)) },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `recent-${i}`, role: "assistant" as const, content: textMessageContent("Acknowledged.") })),
      ...base.providerRequest.context!.messages
    ];
    const request: ProviderRunRequest = {
      ...base.providerRequest,
      context: { mode: "branch_path", messages },
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current-user-message", messages, mode: "hybrid" }),
      contextCompaction: { version: 1, beforeTokens: 10_000, afterTokens: 10_000, budgetTokens: 6_000,
        legacyFallback: false, maskedBatches: 0, maskedObservations: 0, outcome: "needs_summary" },
      modelCapabilities: { ...base.providerRequest.modelCapabilities, contextWindow: 8_192 },
      sessionStatusTool: true,
      tools: [sessionStatusTool]
    };
    let summaryCalls = 0, answerCalls = 0;
    const adapter = createAdapter(async function* (request, options) {
      if (request.forceNonStreaming) {
        summaryCalls += 1;
        expect(followups.closed).toBe(false);
        expect(followups.deliver).not.toHaveBeenCalled();
        if (mode === "stop") {
          expect(activeRunControllerRegistry.abort("run-1")).toBe(true);
          options?.signal?.throwIfAborted();
        }
        if (summaryCalls === 1) followups.accept("Use the corrected quantity 23.");
        const summary = JSON.stringify({ notes: "PRIVATE_COMPACTION_NOTES", sourceRefs: [] });
        yield { type: "token", data: { delta: summary } };
        return providerResult({ finalText: summary });
      }
      answerCalls += 1;
      expect(JSON.stringify(request.providerToolMessages)).toContain("corrected quantity 23");
      yield { type: "token", data: { delta: "The quantity is 23." } };
      return providerResult({ finalText: "The quantity is 23." });
    });
    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter, repository: repository.repository,
      prepared: { ...base, normalizedRequest: request, providerRequest: request }
    })).text(), true);
    // Stop ends the first paid call; otherwise the long history needs bounded parts.
    if (mode === "stop") expect(summaryCalls).toBe(1);
    else expect(summaryCalls).toBeGreaterThan(1);
    expect(answerCalls).toBe(mode === "stop" ? 0 : 1);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_COMPACTION_NOTES");
    const statuses = events.filter(event => event.type === "artifact" && event.data.artifactType === "context_compaction");
    expect(statuses).toMatchObject([
      { data: { payload: { state: "running", cycle: 1 } } },
      { data: { payload: { state: mode === "stop" ? "failed" : "complete", cycle: 1 } } }
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", data: { status: mode === "stop" ? "cancelled" : "complete" } });
    if (mode === "followup") expect(followups.entries[0]?.delivery).toBe("delivered");
  });

  it("buys one summary in the round tool results cross the budget and carries it through checkpoints", async () => {
    // Round 1 stays below the 75% headroom trigger; round 2's inline tool
    // result (the newest batch, never masked) pushes it over the budget.
    const loop = compactionLoopFixture({ historyTokens: 4_600, resultChars: 7_800 });
    const events = await loop.run();
    expect(loop.repository.failedRuns).toEqual([]);
    expect(loop.repository.completeRuns[0]?.finalText).toBe("Done.");
    expect(loop.answers).toHaveLength(3);
    // One summary cycle; the long history takes bounded parts and a reduction.
    expect(loop.summaries.length).toBeGreaterThan(1);
    const [first, crossing, reuse] = loop.answers;
    // Round 1 fits and its checkpoint records its real measurement.
    expect(first?.contextCompactionSummary).toBeUndefined();
    expect(first?.contextCompaction).toMatchObject({ outcome: "already_fits" });
    expect(loop.roundCheckpoints[0]?.contextCompaction?.measurement).toEqual(first?.contextCompaction);
    expect(loop.roundCheckpoints[0]?.contextCompaction?.measurement.beforeTokens).toBeGreaterThan(4_600);
    // Round 2 crossed because of its tool result, bought the summary itself
    // and was never dispatched over budget.
    const summary = crossing?.contextCompactionSummary;
    expect(summary?.notes).toContain("condensed");
    expect(JSON.stringify(crossing?.context)).not.toContain("OLD_HISTORY");
    for (const request of loop.answers) {
      expect(request.contextCompaction?.outcome).not.toBe("needs_summary");
      expect(request.contextCompaction!.afterTokens).toBeLessThanOrEqual(request.contextCompaction!.budgetTokens!);
    }
    const checkpoint = loop.batchCheckpoints.find(batch => batch.roundIndex === 2)?.contextCompaction;
    expect(checkpoint?.summary).toEqual(summary);
    expect(checkpoint?.summaryAttempts?.map(({ state }) => state))
      .toEqual([...loop.summaries.slice(1).map(() => "settled"), "committed"]);
    expect(checkpoint?.measurement).toEqual(crossing?.contextCompaction);
    // Every paid call was claimed durably in round 2 before dispatch, then
    // settled with its usage in the same write; the last one committed the summary.
    const receipts = loop.repository.recordedRunUsageEvents.flatMap(entry =>
      entry.contextSummaryReceipt ? [entry.contextSummaryReceipt] : []);
    expect(receipts.map(({ attempt, roundIndex }) => [attempt.attempt, attempt.state, roundIndex])).toEqual(
      loop.summaries.flatMap((_, index) => [[index + 1, "claim", 2], [index + 1, index === loop.summaries.length - 1 ? "committed" : "settled", 2]]));
    expect(receipts.at(-1)?.summary).toEqual(summary);
    const accounted = loop.repository.recordedRunUsageEvents.at(-1)!.usageAttributions
      .find(entry => entry.modelId === "gpt-tool-model");
    expect(accounted?.operationCount).toBe(loop.summaries.length + loop.answers.length);
    // Round 3 reuses the committed summary without another purchase.
    expect(reuse?.contextCompactionSummary).toEqual(summary);
    expect(JSON.stringify(reuse?.providerToolMessages)).toContain("RESULT_2");
    const statuses = loop.compactionStatuses();
    expect(statuses.map(({ cycle, outcome, state }) => [cycle, state, outcome])).toEqual([
      [1, "running", "pending"], [1, "complete", "summary_applied"]
    ]);
    expect(statuses[0]?.beforeTokens).toBeGreaterThan(crossing!.contextCompaction!.budgetTokens!);
    expect(statuses[1]?.afterTokens).toBe(crossing?.contextCompaction?.afterTokens);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_NOTES");
    expect(events.filter(isContextEvent)).toHaveLength(4);
  });

  it.each([
    ["readable", [] as string[]],
    ["no longer readable", [`tor1_${"9".repeat(32)}`]]
  ])("applies carried checkpoint notes in the crossing round when their sources are %s", async (state, handles) => {
    const carried: ContextSummary = { formatVersion: 1, id: `cs1_${"7".repeat(32)}`, notes: "CARRIED_NOTES old history condensed earlier.",
      sourceDigest: "7".repeat(64), sourceRefs: ["old-history", ...handles] };
    const loop = compactionLoopFixture({ historyTokens: 4_600, resultChars: 7_800, mutate: request => ({ ...request,
      contextCompactionPolicy: { ...request.contextCompactionPolicy!,
        reuse: { coveredMessageId: "recent-1", runId: "run-previous", summary: carried } } }) });
    await loop.run();
    expect(loop.repository.failedRuns).toEqual([]);
    const [first, crossing, next] = loop.answers;
    // The exact branch fits in round 1; its admitted context is sent whole.
    expect(first?.contextCompactionSummary).toBeUndefined();
    expect(JSON.stringify(first?.context)).toContain("OLD_HISTORY");
    const checkpoint = loop.batchCheckpoints.find(batch => batch.roundIndex === 2)?.contextCompaction;
    if (state === "readable") {
      // The crossing round reuses the notes: nothing is bought and the checkpoint records them.
      expect(loop.summaries).toEqual([]);
      expect(crossing?.contextCompactionSummary).toEqual(carried);
      expect(crossing?.context?.messages.map(message => message.id).slice(0, 1)).toEqual([`__context-summary-${carried.id}`]);
      expect(crossing?.context?.messages.map(message => message.id)).toEqual(expect.arrayContaining(["recent-2", "recent-3"]));
      expect(JSON.stringify(crossing?.context)).not.toContain("OLD_HISTORY");
      expect(checkpoint?.summary).toEqual(carried);
      expect(checkpoint?.summaryAttempts).toBeUndefined();
      expect(next?.contextCompactionSummary).toEqual(carried);
      expect(loop.compactionStatuses().map(({ cycle, outcome, state: status }) => [cycle, status, outcome]))
        .toEqual([[1, "complete", "summary_applied"]]);
    } else {
      // A covered source the run cannot read: a fresh bounded plan over the exact branch, never the notes.
      expect(loop.summaries.length).toBeGreaterThan(0);
      expect(loop.summaries.some(summary => JSON.stringify(summary.content).includes("CARRIED_NOTES"))).toBe(false);
      expect(crossing?.contextCompactionSummary?.id).not.toBe(carried.id);
      expect(checkpoint?.summary?.id).toBe(crossing?.contextCompactionSummary?.id);
    }
    for (const request of loop.answers) {
      expect(request.contextCompaction!.afterTokens).toBeLessThanOrEqual(request.contextCompaction!.budgetTokens!);
    }
  });

  it("sends summaries without Memory, Knowledge, Search or tools and publishes no session context for them", async () => {
    const personalContext = { approxTokens: 8, itemCount: 1, memoryGeneration: 2, memoryRevision: 3, mode: "prefetched" as const,
      text: `${PERSONAL_CONTEXT_HEADING}\nPRIVATE_MEMORY_FACT` };
    const loop = compactionLoopFixture({ historyTokens: 4_600, resultChars: 7_800,
      mutate: request => ({ ...request, personalContext }) });
    const events = await loop.run();
    expect(loop.repository.failedRuns).toEqual([]);
    expect(loop.summaries.length).toBeGreaterThan(0);
    for (const summary of loop.summaries) {
      expect(JSON.stringify(summary)).not.toContain("PRIVATE_MEMORY_FACT");
      expect(summary).not.toHaveProperty("personalContext");
      expect(summary).not.toHaveProperty("mcp");
      expect(summary.tools).toBeUndefined();
      expect(summary).toMatchObject({ knowledgePlan: { mode: "none" }, searchPlan: { options: [] }, toolChoice: "none", toolMode: "none",
        modelCapabilities: loop.answers[0]!.modelCapabilities, modelId: loop.answers[0]!.modelId, provider: loop.answers[0]!.provider });
    }
    expect(loop.answers.every(answer => answer.personalContext?.text.includes("PRIVATE_MEMORY_FACT"))).toBe(true);
    // Session context describes answer dispatches only: one per answer plus the settled answer.
    expect(events.filter(isContextEvent)).toHaveLength(loop.answers.length + 1);
  });

  it("masks an older settled result live from the run's own server observations", async () => {
    const loop = compactionLoopFixture({ historyTokens: 1_500, resultChars: 7_800 });
    await loop.run();
    expect(loop.repository.failedRuns).toEqual([]);
    const [, second, final] = loop.answers;
    // Round 2 still fits below the trigger: the first result stays inline.
    expect(JSON.stringify(second?.providerToolMessages)).toContain(`RESULT_1 ${"r".repeat(100)}`);
    // Round 3 replaces the older batch with its reader reference and keeps the newest one.
    const transcript = JSON.stringify(final?.providerToolMessages);
    expect(transcript).not.toContain(`RESULT_1 ${"r".repeat(100)}`);
    expect(transcript).toContain(`RESULT_2 ${"r".repeat(100)}`);
    const handle = transcript.match(/tor1_[a-f0-9]{32}/u)?.[0];
    expect(handle).toBeDefined();
    expect(loop.batchCheckpoints.find(batch => batch.roundIndex === 2)?.contextCompaction?.observationRefs)
      .toContain(handle);
    for (const request of loop.answers) {
      expect(request.contextCompaction!.afterTokens).toBeLessThanOrEqual(request.contextCompaction!.budgetTokens!);
    }
  });

  it("routes a clarification delivered during the loop through the same consumer into the checkpoint", async () => {
    const repository = createRepository();
    const followups = followupFixture(repository.repository);
    const clarification = `Clarified constraint ${"f".repeat(7_000)}`;
    const loop = compactionLoopFixture({
      // Below the 75% trigger until the clarification is delivered.
      historyTokens: 3_500, repository, resultChars: 3_000,
      onToolCall: count => { if (count === 1) followups.accept(clarification); }
    });
    await loop.run();
    expect(loop.repository.failedRuns).toEqual([]);
    expect(loop.repository.completeRuns[0]?.finalText).toBe("Done.");
    expect(followups.entries[0]?.delivery).toBe("delivered");
    expect(loop.summaries).toHaveLength(1);
    // The one purchase measured the clarified request, not the pre-delivery round.
    expect(JSON.stringify(loop.summaries[0]?.content)).toContain("Clarified constraint");
    const [, clarified, next] = loop.answers;
    const summary = clarified?.contextCompactionSummary;
    expect(summary).toBeDefined();
    expect(JSON.stringify(clarified?.providerToolMessages)).toContain("Clarified constraint");
    const checkpoint = loop.batchCheckpoints.find(batch => batch.roundIndex === 2)?.contextCompaction;
    expect(checkpoint).toMatchObject({ followupRevision: 1, summary });
    expect(checkpoint?.summaryAttempts).toEqual([expect.objectContaining({ state: "committed" })]);
    expect(checkpoint?.measurement).toEqual(clarified?.contextCompaction);
    expect(next?.contextCompactionSummary).toEqual(summary);
    for (const request of loop.answers) {
      expect(request.contextCompaction?.outcome).not.toBe("needs_summary");
      expect(request.contextCompaction!.afterTokens).toBeLessThanOrEqual(request.contextCompaction!.budgetTokens!);
    }
    expect(loop.compactionStatuses().map(({ cycle, outcome, state }) => [cycle, state, outcome])).toEqual([
      [1, "running", "pending"], [1, "complete", "summary_applied"]
    ]);
  });

  it("keeps a hybrid Knowledge answer on the legacy guard without buying a summary", async () => {
    const finalText = "Total cholesterol is 5.3 mmol/L [K1].";
    const repository = createRepository({ groundingResult: structuralGroundingResult(finalText) });
    const dispatch = createKnowledgeProviderDispatchRecorder();
    const base = fullContextKnowledgePreparedData();
    const history = [
      { id: "old-history", role: "user" as const, content: textMessageContent(`OLD_HISTORY ${"h".repeat(32_000)}`) },
      ...Array.from({ length: 4 }, (_, index) => ({ id: `recent-${index}`, role: index % 2 ? "user" as const : "assistant" as const,
        content: textMessageContent("Acknowledged.") }))
    ];
    const hybrid = <T extends NormalizedRunRequest>(request: T): T => {
      const messages = [...history, ...request.context!.messages];
      return { ...request, context: { mode: "branch_path", messages },
        contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current-user-message", messages, mode: "hybrid" }),
        modelCapabilities: { ...request.modelCapabilities, contextWindow: 8_192 } };
    };
    const requests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      const providerText = JSON.stringify(plannedCurrentKnowledgeOutput(requests.length, "Total cholesterol is 5.3 mmol/L"));
      yield { data: { delta: providerText }, type: "token" };
      return providerResult({ finalText: providerText });
    });
    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter, knowledgeProviderDispatch: dispatch.lifecycle, repository: repository.repository,
      prepared: { ...base, normalizedRequest: hybrid(base.normalizedRequest), providerRequest: hybrid(base.providerRequest) }
    })).text(), true);
    expect(repository.failedRuns).toEqual([]);
    expect(repository.completeRuns[0]?.finalText).toBe(finalText);
    expect(requests.some(request => request.forceNonStreaming)).toBe(false);
    expect(JSON.stringify(requests)).not.toContain("OLD_HISTORY");
    expect(events.some(event => event.type === "artifact" && event.data.artifactType === "context_truncated")).toBe(true);
    expect(events.some(event => event.type === "artifact" && event.data.artifactType === "context_compaction")).toBe(false);
  });

  it("keeps a checkpoint visible when the subsequent answer provider fails", async () => {
    const view = { id: "checkpoint-1", description: "Intermediate design", createdAt: "2026-09-24T00:00:00.000Z" };
    const execute = vi.fn(async (call: import("../tools/types").ModelToolCall) => workspaceCheckpointResult(call, view, "a".repeat(32), [{
      attachmentId: "draft-attachment", byteSize: 20, fileName: "draft.psd", mimeType: "application/octet-stream",
      relativePath: "project/draft.psd", checkpoint: view
    }]));
    const service = vi.spyOn(workspaceCheckpoints, "defaultWorkspaceCheckpoints").mockResolvedValue({ execute, restore: execute, recover: vi.fn() });
    try {
      const base = preparedData({ provider: "openai", modelId: "gpt-tool-model" });
      const prepared = { ...base, normalizedRequest: { ...base.normalizedRequest, workspaceCheckpoints: true as const, workspace: completionWorkspace },
        providerRequest: { ...base.providerRequest, workspaceCheckpoints: true as const, workspace: completionWorkspace } };
      let rounds = 0;
      let checkpointMessage = "";
      const adapter = createAdapter(async function* (request) {
        if (++rounds === 1) return providerResult({ finalText: "", toolCalls: [{ id: "save", name: "checkpoint_outputs",
          arguments: { files: ["project/draft.psd"], description: "Intermediate design" } }] });
        checkpointMessage = JSON.stringify(request.providerToolMessages);
        throw new Error("synthetic_provider_failure_after_checkpoint");
      });
      const repository = createRepository();
      const events = await createRunExecutionResponse({ ...executionInput({ adapter, prepared, repository: repository.repository }),
        workspace: { accepts: () => false, execute: vi.fn(), finalize: vi.fn(), recoverExports: vi.fn(), tools: async () => [],
          handoff: async () => ({ status: "ready" }), settle: async () => ({ quiesced: true, sessionSettled: true, stoppedVm: true }) }
      }).text();
      expect(execute).toHaveBeenCalledOnce();
      expect(rounds).toBe(2);
      expect(repository.completeRuns).toHaveLength(0);
      expect(repository.failedRuns).toHaveLength(1);
      expect(checkpointMessage).toContain("saved");
      expect(events).toContain("workspace_checkpoint");
      expect(events).toContain("draft-attachment");
      expect(events).not.toContain("capture_id");
    } finally { service.mockRestore(); }
  });
  it("delivers direct-view pixels only on the ephemeral provider copy and keeps safe activity", async () => {
    const bytes = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#f4932c" } }).png().toBuffer();
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const source = { captureId: "b".repeat(32), relativePath: "project/private-preview.png", byteSize: bytes.length, checksum,
      assertAccess: async () => {}, open: async () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) };
    const images = await prepareWorkspaceImages([{ source }]);
    const descriptor = images[0]!.descriptor;
    images[0]!.dispose();
    const captures = { imageSource: async () => source, lookup: async () => ({}) } as unknown as
      Parameters<typeof workspaceImageViewer.createWorkspaceImageViewer>[0];
    const real = workspaceImageViewer.createWorkspaceImageViewer(captures);
    const execute = vi.fn(async (call: import("../tools/types").ModelToolCall) => ({ callId: call.id, name: call.name, status: "complete" as const,
      content: [{ type: "workspace_image" as const, value: { consumerKey: "private-call-key", descriptor } }] }));
    const viewer = vi.spyOn(workspaceImageViewer, "defaultWorkspaceImageViewer").mockResolvedValue({ ...real, execute });
    try {
      const base = preparedData({ provider: "openai", modelId: "gpt-tool-model" });
      const prepared = { ...base, normalizedRequest: { ...base.normalizedRequest, workspaceImageView: true as const, workspace: completionWorkspace },
        providerRequest: { ...base.providerRequest, workspaceImageView: true as const, workspace: completionWorkspace } };
      const requests: ProviderRunRequest[] = [];
      const repository = createRepository();
      const adapter = createAdapter(async function* (request) {
        requests.push(request);
        if (requests.length === 1) return providerResult({ finalText: "", toolCalls: [{ id: "view", name: "view_workspace_image", arguments: { path: "/workspace/project/private-preview.png" } }] });
        const output = request.providerToolMessages!.find((v: unknown) => (v as { type: string }).type === "function_call_output") as { output: Array<{ type: string; image_url: string }> };
        expect(output.output[0]).toMatchObject({ type: "input_image", image_url: `data:image/png;base64,${bytes.toString("base64")}` });
        return providerResult({ finalText: "The image is orange." });
      });
      const events = await createRunExecutionResponse({ ...executionInput({ adapter, prepared, repository: repository.repository }),
        workspace: { accepts: () => false, execute: vi.fn(), finalize: vi.fn(), recoverExports: vi.fn(), tools: async () => [],
          handoff: async () => ({ status: "ready" }), settle: async () => ({ quiesced: true, sessionSettled: true, stoppedVm: true }) }
      }).text();
      expect(repository.failedRuns).toEqual([]);
      expect(repository.completeRuns).toHaveLength(1);
      expect(requests).toHaveLength(2);
      expect(execute).toHaveBeenCalledOnce();
      expect(JSON.stringify([...repository.toolCalls.values()])).not.toContain("base64");
      expect(JSON.stringify([...repository.toolCalls.values()])).toContain(descriptor.checksum);
      expect(events).not.toMatch(/private-preview|private-call-key|base64/);
    } finally { viewer.mockRestore(); }
  });

  it("publishes Agent Follow-up availability before native output on the initial stream", async () => {
    const initial = chatUpdate();
    initial.messages = initial.messages.map(message => message.role === "assistant" ? {
      ...message, status: "streaming", content: textMessageContent(""), followups: { available: true, entries: [] }
    } : message);
    const repository = createRepository({ chatUpdate: initial });
    followupFixture(repository.repository);
    const base = preparedData();
    const agent = { ...agentLimits(DEFAULT_AGENT_POLICY, { AIQSA_AGENT_GATEWAY_URL: "http://agent.invalid" }),
      compatibilityHash: "a".repeat(64), mcpMode: "off" as const };
    const prepared = { ...base,
      normalizedRequest: { ...base.normalizedRequest, agent, workspace: completionWorkspace },
      providerRequest: { ...base.providerRequest, agent, workspace: completionWorkspace }
    };
    const native = vi.spyOn(agentExecutor, "executeCodexTurn").mockImplementation(async input => {
      expect(input.followups?.operations).toBe(repository.repository.followups);
      await input.onEvent({ type: "token", data: { delta: "Native answer" } });
      return { ...providerResult({ finalText: "Native answer" }), followupRevision: 0 };
    });
    try {
      const events = parseSse(await createRunExecutionResponse({
        ...executionInput({ adapter: createAdapter(vi.fn()), prepared, repository: repository.repository }),
        agentResponses: {} as NonNullable<RunExecutionInput["agentResponses"]>,
        workspace: { accepts: () => false, execute: vi.fn(), executeAgent: vi.fn(), finalize: vi.fn(),
          recoverExports: vi.fn(), tools: async () => [], handoff: async () => ({ status: "ready" }),
          settle: async () => ({ quiesced: true, sessionSettled: true, stoppedVm: true }) }
      }).text());
      expect(repository.failedRuns).toEqual([]);
      expect(native).toHaveBeenCalledOnce();
      const admissionIndex = events.findIndex(event => event.type === "chat_update");
      expect(admissionIndex).toBeGreaterThan(events.findIndex(event => event.type === "message_start"));
      expect(admissionIndex).toBeLessThan(events.findIndex(event => event.type === "token"));
      expect(events[admissionIndex]).toMatchObject({ data: { messages: [expect.anything(),
        { followups: { available: true, entries: [] } }] } });
    } finally { native.mockRestore(); }
  });

  it.each([
    ["tool", true], ["tool", false], ["generation", true], ["generation", false]
  ] as const)("applies Workspace Follow-up during %s with streaming=%s without repeating settled work", async (timing, streaming) => {
    const repository = createRepository();
    const followups = followupFixture(repository.repository);
    const enteredTool = deferred<void>(), releaseTool = deferred<void>(), enteredGeneration = deferred<void>();
    const requests: ProviderRunRequest[] = [];
    let marker = 0;
    let toolSignal: AbortSignal | undefined;
    const base = preparedData({ provider: "openai", modelId: "gpt-tool-model" });
    const prepared = { ...base,
      normalizedRequest: { ...base.normalizedRequest, workspace: completionWorkspace },
      providerRequest: { ...base.providerRequest, workspace: completionWorkspace, forceNonStreaming: !streaming }
    };
    const workspace: NonNullable<RunExecutionInput["workspace"]> = {
      accepts: ({ name }) => name === "workspace_fixture",
      execute: vi.fn<NonNullable<RunExecutionInput["workspace"]>["execute"]>(async input => {
        marker += 1;
        toolSignal = input.signal;
        expect(input.workspace).toEqual(completionWorkspace);
        enteredTool.resolve();
        if (timing === "tool") await releaseTool.promise;
        expect(input.signal?.aborted).toBe(false);
        return { callId: input.call.id, name: input.call.name, status: "complete", content: [{ type: "json", value: {
          marker, values: [12, 8, 25], execSessionId: "existing-process", status: "running"
        } }] };
      }),
      finalize: vi.fn(), recoverExports: vi.fn(),
      handoff: vi.fn(async () => { expect(followups.closed).toBe(true); return { status: "ready" as const }; }),
      settle: vi.fn(async () => ({ quiesced: true, sessionSettled: true, stoppedVm: true })),
      tools: async () => [{ capability: "workspace", name: "workspace_fixture", description: "Fixture", inputSchema: { type: "object" } }]
    };
    const adapter = createAdapter(async function* (request, options) {
      requests.push(request);
      if (requests.length === 1) return providerResult({ finalText: "", toolCalls: [{ id: "marker", name: "workspace_fixture", arguments: {} }] });
      if (timing === "generation" && requests.length === 2) {
        if (streaming) yield { type: "token", data: { delta: "Previous draft" } };
        enteredGeneration.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Steered", "AbortError"));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      expect(request.workspace).toEqual(completionWorkspace);
      const history = JSON.stringify(request.providerToolMessages);
      expect(history).toContain("existing-process");
      expect(history).toContain("12,8,25");
      expect(history.indexOf("Use CSV with values below 20")).toBeLessThan(history.indexOf("Keep just count and total"));
      expect(followups.entries.every(entry => entry.delivery === "delivered")).toBe(true);
      return providerResult({ finalText: "count,total\n2,20" });
    });
    const text = createRunExecutionResponse({ ...executionInput({ adapter, prepared, repository: repository.repository }), workspace }).text();
    const endedBeforeStep = text.then(() => {
      throw new Error(`workspace_fixture_ended_before_step:${JSON.stringify(repository.failedRuns)}`);
    });
    const waitForStep = (step: Promise<void>) => Promise.race([step, endedBeforeStep]);
    try {
      await waitForStep(enteredTool.promise);
      if (timing === "generation") await waitForStep(enteredGeneration.promise);
      followups.accept("Use CSV with values below 20");
      followups.accept("Keep just count and total");
      expect(toolSignal?.aborted).toBe(false);
      if (timing === "tool") {
        expect(requests).toHaveLength(1);
        expect(followups.entries.map(entry => entry.delivery)).toEqual(["accepted", "accepted"]);
        releaseTool.resolve();
      }
      const events = parseSse(await text);
      expect(repository.failedRuns).toEqual([]);
      expect(workspace.execute).toHaveBeenCalledOnce();
      expect(marker).toBe(1);
      expect(requests).toHaveLength(timing === "generation" ? 3 : 2);
      expect(repository.completeRuns[0]).toMatchObject({ followupRevision: 2, finalText: "count,total\n2,20",
        usageAttributions: [{ operationCount: requests.length }] });
      expect(followups.entries[0]?.precedingText ?? "").toBe(timing === "generation" && streaming ? "Previous draft" : "");
      expect(workspace.handoff).toHaveBeenCalledOnce();
      expect(events.some(event => event.type === "done" && event.data.status === "complete")).toBe(true);
    } finally {
      releaseTool.resolve();
      activeRunControllerRegistry.abort("run-1");
      await text;
    }
  });

  it.each(["cancelled", "completion_race", "unconfirmed"] as const)("settles interrupted background Follow-up with %s and accounts every call once", async mode => {
    const initial = chatUpdate();
    initial.messages = initial.messages.map(message => message.role === "assistant" ? {
      ...message, status: "streaming", content: textMessageContent(""), followups: { available: true, entries: [] }
    } : message);
    const repository = createRepository({ chatUpdate: initial });
    const entries: RunFollowup[] = [];
    repository.repository.followups = {
      accept: vi.fn(), beginKnowledge: vi.fn(async () => 0),
      load: async () => ({ revision: entries.length, entries: entries.map(entry => ({ ...entry })) }),
      deliver: async ({ revision, precedingText }) => {
        if (revision !== entries.length) return false;
        entries.forEach((entry, index) => { if (entry.delivery === "accepted") entries[index] = {
          ...entry, delivery: "delivered", ...(precedingText ? { precedingText } : {})
        }; });
        return true;
      },
      close: async ({ revision }) => revision === entries.length
    };
    const base = preparedData({ provider: "openai", modelId: "gpt-test" });
    const prepared = { ...base, normalizedRequest: { ...base.normalizedRequest, params: { background: true } },
      providerRequest: { ...base.providerRequest, params: { background: true } } };
    const requests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: "artifact", data: { artifactType: "summary", payload: { responseId: "previous-response" } } };
        yield { type: "token", data: { delta: "Old partial" } };
        yield { type: "usage", data: { inputTokens: 11, outputTokens: 2, totalTokens: 13, completeness: "partial" } };
        entries.push({ id: "clarification", ordinal: 1, text: "Use a table", author: "Author", createdAt: new Date().toISOString(), delivery: "accepted" });
        notifyRunFollowup("run-1", entries.length);
        throw new DOMException("Generation interrupted", "AbortError");
      }
      yield { type: "token", data: { delta: "Updated answer" } };
      return providerResult({ finalText: "Updated answer", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, completeness: "complete" } });
    });
    adapter.cancel = vi.fn(async () => {
      if (mode !== "cancelled") throw new Error("provider_cancel_race");
      return { status: "cancelled", usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 } };
    });
    adapter.refresh = vi.fn(async () => ({ events: [], terminal: mode === "completion_race", status: mode === "completion_race" ? "completed" : "in_progress",
      ...(mode === "completion_race" ? { result: providerResult({ usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13, completeness: "complete" } }) } : {}) }));
    const events = parseSse(await createRunExecutionResponse(executionInput({ adapter, prepared, repository: repository.repository })).text());
    expect(adapter.cancel).toHaveBeenCalledWith("previous-response");
    if (mode === "unconfirmed") {
      expect(requests).toHaveLength(1);
      expect(repository.completeRuns).toHaveLength(0);
      expect(repository.failedRuns[0]?.error.code).toBe("followup_generation_unconfirmed");
      expect(entries[0]?.delivery).toBe("accepted");
      expect(repository.recordedRunUsageEvents.at(-1)?.usageAttributions).toMatchObject([{ operationCount: 1, usage: { inputTokens: 11, outputTokens: 2 } }]);
    } else {
      expect(repository.failedRuns).toEqual([]);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.providerToolMessages).toEqual([{ role: "user", content: "Use a table" }]);
      expect(entries[0]).toMatchObject({ precedingText: "Old partial", delivery: "delivered" });
      expect(repository.completeRuns[0]).toMatchObject({ followupRevision: 1, finalText: "Updated answer",
        usageAttributions: [{ operationCount: 2, usage: { inputTokens: 18, outputTokens: 5 } }] });
      expect(events.some(event => event.type === "message_reset")).toBe(true);
    }
    const admissionIndex = events.findIndex(event => event.type === "chat_update");
    expect(admissionIndex).toBeGreaterThan(events.findIndex(event => event.type === "message_start"));
    expect(admissionIndex).toBeLessThan(events.findIndex(event => event.type === "token"));
    expect(events[admissionIndex]).toMatchObject({ data: { messages: [expect.anything(),
      { followups: { available: true, entries: [] } }] } });
  });

  it.each([false, true])("projects pending and ready artifact states with argument streaming=%s", async streaming => {
    const base = preparedData({ modelId: "gpt-tool-model", provider: "openai" });
    const artifactToolDescription = "Frozen artifact policy at admission";
    const prepared = { ...base,
      normalizedRequest: { ...base.normalizedRequest, artifactTool: true as const, artifactToolDescription },
      providerRequest: { ...base.providerRequest, artifactTool: true as const, artifactToolDescription, tools: [artifactTool(artifactToolDescription)] }
    };
    const requests: ProviderRunRequest[] = [];
    const repository = createRepository();
    const payload = { artifact_id: "artifact-1", version_id: "version-1", version_number: 1, kind: "html", title: "Counter", entrypoint: "index.html" };
    const execute = vi.fn<NonNullable<RunExecutionInput["artifacts"]>["execute"]>(async (call, context) => {
      expect(context.persistedToolCallId).toBe("persisted-tool-call-1");
      expect(context.userId).toBe("user-1");
      return { callId: call.id, name: call.name, status: "complete", content: [{ type: "json", value: payload }],
        artifacts: [{ type: "artifact", data: { artifactType: "generated_artifact", payload } }] };
    });
    const adapter = createAdapter(async function* (request, options) {
      requests.push(request);
      if (requests.length === 1 && streaming) {
        expect(options?.onToolArguments).toBeTypeOf("function");
        await options?.onToolArguments?.({ callIndex: 0, callId: "artifact-call", name: "create_artifact",
          delta: JSON.stringify({ private_field: "RAW_ARGUMENT_CANARY", files: [{ path: "index.html", text: "LIVE_CODE_CANARY" }] }) });
      }
      if (requests.length === 1) return providerResult({ finalText: "", toolCalls: [{ arguments: {
        intent: "create", kind: "html", title: "Counter", entrypoint: "index.html",
        files: [{ path: "index.html", mimeType: "text/html", text: "<h1>Counter</h1>" }]
      }, id: "artifact-call", name: "create_artifact" }] });
      return providerResult({ finalText: "Saved your artifact." });
    });
    const events = parseSse(await createRunExecutionResponse({ ...executionInput({ adapter, prepared, repository: repository.repository }),
      artifacts: { execute, restore: async () => null } }).text(), true);
    expect(repository.failedRuns).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.tools).toContainEqual(expect.objectContaining({ name: "create_artifact", description: artifactToolDescription }));
    expect([...repository.toolCalls.values()]).toEqual([expect.objectContaining({ toolName: "create_artifact", state: "complete" })]);
    expect(events).toContainEqual(expect.objectContaining({ type: "artifact", data: expect.objectContaining({ artifactType: "generated_artifact" }) }));
    const generation = events.filter(event => event.type === "artifact_generation");
    expect(generation[0]).toMatchObject({ data: { phase: "started" } });
    expect(generation.at(-1)).toMatchObject({ data: { phase: "settled", status: "ready", artifact: { versionId: "version-1" } } });
    expect(JSON.stringify(generation).includes("LIVE_CODE_CANARY")).toBe(streaming);
    expect(JSON.stringify(events)).not.toContain("RAW_ARGUMENT_CANARY");
    expect(JSON.stringify(repository.persistedEvents)).not.toContain("LIVE_CODE_CANARY");
    expect(repository.persistedEvents.some(({ event }) => event.type === "artifact_generation")).toBe(false);
    expect(repository.completeRuns).toHaveLength(1);
  });
  it("aborts an in-flight artifact resource operation on Stop without another provider dispatch", async () => {
    const base = preparedData({ modelId: "gpt-tool-model", provider: "openai" });
    const prepared = { ...base, normalizedRequest: { ...base.normalizedRequest, artifactTool: true as const },
      providerRequest: { ...base.providerRequest, artifactTool: true as const, tools: [artifactTool()] } };
    const repository = createRepository();
    let dispatches = 0;
    const adapter = createAdapter(async function* () {
      dispatches++;
      return providerResult({ finalText: "", toolCalls: [{ id: "artifact-stop", name: "create_artifact", arguments: { intent: "create" } }] });
    });
    const execute = vi.fn<NonNullable<RunExecutionInput["artifacts"]>["execute"]>(async (_call, _context, options) => {
      if (!options?.signal) throw new Error("artifact_signal_required");
      expect(options.signal.aborted).toBe(false);
      expect(activeRunControllerRegistry.abort("run-1")).toBe(true);
      expect(options.signal.aborted).toBe(true);
      options.signal.throwIfAborted();
      throw new Error("cancelled_artifact_continued");
    });
    const events = parseSse(await createRunExecutionResponse({ ...executionInput({ adapter, prepared, repository: repository.repository }),
      artifacts: { execute, restore: async () => null } }).text(), true);
    expect(execute).toHaveBeenCalledOnce();
    expect(dispatches).toBe(1);
    expect(repository.completeRuns).toEqual([]);
    expect(events.at(-1)?.data).toEqual({ runId: "run-1", status: "cancelled" });
  });

  it.each(["before_dispatch", "during_runtime_preparation", "after_first_call"] as const)("applies MCP revocation %s without stale schema exposure or extra calls", async (when) => {
    const namespacedName = "mcp_tracker_write";
    const fingerprint = "access-fingerprint";
    const mcp: McpRunPlanSnapshot = { version: 1, servers: [{ serverId: "tracker", serverName: "Tracker", revisionId: "rev", fingerprint }],
      tools: [{ serverId: "tracker", serverName: "Tracker", name: "write", originalName: "write", namespacedName,
        description: "Write a record", inputSchema: { type: "object" }, definitionHash: "a".repeat(64) }] };
    let granted = true;
    const requests: ProviderRunRequest[] = [];
    const filterTools: import("../mcp/toolAccess").McpToolAccessFilter = async (actorId, tools) => {
      expect(actorId).toBe("user-1");
      return tools.filter(() => granted);
    };
    const prepare: NonNullable<RunExecutionInput["mcp"]>["prepare"] = async () => ({ ok: true, snapshot: mcp,
      bindings: [{ serverId: "tracker", fingerprint, runtimeGenerationId: `generation-${fingerprint}` }] });
    const effect = vi.fn();
    const callTool = vi.fn<NonNullable<RunExecutionInput["mcpRuntime"]>["callTool"]>(async (input) => {
      if (when === "during_runtime_preparation") granted = false;
      await input.beforeDispatch?.();
      effect();
      granted = false;
      return { isError: false, text: ["Written once"], structuredContent: null, unsupportedContentTypes: [] };
    });
    const repository = createRepository();
    const egress = createMemoryEgressRecorder();
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        expect(request.tools?.some(({ name }) => name === namespacedName)).toBe(true);
        if (when === "before_dispatch") granted = false;
        return providerResult({ finalText: "", toolCalls: [{ id: "access-call", name: namespacedName, arguments: {} }] });
      }
      expect(request.tools?.some(({ name }) => name === namespacedName)).toBe(false);
      return providerResult({ finalText: "Finished" });
    });
    await createRunExecutionResponse(executionInput({ adapter, mcp: { filterTools, prepare },
      mcpRuntime: { callTool, ensureAcceptedGeneration: async () => true }, memoryEgress: egress.service,
      prepared: preparedData({ mcp, modelId: "gpt-tool-model", provider: "openai" }), repository: repository.repository })).text();
    expect(callTool).toHaveBeenCalledTimes(when === "before_dispatch" ? 0 : 1);
    expect(effect).toHaveBeenCalledTimes(when === "after_first_call" ? 1 : 0);
    if (when === "before_dispatch") expect(egress.blocked).toEqual(expect.arrayContaining([expect.objectContaining({ errorCode: "mcp_tool_access_denied" })]));
    expect(mcp.tools).toHaveLength(1);
  });

  it("persists completion, emits done and closes the answer stream while the title provider is held", async () => {
    const held = deferred<void>();
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield { data: { delta: "Final answer" }, type: "token" };
      return providerResult();
    });
    let queued = false;
    let claimed = false;
    let streamClosed = false;
    const work = chatTitleWork();
    const titleRepository = {
      enqueue: vi.fn(), recover: vi.fn(), isCurrent: vi.fn(async () => true),
      recordUsage: vi.fn(), finish: vi.fn(),
      take: vi.fn(async () => {
        if (!queued || !repository.completeRuns.length || claimed) return null;
        claimed = true;
        return work;
      })
    };
    const execute = vi.fn(async () => { await held.promise; return { title: "A later title" }; });
    const worker = createChatTitleWorker({ execute, repository: titleRepository });
    const schedule = vi.fn(async () => { queued = true; });
    const response = createRunExecutionResponse({ ...executionInput({ adapter, repository: repository.repository }),
      chatTitleGenerator: { schedule } });
    const body = response.text().then((text) => { streamClosed = true; return text; });
    let titleWork: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(repository.completeRuns).toHaveLength(1));
      titleWork = worker.reconcile(new AbortController().signal);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(streamClosed).toBe(true));
      const events = parseSse(await body);
      expect(events).toContainEqual({ data: { delta: "Final answer" }, type: "token" });
      expect(events.at(-1)).toMatchObject({ type: "done", data: { status: "complete" } });
      expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", answerText: "Final answer" }));
      expect(titleRepository.finish).not.toHaveBeenCalled();
      expect(repository.failedRuns).toEqual([]);
      expect(repository.completeRuns[0]?.usage).toMatchObject(usage());
    } finally { held.resolve(); await titleWork; await body; }
    expect(repository.completeRuns).toHaveLength(1);
    expect(titleRepository.finish).toHaveBeenCalledWith(work, "A later title");
  });

  it("keeps successful answer completion when optional title admission fails", async () => {
    const repository = createRepository();
    const adapter = createAdapter(async function* () { return providerResult(); });
    const response = createRunExecutionResponse({ ...executionInput({ adapter, repository: repository.repository }),
      chatTitleGenerator: { schedule: async () => { throw new Error("title_handoff_unavailable"); } } });
    expect(parseSse(await response.text()).at(-1)).toMatchObject({ type: "done", data: { status: "complete" } });
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.failedRuns).toEqual([]);
  });

  it.each(["auto", "none"] as const)("executes the built-in status tool with tool mode %s and persists the completed measurement", async (toolMode) => {
    const base = preparedData({ modelId: "gpt-tool-model", provider: "openai", toolMode });
    const prepared = {
      ...base,
      normalizedRequest: { ...base.normalizedRequest, sessionStatusTool: true as const },
      providerRequest: { ...base.providerRequest, sessionStatusTool: true as const, tools: [sessionStatusTool] }
    };
    const requests: ProviderRunRequest[] = [];
    const repository = createRepository();
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      if (requests.length === 1) return providerResult({ finalText: "", toolCalls: [{
        arguments: {}, id: "status-call", name: "get_session_status"
      }] });
      return providerResult({ finalText: "We have room to continue." });
    });
    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter, prepared, repository: repository.repository
    })).text(), true);
    expect(repository.failedRuns).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["get_session_status"]);
    expect(JSON.stringify(requests[1]?.providerToolMessages)).toContain("contextPercent");
    expect(events.filter(isContextEvent).at(-1)).toMatchObject({ data: { artifactType: "context_status", payload: {
      loadedTools: 1, phase: "after_answer", modelId: "gpt-tool-model"
    } } });
    expect(repository.persistedEvents.filter(({ event }) => isContextEvent(event))).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("loads Skills through the durable loop without exposing their bodies or file arguments in SSE", async () => {
    const base = preparedData({ modelId: "gpt-tool-model", provider: "openai" });
    const { manifest } = freezeSkillManifest({ mode: "auto", pinned: [], toolsSupported: true,
      available: [{ skillId: "skill-1", revisionId: "revision-1", name: "review", description: "Review answers", fileCount: 1 }] });
    const prepared = { ...base, normalizedRequest: { ...base.normalizedRequest, skills: manifest },
      providerRequest: { ...base.providerRequest, skills: manifest, tools: [loadSkillTool, readSkillFileTool] } };
    const requests: ProviderRunRequest[] = [];
    const repository = createRepository();
    const skillTools = { execute: vi.fn(async (call: import("../tools/types").ModelToolCall) => ({ callId: call.id, name: call.name, status: "complete" as const,
      content: [{ type: "json" as const, value: { skill: "review", instructions: "PRIVATE_SKILL_BODY", files: [{ path: "private-file.txt" }] } }] })) };
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      if (requests.length === 1) return providerResult({ finalText: "", toolCalls: [{ arguments: { skill: "review" }, id: "load", name: "load_skill" }] });
      return providerResult({ finalText: "I reviewed the answer." });
    });
    const events = await createRunExecutionResponse({ ...executionInput({ adapter, prepared, repository: repository.repository }), skillTools }).text();
    expect(repository.failedRuns).toEqual([]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(skillTools.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(requests[1]?.providerToolMessages)).toContain("PRIVATE_SKILL_BODY");
    expect(events).not.toMatch(/PRIVATE_SKILL_BODY|private-file.txt/);
    expect(events).toContain('"skillId":"skill-1"');
  });

  it("publishes the prepared request context before the first provider token and replaces it on completion", async () => {
    const held = deferred<void>();
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      await held.promise;
      yield { type: "artifact" as const, data: { artifactType: "context_compaction" as const,
        payload: { notes: "FORGED_PRIVATE_COMPACTION", state: "complete" } } };
      yield { type: "token" as const, data: { delta: "Final answer" } };
      return providerResult();
    });
    const body = createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text();
    try {
      await vi.waitFor(() => expect(repository.persistedEvents.filter(({ event }) => isContextEvent(event))).toHaveLength(1));
      expect(repository.persistedEvents.find(({ event }) => isContextEvent(event))?.event).toMatchObject({
        type: "artifact", data: { artifactType: "context_status", payload: { phase: "request" } }
      });
      expect(repository.completeRuns).toHaveLength(0);
    } finally {
      held.resolve();
    }
    const events = parseSse(await body, true);
    expect(JSON.stringify(events)).not.toContain("FORGED_PRIVATE_COMPACTION");
    expect(JSON.stringify(repository.persistedEvents)).not.toContain("FORGED_PRIVATE_COMPACTION");
    expect(events.findIndex(isContextEvent)).toBeLessThan(events.findIndex((event) => event.type === "token"));
    expect(events.filter(isContextEvent)).toMatchObject([
      { data: { payload: { phase: "request" } } }, { data: { payload: { phase: "after_answer" } } }
    ]);
  });

  it.each(["ready", "failed", "cancelled", "completion_lost"] as const)("waits for safe Workspace handoff and respects %s settlement", async (outcome) => {
    const boundary = deferred<void>();
    const repository = createRepository({ completionWins: outcome !== "completion_lost" });
    const providerCalls = vi.fn();
    const adapter = createAdapter(async function* () { providerCalls(); return providerResult(); });
    const prepared = preparedData();
    const handoff = vi.fn(async () => {
      await boundary.promise;
      if (outcome === "failed") throw new Error("synthetic_handoff_failure");
      return { status: "ready" as const };
    });
    const workspace = {
      accepts: () => false, execute: vi.fn(), finalize: vi.fn(), handoff, recoverExports: vi.fn(),
      settle: vi.fn(async () => ({ quiesced: true, sessionSettled: true, stoppedVm: true })),
      tools: async () => [{ capability: "workspace" as const, description: "Fixture", inputSchema: {}, name: "workspace_fixture" }]
    };
    const response = createRunExecutionResponse({ ...executionInput({ adapter, repository: repository.repository,
      prepared: { ...prepared, normalizedRequest: { ...prepared.normalizedRequest, workspace: completionWorkspace } }
    }), workspace });
    let received = "";
    const text = (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return received;
          received += decoder.decode(chunk.value, { stream: true });
        }
      } finally { reader.releaseLock(); }
    })();
    try {
      await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
      expect(repository.publishedAnswers).toHaveLength(1);
      expect(repository.completeRuns).toHaveLength(0);
      await vi.waitFor(() => expect(parseSse(received)).toContainEqual({
        type: "answer_complete", data: { assistantMessageId: "assistant-1", runId: "run-1" }
      }));
      expect(parseSse(received).some((event) => event.type === "done")).toBe(false);
      if (outcome === "cancelled") expect(activeRunControllerRegistry.abort("run-1")).toBe(true);
      boundary.resolve();
      const events = parseSse(await text);
      expect(events.some((event) => event.type === "done" && event.data.status === "complete")).toBe(outcome === "ready");
      expect(repository.completeRuns).toHaveLength(outcome === "ready" || outcome === "completion_lost" ? 1 : 0);
      expect(providerCalls).toHaveBeenCalledOnce();
      expect(workspace.finalize).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === "answer_complete")).toEqual([
        { type: "answer_complete", data: { assistantMessageId: "assistant-1", runId: "run-1" } }
      ]);
      expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
      if (outcome === "completion_lost") expect(repository.recordedRunUsageEvents).toHaveLength(1);
    } finally { boundary.resolve(); await text; }
  });

  it("completes the Workspace answer before a held export and preserves it after transfer failure", async () => {
    const transfer = deferred<void>();
    const repository = createRepository({ chatUpdate: chatUpdate() });
    const providerCalls = vi.fn();
    const adapter = createAdapter(async function* () { providerCalls(); return providerResult(); });
    const prepared = preparedData();
    const finalize = vi.fn(async () => { await transfer.promise; return { code: "workspace_output_export_failed" as const, retryable: true, status: "failed" as const }; });
    const handoff = vi.fn(async () => ({ status: "ready" as const }));
    const workspace = {
      accepts: () => false, execute: vi.fn(), finalize, handoff, recoverExports: vi.fn(),
      settle: vi.fn(async () => ({ quiesced: true, sessionSettled: true, stoppedVm: true })),
      tools: async () => [{ capability: "workspace" as const, description: "Fixture tool", inputSchema: { type: "object" }, name: "workspace_fixture" }]
    };
    const response = createRunExecutionResponse({ ...executionInput({ adapter, repository: repository.repository,
      prepared: { ...prepared, normalizedRequest: { ...prepared.normalizedRequest, workspace: completionWorkspace } }
    }), workspace });
    const text = response.text();
    try {
      await vi.waitFor(() => { expect(repository.failedRuns).toEqual([]); expect(repository.completeRuns).toHaveLength(1); });
      const events = parseSse(await text);
      expect(events.at(-1)).toMatchObject({ type: "done", data: { status: "complete" } });
      expect(handoff).toHaveBeenCalledOnce();
      expect(finalize).not.toHaveBeenCalled();
      expect(providerCalls).toHaveBeenCalledOnce();
      const background = finalize();
      transfer.resolve();
      await background;
      expect(repository.completeRuns).toHaveLength(1);
      expect(repository.failedRuns).toEqual([]);
      expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
    } finally { transfer.resolve(); await text; }
  });

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

  it("sends the persisted Workspace sequence in the live artifact", async () => {
    const repository = createRepository();
    const adapter = createAdapter(async function* () {
      yield {
        data: { artifactType: "workspace_activity", payload: { command: { preview: "pytest" }, id: "command", kind: "command", phase: "running", updateId: "start" } },
        type: "artifact"
      };
      return providerResult();
    });
    const events = parseSse(await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text());
    const persisted = repository.persistedEvents.find(({ event }) =>
      event.type === "artifact" && event.data.artifactType === "workspace_activity");
    expect(persisted?.event).toMatchObject({ data: { payload: { sequence: persisted?.sequence, updateId: "start" } } });
    expect(events.find((event) => event.type === "artifact" && event.data.artifactType === "workspace_activity"))
      .toEqual(persisted?.event);
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
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event)).map(({ event }) => event.type)).toEqual(["artifact"]);
    expect(
      repository.persistedEvents.filter(({ event }) => !isContextEvent(event))
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
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event))).toEqual([]);
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

  it("persists grounded text and safe display while live completion matches the refetched answer", async () => {
    const persistedChatUpdate = chatUpdate();
    persistedChatUpdate.messages[1]!.content = textMessageContent("Live grounded answer");
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
          suggestionsHtml: '<div><a href="https://www.google.com/search?q=weather">Weather</a></div>'
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
      yield { type: "artifact", data: { artifactType: "summary",
        payload: { responseId: "provider-summary-identifier", raw: "provider-wrapper-canary" } } };
      yield { data: { delta: "Live grounded answer" }, type: "token" };
      return providerResult({
        finalProviderResponsePreview: {
          citation: "https://source.example/secret",
          searchSuggestionsHtml: '<div><a href="https://www.google.com/search?q=weather">Weather</a></div>'
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

    expect(repository.assistantTexts.at(-1)).toContain("Live grounded answer");
    expect(repository.completeRuns).toHaveLength(1);
    expect(repository.completeRuns[0]?.finalText).toBe("Live grounded answer");
    expect(repository.completeRuns[0]).not.toHaveProperty("finalProviderResponsePreview");
    expect(repository.durableProviderResponsePreview).toBeNull();
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event)).map(({ event }) => event.type)).toEqual([
      "grounding_display", "artifact"
    ]);
    expect(JSON.stringify(repository.persistedEvents)).not.toContain("runSearch");
    expect(JSON.stringify(events)).not.toContain("runSearch");
    expect(JSON.stringify(events)).not.toMatch(/provider-summary-identifier|provider-wrapper-canary/);
    expect(JSON.stringify(events.find((event) => event.type === "chat_update")))
      .toContain("Live grounded answer");
    const groundingIndex = events.findIndex((event) => event.type === "grounding_display");
    const liveAnswerIndex = events.findIndex(
      (event) => event.type === "token" && event.data.delta === "Live grounded answer"
    );
    expect(groundingIndex).toBeGreaterThan(-1);
    expect(liveAnswerIndex).toBeGreaterThan(groundingIndex);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("retains partial grounded text and safe output on ordinary provider failure", async () => {
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
          suggestionsHtml: '<div><a href="https://www.google.com/search?q=weather">Weather</a></div>'
        },
        type: "grounding_display"
      };
      yield { data: { delta: "failed grounded partial" }, type: "token" };
      throw new Error("grounded_stream_failed");
    });

    const events = parseSse(
      await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text()
    );

    expect(repository.assistantTexts.at(-1)).toBe("failed grounded partial");
    expect(repository.completeRuns).toEqual([]);
    expect(repository.failedRuns).toHaveLength(1);
    expect(repository.durableProviderResponsePreview).toBeNull();
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event))).toHaveLength(1);
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event))[0]?.event.type).toBe("grounding_display");
    expect(JSON.stringify(repository.persistedEvents)).not.toContain("runSearch");
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
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event))).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      "run_start",
      "message_start",
      "token",
      "usage",
      "done"
    ]);
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event))).toEqual([]);
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
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event))).toEqual([]);
    expect(repository.failedRuns).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: { code: "provider_stream_failed", message: "The response could not be completed. The cause is unconfirmed; do not repeat an uncertain action." },
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
    const warning = captureRunObservation();
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
    const safetyWarnings = warning.records().filter((entry) => entry.event === "provider_stream_safety_terminated");
    expect(safetyWarnings).toHaveLength(1);
    expect(safetyWarnings[0]).toMatchObject({
      code: "provider_stream_too_large",
      durationMs: 123,
      limit: 64,
      observed: 65,
      termination: "total_limit",
      totalStreamBytes: 65
    });
    warning.restore();
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
        message: "The provider request timed out. Its outcome may be unknown."
      },
      type: "error"
    });
    expect(repository.assistantTexts).toEqual(["partial"]);
    expect(repository.failedRuns).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "provider_request_timed_out",
        message: "The provider request timed out. Its outcome may be unknown."
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
        message: "The response could not be completed. The cause is unconfirmed; do not repeat an uncertain action."
      },
      type: "error"
    });
    expect(repository.providerResponseIds).toEqual(["response-1"]);
    expect(repository.failedRuns).toEqual([{
      assistantMessageId: "assistant-1",
      error: {
        code: "provider_stream_failed",
        message: "The response could not be completed. The cause is unconfirmed; do not repeat an uncertain action."
      },
      runId: "run-1"
    }]);
  });

  it("persists an ordinary failed provider draft without executing absent tool calls", async () => {
    const warning = captureRunObservation();
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
    const safetyWarnings = warning.records().filter((entry) => entry.event === "provider_stream_safety_terminated");
    expect(safetyWarnings).toHaveLength(1);
    expect(safetyWarnings[0]).toMatchObject({
      durationMs: 20,
      limit: 128,
      observed: 129,
      totalStreamBytes: 129
    });
    warning.restore();
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
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event))).toEqual([]);
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
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event))).toEqual([]);
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
    // Stop ends the stream with an explicit cancelled frame, never a bare close.
    expect(events.map((event) => event.type)).toEqual(["run_start", "message_start", "token", "done"]);
    expect(events.at(-1)?.data).toEqual({ runId: "run-1", status: "cancelled" });
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
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event))).toEqual([]);
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
    expect(repository.persistedEvents.filter(({ event }) => !isContextEvent(event))).toEqual([]);
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

  it.each([undefined, 2, 3, 4, 5, 6, 7] as const)("runs one focused retrieval with the frozen hidden workflow (%s)", async (workflowVersion) => {
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

    const prepared = focusedKnowledgePreparedData();
    if (workflowVersion !== undefined) prepared.normalizedRequest.knowledgeAnswerWorkflowVersion = workflowVersion;
    const body = await createRunExecutionResponse(executionInput({
      adapter,
      knowledgeExecutor: executor,
      knowledgeProviderDispatch: dispatch.lifecycle,
      prepared,
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
    expect(providerRequests[0]?.prompt.system?.includes(workflowVersion === 7 ? "Every claim text is one literal plain-text line" : "Every claim text must be a single plain-text line."))
      .toBe(workflowVersion !== undefined);
    expect(providerRequests[1]?.prompt.system).toContain(
      workflowVersion === 7 ? '<aiqsa_knowledge_coverage_scope_partial_evidence_contract version="1">' : '<aiqsa_knowledge_coverage_scope_contract version="7">'
    );
    expect(providerRequests[3]?.prompt.system).toContain(
      '<aiqsa_knowledge_grounded_selector_contract version="22">'
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

  it.each([1, 7])("restarts Knowledge review for the clarified question with %s consumed operations", async consumed => {
    const finalText = "Total cholesterol is 5.3 mmol/L [K1].";
    const repository = createRepository({ groundingResult: structuralGroundingResult(finalText) });
    const dispatch = createKnowledgeProviderDispatchRecorder();
    const entries: RunFollowup[] = [];
    repository.repository.followups = {
      accept: vi.fn(),
      load: async () => ({ revision: entries.length, entries }),
      deliver: async () => { entries.forEach((entry, index) => { entries[index] = { ...entry, delivery: "delivered" }; }); return true; },
      close: async ({ revision }) => revision === entries.length,
      beginKnowledge: async ({ revision }) => revision ? consumed : 0
    };
    const requests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        entries.push({ id: "clarification", ordinal: 1, text: "Report cholesterol only.", author: "User",
          createdAt: "2026-09-22T00:00:00.000Z", delivery: "accepted" });
        notifyRunFollowup("run-1", 1);
      }
      return providerResult({ finalText: JSON.stringify(plannedCurrentKnowledgeOutput(
        Math.max(1, requests.length - 1), "Total cholesterol is 5.3 mmol/L")) });
    });
    await createRunExecutionResponse(executionInput({ adapter, knowledgeProviderDispatch: dispatch.lifecycle,
      prepared: fullContextKnowledgePreparedData(), repository: repository.repository })).text();
    expect(JSON.stringify(requests[0])).not.toContain("Report cholesterol only.");
    expect(requests.slice(1).every(request => JSON.stringify(request).includes("Report cholesterol only."))).toBe(true);
    expect(dispatch.markAmbiguous).toHaveBeenCalledOnce();
    expect(dispatch.prepare.mock.calls.map(([call]) => call.ordinal)).toEqual(consumed === 1 ? [1, 2, 3, 4, 5, 6] : [1, 8]);
    if (consumed === 1) {
      expect(repository.failedRuns).toEqual([]);
      expect(repository.completeRuns[0]).toMatchObject({ followupRevision: 1, finalText });
    } else {
      expect(requests).toHaveLength(2);
      expect(repository.completeRuns).toEqual([]);
      expect(repository.failedRuns).toHaveLength(1);
    }
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
        finalText: JSON.stringify(plannedDraftOutput("Supported answer")),
        usage: { inputTokens: 5, outputTokens: 3 }
      });
      yield { type: "usage", data: { inputTokens: 4, outputTokens: 0 } };
      yield { type: "usage", data: { inputTokens: 7 } };
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
    expect(repository.recordedRunUsageEvents.at(-1)?.usageAttributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: "openai-answer-model", provider: "openai", operationCount: 2,
        usage: expect.objectContaining({ completeness: "partial", inputTokens: 12, outputTokens: 3, totalTokens: 15 }) })
    ]));
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
          code: "opensearch_timeout",
          message: "Knowledge search timed out. Try again later."
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

  it.each([
    [8, undefined, undefined, undefined],
    [9, undefined, undefined, undefined],
    [9, 2, 2, undefined],
    [10, 2, 3, undefined],
    [11, 2, 3, undefined],
    [11, 3, 3, undefined],
    [11, 3, 4, undefined],
    [11, 3, 5, undefined],
    [11, 3, 5, 1]
  ] as const)("composes and reviews Knowledge with workflow %s, search instructions %s, packing %s and review repair %s", async (workflowVersion, knowledgeSearchInstructionVersion, knowledgeEvidencePackingVersion, knowledgeReviewRepairFeedbackVersion) => {
    const repository = createRepository({ groundingResult: structuralGroundingResult("Reviewed answer [K1].") });
    const finalize = vi.spyOn(repository.repository, "groundKnowledgeEvidenceAnswer");
    const legacy = vi.spyOn(repository.repository, "groundKnowledgeAnswerV21");
    const { execute, executor } = toolLoopKnowledgeExecutor();
    const dispatch = createKnowledgeProviderDispatchRecorder();
    const requests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      if (requests.length === 1) return providerResult({ finalText: "", toolCalls: [{
        name: KNOWLEDGE_SEARCH_TOOL_NAME, id: "knowledge-call-1", arguments: { query: "retention", sourceAliases: [] }
      }] });
      if (requests.length === 2) return providerResult({ finalText: "AIQSA_KNOWLEDGE_RETRIEVAL_COMPLETE" });
      return providerResult({ finalText: JSON.stringify(requests.length === 3
        ? { version: 1, blocks: [{ kind: "paragraph", text: "A supported answer.", evidenceHandles: ["K1"] }] }
        : workflowVersion === 11 ? { version: 2, blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1"], reason: "" }],
          analysisComplete: true, requirements: [{ requirement: "Explain retention.", status: "answered", blockIds: ["B1"], correctionEvidenceHandles: [], gap: "" }], followUps: [] }
        : { version: 1, blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: ["K1"] }],
          coverage: "complete", analysisComplete: true, missingInformation: [], followUps: [] }) });
    });
    const base = preparedData({ knowledgeBaseIds: ["base-1"], modelId: "openai-answer-model", provider: "openai" });
    const searchPolicy = knowledgeSearchInstructionVersion === undefined ? {} : { knowledgeSearchInstructionVersion };
    const packingPolicy = knowledgeEvidencePackingVersion === undefined ? {} : { knowledgeEvidencePackingVersion };
    const repairPolicy = knowledgeReviewRepairFeedbackVersion === undefined ? {} : { knowledgeReviewRepairFeedbackVersion };
    const prepared = { ...base, normalizedRequest: { ...base.normalizedRequest, knowledgeAnswerWorkflowVersion: workflowVersion, ...searchPolicy, ...packingPolicy, ...repairPolicy },
      providerRequest: { ...base.providerRequest, knowledgeAnswerWorkflowVersion: workflowVersion, ...searchPolicy, ...packingPolicy, ...repairPolicy } };
    const response = await createRunExecutionResponse(executionInput({ adapter, prepared, repository: repository.repository,
      knowledgeExecutor: executor, knowledgeProviderDispatch: dispatch.lifecycle })).text();
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(4);
    expect(dispatch.prepare.mock.calls.map(([input]) => input.purpose)).toEqual(workflowVersion === 11
      ? ["knowledge_evidence_compose_v2", "knowledge_evidence_review_v2"] : ["knowledge_evidence_compose_v1", "knowledge_evidence_review_v1"]);
    for (const [input] of dispatch.prepare.mock.calls) {
      if (knowledgeReviewRepairFeedbackVersion === 1) expect(input.acceptedRequest).toMatchObject({ repairFeedbackVersion: 1 });
      else expect(input.acceptedRequest).not.toHaveProperty("repairFeedbackVersion");
    }
    for (const request of requests.slice(0, 2)) {
      expect(request.knowledgeSearchInstructionVersion).toBe(knowledgeSearchInstructionVersion);
      expect(request.knowledgeEvidencePackingVersion).toBe(knowledgeEvidencePackingVersion);
      expect(request.tools?.find(tool => tool.name === KNOWLEDGE_SEARCH_TOOL_NAME)?.description)
        .toBe((knowledgeSearchInstructionVersion !== undefined ? knowledgeRetrievalToolV2 : knowledgeRetrievalTool).description);
    }
    expect(finalize).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
    expect(repository.failedRuns).toEqual([]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(response).not.toContain("A supported answer.");
  });

  it.each([9, 10, 11] as const)("uses reviewed gaps to retrieve new evidence before revising an ordinary answer (%s)", async workflowVersion => {
    const repository = createRepository({ groundingResult: structuralGroundingResult("Reviewed answer [K1] [K2].") });
    const initial = knowledgeEvidence();
    const { execute, executor } = toolLoopKnowledgeExecutor(initial);
    const moreDraft = { ...initial, invocationOrdinal: 2, results: initial.results.map(item => ({ ...item,
      chunkId: "chunk-2", handle: "K2", includedText: "The missing procedural step.",
      includedTextBytes: Buffer.byteLength("The missing procedural step."), sourceTextBytes: Buffer.byteLength("The missing procedural step.") })) };
    const more = { ...moreDraft, providerText: knowledgeToolResultText(moreDraft) };
    execute.mockImplementation(async call => {
      const evidence = call.id.startsWith("knowledge-review-v1-") ? more : initial;
      return { callId: call.id, name: call.name, status: "complete", content: knowledgeToolResultContent(evidence),
        rawPreview: { knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION, knowledgeRetrieval: evidence, providerCall: true } };
    });
    const base = preparedData({ knowledgeBaseIds: ["base-1"], modelId: "openai-answer-model", provider: "openai" });
    const prepared = { ...base, normalizedRequest: { ...base.normalizedRequest, knowledgeAnswerWorkflowVersion: workflowVersion },
      providerRequest: { ...base.providerRequest, knowledgeAnswerWorkflowVersion: workflowVersion } };
    repository.repository.loadCheckpointedToolLoopRun = async ({ runId, userId }) => ({
      assistantMessageId: "assistant-1", assistantText: null, calls: [...repository.toolCalls.values()], chatId: "chat-1",
      checkpoint: { version: 2, phase: "provider_running", roundIndex: 2, providerContinuation: null, providerCursor: null, answerRoundUsage: [] },
      id: runId, userId, status: "streaming", modelId: prepared.normalizedRequest.modelId, provider: "openai", providerResponseId: null,
      normalizedRequest: prepared.normalizedRequest, knowledgeScope: { bindings: [], budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
        exclusions: [], knowledgePlan: prepared.normalizedRequest.knowledgePlan }
    });
    const requests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      const step = requests.length;
      if (step === 1) return providerResult({ finalText: "", toolCalls: [{ name: KNOWLEDGE_SEARCH_TOOL_NAME,
        id: "first-search", arguments: { query: "procedure", sourceAliases: [] } }] });
      if (step === 2) return providerResult({ finalText: "AIQSA_KNOWLEDGE_RETRIEVAL_COMPLETE" });
      return providerResult({ finalText: JSON.stringify(step === 3 || step === 5
        ? { version: 1, blocks: [{ kind: "paragraph", text: step === 3 ? "The first supported step." : "The complete supported procedure.", evidenceHandles: step === 3 ? ["K1"] : ["K1", "K2"] }] }
        : workflowVersion === 11 ? { version: 2, blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: step === 4 ? ["K1"] : ["K1", "K2"], reason: "" }],
          analysisComplete: true, requirements: [{ requirement: "Explain the complete procedure.", status: step === 4 ? "missing_evidence" : "answered",
            blockIds: ["B1"], correctionEvidenceHandles: [], gap: step === 4 ? "The final step." : "" }],
          followUps: step === 4 ? [{ query: "procedure final step", sourceAliases: [], requirementIds: ["R1"] }] : [] }
        : { version: 1, blocks: [{ blockId: "B1", verdict: "supported", evidenceHandles: step === 4 ? ["K1"] : ["K1", "K2"] }],
          coverage: step === 4 ? "partial" : "complete", analysisComplete: true,
          missingInformation: step === 4 ? ["The final step."] : [],
          followUps: step === 4 ? [{ query: "procedure final step", sourceAliases: [] }] : [] }) });
    });
    const dispatch = createKnowledgeProviderDispatchRecorder();
    await createRunExecutionResponse(executionInput({ adapter, prepared, repository: repository.repository,
      knowledgeExecutor: executor, knowledgeProviderDispatch: dispatch.lifecycle })).text();
    expect(repository.failedRuns).toEqual([]);
    expect(repository.completeRuns).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(6);
    const suffix = workflowVersion === 11 ? "v2" : "v1";
    expect(dispatch.prepare.mock.calls.map(([input]) => input.purpose)).toEqual([
      `knowledge_evidence_compose_${suffix}`, `knowledge_evidence_review_${suffix}`,
      `knowledge_evidence_compose_${suffix}`, `knowledge_evidence_review_${suffix}`
    ]);
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

  it.each(["knowledge_retrieval_aborted", "knowledge_search_projection_incomplete", "opensearch_connection_failed",
    "opensearch_authentication_failed", "opensearch_configuration_invalid", "opensearch_index_incompatible", "opensearch_rate_limited"])(
    "durably preserves %s through tool result and terminal failure", async (failureCode) => {
    const finalText = "Knowledge retrieval was unavailable.";
    const repository = createRepository({
      groundingResult: structuralGroundingResult(finalText)
    });
    const deadline = new Error(failureCode);
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
    const persistedFailureCode = failureCode === "knowledge_retrieval_aborted" ? "opensearch_timeout" : failureCode;
    expect(JSON.stringify(providerRequests[1]?.providerToolMessages)).toContain("Knowledge");
    expect([...repository.toolCalls.values()]).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ rawPreview: { knowledgeFailure: expect.objectContaining({
        code: persistedFailureCode, mappingVersion: 1, version: 1
      }) } }), state: "error" })
    ]);
    expect(repository.completeRuns).toHaveLength(0);
    expect(repository.failedRuns).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: persistedFailureCode }) })]);
    expect(JSON.stringify(repository.failedRuns)).not.toContain("bounded private lookup");
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
        operationCount: 2, modelId: "openai-answer-model",
        provider: "openai",
        usage: {
          completeness: "complete", cachedInputTokens: null,
          cacheWriteInputTokens: null,
          inputTokens: 6,
          outputTokens: 8,
          reasoningTokens: 1,
          totalTokens: 14
        }
      },
      {
        estimatedCostMicros: null,
        operationCount: 1, modelId: "perplexity/sonar-pro-search",
        provider: "openrouter",
        usage: {
          completeness: "complete", cachedInputTokens: null,
          cacheWriteInputTokens: null,
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
      persistedEvents: repository.persistedEvents.filter(({ event }) => !isContextEvent(event)),
      providerRequestPreviews: repository.providerRequestPreviews,
      searchRuns: repository.searchRuns,
      toolCalls: [...repository.toolCalls.values()]
    });
    expect(durable).not.toContain("ENCRYPTED_CONTENT_CANARY");
    expect(durable).not.toContain("ENCRYPTED_INDEX_CANARY");
    expect(durable).not.toContain("RAW_ANTHROPIC_RESULT_CANARY");
  });

  it.each([false, true])("persists a safe answer-routing failure with mixed tools %s", async (mixedTools) => {
    const base = preparedData({ provider: "openrouter", modelId: "deepseek/deepseek-v4-pro-0813",
      ...(mixedTools ? { mcpDiscovery: { version: 2, catalog: { version: 1, servers: [] }, epochs: [] } } : {}) });
    const prepared = {
      ...base,
      normalizedRequest: { ...base.normalizedRequest, ...(mixedTools ? { imagePlan: mixedToolsImagePlan, sessionStatusTool: true as const } : {}) },
      providerRequest: { ...base.providerRequest, ...(mixedTools ? { imagePlan: mixedToolsImagePlan, sessionStatusTool: true as const, tools: openRouterMixedTools() } : {}) },
      providerAdmissionPlan: { ...base.providerAdmissionPlan, answer: { ...base.providerAdmissionPlan.answer,
        snapshot: { ...base.providerAdmissionPlan.answer.snapshot, modelDisplayName: "Accepted answer label" } } }
    };
    const remotePrivate = "PRIVATE_ROUTING_FUNNEL_CANARY";
    const fetchFn = vi.fn(async () => Response.json({ error: { code: 404,
      message: `No endpoints found that support the provided parameters. ${remotePrivate}`,
      metadata: { failed_routing_step: "parameters", routing_funnel: { raw: remotePrivate } }
    } }, { status: 404 }));
    const route = vi.fn();
    const materialize = vi.fn();
    const appendMcpDiscoveryEpoch = vi.fn();
    const repository = createRepository();
    const response = await createRunExecutionResponse(executionInput({ prepared,
      adapter: createOpenRouterChatAdapter({ client: createFetchOpenRouterChatClient({ apiKey: "fixture", fetchFn }) }),
      mcp: { filterTools: allowMcpTools, materialize, prepare: materialize, router: { route } },
      repository: { ...repository.repository, appendMcpDiscoveryEpoch }
    })).text();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(repository.failedRuns).toEqual([expect.objectContaining({
      error: { code: "openrouter_required_parameters_unavailable",
        message: expect.stringContaining("answer model “Accepted answer label”") },
      options: { recoveryTerminal: true }
    })]);
    expect(repository.failedRuns[0]?.error.message).toContain("before retrying");
    expect(response).toContain("openrouter_required_parameters_unavailable");
    expect(response).toContain("Accepted answer label");
    expect(response + JSON.stringify(repository.failedRuns)).not.toContain(remotePrivate);
    expect(repository.toolCalls.size).toBe(0);
    expect(route).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(appendMcpDiscoveryEpoch).not.toHaveBeenCalled();
    expect(repository.completeRuns).toEqual([]);
  });

  it.each([
    { mode: "single", goals: ["create a Jira issue"], provider: "openai", modelId: "gpt-tool-model" },
    { mode: "batch", goals: ["a".repeat(400), "create a Jira issue"], provider: "openai", modelId: "gpt-tool-model" },
    { mode: "OpenRouter DeepSeek", goals: ["create a Jira issue"], provider: "openrouter", modelId: "deepseek/deepseek-v4-pro-0813" },
    { mode: "OpenRouter Opus batch", goals: ["a".repeat(400), "create a Jira issue"], provider: "openrouter", modelId: "anthropic/claude-opus-5" }
  ])("discovers and checkpoints MCP schemas for $mode goals", async ({ goals, provider, modelId }) => {
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
      modelId,
      provider
    });
    const applicationTools = provider === "openrouter" ? openRouterMixedTools() : [];
    const applicationControls = provider === "openrouter" ? {
      imagePlan: mixedToolsImagePlan, sessionStatusTool: true as const,
      modelCapabilities: { ...basePrepared.normalizedRequest.modelCapabilities, contextWindow: 262_144 },
      params: { maxTokens: 65_536, temperature: 1, reasoning: { enabled: true, effort: "high" },
        provider: { dataCollection: "deny", allowFallbacks: true, sort: "throughput", requireParameters: false } }
    } : {};
    const prepared: MaterializedPreparedRunData = {
      ...basePrepared,
      normalizedRequest: { ...basePrepared.normalizedRequest, ...applicationControls },
      providerRequest: {
        ...basePrepared.providerRequest,
        ...applicationControls,
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
      if (provider === "openrouter") {
        const body = buildOpenRouterChatRequest(request);
        expect(body).not.toHaveProperty("parallel_tool_calls");
        expect(body).toMatchObject({ max_tokens: 65_536, temperature: 1,
          provider: { data_collection: "deny", require_parameters: true, allow_fallbacks: true } });
        expect(body.tools).toEqual(expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: "generate_image", strict: false }) }),
          expect.objectContaining({ function: expect.objectContaining({ name: "get_session_status", strict: true }) }),
          expect.objectContaining({ function: expect.objectContaining({ name: "find_tools", strict: false }) })
        ]));
      }
      if (providerRequests.length === 1) {
        return providerResult({
          finalText: "",
          toolCalls: goals.map((goal, index) => ({
            arguments: { goal },
            id: `find-call-${index}`,
            name: "find_tools"
          }))
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
      discovery.epochs.push({
        epoch: discovery.epochs.length + 1,
        goal: input.goal,
        modelRunToolCallId: input.modelRunToolCallId,
        roundIndex: input.roundIndex,
        toolIds: [namespacedName]
      });
      return { discovery, snapshot };
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
      mcp: { filterTools: allowMcpTools, materialize, prepare, router: { route } },
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
    const initialToolNames = applicationTools.length ? applicationTools.map((tool) => tool.name) : ["find_tools"];
    expect(providerRequests[0]?.tools?.map((tool) => tool.name)).toEqual(initialToolNames);
    expect(providerRequests[0]?.parallelToolCalls).toBe(false);
    expect(JSON.stringify(providerRequests[0]?.mcpDiscovery?.catalog)).not.toContain("inputSchema");
    expect(providerRequests[1]?.tools?.map((tool) => tool.name)).toEqual([
      ...initialToolNames,
      namespacedName
    ]);
    expect(providerRequests[1]?.parallelToolCalls).toBe(true);
    expect(providerRequests[1]?.tools?.find((tool) => tool.name === namespacedName)?.inputSchema)
      .toEqual(snapshot.tools[0]?.inputSchema);
    expect(materialize).toHaveBeenCalledWith("user-1", [{
      namespacedName,
      revisionId: "revision-jira",
      serverId: "server-jira"
    }], expect.any(AbortSignal));
    expect(route).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ goals, timeoutMs: 60_000 }));
    expect(appendMcpDiscoveryEpoch).toHaveBeenCalledTimes(goals.length);
    expect(discovery.epochs.map((epoch) => epoch.goal)).toEqual(goals);
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
      mcp: { filterTools: allowMcpTools, materialize, prepare: materialize, router: { route } },
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

  it.each(["unexpected", "reported", "cancelled", "output_limit", "request_rejected"] as const)(
    "settles Auto discovery %s with safe errors and reported usage", async (outcome) => {
    const discovery: McpDiscoveryState = {
      catalog: { servers: [{ namespace: "issues", revisionId: "revision-issues", serverId: "server-issues",
            serverName: "Issues", description: "Manage issues", tools: [{ namespacedName: "mcp_issues_create", originalName: "create", description: "Create an issue" }] }], version: 1 },
      epochs: [],
      version: 2
    };
    const rawFailure = "PRIVATE_SYSTEM_MODEL_ENDPOINT_FAILURE";
    const route = vi.fn(async () => {
      if (outcome === "unexpected") throw new Error(rawFailure);
      if (outcome === "cancelled") expect(activeRunControllerRegistry.abort("run-1")).toBe(true);
      throw new McpSemanticRouterError(
        outcome === "cancelled" ? "mcp_router_cancelled" : outcome === "output_limit" ? "mcp_router_output_limit"
          : outcome === "request_rejected" ? "mcp_router_gemini_invalid_request" : "mcp_router_request_failed",
        { modelId: "gpt-router", provider: "openai", usage: { inputTokens: 12, outputTokens: 3, reasoningTokens: 0 } }
      );
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
        return providerResult({
          finalText: "",
          toolCalls: [{
            arguments: { goal: "create an issue" },
            id: "provider-find-tools-failure",
            name: "find_tools"
          }]
        });
      }),
      mcp: { filterTools: allowMcpTools, materialize, prepare: materialize, router: { route } },
      prepared: preparedData({
        mcpDiscovery: discovery,
        ...(outcome === "output_limit" ? { toolBudgets: { mcpAutoDiscoveryMaxOutputTokens: 32768, maxMcpToolsPerDiscovery: 10, maxToolCalls: 20, maxToolRounds: 8 } } : {}),
        modelId: "gpt-tool-model",
        provider: "openai"
      }),
      repository: { ...repository.repository, appendMcpDiscoveryEpoch }
    })).text();

    if (outcome !== "cancelled") expect(repository.failedRuns).toEqual([expect.objectContaining({
      error: {
        ...mcpAutoDiscoveryFailure(outcome === "output_limit" ? "mcp_router_output_limit"
          : outcome === "request_rejected" ? "mcp_router_gemini_invalid_request" : "mcp_router_request_failed")
      }
    })]);
    expect(JSON.stringify(repository.failedRuns)).not.toContain(rawFailure);
    if (outcome === "request_rejected") expect(repository.failedRuns[0]?.options).toEqual({ recoveryTerminal: true });
    if (outcome !== "cancelled") expect([...repository.toolCalls.values()]).toEqual([
      expect.objectContaining({ state: "error", toolName: "find_tools" })
    ]);
    if (outcome !== "unexpected") {
      expect(repository.recordedRunUsageEvents.at(-1)?.usageAttributions.filter(
        (entry) => entry.modelId === "gpt-router"
      )).toEqual([expect.objectContaining({
        provider: "openai",
        usage: expect.objectContaining({ inputTokens: 12, outputTokens: 3, reasoningTokens: 0 })
      })]);
    }
    expect(route).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxOutputTokens: outcome === "output_limit" ? 32768 : null }));
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
        filterTools: allowMcpTools, materialize,
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
      error: mcpAutoDiscoveryFailure("mcp_materialization_mcp_not_ready")
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

    const route = vi.fn(async () => { throw new McpSemanticRouterError("mcp_router_gemini_invalid_request"); });

    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      memoryEgress: egress.service,
      mcp: { filterTools: allowMcpTools, prepare, router: { route } },
      mcpRuntime: {
        callTool,
        async ensureAcceptedGeneration(generationId) {
          return generationId === `generation-${fingerprint}`;
        }
      },
      prepared,
      repository: repository.repository
    })).text());

    expect(route).not.toHaveBeenCalled();
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
    expect(prepare).toHaveBeenCalledTimes(2);
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
      runtimeErrorCode: null, expectedErrorCode: null, revoked: false
    },
    {
      arguments: { value: "harmless-revocation-value" },
      label: "destination revocation",
      runtimeErrorCode: null, expectedErrorCode: "mcp_accepted_generation_changed", revoked: true
    },
    ...["mcp_health_check_failed", "mcp_timeout", "mcp_authorization_required", "mcp_server_unavailable"].map((code) => ({
      arguments: { value: "safe-runtime-fixture" }, label: `MCP ${code}`,
      runtimeErrorCode: code, expectedErrorCode: code === "mcp_server_unavailable" ? "memory_egress_destination_revoked" : code,
      revoked: true
    }))
  ])("uses admin trust for $label while retaining immediate destination drift checks", async ({
    arguments: toolArguments,
    revoked, runtimeErrorCode, expectedErrorCode
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
      if (runtimeErrorCode) return { ok: false, code: "mcp_not_ready", issues: [{
        errorCode: runtimeErrorCode, name: "Synthetic server", readiness: "unavailable"
      }] };
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
      mcp: { filterTools: allowMcpTools, prepare },
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
          errorCode: expectedErrorCode,
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
    expect(prepare).toHaveBeenCalledWith("user-1", { allowedServerIds: ["server-blocked"] });
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[1]).toMatchObject({ toolChoice: "auto" });
    expect(repository.completeRuns[0]?.finalText).toBe("Dispatch stayed blocked");
    expect([...repository.toolCalls.values()][0]).toMatchObject({
      state: revoked ? "error" : "complete"
    });
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it.each([false, true])("recalls a large MCP original through the public reader, with duplicate representation=%s", async duplicate => {
    const name = "mcp_synthetic_records";
    const mcp: McpRunPlanSnapshot = { version: 1,
      servers: [{ fingerprint: "a".repeat(64), revisionId: "synthetic-revision", serverId: "synthetic-server", serverName: "Records" }],
      tools: [{ definitionHash: "b".repeat(64), description: "Read records", inputSchema: { type: "object" },
        name: "records", namespacedName: name, originalName: "records", serverId: "synthetic-server", serverName: "Records" }] };
    const original = { padding: "x".repeat(320 * 1024), tail: { marker: "rare-tail", count: 271828 } };
    const callTool = vi.fn(async () => ({ isError: false, text: [JSON.stringify(original)],
      structuredContent: duplicate ? original : null, unsupportedContentTypes: [] }));
    const repository = createRepository();
    const observations = memoryToolObservations();
    const requests: ProviderRunRequest[] = [];
    const base = preparedData({ mcp, modelId: "synthetic-model", provider: "openai" });
    const prepared = { ...base, normalizedRequest: { ...base.normalizedRequest, toolObservationVersion: 1 as const },
      providerRequest: { ...base.providerRequest, toolObservationVersion: 1 as const } };
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      expect(request.tools?.some(tool => tool.name === "read_tool_result")).toBe(true);
      if (requests.length === 1) return providerResult({ finalText: "", toolCalls: [{ id: "original", name, arguments: {} }] });
      const transcript = JSON.stringify(request.providerToolMessages);
      expect(Buffer.byteLength(transcript)).toBeLessThan(40 * 1024);
      if (requests.length === 2) {
        expect(transcript).not.toContain("rare-tail");
        const handle = transcript.match(/tor1_[a-f0-9]{32}/u)?.[0];
        expect(handle).toBeDefined();
        return providerResult({ finalText: "", toolCalls: [{ id: "recall", name: "read_tool_result", arguments: { handle, query: "rare-tail" } }] });
      }
      expect(transcript).toContain("271828");
      return providerResult({ finalText: "271828" });
    });
    await createRunExecutionResponse({ ...executionInput({ adapter, prepared, repository: repository.repository,
      mcpRuntime: { callTool, ensureAcceptedGeneration: async () => true } }), observations: observations.service() }).text();
    expect(repository.failedRuns).toEqual([]);
    expect(repository.completeRuns[0]?.finalText).toBe("271828");
    expect(callTool).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(3);
    expect([...repository.toolCalls.values()].map(call => call.state)).toEqual(["complete", "complete"]);
    expect(Buffer.byteLength(JSON.stringify([...repository.toolCalls.values()]))).toBeLessThan(40 * 1024);
    expect(observations.rows.size).toBe(1);
    expect([...observations.rows.values()][0]).toMatchObject({ state: "READY", storageMode: "OBJECT", executionOutcome: "complete" });
  });

  it("keeps a newly accepted Off run on legacy tool execution without capture or reader registration", async () => {
    const name = "mcp_synthetic_records_off";
    const mcp: McpRunPlanSnapshot = { version: 1,
      servers: [{ fingerprint: "a".repeat(64), revisionId: "synthetic-revision", serverId: "synthetic-server", serverName: "Records" }],
      tools: [{ definitionHash: "b".repeat(64), description: "Read records", inputSchema: { type: "object" },
        name: "records", namespacedName: name, originalName: "records", serverId: "synthetic-server", serverName: "Records" }] };
    const repository = createRepository();
    const observations = memoryToolObservations();
    const requests: ProviderRunRequest[] = [];
    const base = preparedData({ mcp, modelId: "synthetic-model", provider: "openai" });
    const prepared = { ...base, normalizedRequest: { ...base.normalizedRequest, toolObservationVersion: 0 as const },
      providerRequest: { ...base.providerRequest, toolObservationVersion: 0 as const } };
    const callTool = vi.fn(async () => ({ isError: false, structuredContent: null, text: ["legacy-result"], unsupportedContentTypes: [] }));
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      expect(request.tools?.some(tool => tool.name === "read_tool_result")).toBe(false);
      return requests.length === 1
        ? providerResult({ finalText: "", toolCalls: [{ id: "original", name, arguments: {} }] })
        : providerResult({ finalText: "legacy-result" });
    });
    await createRunExecutionResponse({ ...executionInput({ adapter, prepared, repository: repository.repository,
      mcpRuntime: { callTool, ensureAcceptedGeneration: async () => true } }), observations: observations.service() }).text();
    expect(callTool).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(observations.rows.size).toBe(0);
    expect(repository.completeRuns[0]?.finalText).toBe("legacy-result");
  });

  it("publishes the reached budget and terminalizes a forbidden synthesis without losing text or work", async () => {
    const name = "mcp_synthetic_search";
    const mcp: McpRunPlanSnapshot = {
      version: 1,
      servers: [{ fingerprint: "synthetic-fingerprint", revisionId: "synthetic-revision", serverId: "synthetic-server", serverName: "Repository Tools" }],
      tools: [{ definitionHash: "a".repeat(64), description: "Search records", inputSchema: { type: "object" },
        name: "search", namespacedName: name, originalName: "search", serverId: "synthetic-server", serverName: "Repository Tools" }]
    };
    const repository = createRepository();
    const requests: ProviderRunRequest[] = [];
    const adapter = createAdapter(async function* (request) {
      requests.push(request);
      return providerResult({
        finalText: requests.length === 1 ? "" : "Available partial answer",
        providerResponseId: `synthetic-response-${requests.length}`,
        toolCalls: [{ arguments: {}, id: `synthetic-call-${requests.length}`, name }],
        usage: usage(2, 1, 0)
      });
    });
    const callTool = vi.fn(async () => ({ isError: false, structuredContent: null, text: ["[]"], unsupportedContentTypes: [] }));
    const events = parseSse(await createRunExecutionResponse(executionInput({
      adapter,
      mcpRuntime: { callTool, ensureAcceptedGeneration: async () => true },
      prepared: preparedData({ mcp, modelId: "synthetic-model", provider: "openai", toolBudgets: { maxToolCalls: 1, maxToolRounds: 8 } }),
      repository: repository.repository
    })).text());

    expect(requests.map((request) => request.toolChoice)).toEqual(["auto", "none"]);
    expect(callTool).toHaveBeenCalledOnce();
    expect([...repository.toolCalls.values()]).toEqual([expect.objectContaining({ state: "complete" })]);
    expect(repository.assistantTexts.at(-1)).toBe("Available partial answer");
    expect(repository.completeRuns).toEqual([]);
    expect(repository.failedRuns).toEqual([expect.objectContaining({ error: TOOL_SYNTHESIS_FAILURE, options: { recoveryTerminal: true } })]);
    expect(events).toContainEqual(expect.objectContaining({ type: "artifact", data: {
      artifactType: "tool_budget", payload: { kind: "calls", limit: 1 }
    } }));
    expect(events).toContainEqual(expect.objectContaining({ type: "error", data: TOOL_SYNTHESIS_FAILURE }));
    expect(repository.recordedRunUsageEvents.filter((entry) => entry.answerRoundUsage?.roundIndex === 2 &&
      entry.answerRoundUsage.completeness === "terminal")).toHaveLength(1);
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
          origin: "mcp",
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

  it("persists partial Search usage when Stop interrupts its provider call", async () => {
    const repository = createRepository();
    let answerRounds = 0;
    const adapter = createAdapter(async function* () {
      answerRounds += 1;
      return providerResult({
        finalText: "",
        toolCalls: [{ arguments: { query: "current sources" }, id: "tool-call-1", name: "search_engine_1" }],
        usage: usage(2, 1, 0)
      });
    });
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search() {
        expect(activeRunControllerRegistry.abort("run-1")).toBe(true);
        throw new ProviderSearchExecutionError({ artifacts: [], code: "search_interrupted", usage: { inputTokens: 7 } });
      }
    };
    const prepared = preparedData({
      modelId: "openai-answer-model", provider: "openai", searchPlan: perplexityClientSearchPlan()
    });
    await createRunExecutionResponse(executionInput({
      adapter, prepared, repository: repository.repository, searchAdapter
    })).text();
    expect(answerRounds).toBe(1);
    expect(repository.completeRuns).toEqual([]);
    expect([...repository.toolCalls.values()]).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({
          rawPreview: expect.objectContaining({
            searchExecutions: [expect.objectContaining({ failure: { code: "search_cancelled" } })]
          })
        }),
        state: "error",
        usageAccountedAt: expect.any(String)
      })
    ]);
    expect(repository.recordedRunUsageEvents.at(-1)?.usageAttributions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: "perplexity/sonar-pro-search", provider: "openrouter", operationCount: 1,
        usage: expect.objectContaining({ inputTokens: 7, outputTokens: null, totalTokens: null, completeness: "partial" })
      })
    ]));
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
        message: "Provider round 2 failed."
      },
      type: "error"
    });
    expect(repository.completeRuns).toEqual([]);
    expect(repository.recordedRunUsageEvents).toHaveLength(4);
    expect(repository.recordedRunUsageEvents[0]?.answerRoundUsage).toEqual({
      completeness: "terminal",
      roundIndex: 1,
      usage: {
        completeness: "complete", cachedInputTokens: null,
        cacheWriteInputTokens: null,
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
        completeness: "partial", cachedInputTokens: null,
        cacheWriteInputTokens: null,
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
        operationCount: 2,
        modelId: "openai-answer-model",
        provider: "openai",
        usage: {
          completeness: "partial", cachedInputTokens: null,
          cacheWriteInputTokens: null,
          inputTokens: 6,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 8
        }
      },
      {
        estimatedCostMicros: null,
        operationCount: 1,
        modelId: "perplexity/sonar-pro-search",
        provider: "openrouter",
        usage: {
          completeness: "complete", cachedInputTokens: null,
          cacheWriteInputTokens: null,
          inputTokens: 3,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 5
        }
      }
    ]);
  });
});

describe("run execution diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])("reports completion only when guarded persistence applies (%s)", async (completionWins) => {
    const observation = captureRunObservation();
    const repository = createRepository({ completionWins });
    const traceId = "1".repeat(32);
    const response = runWithContext({ trace_id: traceId }, () => createRunExecutionResponse(executionInput({
      adapter: createAdapter(async function* () {
        yield { type: "token", data: { delta: "PRIVATE_ANSWER_CANARY" } };
        return providerResult({ finalText: "PRIVATE_ANSWER_CANARY" });
      }),
      repository: repository.repository
    })));
    await response.text();
    const records = observation.records();
    expect(records.filter((entry) => entry.event === "run_persistence")).toMatchObject([{
      trace_id: traceId, run_id: "run-1", stage: "complete", outcome: completionWins ? "confirmed" : "not_applied"
    }]);
    expect(records.filter((entry) => entry.event === "run_execution" && entry.outcome === "completed")).toHaveLength(completionWins ? 1 : 0);
    expect(records.every((entry) => entry.trace_id === traceId && entry.run_id === "run-1")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_ANSWER_CANARY");
    expect(records.length).toBeLessThanOrEqual(3);
  });

  it.each(["grounding", "pricing", "write"] as const)("reports a completion write failure only after completeRun is attempted (%s)", async (stage) => {
    const observation = captureRunObservation();
    const error = stage === "grounding" ? new Error("PRIVATE_GROUNDING_CANARY")
      : new Prisma.PrismaClientInitializationError("PRIVATE_DATABASE_CANARY", "test", "P1001");
    const repository = createRepository(stage === "grounding" ? { groundingError: error } : {});
    const database = createPrismaRunRepository({
      providerModel: { findMany: vi.fn().mockRejectedValueOnce(error).mockResolvedValue([]) },
      $transaction: vi.fn().mockRejectedValue(error)
    } as unknown as PrismaClient);
    if (stage === "pricing") repository.repository.loadModelPricing = database.loadModelPricing;
    if (stage === "write") repository.repository.completeRun = database.completeRun;
    const completeRun = vi.spyOn(repository.repository, "completeRun");
    const originalFailRun: RunRepository["failRun"] = repository.repository.failRun;
    repository.repository.failRun = vi.fn<RunRepository["failRun"]>(async (...args) => {
      expect(observation.records()).toContainEqual(expect.objectContaining({
        event: "run_execution", stage: "completion", outcome: "failed", prisma_code: stage === "grounding" ? "unknown" : "P1001"
      }));
      return originalFailRun(...args);
    });
    const adapter = createAdapter(async function* () {
      yield { type: "usage", data: usage() };
      return providerResult({ finalText: "PRIVATE_ANSWER_CANARY" });
    });
    const events = parseSse(await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text());
    expect(completeRun).toHaveBeenCalledTimes(stage === "write" ? 1 : 0);
    expect(repository.failedRuns).toHaveLength(1);
    const completionRecords = observation.records().filter((entry) => entry.event === "run_persistence" && entry.stage === "complete");
    expect(completionRecords).toHaveLength(stage === "write" ? 1 : 0);
    if (stage === "write") expect(completionRecords[0]).toMatchObject({ outcome: "unconfirmed", prisma_code: "P1001" });
    expect(observation.records()).not.toContainEqual(expect.objectContaining({ event: "run_execution", outcome: "completed" }));
    expect(events.some((entry) => entry.type === "done")).toBe(false);
    expect(JSON.stringify(observation.records())).not.toContain("PRIVATE_");
  });

  it("keeps the original provider failure when failRun also fails and never reports a confirmed terminal", async () => {
    const observation = captureRunObservation();
    const repository = createRepository();
    const databaseError = new Error("PRIVATE_SQL_VALUES_CANARY");
    rememberDatabaseFailure(databaseError, "P1001");
    repository.repository.failRun = vi.fn(async () => {
      expect(observation.records()).toContainEqual(expect.objectContaining({
        event: "run_execution", outcome: "failed", reason: "deadline", timeout_ms: 37
      }));
      throw databaseError;
    });
    const adapter = createAdapter(async function* () {
      const timeout = new ProviderRequestTimeoutError(37);
      timeout.message = "PRIVATE_PROVIDER_BODY_CANARY";
      yield { type: "usage", data: usage() };
      throw timeout;
    });
    const events = parseSse(await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text());
    const records = observation.records();
    expect(records.filter((entry) => entry.event === "run_persistence")).toMatchObject([{
      stage: "fail", outcome: "unconfirmed", prisma_code: "P1001"
    }]);
    expect(records.some((entry) => entry.outcome === "completed" || entry.outcome === "confirmed")).toBe(false);
    expect(events.some((entry) => entry.type === "done")).toBe(false);
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_SQL_VALUES_CANARY|PRIVATE_PROVIDER_BODY_CANARY/);
  });

  it("correlates a separate Stop trace while cancellation handling retains the original run trace", async () => {
    const observation = captureRunObservation();
    const waiting = deferred<void>();
    const repository = createRepository();
    const adapter = createAdapter(async function* (_request, options) {
      const signal = options!.signal!;
      waiting.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      yield { type: "token", data: { delta: "unreachable" } };
      return providerResult();
    });
    const response = runWithContext({ trace_id: "2".repeat(32) }, () => createRunExecutionResponse(executionInput({
      adapter, repository: repository.repository
    })));
    await waiting.promise;
    runWithContext({ trace_id: "3".repeat(32) }, () => activeRunControllerRegistry.abort("run-1"));
    await response.text();
    expect(observation.records()).toContainEqual(expect.objectContaining({
      event: "run_abort_delivery", trace_id: "3".repeat(32), run_id: "run-1", outcome: "delivered"
    }));
    expect(observation.records()).toContainEqual(expect.objectContaining({
      event: "run_execution", trace_id: "2".repeat(32), run_id: "run-1", outcome: "cancelled", abort_source: "stop"
    }));
    expect(repository.failedRuns).toHaveLength(0);
    expect(repository.completeRuns).toHaveLength(0);
  });
});

it.each(["completeRun", "updateRunProviderResponseId"] as const)("keeps successful provider usage and classifies local %s failure without replay", async method => {
  const repository = createRepository();
  const dispatch = vi.fn();
  vi.spyOn(repository.repository, method).mockRejectedValueOnce(new Error("PRIVATE Authorization Bearer signed-url"));
  const adapter = createAdapter(async function* () {
    dispatch();
    if (method === "updateRunProviderResponseId") {
      yield { type: "usage", data: usage() };
      yield { data: { artifactType: "summary", payload: { responseId: "response-1" } }, type: "artifact" };
    }
    return providerResult();
  });
  const events = parseSse(await createRunExecutionResponse(executionInput({ adapter, repository: repository.repository })).text());
  expect(dispatch).toHaveBeenCalledOnce();
  expect(repository.failedRuns).toHaveLength(1);
  expect(repository.failedRuns[0]?.error).toMatchObject({ code: method === "completeRun"
    ? "run_completion_persistence_failed" : "run_result_publication_failed" });
  expect(JSON.stringify(events)).not.toContain("PRIVATE");
  expect(repository.recordedRunUsageEvents[0]?.usageAttributions[0]?.usage).toMatchObject({ inputTokens: usage().inputTokens, outputTokens: usage().outputTokens });
});

it("retains final-only provider usage if completing the local egress receipt throws", async () => {
  const repository = createRepository();
  const egress = createMemoryEgressRecorder();
  vi.spyOn(egress.service, "completeDispatch").mockRejectedValueOnce(new Error("PRIVATE receipt database"));
  const dispatch = vi.fn();
  const adapter = createAdapter(async function* () { dispatch(); return providerResult(); });
  const base = preparedData();
  const personalContext = { approxTokens: 1, itemCount: 1, memoryGeneration: 1, memoryRevision: 1, mode: "prefetched" as const, text: `${PERSONAL_CONTEXT_HEADING}\nSynthetic context` };
  const prepared = { ...base, normalizedRequest: { ...base.normalizedRequest, personalContext }, providerRequest: { ...base.providerRequest, personalContext } };
  const events = parseSse(await createRunExecutionResponse(executionInput({ adapter, prepared, repository: repository.repository, memoryEgress: egress.service })).text());
  expect(dispatch).toHaveBeenCalledOnce();
  expect(repository.failedRuns[0]?.error).toMatchObject({ code: "run_completion_persistence_failed" });
  expect(repository.recordedRunUsageEvents[0]?.usageAttributions[0]?.usage).toMatchObject({ inputTokens: usage().inputTokens, outputTokens: usage().outputTokens });
  expect(JSON.stringify(events)).not.toContain("PRIVATE");
  expect(egress.completed).toEqual([]);
  expect(egress.failed).toHaveLength(1);
});
