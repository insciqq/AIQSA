const allowMcpTools: import("../mcp/toolAccess").McpToolAccessFilter = async (_userId, tools) => [...tools];
import { buildOpenAICompatibleChatRequest } from "../providers/openaiCompatibleChatRequest";
import { WORKSPACE_BROWSER_GUIDANCE } from "../workspace/browserGuidance";
import { WORKSPACE_PSD_GUIDANCE } from "../workspace/psdGuidance";
import { buildOpenAIResponsesRequest } from "../providers/openaiResponsesRequest";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_KNOWLEDGE_SELECTION, type KnowledgeSelection } from "../../contracts/knowledge";
import { textMessageContent } from "../../domain/content";
import { resolveStandardChatBaseline } from "../../domain/promptTemplates";
import { createInstructionPreviewHandlers } from "../instructions/previewHandlers";
import type { ResolvedEntitlements } from "../auth/entitlements";
import type { McpRunPlanResult } from "../mcp/runPlan";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../knowledge/knowledgeBudget";
import type { KnowledgeRunAdmissionPlan } from "../knowledge/runAdmission";
import type { KnowledgeFullContextPassage } from "../knowledge/fullContext";
import {
  ProviderAdmissionError,
  type ProviderAdmissionPlan
} from "../providerRuntime/admission";
import { MEMORY_ACTION_NO_COMMIT_RESULT } from "../providers/memoryActionAnswer";
import type { ProviderAdapter, ProviderConversationMessage, ProviderModelCapabilities } from "../providers/types";
import type { ProjectRunAdmission, RunAttachmentRecord } from "./runRepositoryContract";
import type { RunAttachmentLimits } from "./attachmentLimits";
import { materializePreparedRunData, prepareRun, type PreparedRun, type RegenerateRunPreparationSource, type RunPreparationDeps, type RunPreparationInput, type RunPreparationResult, type SendRunPreparationSource } from "./runPreparation";
import { DEFAULT_AGENT_POLICY } from "@/lib/contracts/agentPolicy";
import { SkillCatalogAuthorityChangedError } from "../skills/catalogRelevanceService";
import { decodeFrozenSkillManifest } from "../skills/runManifest";
import { syntheticImagePlan } from "@/tests/support/imagePlan";
import { conversationMessagesFromPathRows } from "./prismaRepository";
import type { AcceptedVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import { renderCodexManagedProfile } from "../agents/codexProfile";
import { agentPrompts } from "../agents/prompt";
import { DEFAULT_TOOL_RUN_BUDGETS } from "./toolBudgets";
import { hashCanonicalMcpValue } from "../mcp/definitions";

// Passthrough spy: the Agent compatibility identity input is otherwise private.
vi.mock("../mcp/definitions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/definitions")>();
  return { ...actual, hashCanonicalMcpValue: vi.fn(actual.hashCanonicalMcpValue) };
});

const baseCapabilities: ProviderModelCapabilities = {
  contextWindow: 32_768,
  defaultMaxOutputTokens: 512,
  nativePdfInput: false,
  nativeSearch: true,
  pdf: true,
  reasoning: true,
  streaming: true,
  vision: true
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const priorMessage: ProviderConversationMessage = {
  content: textMessageContent("Server-owned prior question"),
  id: "prior-user-message",
  role: "user"
};

const storedUserMessage: ProviderConversationMessage = {
  content: textMessageContent("Shared question"),
  id: "stored-user-message",
  role: "user"
};

function knowledgeSelection(baseIds: readonly string[] = []): KnowledgeSelection {
  return baseIds.length > 0
    ? { baseIds: [...baseIds], mode: "explicit", sourceIds: [], version: 1 }
    : { baseIds: [], mode: "none", sourceIds: [], version: 1 };
}

type KnowledgeAdmissionInput = Parameters<
  NonNullable<RunPreparationDeps["knowledgeAdmission"]>["load"]
>[0];

function admittedKnowledge(
  input: KnowledgeAdmissionInput,
  fingerprintCharacter: string,
  bindings?: KnowledgeRunAdmissionPlan["bindings"]
) {
  const admittedBindings = bindings ?? (input.knowledgePlan.mode === "none"
    ? []
    : [{
        approxTokens: 1_200,
        baseContentRevision: 1,
        embeddingCredentialSource: "default" as const,
        embeddingExecutionSnapshot: {} as never,
        embeddingProviderModelId: "embedding-model-1",
        includeWholeBase: true,
        indexedContentRevision: 1,
        indexGenerationId: "generation-1",
        knowledgeBaseId: input.knowledgePlan.baseIds[0] ?? "knowledge-base-1",
        ordinal: 0,
        passageCount: 6,
        readySourceCount: 1,
        selectedSourceIds: [],
        sourceCount: 1,
        targetDimension: 1024 as const,
        vectorSpaceFingerprint: "a".repeat(64)
      }]);
  return {
    bindings: admittedBindings,
    budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
    exclusions: [],
    fingerprint: fingerprintCharacter.repeat(64),
    knowledgePlan: input.knowledgePlan,
    resolvedSourceCount: 0,
    ...(input.executionScope ? { executionScope: input.executionScope } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    userId: input.userId
  };
}

function defaultEntitlements(): ResolvedEntitlements {
  return {
    modelKeys: new Set(),
    providerKeys: new Set(["fake", "openai", "openrouter"]),
    searchStrategies: new Set([
      "openai-native-web-search",
      "perplexity-tool-search",
      "unknown-search"
    ])
  };
}

function emptyEntitlements(): ResolvedEntitlements {
  return {
    modelKeys: new Set(),
    providerKeys: new Set(),
    searchStrategies: new Set()
  };
}

function readyMcpPlan(
  credentialSources?: readonly ("oauth" | "personal" | "shared")[]
): McpRunPlanResult {
  return {
    bindings: [{
      fingerprint: "fingerprint-1",
      runtimeGenerationId: "generation-1",
      serverId: "server-1"
    }],
    ok: true,
    snapshot: {
      servers: [{
        ...(credentialSources ? { credentialSources: [...credentialSources] } : {}),
        fingerprint: "fingerprint-1",
        revisionId: "revision-1",
        serverId: "server-1",
        serverName: "Team tools"
      }],
      tools: [{
        definitionHash: "a".repeat(64),
        description: "Look up team data",
        inputSchema: { type: "object" },
        name: "lookup",
        namespacedName: "mcp_team_lookup_1",
        originalName: "lookup",
        serverId: "server-1",
        serverName: "Team tools"
      }],
      version: 1
    }
  };
}

function compatibleAdmissionPlan(
  adapterKind: "openai_chat_completions_compatible" | "openai_responses_compatible",
  options: Readonly<{
    nativeSearch?: boolean;
  }> = {}
): ProviderAdmissionPlan {
  const capabilities: ProviderModelCapabilities = {
    ...baseCapabilities,
    nativeSearch: options.nativeSearch ?? false,
    toolCalling: true
  };
  const defaultParams = {
    background: false,
    manualContextReplay: true,
    maxOutputTokens: 512,
    store: false,
    stream: false,
    temperature: 1
  };
  return {
    answer: {
      credentialSource: "default",
      modelConfiguration: { adapterKind, capabilities, defaultParams },
      snapshot: {
        connection: {
          allowPrivateNetwork: false,
          apiRoot: "https://compatible.example.test/v1",
          authenticationMode: "bearer",
          responseTimeoutMs: 300_000
        },
        connectionDisplayName: "Compatible endpoint",
        connectionId: "connection-compatible",
        credentialId: "credential-compatible",
        credentialVersionId: "credential-version-compatible",
        model: {
          adapterKind,
          answerSelectable: true,
          capabilities,
          defaultParams,
          modelClass: "answer",
          upstreamModelId: "vendor/model"
        },
        modelDisplayName: "Vendor model",
        providerFamily: "openai_compatible",
        providerModelId: "deployment-compatible",
        version: 1
      }
    },
    fingerprint: "a".repeat(64),
    requestedSearchPlan: { mode: "all_selected", optionIds: [] },
    searches: [],
    selection: {
      providerConnectionId: "connection-compatible",
      providerModelId: "deployment-compatible"
    },
    userId: "user-1"
  };
}

function providerNeutralOpenAISearchPlan(
  adapterKind: "anthropic_messages" | "gemini_interactions_native",
  options: Readonly<{
    optionId?: string;
    source?: "custom" | "official";
  }> = {}
): ProviderAdmissionPlan {
  const providerFamily = adapterKind === "anthropic_messages" ? "anthropic" : "gemini";
  const providerConnectionId = `connection-${providerFamily}`;
  const providerModelId = `deployment-${providerFamily}`;
  const modelId = adapterKind === "anthropic_messages"
    ? "claude-opus-5"
    : "gemini-3.6-flash";
  const capabilities: ProviderModelCapabilities = {
    ...baseCapabilities,
    nativeSearch: false,
    toolCalling: true
  };
  const technicalCapabilities: ProviderModelCapabilities = {
    ...baseCapabilities,
    nativeSearch: true,
    toolCalling: true
  };
  const customSource = options.source === "custom";
  const sourceConnectionId = customSource
    ? "connection-custom-search"
    : "connection-openai-search";
  const sourceProviderModelId = customSource
    ? "technical-custom-search"
    : "technical-openai-search";
  const sourceUpstreamModelId = customSource ? "vendor/search" : "gpt-5.6-search";
  const technicalRole: ProviderAdmissionPlan["answer"] = {
    credentialSource: "default",
    modelConfiguration: {
      adapterKind: customSource ? "openai_responses_compatible" : "openai_responses_native",
      capabilities: technicalCapabilities,
      defaultParams: {}
    },
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: customSource
          ? "https://custom-search.example.test/v1"
          : "https://api.openai.com/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      connectionDisplayName: customSource ? "Custom Search" : "OpenAI",
      connectionId: sourceConnectionId,
      credentialId: customSource ? "credential-custom-search" : "credential-openai-search",
      credentialVersionId: customSource
        ? "credential-version-custom-search"
        : "credential-version-openai-search",
      model: {
        adapterKind: customSource ? "openai_responses_compatible" : "openai_responses_native",
        answerSelectable: false,
        capabilities: technicalCapabilities,
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: sourceUpstreamModelId
      },
      modelDisplayName: customSource ? "Custom Search model" : "OpenAI Search model",
      providerFamily: customSource ? "openai_compatible" : "openai",
      providerModelId: sourceProviderModelId,
      version: 1
    }
  };
  const optionId = options.optionId ?? "openai-native-web-search";
  return {
    answer: {
      credentialSource: "default",
      modelConfiguration: { adapterKind, capabilities, defaultParams: {} },
      snapshot: {
        connection: {
          allowPrivateNetwork: false,
          apiRoot: adapterKind === "anthropic_messages"
            ? "https://api.anthropic.com/v1"
            : "https://generativelanguage.googleapis.com/v1beta",
          authenticationMode: "bearer",
          responseTimeoutMs: 300_000
        },
        connectionDisplayName: providerFamily === "anthropic" ? "Anthropic" : "Gemini",
        connectionId: providerConnectionId,
        credentialId: `credential-${providerFamily}`,
        credentialVersionId: `credential-version-${providerFamily}`,
        model: {
          adapterKind,
          answerSelectable: true,
          capabilities,
          defaultParams: {},
          modelClass: "answer",
          upstreamModelId: modelId
        },
        modelDisplayName: modelId,
        providerFamily,
        providerModelId,
        version: 1
      }
    },
    fingerprint: "b".repeat(64),
    requestedSearchPlan: { mode: "model_choice", optionIds: [optionId] },
    searches: [{
      bindingKey: `search:${optionId}`,
      configuration: {
        adapterKind: "provider_model_client",
        config: {
          maxResults: 8,
          modelCapabilities: technicalCapabilities,
          modelDefaultParams: {},
          queryMaxCharacters: 500,
          timeoutMs: 300_000
        },
        credentialMode: "provider_model",
        displayName: customSource ? "Custom Search" : "OpenAI Search",
        executionModes: ["all_selected", "model_choice"],
        kind: "provider_model_web_search",
        modelId: sourceUpstreamModelId,
        protocol: "openai_responses_web_search",
        provider: customSource ? "openai_compatible" : "openai",
        providerModelId: sourceProviderModelId,
        revisionId: customSource ? "revision-custom-search" : "revision-openai-search",
        searchStrategyRowId: customSource
          ? "integration-custom-search"
          : "integration-openai-search",
        strategyId: optionId
      },
      integrationId: customSource ? "integration-custom-search" : "integration-openai-search",
      optionId,
      ordinal: 0,
      revisionId: customSource ? "revision-custom-search" : "revision-openai-search",
      role: technicalRole
    }],
    selection: { providerConnectionId, providerModelId },
    userId: "user-1"
  };
}

function nativeSearchCoexistencePlans(
  adapterKind: "anthropic_messages" | "gemini_interactions_native"
): Readonly<{
  client: ProviderAdmissionPlan;
  hosted: ProviderAdmissionPlan;
  optionId: string;
}> {
  const base = providerNeutralOpenAISearchPlan(adapterKind);
  const anthropic = adapterKind === "anthropic_messages";
  const optionId = anthropic ? "anthropic-web-search" : "gemini-google-search";
  const provider = anthropic ? "anthropic" : "gemini";
  const protocol = anthropic ? "anthropic_web_search" : "gemini_google_search";
  const kind = anthropic ? "web_search" : "gemini_google_search";
  const displayName = anthropic ? "Anthropic Search" : "Google Search";
  const modelId = anthropic ? "claude-opus-5" : "gemini-3.6-flash";
  const requestedSearchPlan = { mode: "model_choice" as const, optionIds: [optionId] };
  const hosted: ProviderAdmissionPlan = {
    ...base,
    requestedSearchPlan,
    searches: [{
      bindingKey: null,
      configuration: {
        adapterKind: "answer_provider_hosted",
        config: { maxResults: 8, queryMaxCharacters: 500, timeoutMs: 300_000 },
        credentialMode: "answer_provider",
        displayName,
        executionModes: ["model_choice"],
        kind,
        modelId: null,
        protocol,
        provider,
        providerModelId: null,
        revisionId: `revision-${provider}-hosted`,
        searchStrategyRowId: `integration-${provider}-hosted`,
        strategyId: optionId
      },
      integrationId: `integration-${provider}-hosted`,
      optionId,
      ordinal: 0,
      revisionId: `revision-${provider}-hosted`
    }]
  };
  const client: ProviderAdmissionPlan = {
    ...base,
    requiresClientToolCoexistence: true,
    requestedSearchPlan,
    searches: [{
      bindingKey: `search:${optionId}`,
      configuration: {
        adapterKind: "provider_model_client",
        config: {
          maxOutputTokens: 4_096,
          maxResults: 8,
          maxSearchCallsPerAnswer: 2,
          modelCapabilities: { ...baseCapabilities, nativeSearch: true },
          modelDefaultParams: {},
          queryMaxCharacters: 500,
          reasoningPolicy: "lowest_supported",
          timeoutMs: 300_000
        },
        credentialMode: "provider_model",
        displayName,
        executionModes: ["all_selected", "model_choice"],
        kind,
        modelId,
        protocol,
        provider,
        providerModelId: base.selection.providerModelId,
        revisionId: `revision-${provider}-client`,
        searchStrategyRowId: `integration-${provider}-client`,
        strategyId: optionId
      },
      integrationId: `integration-${provider}-client`,
      optionId,
      ordinal: 0,
      revisionId: `revision-${provider}-client`,
      role: base.answer
    }]
  };

  return { client, hosted, optionId };
}

function runAttachment(input: {
  byteSize?: number;
  checksum?: string | null;
  extractedText?: string | null;
  id: string;
  kind: "document" | "file" | "image" | "pdf";
  metadata?: unknown;
  mimeType: string;
  storageKey: string;
}): RunAttachmentRecord {
  return {
    byteSize: input.byteSize ?? 32,
    checksum: input.checksum ?? null,
    extractedText:
      input.extractedText === undefined
        ? input.kind === "pdf"
          ? "Extracted PDF fallback"
          : null
        : input.extractedText,
    fileName: `${input.id}.${input.kind === "pdf" ? "pdf" : input.kind === "image" ? "png" : input.kind === "file" ? "opaque" : "txt"}`,
    id: input.id,
    kind: input.kind,
    metadata: input.metadata ?? {},
    mimeType: input.mimeType,
    processingErrorCode: null,
    status: "ready",
    storageKey: input.storageKey
  };
}

type HarnessOptions = Readonly<{
  attachmentLimits?: RunAttachmentLimits;
  attachments?: readonly RunAttachmentRecord[];
  capabilities?: ProviderModelCapabilities | null;
  defaultParams?: Readonly<Record<string, unknown>>;
  entitlements?: ResolvedEntitlements;
  fullContextPassages?: readonly KnowledgeFullContextPassage[] | null;
  mcpPlan?: McpRunPlanResult;
  providerIds?: readonly string[];
  regenerateContext?: readonly ProviderConversationMessage[];
  sendContext?: readonly ProviderConversationMessage[];
  storageObjects?: Readonly<Record<string, Readonly<{ body: Buffer; contentType: string }>>>;
}>;

function createHarness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const attachmentLoads: { attachmentIds: string[]; userId: string }[] = [];
  const capabilityLoads: { modelId: string; provider: string }[] = [];
  const entitlementLoads: string[] = [];
  const regenerateContextLoads: { chatId: string; leafMessageId: string; userId: string }[] = [];
  const sendContextLoads: { chatId: string; userId: string }[] = [];
  const storageReads: string[] = [];
  const mcpPrepareCalls: Array<{
    allowedServerIds?: readonly string[];
    userId: string;
  }> = [];
  const attachments = options.attachments ?? [];
  const capabilities = Object.prototype.hasOwnProperty.call(options, "capabilities")
    ? (options.capabilities ?? null)
    : baseCapabilities;
  const adapter: ProviderAdapter = {
    buildRequestPreview(request) {
      return {
        attachments: request.attachments.map((attachment) => ({
          fileName: attachment.fileName,
          id: attachment.id,
          kind: attachment.kind
        })),
        modelId: request.modelId,
        provider: request.provider
      };
    },
    async *stream() {
      return {
        finalProviderResponsePreview: {},
        finalText: "unused",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0
        }
      };
    }
  };
  const providerIds = options.providerIds ?? ["fake", "openai", "openrouter"];
  const providers = Object.fromEntries(providerIds.map((provider) => [provider, adapter]));
  const repository: RunPreparationDeps["repository"] = {
    async loadAttachments(userId, attachmentIds) {
      calls.push("attachments");
      attachmentLoads.push({ attachmentIds: [...attachmentIds], userId });
      const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));

      return attachmentIds.flatMap((attachmentId) => {
        const attachment = byId.get(attachmentId);
        return attachment ? [attachment] : [];
      });
    },
    async loadConversationContextForExpectedLeaf(chatId, userId, expectedActiveLeafMessageId) {
      calls.push("context:send");
      sendContextLoads.push({ chatId, userId });
      return expectedActiveLeafMessageId === "prior-user-message" || expectedActiveLeafMessageId === null
        ? [...(options.sendContext ?? [priorMessage])]
        : null;
    },
    async loadConversationContextForLeaf(chatId, userId, leafMessageId) {
      calls.push("context:regenerate");
      regenerateContextLoads.push({ chatId, leafMessageId, userId });
      return [...(options.regenerateContext ?? [priorMessage, storedUserMessage])];
    },
    ...(Object.hasOwn(options, "fullContextPassages")
      ? {
          async loadKnowledgeFullContextPassages() {
            calls.push("knowledge:full-context");
            return options.fullContextPassages ?? null;
          }
        }
      : {})
  };
  const storage = options.storageObjects
    ? {
        async getObject(storageKey: string, readOptions?: { maxBytes?: number; signal?: AbortSignal }) {
          calls.push(`storage:${storageKey}`);
          storageReads.push(storageKey);
          if (readOptions?.signal?.aborted) {
            throw readOptions.signal.reason;
          }
          const object = options.storageObjects?.[storageKey];
          if (!object) {
            throw new Error("stored_object_not_found");
          }
          if (readOptions?.maxBytes !== undefined && object.body.length > readOptions.maxBytes) {
            throw new Error("test_storage_read_exceeded_bound");
          }

          return {
            body: object.body,
            contentType: object.contentType,
            storageKey
          };
        }
      }
    : undefined;
  const deps: RunPreparationDeps = {
    allowFakeProvider: true,
    ...(options.attachmentLimits
      ? { getAttachmentLimits: () => options.attachmentLimits! }
      : {}),
    ...(options.mcpPlan ? {
      mcp: {
        filterTools: allowMcpTools, async prepare(userId, prepareOptions) {
          mcpPrepareCalls.push({
            ...(prepareOptions?.allowedServerIds
              ? { allowedServerIds: [...prepareOptions.allowedServerIds] }
              : {}),
            userId
          });
          return options.mcpPlan!;
        }
      }
    } : {}),
    providerAdmission: {
      async load(input) {
        if (!providerIds.includes(input.providerConnectionId)) {
          throw new ProviderAdmissionError("model_not_available");
        }
        calls.push("entitlements");
        entitlementLoads.push(input.userId);
        const entitlements = options.entitlements ?? defaultEntitlements();
        if (
          !entitlements.providerKeys.has(input.providerConnectionId) &&
          !entitlements.modelKeys.has(`${input.providerConnectionId}:${input.providerModelId}`)
        ) {
          throw new ProviderAdmissionError("model_not_available");
        }
        if (input.searchPlan.optionIds.some((optionId) =>
          !entitlements.searchStrategies.has(optionId))) {
          throw new ProviderAdmissionError("search_strategy_not_available");
        }
        calls.push("capabilities");
        capabilityLoads.push({
          modelId: input.providerModelId,
          provider: input.providerConnectionId
        });
        if (!capabilities) {
          throw new ProviderAdmissionError("model_not_available");
        }
        if (input.searchPlan.optionIds.length > 0) {
          throw new ProviderAdmissionError("search_strategy_not_available");
        }

        const defaultParams = { ...(options.defaultParams ?? {}) };
        const adapterKind = input.providerConnectionId === "openrouter"
          ? "openrouter_chat_completions" as const
          : input.providerConnectionId === "fake"
            ? "fake" as const
            : "openai_responses_native" as const;
        const fake = adapterKind === "fake";
        const openRouterRouting = adapterKind === "openrouter_chat_completions"
          ? { mode: "automatic" as const, providers: [] as [] }
          : undefined;
        return {
          answer: {
            credentialSource: "default" as const,
            modelConfiguration: {
              adapterKind,
              capabilities,
              defaultParams,
              ...(openRouterRouting ? { openRouterRouting } : {})
            },
            snapshot: {
              connection: {
                allowPrivateNetwork: fake,
                apiRoot: fake ? "http://127.0.0.1" : "https://api.example.test/v1",
                authenticationMode: fake ? "none" as const : "bearer" as const,
                responseTimeoutMs: 300_000
              },
              connectionDisplayName: input.providerConnectionId,
              connectionId: input.providerConnectionId,
              credentialId: fake ? null : `credential:${input.providerConnectionId}`,
              credentialVersionId: fake
                ? null
                : `credential-version:${input.providerConnectionId}`,
              model: fake
                ? {
                    adapterKind: "fake" as const,
                    capabilities,
                    defaultParams,
                    upstreamModelId: input.providerModelId
                  }
                : {
                    adapterKind,
                    answerSelectable: true,
                    capabilities,
                    defaultParams,
                    modelClass: "answer" as const,
                    ...(openRouterRouting ? { openRouterRouting } : {}),
                    upstreamModelId: input.providerModelId
                  },
              modelDisplayName: input.providerModelId,
              providerFamily: input.providerConnectionId,
              providerModelId: input.providerModelId,
              version: 1 as const
            }
          },
          fingerprint: "f".repeat(64),
          requestedSearchPlan: input.searchPlan,
          ...(input.searchPreferenceSource
            ? {
                requestedSearchPreferencePlan: input.searchPreferencePlan,
                requestedSearchPreferenceSource: input.searchPreferenceSource
              }
            : {}),
          searches: [],
          selection: {
            providerConnectionId: input.providerConnectionId,
            providerModelId: input.providerModelId
          },
          userId: input.userId
        };
      }
    },
    providers,
    repository,
    ...(storage ? { storage } : {})
  };

  return {
    adapter,
    attachmentLoads,
    calls,
    capabilityLoads,
    deps,
    entitlementLoads,
    mcpPrepareCalls,
    regenerateContextLoads,
    sendContextLoads,
    storageReads
  };
}

function successBody(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    content: textMessageContent("Shared question"),
    context: {
      messages: [
        {
          content: textMessageContent("Untrusted client context"),
          id: "client-context",
          role: "assistant"
        }
      ]
    },
    controlDefaults: {
      backgroundMode: true,
      maxOutputTokens: "9000.4",
      reasoningEffort: "high",
      streamMode: true,
      temperature: "-1"
    },
    params: {
      temperature: 0.5
    },
    prompt: {
      developer: "Client developer prompt",
      system: "Client system prompt"
    },
    searchPlan: { mode: "all_selected", optionIds: [] },
    timeZone: "Europe/Berlin",
    ...overrides
  };
}

function sendInput(
  body: Readonly<Record<string, unknown>> | null = successBody(),
  chatOverrides: Partial<SendRunPreparationSource["chat"]> = {}
): RunPreparationInput {
  const source: SendRunPreparationSource = {
    chat: {
      activeLeafMessageId: "prior-user-message",
      defaultModelId: "fake-qsa",
      defaultProvider: "fake",
      id: "chat-1",
      projectMemory: "  Server project memory  ",
      ...chatOverrides
    },
    kind: "send"
  };

  return {
    body,
    source,
    userId: "user-1"
  };
}

function firstProjectSendInput(
  body: Readonly<Record<string, unknown>> | null = successBody(),
  chatOverrides: Partial<SendRunPreparationSource["chat"]> = {}
): RunPreparationInput {
  const input = sendInput(body, chatOverrides);
  if (input.source.kind !== "send") throw new Error("invalid send fixture");
  return {
    ...input,
    source: { ...input.source, draftProjectChat: true }
  };
}

function projectAdmission(
  overrides: Partial<ProjectRunAdmission> = {}
): ProjectRunAdmission {
  return {
    accessRevision: 2,
    assistantBindings: [],
    defaults: {
      assistantId: null,
      controlValues: {},
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpMode: "off",
      providerModelId: "fake-qsa",
      searchPlan: { mode: "all_selected", optionIds: [] }
    },
    instructions: "Use the shared project context.",
    instructionsRevision: 3,
    knowledgeBaseIds: [],
    mcpServerIds: [],
    memoryEnabled: false,
    memoryItems: [],
    memoryRevision: 0,
    modelIds: ["fake-qsa"],
    policy: { externalToolsEnabled: true },
    policyRevision: 4,
    projectId: "project-1",
    role: "CONTRIBUTOR",
    searchOptionIds: [],
    ...overrides
  };
}

function regenerateInput(
  body: Readonly<Record<string, unknown>> | null = successBody(),
  sourceOverrides: Partial<RegenerateRunPreparationSource["source"]> = {}
): RunPreparationInput {
  const source: RegenerateRunPreparationSource = {
    kind: "regenerate",
    source: {
      assistantMessage: {
        modelId: "fake-qsa",
        provider: "fake"
      },
      chat: {
        defaultModelId: "fake-qsa",
        defaultProvider: "fake",
        id: "chat-1",
        projectMemory: "  Server project memory  "
      },
      userMessage: {
        content: textMessageContent("Shared question"),
        id: "stored-user-message"
      },
      ...sourceOverrides
    }
  };

  return {
    body,
    source,
    userId: "user-1"
  };
}

function preparedFrom(result: RunPreparationResult): PreparedRun {
  if (!result.ok) {
    throw new Error(`Expected prepared run, received ${result.code}`);
  }

  return result.prepared;
}

async function withFrozenClock<Value>(run: () => Promise<Value>): Promise<Value> {
  vi.useFakeTimers({ now: new Date("2026-08-06T09:15:00Z"), toFake: ["Date"] });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

async function expectFailure(input: {
  calls: readonly string[];
  expected: Readonly<{
    actual?: Readonly<Record<string, number>>;
    code: string;
    limits?: Readonly<Record<string, number>>;
    message?: string;
    status: 400 | 403 | 409 | 413;
  }>;
  harness?: HarnessOptions;
  messageContains?: string;
  request?: RunPreparationInput;
}) {
  const harness = createHarness(input.harness);
  const result = await prepareRun(harness.deps, input.request ?? sendInput());

  expect(result).toMatchObject({
    ...input.expected,
    ok: false
  });
  if (input.messageContains && !result.ok) {
    expect(result.message).toContain(input.messageContains);
  }
  expect(harness.calls).toEqual(input.calls);
}

describe("run preparation", () => {
  it.each([
    [{ agentEnabled: "yes" }, "agent_selection_invalid"],
    [{ agentEnabled: true, workspace: { enabled: false } }, "agent_workspace_required"],
    [{ agentEnabled: true, workspace: { enabled: true }, assistantId: "assistant" }, "agent_personal_chat_required"]
  ] as const)("rejects incompatible Agent admission before workspace effects: %s", async (body, code) => {
    const harness = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const workspace = { prepare: vi.fn() };
    expect(await prepareRun({ ...harness.deps, workspace }, sendInput(successBody(body))))
      .toMatchObject({ ok: false, code });
    expect(workspace.prepare).not.toHaveBeenCalled();
  });

  it("freezes owner instructions for sends and regeneration without changing the user question", async () => {
    for (const input of [sendInput(), regenerateInput(successBody())]) {
      const h = createHarness();
      const accepted = { presetId: "preset", revision: 3, selectionVersion: 2,
        systemInstructions: "SYNTHETIC_PERSONAL_STYLE", responseReminder: "SYNTHETIC_REMINDER" };
      const instructions = { resolveForRun: vi.fn(async () => ({ ...accepted })) };
      const result = materializePreparedRunData(preparedFrom(await prepareRun({ ...h.deps, instructions }, input)));
      expect(instructions.resolveForRun).toHaveBeenCalledOnce();
      expect(result.normalizedRequest.instructionPreset).toEqual({ presetId: "preset", revision: 3, selectionVersion: 2 });
      expect(result.normalizedRequest.prompt).toMatchObject({ personalInstructions: accepted.systemInstructions, responseReminder: accepted.responseReminder });
      expect(result.normalizedRequest.prompt.baseline?.source).toBe("standard_chat");
      expect(JSON.stringify(result.normalizedRequest.content)).not.toContain(accepted.responseReminder);
      expect(JSON.stringify(result.providerRequestPreview)).not.toContain(accepted.systemInstructions);
      accepted.systemInstructions = "Changed after acceptance";
      expect(result.normalizedRequest.prompt.personalInstructions).toBe("SYNTHETIC_PERSONAL_STYLE");
    }
  });

  it("never resolves personal presets for shared Projects", async () => {
    const h = createHarness(); const instructions = { resolveForRun: vi.fn() };
    const result = materializePreparedRunData(preparedFrom(await prepareRun({ ...h.deps, instructions },
      sendInput(successBody(), { project: projectAdmission() }))));
    expect(instructions.resolveForRun).not.toHaveBeenCalled();
    expect(result.normalizedRequest.instructionPreset).toBeUndefined();
    expect(result.normalizedRequest.prompt.responseReminder).toBe("");
  });

  it("replaces default answer rules and freezes rendered macros without disclosing them in previews", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-07T23:34:00Z"));
    try {
      const h = createHarness();
      const preset = { presetId: "preset", revision: 4, selectionVersion: 2, systemInstructions: "Date {local_date}.",
        responseReminder: "Time {local_time}.", answerRules: "PRIVATE_RULE_{local_date}" };
      const instructions = { resolveForRun: vi.fn(async () => ({ ...preset })) };
      const result = materializePreparedRunData(preparedFrom(await prepareRun({ ...h.deps, instructions },
        sendInput(successBody({ timeZone: "Europe/Moscow" })))));
      expect(result.normalizedRequest.prompt).toMatchObject({ developer: null,
        personalInstructions: "Date June 8, 2026.\n\nAnswer rules:\nPRIVATE_RULE_June 8, 2026",
        responseReminder: "Time 02:34 AM GMT+3." });
      expect(result.normalizedRequest.prompt.system).toContain("June 8, 2026");
      expect(JSON.stringify(result.providerRequestPreview)).not.toContain("PRIVATE_RULE");
      preset.answerRules = "Later edit";
      vi.setSystemTime(new Date("2026-06-08T23:34:00Z"));
      expect(result.normalizedRequest.prompt.personalInstructions).toContain("PRIVATE_RULE_June 8, 2026");
      expect(result.normalizedRequest.prompt.personalInstructions).not.toContain("Later edit");
    } finally { vi.useRealTimers(); }
  });

  it("admits Search with Agent and freezes policy without making budgets part of thread compatibility", async () => {
    vi.stubEnv("AIQSA_AGENT_GATEWAY_URL", "http://agent.invalid");
    try {
      const harness = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
      const search = providerNeutralOpenAISearchPlan("anthropic_messages").searches[0]!;
      const load = vi.fn<NonNullable<RunPreparationDeps["providerAdmission"]>["load"]>(async (input) => ({
        ...await harness.deps.providerAdmission!.load({ ...input, searchPlan: { mode: "all_selected", optionIds: [] } }),
        requestedSearchPlan: input.searchPlan, requiresClientSearchRoutes: true, searches: [search]
      }));
      const workspace: NonNullable<RunPreparationDeps["workspace"]> = { prepare: vi.fn<NonNullable<RunPreparationDeps["workspace"]>["prepare"]>(async (input) => ({ ok: true, tools: [], plan: {
        ...input, expiresAt: new Date(Date.now() + 60000).toISOString(), policyRevision: 1, sandboxName: "fixture", sessionId: "ws_fixture", toolDefinitions: [],
        normalized: { enabled: true, imageRef: "fixture", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: true,
          maxToolCalls: 64, maxToolRounds: 16, mcpVersion: "0.6.16", messageManifestPath: "/workspace/inbox/messages/fixture.json",
          outputDirectory: `/workspace/output/${input.runId}`, projectDirectory: "/workspace/project", runtimeVersion: "0.6.16", sessionId: "ws_fixture",
          syncToolTimeoutSeconds: 30, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 300 }
      } })) };
      const body = successBody({ agentEnabled: true, workspace: { enabled: true }, provider: "openai", modelId: "gpt-fixture",
        params: { maxOutputTokens: 2048 }, searchPlan: { mode: "all_selected", optionIds: [search.optionId] } });
      const configs = [];
      for (const limitsEnabled of [false, true]) {
        const prepared = preparedFrom(await prepareRun({ ...harness.deps, workspace, providerAdmission: { load },
          agentPolicy: { read: async () => ({ ...DEFAULT_AGENT_POLICY, limitsEnabled, maxOutputTokens: 256, version: limitsEnabled ? 2 : 1 }) }
        }, sendInput(body)));
        expect(prepared.normalizedRequest.agent).toMatchObject({ limitsEnabled, timeoutSeconds: limitsEnabled ? 3600 : null,
          maxOutputTokens: limitsEnabled ? 256 : 2048, policyVersion: limitsEnabled ? 2 : 1 });
        expect(prepared.normalizedRequest.prompt.system).toContain("no current message manifest is present");
        expect(prepared.normalizedRequest.prompt.system).toContain(WORKSPACE_PSD_GUIDANCE);
        expect(prepared.normalizedRequest.prompt.system).not.toContain("Read messageManifestPath");
        configs.push(prepared.normalizedRequest.agent!);
      }
      expect(load).toHaveBeenCalledWith(expect.objectContaining({ requiresClientSearchRoutes: true }));
      expect(workspace.prepare).toHaveBeenCalledWith(expect.objectContaining({ agentEnabled: true }));
      expect(configs[0]!.compatibilityHash).toBe(configs[1]!.compatibilityHash);
      vi.mocked(workspace.prepare).mockResolvedValue({ ok: false, code: "agent_unavailable", status: 503 });
      for (const input of [sendInput(body), regenerateInput(body)]) {
        await expect(prepareRun({ ...harness.deps, workspace, providerAdmission: { load } }, input))
          .resolves.toMatchObject({ ok: false, code: "agent_unavailable", status: 503 });
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    { vision: false, verified: false }, { vision: true, verified: false }, { vision: true, verified: true }
  ])("routes Workspace images only to System Vision independently of the main modality (%j)", async ({ vision, verified }) => {
    vi.stubEnv("AIQSA_AGENT_GATEWAY_URL", "http://agent.invalid");
    try {
      const h = createHarness({ capabilities: { ...baseCapabilities, vision, toolCalling: true } });
      const workspace: NonNullable<RunPreparationDeps["workspace"]> = { prepare: vi.fn(async input => ({ ok: true as const, tools: [], plan: {
        ...input, expiresAt: new Date(Date.now() + 60000).toISOString(), policyRevision: 1, sandboxName: "fixture", sessionId: "ws_fixture", toolDefinitions: [],
        normalized: { enabled: true as const, imageRef: "fixture", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: true,
          maxToolCalls: 64, maxToolRounds: 16, mcpVersion: "0.6.16", messageManifestPath: "/workspace/inbox/messages/fixture.json",
          outputDirectory: `/workspace/output/${input.runId}`, projectDirectory: "/workspace/project", runtimeVersion: "0.6.16", sessionId: "ws_fixture",
          syncToolTimeoutSeconds: 30, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 300 }
      } })) };
      const original = h.deps.providerAdmission!.load;
      const load: NonNullable<RunPreparationDeps["providerAdmission"]>["load"] = async input => {
        const plan = await original(input);
        return { ...plan, answer: { ...plan.answer, verifiedVisionInput: verified ? true : undefined } };
      };
      const snapshot = compatibleAdmissionPlan("openai_responses_compatible").answer.snapshot;
      const plans: AcceptedVisionAnalysisPlan[] = [
        { version: 1, available: false, code: "vision_model_absent" },
        { version: 1, available: false, code: "vision_model_unavailable" },
        { version: 1, available: true, policyVersion: 1, verifiedVisionInput: true, reasoningEffort: null, snapshot,
          authority: { connectionId: snapshot.connectionId, connectionVersion: 1, credentialId: snapshot.credentialId!,
            credentialVersionId: snapshot.credentialVersionId!, providerModelId: snapshot.providerModelId, modelVersion: 1 } }
      ];
      for (const plan of plans) for (const agentEnabled of [false, true]) {
        const deps = { ...h.deps, workspace, providerAdmission: { load }, vision: { resolve: async () => plan },
          agentPolicy: { read: async () => ({ ...DEFAULT_AGENT_POLICY }) } };
        const result = preparedFrom(await prepareRun(deps, sendInput(successBody({ agentEnabled, workspace: { enabled: true },
          provider: "openai", modelId: "gpt-fixture", mcp: { mode: "off" } }))));
        expect(result.normalizedRequest.visionAnalysis).toEqual(plan);
        expect(result.normalizedRequest.agent?.imageInput).toBe(agentEnabled ? false : undefined);
        expect(result.normalizedRequest.workspaceImageView).toBeUndefined();
        expect(result.providerRequest).toMatchObject({ provider: "openai", modelId: "gpt-fixture", modelCapabilities: { vision } });
        expect(result.providerRequest.tools?.some(tool => tool.name === "analyze_image")).toBe(!agentEnabled);
        expect(result.providerRequest.tools?.some(tool => tool.name === "view_workspace_image")).toBe(false);
        expect(result.normalizedRequest.prompt.system).toContain("Direct image viewing is unavailable");
        expect(result.normalizedRequest.prompt.system).not.toContain("direct image viewer first");
        if (!plan.available) expect(result.normalizedRequest.prompt.system).toContain("without substituting another model");
        if (agentEnabled) {
          const configuration = result.normalizedRequest.agent!;
          const profile = renderCodexManagedProfile({ gatewayOrigin: configuration.gatewayOrigin, modelId: "gpt-fixture",
            contextWindowTokens: 32768, maxOutputTokens: configuration.maxOutputTokens, mcpTimeoutSeconds: 60,
            mcpMode: configuration.mcpMode, imageInput: configuration.imageInput, visionAnalysis: Boolean(result.normalizedRequest.visionAnalysis),
            developerInstructions: agentPrompts(materializePreparedRunData(result).providerRequest).developerInstructions });
          expect(profile).toContain("view_image = false");
          expect(profile).toContain('enabled_tools = ["analyze_image"]');
          expect(profile).not.toContain("direct image viewer first");
        }
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps the pre-observation Agent thread identity under Off and separates observation-v1 threads", async () => {
    vi.stubEnv("AIQSA_AGENT_GATEWAY_URL", "http://agent.invalid");
    try {
      const h = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
      const workspace: NonNullable<RunPreparationDeps["workspace"]> = { prepare: vi.fn(async input => ({ ok: true as const, tools: [], plan: {
        ...input, expiresAt: new Date(Date.now() + 60000).toISOString(), policyRevision: 1, sandboxName: "fixture", sessionId: "ws_fixture", toolDefinitions: [],
        normalized: { enabled: true as const, imageRef: "fixture", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: true,
          maxToolCalls: 64, maxToolRounds: 16, mcpVersion: "0.6.16", messageManifestPath: "/workspace/inbox/messages/fixture.json",
          outputDirectory: `/workspace/output/${input.runId}`, projectDirectory: "/workspace/project", runtimeVersion: "0.6.16", sessionId: "ws_fixture",
          syncToolTimeoutSeconds: 30, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 300 }
      } })) };
      const identities = new Map<string, Readonly<{ hash: string; input: Record<string, unknown> }>>();
      for (const policy of ["off", "v1"] as const) {
        vi.mocked(hashCanonicalMcpValue).mockClear();
        const deps = { ...h.deps, workspace, agentPolicy: { read: async () => ({ ...DEFAULT_AGENT_POLICY }) },
          runPolicy: { load: async () => ({ ...DEFAULT_TOOL_RUN_BUDGETS, toolObservationPolicy: policy }) } };
        const prepared = preparedFrom(await prepareRun(deps, sendInput(successBody({ agentEnabled: true, workspace: { enabled: true },
          provider: "openai", modelId: "gpt-fixture", mcp: { mode: "off" } }))));
        const input = vi.mocked(hashCanonicalMcpValue).mock.calls.map(([value]) => value)
          .find((value): value is Record<string, unknown> => typeof value === "object" && value !== null && "managedProfileVersion" in value);
        expect(input).toBeDefined();
        expect(prepared.normalizedRequest.toolObservationVersion).toBe(policy === "v1" ? 1 : 0);
        identities.set(policy, { hash: prepared.normalizedRequest.agent!.compatibilityHash, input: input! });
      }
      const off = identities.get("off")!, v1 = identities.get("v1")!;
      // Off hashes exactly the v0.2.24 identity shape, so arm() still finds a
      // compatible completed predecessor thread accepted before the upgrade.
      expect(off.input.managedProfileVersion).toBe(7);
      expect(off.input).not.toHaveProperty("toolObservationVersion");
      expect(v1.input).toMatchObject({ managedProfileVersion: 7, toolObservationVersion: 1 });
      const { toolObservationVersion: _version, ...withoutObservation } = v1.input;
      expect(hashCanonicalMcpValue(withoutObservation)).toBe(off.hash);
      expect(v1.hash).not.toBe(off.hash);
    } finally { vi.unstubAllEnvs(); }
  });

  it("admits Agent artifacts with MCP Off and invalidates continuation only for accepted capability/context changes", async () => {
    vi.stubEnv("AIQSA_AGENT_GATEWAY_URL", "http://agent.invalid");
    try {
      const h = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
      let version = "version-one";
      const artifacts = { validateEditTarget: async () => ({ ok: true }), contextForChat: async () => [{
        artifact_id: "artifact-one", base_version_id: version, kind: "html", title: "Page", version_number: 1,
        entrypoint: "index.html", files: [{ path: "index.html", mimeType: "text/html", text: "<p>Synthetic</p>" }]
      }] } as unknown as NonNullable<RunPreparationDeps["artifacts"]>;
      const workspace: NonNullable<RunPreparationDeps["workspace"]> = { prepare: vi.fn(async input => ({ ok: true as const, tools: [], plan: {
        ...input, expiresAt: new Date(Date.now() + 60000).toISOString(), policyRevision: 1, sandboxName: "fixture", sessionId: "ws_fixture", toolDefinitions: [],
        normalized: { enabled: true as const, imageRef: "fixture", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: true,
          maxToolCalls: 64, maxToolRounds: 16, mcpVersion: "0.6.16", messageManifestPath: "/workspace/inbox/messages/fixture.json",
          outputDirectory: `/workspace/output/${input.runId}`, projectDirectory: "/workspace/project", runtimeVersion: "0.6.16", sessionId: "ws_fixture",
          syncToolTimeoutSeconds: 30, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 300 }
      } })) };
      let imagePlan: ReturnType<typeof syntheticImagePlan> | null = syntheticImagePlan();
      const deps = { ...h.deps, artifacts, workspace, images: { resolve: async () => imagePlan }, agentPolicy: { read: async () => ({ ...DEFAULT_AGENT_POLICY }) } };
      const body = successBody({ agentEnabled: true, workspace: { enabled: true }, provider: "openai", modelId: "gpt-fixture", mcp: { mode: "off" } });
      const first = preparedFrom(await prepareRun(deps, sendInput(body))).normalizedRequest;
      expect(first).toMatchObject({ artifactTool: true, agent: { mcpMode: "off" }, artifactReferences: [{ artifactId: "artifact-one", versionId: version }] });
      expect(first.artifactResourcePolicy).toBeDefined();
      expect(first.imagePlan).toEqual(imagePlan);
      const same = preparedFrom(await prepareRun(deps, sendInput(body))).normalizedRequest;
      expect(same.agent!.compatibilityHash).toBe(first.agent!.compatibilityHash);
      imagePlan = { ...imagePlan!, parameters: { quality: "high" } };
      const changedImage = preparedFrom(await prepareRun(deps, sendInput(body))).normalizedRequest;
      expect(changedImage.agent!.compatibilityHash).not.toBe(first.agent!.compatibilityHash);
      imagePlan = null;
      const missingImage = preparedFrom(await prepareRun(deps, sendInput(body))).normalizedRequest;
      expect(missingImage.imagePlan).toBeUndefined();
      expect(missingImage.agent!.compatibilityHash).not.toBe(changedImage.agent!.compatibilityHash);
      version = "version-two";
      const next = preparedFrom(await prepareRun(deps, sendInput(body))).normalizedRequest;
      expect(next.agent!.compatibilityHash).not.toBe(missingImage.agent!.compatibilityHash);
      const edited = preparedFrom(await prepareRun(deps, sendInput({ ...body, artifactEdit: { artifactId: "artifact-one", versionId: version } }))).normalizedRequest;
      expect(edited.artifactEdit?.versionId).toBe(version);
      expect(edited.agent!.compatibilityHash).not.toBe(next.agent!.compatibilityHash);
      vi.stubEnv("AIQSA_ARTIFACT_EXTERNAL_RESOURCES", "off");
      const restricted = preparedFrom(await prepareRun(deps, sendInput(body))).normalizedRequest;
      expect(restricted.artifactResourcePolicy?.on).toBe(false);
      expect(restricted.agent!.compatibilityHash).not.toBe(next.agent!.compatibilityHash);
      expect(first.artifactResourcePolicy?.on).toBe(true);
      await expect(prepareRun(deps, sendInput({ ...body, tools: "none", artifactIntent: "create" })))
        .resolves.toMatchObject({ ok: false, code: "artifact_intent_unavailable" });
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([true, false])("freezes browser guidance only when Workspace is enabled: %s", async (enabled) => {
    const harness = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const workspace: NonNullable<RunPreparationDeps["workspace"]> = { prepare: vi.fn<NonNullable<RunPreparationDeps["workspace"]>["prepare"]>(async (input) => ({ ok: true, tools: [], plan: {
      ...input, expiresAt: new Date(Date.now() + 60_000).toISOString(), policyRevision: 1, sandboxName: "synthetic-browser", sessionId: "ws_browser", toolDefinitions: [],
      normalized: { enabled: true, imageRef: "synthetic-image", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: true,
        maxToolCalls: 64, maxToolRounds: 16, mcpVersion: "0.6.16", messageManifestPath: "/workspace/inbox/messages/synthetic/manifest.json",
        outputDirectory: `/workspace/output/${input.runId}`, projectDirectory: "/workspace/project", runtimeVersion: "0.6.16", sessionId: "ws_browser",
        syncToolTimeoutSeconds: 30, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 300 }
    } })) };
    const prepared = preparedFrom(await prepareRun({ ...harness.deps, workspace }, sendInput(successBody({ workspace: { enabled } }))));
    const accepted = materializePreparedRunData(prepared);
    expect(accepted.followupAdmission?.budgetTokens).toBeGreaterThan(0);
    expect(accepted.normalizedRequest.followupContextReserveTokens).toBe(accepted.followupAdmission?.budgetTokens);
    if (enabled) {
      expect(workspace.prepare).toHaveBeenCalledOnce();
      expect(accepted.normalizedRequest.prompt.system).toContain(WORKSPACE_BROWSER_GUIDANCE);
      expect(accepted.normalizedRequest.prompt.system).toContain(WORKSPACE_PSD_GUIDANCE);
      expect(accepted.providerRequest.prompt.system).toBe(accepted.normalizedRequest.prompt.system);
      expect(accepted.normalizedRequest.prompt.system).toContain("aria_snapshot()");
      expect(accepted.normalizedRequest.prompt.system).toContain("no current message manifest is present");
      expect(accepted.normalizedRequest.prompt.system).not.toContain("Current message manifest:");
    } else {
      expect(workspace.prepare).not.toHaveBeenCalled();
      expect(accepted.normalizedRequest.prompt.system).not.toContain(WORKSPACE_BROWSER_GUIDANCE);
      expect(accepted.normalizedRequest.prompt.system).not.toContain(WORKSPACE_PSD_GUIDANCE);
    }
  });

  it.each([false, true])("discovers the prior opaque source after failure, including trimmed history: %s", async (trimmed) => {
    const source = { ...runAttachment({ id: "source-original", kind: "file", mimeType: "application/octet-stream",
      storageKey: "synthetic/source", checksum: "a".repeat(64) }), fileName: "same.psd" };
    const sibling = { ...source, id: "sibling-source", storageKey: "synthetic/sibling" };
    const history = conversationMessagesFromPathRows([
      { chatId: "chat", messageId: "original-question", messageRole: "user", messageStatus: "complete",
        messageContent: { blocks: [{ type: "text", text: "Width 1024; keep the blue layer." + (trimmed ? " detail".repeat(40_000) : "") },
          { type: "file", attachmentId: source.id }] } },
      { chatId: "chat", messageId: "failed-answer", messageParentId: "original-question", messageRole: "assistant",
        messageStatus: "error", messageContent: null }
    ]);
    const harness = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true }, attachments: [source, sibling], sendContext: history });
    const workspace: NonNullable<RunPreparationDeps["workspace"]> = { prepare: vi.fn(async input => ({ ok: true as const, tools: [], plan: {
      ...input, expiresAt: new Date(Date.now() + 60_000).toISOString(), policyRevision: 1, sandboxName: "synthetic-files", sessionId: "ws_files", toolDefinitions: [],
      normalized: { enabled: true as const, imageRef: "synthetic-image", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: true,
        maxToolCalls: 64, maxToolRounds: 16, mcpVersion: "0.6.16", messageManifestPath: "/workspace/inbox/messages/synthetic/manifest.json",
        outputDirectory: `/workspace/output/${input.runId}`, projectDirectory: "/workspace/project", runtimeVersion: "0.6.16", sessionId: "ws_files",
        syncToolTimeoutSeconds: 30, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 300 }
    } })) };
    const prepared = materializePreparedRunData(preparedFrom(await prepareRun({ ...harness.deps, workspace },
      sendInput(successBody({ content: textMessageContent("Continue"), workspace: { enabled: true } })))));
    const request = prepared.providerRequest;
    expect(request.prompt.system).toContain('"attachmentId":"source-original"');
    expect(request.prompt.system).toContain('"referencedByMessage":"original-question"');
    expect(request.prompt.system).toContain('"index":"/workspace/inbox/index.json"');
    expect(request.prompt.system).not.toContain("sibling-source");
    expect(request.attachments).toEqual([]);
    expect(request.context?.messages.some(message => message.id === "failed-answer")).toBe(false);
    expect(request.context?.messages.some(message => message.id === "original-question")).toBe(!trimmed);
    expect(request.prompt.system).toBe(prepared.normalizedRequest.prompt.system);
    expect(harness.attachmentLoads).toContainEqual({ attachmentIds: ["source-original"], userId: "user-1" });
  });

  it("binds Agent native discovery and compatibility to the full catalog and profile", async () => {
    vi.stubEnv("AIQSA_AGENT_GATEWAY_URL", "http://agent.invalid");
    try {
      const h = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
      const pinned = { skillId: "p", revisionId: "p-r", name: "pinned", instructions: "PINNED_BODY", fileCount: 1 };
      const available = { skillId: "a", revisionId: "a-r", name: "available", description: "NATIVE_DESCRIPTION", fileCount: 1 };
      const skills = { resolveForRun: vi.fn(async () => ({ ok: true as const, skills: [pinned] })),
        listEnabledForRun: vi.fn(async () => [available]), loadedBeforeForMessages: vi.fn(async () => ["a"]) };
      const workspace: NonNullable<RunPreparationDeps["workspace"]> = { prepare: vi.fn<NonNullable<RunPreparationDeps["workspace"]>["prepare"]>(async input => ({ ok: true as const, tools: [], plan: {
        ...input, expiresAt: new Date(Date.now() + 60_000).toISOString(), policyRevision: 1, sandboxName: "synthetic-skills", sessionId: "ws_skills", toolDefinitions: [],
        normalized: { enabled: true as const, imageRef: "synthetic-image", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: true,
          maxToolCalls: 64, maxToolRounds: 16, mcpVersion: "0.6.16", messageManifestPath: "/workspace/inbox/messages/synthetic/manifest.json",
          outputDirectory: `/workspace/output/${input.runId}`, projectDirectory: "/workspace/project", runtimeVersion: "0.6.16", sessionId: "ws_skills",
          syncToolTimeoutSeconds: 30, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 300 }
      } })) };
      const deps = { ...h.deps, skills, workspace, agentPolicy: { read: async () => ({ ...DEFAULT_AGENT_POLICY }) } };
      const body = successBody({ agentEnabled: true, workspace: { enabled: true }, provider: "openai", modelId: "gpt-fixture", skillIds: ["p"] });
      const first = preparedFrom(await prepareRun(deps, sendInput(body)));
      expect(first.normalizedRequest.skills).toMatchObject({ mode: "auto", available: [{ skillId: "a", revisionId: "a-r", alias: "available", loadedBefore: false }] });
      expect(first.providerRequest.context?.messages.some(message => message.purpose === "skill_catalog")).toBe(false);
      expect(JSON.stringify(first.providerRequest.context)).toContain('/workspace/.aiqsa/skills/pinned');
      expect(JSON.stringify(first.providerRequest.context)).toContain("PINNED_BODY");
      expect(JSON.stringify(first.providerRequest.context)).not.toContain("NATIVE_DESCRIPTION");
      expect(first.providerRequest.tools?.some(tool => tool.capability === "skill")).toBe(false);
      expect(skills.loadedBeforeForMessages).not.toHaveBeenCalled();
      const filtered = preparedFrom(await prepareRun({ ...deps, skillCatalogRelevance: async decision => {
        await decision.authorize(); return [];
      } }, { ...sendInput(body), skillCatalogDecision: { operationKey: "agent-admission", authorizeScope: async () => undefined } }));
      expect(filtered.normalizedRequest.skills).toMatchObject({ pinned: [{ skillId: "p" }], available: [] });
      expect(filtered.normalizedRequest.agent!.compatibilityHash).not.toBe(first.normalizedRequest.agent!.compatibilityHash);
      expect(filtered.providerRequest.tools?.some(tool => tool.capability === "skill")).toBe(false);
      const same = preparedFrom(await prepareRun(deps, sendInput(body)));
      expect(same.normalizedRequest.agent!.compatibilityHash).toBe(first.normalizedRequest.agent!.compatibilityHash);
      available.revisionId = "a-r2";
      const revised = preparedFrom(await prepareRun(deps, sendInput(body)));
      expect(revised.normalizedRequest.agent!.compatibilityHash).not.toBe(first.normalizedRequest.agent!.compatibilityHash);
      const off = preparedFrom(await prepareRun(deps, sendInput({ ...body, skills: { mode: "off" } })));
      expect(off.normalizedRequest.skills).toMatchObject({ mode: "off", available: [], pinned: [{ skillId: "p" }] });
      expect(off.normalizedRequest.agent!.compatibilityHash).not.toBe(revised.normalizedRequest.agent!.compatibilityHash);
    } finally { vi.unstubAllEnvs(); }
  });


  it("requires a configured default model for the first Project send", async () => {
    const result = await prepareRun(
      createHarness().deps,
      firstProjectSendInput(successBody(), {
        project: projectAdmission({
          defaults: { ...projectAdmission().defaults, providerModelId: null }
        })
      })
    );

    expect(result).toMatchObject({
      code: "project_setup_required",
      ok: false,
      status: 409
    });
  });

  it("does not let an explicit alternate model bypass an unavailable Project default", async () => {
    const result = await prepareRun(
      createHarness().deps,
      firstProjectSendInput(successBody({
        modelId: "fake-qsa",
        provider: "fake"
      }), {
        defaultModelId: "unavailable-default",
        defaultProvider: "unavailable-provider",
        project: projectAdmission({
          defaults: {
            ...projectAdmission().defaults,
            providerModelId: "unavailable-default"
          },
          modelIds: ["unavailable-default", "fake-qsa"]
        })
      })
    );

    expect(result).toMatchObject({
      code: "project_default_model_unavailable",
      ok: false,
      status: 409
    });
  });

  it("fails closed when a Project model is not explicitly linked", async () => {
    const harness = createHarness();
    const result = await prepareRun(
      harness.deps,
      sendInput(successBody(), { project: projectAdmission({ modelIds: [] }) })
    );

    expect(result).toMatchObject({ code: "provider_not_available", ok: false, status: 403 });
    expect(harness.calls).toEqual([]);
  });

  it("rejects personal Search preferences in Project runs before provider admission", async () => {
    const harness = createHarness();
    const result = await prepareRun(
      harness.deps,
      sendInput(successBody({
        searchPreferencePlan: { mode: "all_selected", optionIds: [] },
        searchPreferenceSource: "personal"
      }), { project: projectAdmission() })
    );

    expect(result).toMatchObject({ code: "search_preference_invalid", ok: false, status: 400 });
    expect(harness.calls).toEqual([]);
  });

  it("applies server-owned Project controls and instructions without Project Memory", async () => {
    const harness = createHarness();
    const result = await prepareRun(
      harness.deps,
      sendInput(successBody({ params: {} }), {
        project: projectAdmission({
          defaults: {
            ...projectAdmission().defaults,
            controlValues: { temperature: "0.25" }
          },
          memoryEnabled: true,
          memoryItems: [{
            factId: "fact-1",
            factVersionId: "fact-version-1",
            includedText: "The team deploys on Tuesdays.",
            ordinal: 0
          }]
        })
      })
    );
    const prepared = preparedFrom(result);

    expect(prepared.normalizedRequest.params.temperature).toBe(0.25);
    expect(prepared.normalizedRequest.prompt.system).toContain(
      "Project Instructions:\nUse the shared project context."
    );
    expect(prepared.normalizedRequest.prompt.system).not.toContain("Project Memory (");
    expect(prepared.normalizedRequest.prompt.system).not.toContain("The team deploys on Tuesdays.");
    expect(prepared.normalizedRequest.prompt.memoryActionAnswerResult).toEqual(
      MEMORY_ACTION_NO_COMMIT_RESULT
    );
    expect(prepared.project).toMatchObject({
      memoryEnabled: false,
      memoryItems: [],
      projectId: "project-1"
    });
    expect(prepared.defaults).toBeNull();
  });

  it("keeps Project Knowledge scope while requiring a client Search coexistence route", async () => {
    const { client, hosted, optionId } = nativeSearchCoexistencePlans(
      "gemini_interactions_native"
    );
    const admissionLoad = vi.fn(async (input: {
      executionScope?: "project";
      requiresClientToolCoexistence?: boolean;
    }) => input.requiresClientToolCoexistence ? client : hosted);
    const knowledgeLoad = vi.fn<
      NonNullable<RunPreparationDeps["knowledgeAdmission"]>["load"]
    >(async (input) => admittedKnowledge(input, "c"));
    const result = await prepareRun(
      {
        ...createHarness().deps,
        allowFakeProvider: false,
        knowledgeAdmission: { load: knowledgeLoad },
        providerAdmission: { load: admissionLoad }
      },
      sendInput(successBody({
        knowledgePlan: knowledgeSelection(["knowledge-base-1"]),
        modelId: hosted.selection.providerModelId,
        params: {},
        provider: hosted.selection.providerConnectionId,
        searchPlan: { mode: "model_choice", optionIds: [optionId] }
      }), {
        project: projectAdmission({
          defaults: {
            ...projectAdmission().defaults,
            knowledgePlan: knowledgeSelection(["knowledge-base-1"]),
            providerModelId: hosted.selection.providerModelId,
            searchPlan: { mode: "model_choice", optionIds: [optionId] }
          },
          knowledgeBaseIds: ["knowledge-base-1"],
          modelIds: [hosted.selection.providerModelId],
          searchOptionIds: [optionId]
        })
      })
    );

    expect(result.ok).toBe(true);
    expect(admissionLoad).toHaveBeenCalledOnce();
    expect(admissionLoad).toHaveBeenCalledWith(expect.objectContaining({
      executionScope: "project"
    }));
    expect(admissionLoad.mock.calls[0]?.[0]).toMatchObject({
      requiresClientToolCoexistence: true
    });
    expect(knowledgeLoad).toHaveBeenCalledWith(expect.objectContaining({
      executionScope: "project",
      projectId: "project-1"
    }));
  });

  it("admits exact shared Project MCP bindings", async () => {
    const harness = createHarness({
      capabilities: { ...baseCapabilities, toolCalling: true },
      mcpPlan: readyMcpPlan(["shared"])
    });
    const project = projectAdmission({
      defaults: {
        ...projectAdmission().defaults,
        mcpMode: "load_all",
        providerModelId: "openai-tool-model"
      },
      mcpServerIds: ["server-1"],
      modelIds: ["openai-tool-model"]
    });
    const prepared = preparedFrom(await prepareRun(
      harness.deps,
      sendInput(successBody({
        modelId: "openai-tool-model",
        params: { background: false },
        provider: "openai",
        tools: "auto"
      }), { project })
    ));

    expect(harness.mcpPrepareCalls).toEqual([{
      allowedServerIds: ["server-1"],
      userId: "user-1"
    }]);
    expect(prepared.mcpBindings).toEqual([{
      fingerprint: "fingerprint-1",
      runtimeGenerationId: "generation-1",
      serverId: "server-1"
    }]);
  });

  it("uses project_mcp_not_configured only when shared Project MCP integration is absent", async () => {
    const result = await prepareRun(
      createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } }).deps,
      sendInput(successBody({ tools: "auto" }), {
        project: projectAdmission({
          defaults: { ...projectAdmission().defaults, mcpMode: "load_all" },
          mcpServerIds: ["server-1"]
        })
      })
    );

    expect(result).toMatchObject({
      code: "project_mcp_not_configured",
      ok: false,
      status: 503
    });
  });

  it("reports a configured but unrunnable Project MCP generation as mcp_not_ready", async () => {
    const mcpPlan: McpRunPlanResult = {
      code: "mcp_not_ready",
      issues: [{ errorCode: "runtime_unavailable", name: "Team tools", readiness: "unavailable" }],
      ok: false
    };
    const result = await prepareRun(
      createHarness({
        capabilities: { ...baseCapabilities, toolCalling: true },
        mcpPlan
      }).deps,
      sendInput(successBody({ tools: "auto" }), {
        project: projectAdmission({
          defaults: { ...projectAdmission().defaults, mcpMode: "load_all" },
          mcpServerIds: ["server-1"]
        })
      })
    );

    expect(result).toMatchObject({ code: "mcp_not_ready", ok: false, status: 409 });
  });

  it("rejects personal or OAuth MCP credentials in Project chats", async () => {
    const harness = createHarness({ mcpPlan: readyMcpPlan(["oauth"]) });
    const result = await prepareRun(
      harness.deps,
      sendInput(successBody({ params: {} }), {
        project: projectAdmission({
          defaults: { ...projectAdmission().defaults, mcpMode: "load_all" },
          mcpServerIds: ["server-1"]
        })
      })
    );

    expect(result).toMatchObject({
      code: "project_mcp_personal_credentials_forbidden",
      ok: false,
      status: 403
    });
  });

  it("keeps an unavailable personal Project MCP generation distinct from readiness", async () => {
    const result = await prepareRun(
      createHarness({
        capabilities: { ...baseCapabilities, toolCalling: true },
        mcpPlan: {
          code: "mcp_not_ready",
          issues: [{
            errorCode: "mcp_project_credentials_unavailable",
            name: "Personal-only tools",
            readiness: "unavailable"
          }],
          ok: false
        }
      }).deps,
      sendInput(successBody({ tools: "auto" }), {
        project: projectAdmission({
          defaults: { ...projectAdmission().defaults, mcpMode: "load_all" },
          mcpServerIds: ["server-1"]
        })
      })
    );

    expect(result).toMatchObject({
      code: "project_mcp_personal_credentials_forbidden",
      ok: false,
      status: 403
    });
  });

  it("enforces the Project external-tools policy", async () => {
    const harness = createHarness({ mcpPlan: readyMcpPlan(["shared"]) });
    const result = await prepareRun(
      harness.deps,
      sendInput(successBody({ params: {} }), {
        project: projectAdmission({
          defaults: { ...projectAdmission().defaults, mcpMode: "load_all" },
          mcpServerIds: ["server-1"],
          policy: { externalToolsEnabled: false }
        })
      })
    );

    expect(result).toMatchObject({
      code: "project_external_tools_disabled",
      ok: false,
      status: 403
    });
    expect(harness.mcpPrepareCalls).toEqual([]);
  });

  it("freezes the installation tool budgets into the accepted request", async () => {
    const harness = createHarness();
    const load = vi.fn().mockResolvedValue({
      mcpAutoDiscoveryTimeoutSeconds: 60,
      mcpAutoDiscoveryMaxOutputTokens: 4096,
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 200,
      maxToolRounds: 17
    });
    const prepared = preparedFrom(await prepareRun({
      ...harness.deps,
      runPolicy: { load }
    }, sendInput()));

    expect(load).toHaveBeenCalledOnce();
    expect(prepared.normalizedRequest.toolBudgets).toEqual({
      mcpAutoDiscoveryTimeoutSeconds: 60,
      mcpAutoDiscoveryMaxOutputTokens: 4096,
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 200,
      maxToolRounds: 17
    });
    expect(prepared.providerRequest.toolBudgets).toEqual({
      mcpAutoDiscoveryTimeoutSeconds: 60,
      mcpAutoDiscoveryMaxOutputTokens: 4096,
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 200,
      maxToolRounds: 17
    });
  });

  it("defensively separates and deeply freezes prepared data without freezing service dependencies", async () => {
    const originalBlock = {
      text: "Shared question",
      type: "text"
    };
    const originalParams = { temperature: 0.5 };
    const harness = createHarness();
    const result = await prepareRun(
      harness.deps,
      sendInput(
        successBody({
          content: { blocks: [originalBlock] },
          modelId: "openai-answer-model",
          params: originalParams,
          provider: "openai"
        })
      )
    );
    if (!result.ok) {
      throw new Error(`Expected prepared run, received ${result.code}`);
    }
    const prepared = result.prepared;
    const preparedBlock = prepared.normalizedRequest.content.blocks[0] as Readonly<Record<string, unknown>>;
    const previewAttachments = (prepared.providerRequestPreview as { readonly attachments: readonly unknown[] })
      .attachments;

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
    // Ordinary runs must keep persisting accepted defaults; guard against null
    // first because Object.isFrozen(null/undefined) is vacuously true.
    expect(prepared.defaults).not.toBeNull();
    expect(Object.isFrozen(prepared.defaults)).toBe(true);
    expect(Object.isFrozen(prepared.defaults?.controlDefaults)).toBe(true);
    expect(Object.isFrozen(prepared.normalizedRequest)).toBe(true);
    expect(Object.isFrozen(prepared.normalizedRequest.content)).toBe(true);
    expect(Object.isFrozen(prepared.normalizedRequest.content.blocks)).toBe(true);
    expect(Object.isFrozen(preparedBlock)).toBe(true);
    expect(Object.isFrozen(prepared.normalizedRequest.context?.messages)).toBe(true);
    expect(Object.isFrozen(prepared.normalizedRequest.params)).toBe(true);
    expect(Object.isFrozen(prepared.providerRequest)).toBe(true);
    expect(Object.isFrozen(prepared.providerRequest.attachments)).toBe(true);
    expect(Object.isFrozen(prepared.providerRequestPreview)).toBe(true);
    expect(Object.isFrozen(previewAttachments)).toBe(true);
    expect(result.adapter).toBeDefined();
    expect(Object.isFrozen(result.adapter)).toBe(false);
    expect(Object.isFrozen(originalBlock)).toBe(false);
    expect(Object.isFrozen(originalParams)).toBe(false);
    expect(preparedBlock).not.toBe(originalBlock);

    expect(() => {
      (prepared.normalizedRequest.attachmentIds as unknown as string[]).push("late-attachment");
    }).toThrow(TypeError);
    expect(() => {
      (prepared.normalizedRequest.params as Record<string, unknown>).temperature = 1;
    }).toThrow(TypeError);
    expect(() => {
      (preparedBlock as Record<string, unknown>).text = "late mutation";
    }).toThrow(TypeError);

    originalBlock.text = "changed outside preparation";
    originalParams.temperature = 0.25;
    expect(preparedBlock.text).toBe("Shared question");
    expect(prepared.normalizedRequest.params.temperature).toBe(0.5);
    expect(prepared.normalizedRequest.content).toBe(prepared.providerRequest.content);
    expect(prepared.normalizedRequest.context).toBe(prepared.providerRequest.context);

    const materialized = materializePreparedRunData(prepared);
    expect(Object.isFrozen(materialized.normalizedRequest)).toBe(false);
    expect(Object.isFrozen(materialized.providerRequest)).toBe(false);
    materialized.normalizedRequest.content.blocks.push({ text: "execution-only", type: "text" });
    (materialized.providerRequest.content.blocks[0] as Record<string, unknown>).text = "provider-only";
    expect(prepared.normalizedRequest.content.blocks).toHaveLength(1);
    expect(materialized.normalizedRequest.content).not.toBe(materialized.providerRequest.content);
    expect((materialized.normalizedRequest.content.blocks[0] as Record<string, unknown>).text).toBe(
      "Shared question"
    );
  });

  it("resolves selected Skills server-side and binds immutable revisions into the run", async () => {
    const harness = createHarness();
    const resolveForRun = vi.fn(async () => ({
      ok: true as const,
      skills: [{
        instructions: "Verify every factual claim before answering.",
        name: "Careful editor",
        revisionId: "skill-revision-2",
        skillId: "skill-editor"
      }, {
        instructions: "End with a short action list.",
        name: "Action closer",
        revisionId: "skill-revision-4",
        skillId: "skill-actions"
      }]
    }));
    const prepared = preparedFrom(await prepareRun(
      { ...harness.deps, skills: { resolveForRun } },
      sendInput(successBody({ skillIds: ["skill-editor", "skill-actions"] }))
    ));

    expect(resolveForRun).toHaveBeenCalledWith("user-1", ["skill-editor", "skill-actions"]);
    expect(prepared.skillBindings).toEqual([
      { alias: "careful-editor", revisionId: "skill-revision-2", skillId: "skill-editor" },
      { alias: "action-closer", revisionId: "skill-revision-4", skillId: "skill-actions" }
    ]);
    expect(prepared.normalizedRequest.skills).toEqual({ version: 2, mode: "auto", available: [], pinned: [
      { alias: "careful-editor", fileCount: 0, name: "Careful editor", revisionId: "skill-revision-2", skillId: "skill-editor" },
      { alias: "action-closer", fileCount: 0, name: "Action closer", revisionId: "skill-revision-4", skillId: "skill-actions" }
    ] });
    expect(prepared.providerRequest.prompt.developer).not.toContain("Careful editor");
    expect(prepared.providerRequest.context?.messages.slice(-2)).toEqual([
      {
        content: {
          blocks: [{
            text: [
              "<selected_skills>",
              "  <skill name=\"Careful editor\" alias=\"careful-editor\" files=\"0\">",
              "Verify every factual claim before answering.",
              "  </skill>",
              "  <skill name=\"Action closer\" alias=\"action-closer\" files=\"0\">",
              "End with a short action list.",
              "  </skill>",
              "</selected_skills>"
            ].join("\n"),
            type: "text"
          }]
        },
        id: "skill-context:current-user-message",
        purpose: "skill_context",
        role: "user"
      },
      {
        content: { blocks: [{ text: "Shared question", type: "text" }] },
        id: "current-user-message",
        role: "user"
      }
    ]);
    expect(JSON.stringify(prepared.providerRequestPreview)).not.toContain(
      "Verify every factual claim"
    );
    expect(JSON.stringify(prepared.providerRequestPreview)).toContain(
      "[selected Skill instructions omitted]"
    );
  });

  it("admits an Auto catalog without its bodies and retains pinned files under Off or tool degradation", async () => {
    const h = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const pinned = { skillId: "p", revisionId: "p-r", name: "pinned", instructions: "PINNED_SECRET", fileCount: 1,
      files: [{ path: "references/p.md", byteSize: 42, kind: "text" as const, executable: false }] };
    const skills = { resolveForRun: vi.fn(async () => ({ ok: true as const, skills: [pinned] })),
      listEnabledForRun: vi.fn(async () => [{ skillId: "a", revisionId: "a-r", name: "available", description: "CATALOG_SECRET", fileCount: 1 }]),
      loadedBeforeForMessages: vi.fn(async () => ["a"]) };
    const auto = preparedFrom(await prepareRun({ ...h.deps, skills }, sendInput(successBody({ skillIds: ["p"] }))));
    expect(auto.normalizedRequest.skills).toMatchObject({ version: 2, mode: "auto", tools: "load_and_read", available: [{ skillId: "a", loadedBefore: true }] });
    expect(auto.providerRequest.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["load_skill", "read_skill_file"]));
    expect(auto.providerRequest.context?.messages.slice(-3).map((message) => message.purpose)).toEqual(["skill_context", "skill_catalog", undefined]);
    expect(JSON.stringify(auto.providerRequestPreview)).not.toMatch(/PINNED_SECRET|CATALOG_SECRET|references\/p.md/);
    const off = preparedFrom(await prepareRun({ ...h.deps, skills }, sendInput(successBody({ skillIds: ["p"], skills: { mode: "off" } }))));
    expect(off.normalizedRequest.skills).toMatchObject({ mode: "off", tools: "read", available: [] });
    expect(off.providerRequest.tools?.map((tool) => tool.name)).toContain("read_skill_file");
    expect(off.providerRequest.tools?.map((tool) => tool.name)).not.toContain("load_skill");
    const none = preparedFrom(await prepareRun({ ...h.deps, skills }, sendInput(successBody({ skillIds: ["p"], tools: "none" }))));
    expect(none.normalizedRequest.skills).toMatchObject({ available: [], pinned: [{ skillId: "p" }] });
    expect(none.providerRequest.tools?.some((tool) => tool.capability === "skill")).toBe(false);
    expect(JSON.stringify(none.providerRequest.context)).toContain("PINNED_SECRET");
  });

  it.each(["send", "regenerate"] as const)("freezes only the complete authorized relevance selection for %s, preserving pins and aliases", async kind => {
    const h = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const pinned = { skillId: "p", revisionId: "p-r", name: "Procedure 1", instructions: "PINNED_BODY", fileCount: 1 };
    const available = Array.from({ length: 40 }, (_, index) => ({ skillId: `s${index}`, revisionId: `r${index}`,
      name: `Procedure ${index}`, description: `Task ${index}`, instructions: "AVAILABLE_BODY" }));
    const skills = { resolveForRun: vi.fn(async () => ({ ok: true as const, skills: [pinned] })),
      listEnabledForRun: vi.fn(async () => available), loadedBeforeForMessages: vi.fn(async () => ["s1"]) };
    const input = (kind === "send" ? sendInput : regenerateInput)(successBody({ skillIds: ["p"] }));
    const baseline = preparedFrom(await prepareRun({ ...h.deps, skills }, input));
    const authorizeScope = vi.fn(async () => undefined);
    const relevance = vi.fn<NonNullable<RunPreparationDeps["skillCatalogRelevance"]>>(async decision => {
      expect(decision.query).toBe("Shared question");
      expect(decision.operationKey).toBe("admission-identity");
      expect(decision.candidates).toHaveLength(40);
      await decision.authorize();
      return ["s2", "s1"];
    });
    const filtered = preparedFrom(await prepareRun({ ...h.deps, skills, skillCatalogRelevance: relevance }, {
      ...input, skillCatalogDecision: { operationKey: "admission-identity", authorizeScope }
    }));
    expect(relevance).toHaveBeenCalledOnce();
    expect(authorizeScope).toHaveBeenCalledTimes(2);
    expect(filtered.normalizedRequest.skills).toMatchObject({ version: 2, pinned: decodeFrozenSkillManifest(baseline.normalizedRequest.skills)!.pinned,
      available: [{ skillId: "s2", alias: "procedure-2" }, { skillId: "s1", alias: "procedure-1-2", loadedBefore: true }] });
    expect(filtered.skillBindings?.map(binding => binding.skillId)).toEqual(["p"]);
    expect(JSON.stringify(filtered.providerRequest.context)).toContain("PINNED_BODY");
    expect(JSON.stringify(filtered.providerRequest.context)).not.toContain("AVAILABLE_BODY");
    const frozen = JSON.stringify(filtered.normalizedRequest.skills);
    available[1]!.revisionId = "later-revision";
    expect(JSON.stringify(filtered.normalizedRequest.skills)).toBe(frozen);
  });

  it("keeps fallback preparation byte-identical and never filters Off or unsupported catalogs", async () => {
    const h = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const skills = { resolveForRun: vi.fn(async () => ({ ok: true as const, skills: [] })),
      listEnabledForRun: vi.fn(async () => [{ skillId: "a", revisionId: "r", name: "A", description: "Task A" }]) };
    const relevance = vi.fn<NonNullable<RunPreparationDeps["skillCatalogRelevance"]>>(async () => null);
    const input = sendInput();
    const baseline = preparedFrom(await prepareRun({ ...h.deps, skills }, input));
    const authority = { operationKey: "fallback-admission", authorizeScope: vi.fn(async () => undefined) };
    const fallback = preparedFrom(await prepareRun({ ...h.deps, skills, skillCatalogRelevance: relevance }, { ...input, skillCatalogDecision: authority }));
    expect(JSON.stringify(fallback.normalizedRequest.skills)).toBe(JSON.stringify(baseline.normalizedRequest.skills));
    expect(JSON.stringify(fallback.providerRequest.context)).toBe(JSON.stringify(baseline.providerRequest.context));
    expect(authority.authorizeScope).not.toHaveBeenCalled();
    for (const body of [{ skills: { mode: "off" } }, { tools: "none" }]) {
      await prepareRun({ ...h.deps, skills, skillCatalogRelevance: relevance }, { ...sendInput(successBody(body)), skillCatalogDecision: authority });
    }
    expect(relevance).toHaveBeenCalledOnce();
  });

  it.each(["scope", "catalog", "pin"] as const)("rejects changed %s authority instead of hiding it behind relevance fallback", async changed => {
    const h = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const pinned = { skillId: "p", revisionId: "pr", name: "Pin", instructions: "Pinned" };
    const skill = { skillId: "a", revisionId: "ar", name: "Available", description: "Available task" };
    const skills = { resolveForRun: vi.fn(async () => ({ ok: true as const, skills: [pinned] })),
      listEnabledForRun: vi.fn(async () => [skill]) };
    const authorizeScope = vi.fn(async () => undefined);
    const relevance: NonNullable<RunPreparationDeps["skillCatalogRelevance"]> = async decision => {
      if (changed === "scope") authorizeScope.mockRejectedValueOnce(new SkillCatalogAuthorityChangedError());
      else if (changed === "catalog") skills.listEnabledForRun.mockResolvedValueOnce([]);
      else skills.resolveForRun.mockResolvedValueOnce({ ok: true, skills: [{ ...pinned, revisionId: "new" }] });
      await decision.authorize();
      return [];
    };
    expect(await prepareRun({ ...h.deps, skills, skillCatalogRelevance: relevance }, {
      ...sendInput(successBody({ skillIds: ["p"] })), skillCatalogDecision: { operationKey: "changed-admission", authorizeScope }
    })).toMatchObject({ ok: false, code: "skill_not_available", status: 404 });
  });

  it("rejects an unavailable required Project Skill before optional relevance can hide it", async () => {
    const h = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const relevance = vi.fn<NonNullable<RunPreparationDeps["skillCatalogRelevance"]>>(async () => []);
    const skills = { resolveForRun: vi.fn(async () => ({ ok: true as const, skills: [] })),
      resolveForProject: vi.fn(async () => ({ ok: false as const, code: "skill_not_available" as const, status: 404 as const })) };
    const result = await prepareRun({ ...h.deps, skills, skillCatalogRelevance: relevance }, {
      ...sendInput(successBody(), { project: projectAdmission({ skillIds: ["required"] }) }),
      skillCatalogDecision: { operationKey: "project-admission", authorizeScope: async () => undefined }
    });
    expect(result).toMatchObject({ ok: false, code: "skill_not_available" });
    expect(relevance).not.toHaveBeenCalled();
    expect(skills.resolveForRun).not.toHaveBeenCalled();
  });

  it("fails before snapshotting unsupported Buffer data without mutating it", async () => {
    const opaqueBuffer = Buffer.from("leave-buffer-mutable");
    const harness = createHarness();

    await expect(
      prepareRun(
        harness.deps,
        sendInput(
          successBody({
            content: {
              blocks: [{ opaqueBuffer, text: "Shared question", type: "text" }]
            }
          })
        )
      )
    ).rejects.toThrow("prepared_run_snapshot_requires_plain_data");
    expect(Object.isFrozen(opaqueBuffer)).toBe(false);
    expect(opaqueBuffer.toString()).toBe("leave-buffer-mutable");
  });

  it("keeps natural-language Memory control out of the answer-model tool set", async () => {
    const harness = createHarness({
      capabilities: {
        ...baseCapabilities,
        toolCalling: true
      }
    });
    const prepared = preparedFrom(await prepareRun(
      harness.deps,
      sendInput(successBody({
        content: textMessageContent("Remember that my favorite color is teal")
      }))
    ));

    expect(prepared.normalizedRequest.memoryActionTools).toBeUndefined();
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session") ?? []).toEqual([]);
  });

  it("does not invent a language fallback when the answer model lacks tool calling", async () => {
    const prepared = preparedFrom(await prepareRun(
      createHarness().deps,
      sendInput(successBody({
        content: textMessageContent("Remember that my favorite color is teal")
      }))
    ));

    expect(prepared.normalizedRequest.memoryActionTools).toBeUndefined();
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session") ?? []).toEqual([]);
  });

  it("lets a direct-user Memory action coexist with admin-connected tools", async () => {
    const harness = createHarness({
      capabilities: {
        ...baseCapabilities,
        backgroundStreaming: true,
        nativeBackground: true,
        parallelToolCalls: true,
        toolCalling: true
      },
      defaultParams: { background: true, maxOutputTokens: 512, stream: true },
      mcpPlan: readyMcpPlan()
    });
    const prepared = preparedFrom(await prepareRun(
      harness.deps,
      sendInput(successBody({
        content: textMessageContent("Remember that my favorite color is teal"),
        mcp: { mode: "load_all" },
        modelId: "openai-tool-model",
        params: { background: true, stream: true },
        provider: "openai"
      }))
    ));

    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
      "mcp_team_lookup_1"
    ]);
  });

  it("accepts the reviewed Temporary policy only on an empty first send", async () => {
    const result = await prepareRun(
      createHarness().deps,
      sendInput(
        successBody({
          chatMode: "TEMPORARY",
          temporaryRetentionPolicyVersion: "temporary-24h-v1"
        }),
        {
          activeLeafMessageId: null,
          memoryMode: "NORMAL",
          messageCount: 0
        }
      )
    );

    const prepared = materializePreparedRunData(preparedFrom(result));
    expect(prepared.initialChatMode).toEqual({
      chatMode: "TEMPORARY",
      temporaryRetentionPolicyVersion: "temporary-24h-v1"
    });
    expect(prepared.normalizedRequest.prompt.system).not.toContain("Project memory:");
    expect(prepared.normalizedRequest.prompt.system).not.toContain("Server project memory");
    expect(prepared.normalizedRequest.prompt.memoryActionAnswerResult).toEqual(
      MEMORY_ACTION_NO_COMMIT_RESULT
    );
  });

  it("rejects stale policy acknowledgement and late Temporary conversion", async () => {
    const stalePolicy = await prepareRun(
      createHarness().deps,
      sendInput(successBody({
        chatMode: "TEMPORARY",
        temporaryRetentionPolicyVersion: "temporary-invalid"
      }), { activeLeafMessageId: null, memoryMode: "NORMAL", messageCount: 0 })
    );
    const lateConversion = await prepareRun(
      createHarness().deps,
      sendInput(successBody({
        chatMode: "TEMPORARY",
        temporaryRetentionPolicyVersion: "temporary-24h-v1"
      }), { memoryMode: "NORMAL", messageCount: 2 })
    );

    expect(stalePolicy).toMatchObject({
      code: "memory_temporary_policy_review_required",
      ok: false,
      status: 409
    });
    expect(lateConversion).toMatchObject({
      code: "memory_temporary_chat_forbidden",
      ok: false,
      status: 409
    });
  });

  it("does not expose Memory tools in an admitted Temporary chat", async () => {
    const prepared = preparedFrom(await prepareRun(
      createHarness({
        capabilities: { ...baseCapabilities, toolCalling: true }
      }).deps,
      sendInput(
        successBody({
          content: textMessageContent("Remember that my favorite color is teal")
        }),
        { memoryMode: "TEMPORARY", messageCount: 2 }
      )
    ));

    expect(prepared.normalizedRequest.memoryActionTools).toBeUndefined();
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session") ?? []).toEqual([]);
  });

  it.each(["Europe/Berlin", "Invalid/Zone", undefined])("renders the default preview from the ordinary-run instructions: %s", async timeZone => {
    await withFrozenClock(async () => {
      const prepared = preparedFrom(await prepareRun(createHarness().deps, sendInput(successBody({ timeZone }))));
      const handlers = createInstructionPreviewHandlers({
        resolveAuth: vi.fn().mockResolvedValue({ userId: "owner", user: { status: "active" } })
      });
      const query = timeZone === undefined ? "" : `?timeZone=${encodeURIComponent(timeZone)}`;
      const response = await handlers.GET(new Request(`http://localhost/api/me/instructions/preview${query}`));
      const { preview } = await response.json();
      expect(response.status).toBe(200);
      expect(preview.baseline.renderedSystemPrompt).toBe(prepared.normalizedRequest.prompt.system);
      expect(preview.visibleAnswerContract).toBe(prepared.normalizedRequest.prompt.developer);
      expect(preview.generatedAt).toBe(new Date().toISOString());
      expect(preview.baseline.timeZone).toBe(prepared.normalizedRequest.prompt.baseline?.timeZone);
      expect(preview.baseline.timeZoneSource).toBe(prepared.normalizedRequest.prompt.baseline?.timeZoneSource);
    });
  });

  it("keeps send and regeneration preparation in parity while using their server-owned context sources", async () => {
    const sendHarness = createHarness();
    const regenerateHarness = createHarness();
    const [sendPrepared, regeneratePrepared, expectedBaseline] = await withFrozenClock(
      async () =>
        [
          preparedFrom(await prepareRun(sendHarness.deps, sendInput())),
          preparedFrom(
            await prepareRun(regenerateHarness.deps, regenerateInput(successBody({ text: "Ignored client text" })))
          ),
          resolveStandardChatBaseline({ timeZone: "Europe/Berlin" })
        ] as const
    );
    const { context: sendContext, ...sendNormalized } = sendPrepared.normalizedRequest;
    const { context: regenerateContext, ...regenerateNormalized } = regeneratePrepared.normalizedRequest;

    expect(sendNormalized).toEqual(regenerateNormalized);
    expect(sendContext?.messages.map((message) => ({ content: message.content, role: message.role }))).toEqual(
      regenerateContext?.messages.map((message) => ({ content: message.content, role: message.role }))
    );
    expect(sendContext?.messages.map((message) => message.id)).toEqual([
      "prior-user-message",
      "current-user-message"
    ]);
    expect(regenerateContext?.messages.map((message) => message.id)).toEqual([
      "prior-user-message",
      "stored-user-message"
    ]);
    expect(sendContext?.messages.some((message) => message.id === "client-context")).toBe(false);
    expect(regenerateContext?.messages.some((message) => message.id === "client-context")).toBe(false);
    expect(sendPrepared.normalizedRequest.prompt).toEqual({
      baseline: {
        source: "standard_chat",
        timeZone: "Europe/Berlin",
        timeZoneSource: "client"
      },
      developer: expect.stringContaining("Visible answer contract:"),
      memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
      responseReminder: "",
      system: expectedBaseline.renderedSystemPrompt
    });
    expect(sendPrepared.normalizedRequest.prompt.system).toContain("You are a helpful AI assistant. Today is ");
    expect(sendPrepared.normalizedRequest.prompt.system).not.toContain("Client system prompt");
    expect(sendPrepared.normalizedRequest.prompt.developer).not.toContain("Client developer prompt");
    expect(regeneratePrepared.normalizedRequest.prompt).toEqual(sendPrepared.normalizedRequest.prompt);
    expect(sendPrepared.defaults).toEqual(regeneratePrepared.defaults);
    expect(sendPrepared.defaults).toEqual({
      controlDefaults: {
        maxOutputTokens: "8192",
        reasoningEffort: "high",
        temperature: "0"
      },
      modelId: "fake-qsa",
      provider: "fake",
      searchPlan: {
        mode: "all_selected",
        optionIds: []
      },
      userId: "user-1"
    });
    expect(sendPrepared.sourceKind).toBe("send");
    expect(regeneratePrepared.sourceKind).toBe("regenerate");
    expect(sendHarness.calls).toEqual([
      "entitlements",
      "capabilities",
      "context:send"
    ]);
    expect(regenerateHarness.calls).toEqual([
      "entitlements",
      "capabilities",
      "context:regenerate"
    ]);
    expect(sendHarness.entitlementLoads).toEqual(["user-1"]);
    expect(regenerateHarness.entitlementLoads).toEqual(["user-1"]);
    expect(sendHarness.sendContextLoads).toEqual([{ chatId: "chat-1", userId: "user-1" }]);
    expect(sendHarness.regenerateContextLoads).toEqual([]);
    expect(regenerateHarness.sendContextLoads).toEqual([]);
    expect(regenerateHarness.regenerateContextLoads).toEqual([
      { chatId: "chat-1", leafMessageId: "stored-user-message", userId: "user-1" }
    ]);
  });

  it("falls back to the recorded UTC baseline when the client time zone is unusable", async () => {
    const [invalidZone, missingZone, expectedBaseline] = await withFrozenClock(
      async () =>
        [
          preparedFrom(
            await prepareRun(createHarness().deps, sendInput(successBody({ timeZone: "Invalid/Zone" })))
          ),
          preparedFrom(
            await prepareRun(createHarness().deps, sendInput(successBody({ timeZone: undefined })))
          ),
          resolveStandardChatBaseline({})
        ] as const
    );

    for (const prepared of [invalidZone, missingZone]) {
      expect(prepared.normalizedRequest.prompt).toEqual({
        baseline: {
          source: "standard_chat",
          timeZone: "UTC",
          timeZoneSource: "utc_fallback"
        },
        developer: expect.stringContaining("Visible answer contract:"),
        memoryActionAnswerResult: MEMORY_ACTION_NO_COMMIT_RESULT,
        responseReminder: "",
        system: expectedBaseline.renderedSystemPrompt
      });
    }
  });

  it("uses chat defaults for sends and stored assistant defaults/content for regeneration", async () => {
    const sendHarness = createHarness();
    const regenerateHarness = createHarness();
    const body = successBody({
      content: textMessageContent("Client replacement content"),
      params: {},
      prompt: {}
    });
    const sendPrepared = preparedFrom(await prepareRun(sendHarness.deps, sendInput(body)));
    const regeneratePrepared = preparedFrom(
      await prepareRun(
        regenerateHarness.deps,
        regenerateInput(body, {
          assistantMessage: {
            modelId: "assistant-model",
            provider: "openrouter"
          },
          userMessage: {
            content: textMessageContent("Stored regeneration content"),
            id: "stored-user-message"
          }
        })
      )
    );

    expect(sendPrepared.normalizedRequest).toMatchObject({
      content: textMessageContent("Client replacement content"),
      modelId: "fake-qsa",
      provider: "fake"
    });
    expect(regeneratePrepared.normalizedRequest).toMatchObject({
      content: textMessageContent("Stored regeneration content"),
      modelId: "assistant-model",
      provider: "openrouter"
    });
    expect(sendHarness.capabilityLoads).toEqual([{ modelId: "fake-qsa", provider: "fake" }]);
    expect(regenerateHarness.capabilityLoads).toEqual([
      { modelId: "assistant-model", provider: "openrouter" }
    ]);
  });

  it("loads the edited branch's stored attachment for regeneration", async () => {
    const attachment = runAttachment({
      id: "edited-document", kind: "document", mimeType: "text/plain",
      storageKey: "private/original-document", extractedText: "Original document evidence"
    });
    const edited = {
      id: "edited-user-message", role: "user" as const,
      content: { blocks: [
        { type: "text", text: "Corrected question" },
        { type: "file", attachmentId: attachment.id, fileName: attachment.fileName }
      ] }
    };
    const harness = createHarness({ attachments: [attachment], regenerateContext: [priorMessage, edited] });

    const prepared = preparedFrom(await prepareRun(harness.deps, regenerateInput(
      successBody({ text: "Ignored client replacement" }), { userMessage: edited }
    )));

    expect(prepared.normalizedRequest.content).toEqual(edited.content);
    expect(prepared.normalizedRequest.attachmentIds).toEqual([attachment.id]);
    expect(prepared.providerRequest.attachments).toEqual([
      expect.objectContaining({ id: attachment.id, extractedText: "Original document evidence" })
    ]);
    expect(harness.regenerateContextLoads).toEqual([{
      chatId: "chat-1", leafMessageId: edited.id, userId: "user-1"
    }]);
  });

  it("merges catalog defaults while keeping OpenRouter routing and privacy policy server-authoritative", async () => {
    const policy = {
      allowFallbacks: false,
      dataCollection: "deny",
      order: ["anthropic"],
      only: ["Anthropic"],
      requireParameters: true,
      sort: "throughput",
      zdr: true
    };
    const harness = createHarness({
      defaultParams: {
        maxTokens: 512,
        provider: policy,
        reasoning: {
          effort: "high",
          enabled: true,
          exclude: false,
          maxTokens: 0
        },
        stream: true
      }
    });
    const prepared = preparedFrom(
      await prepareRun(
        harness.deps,
        sendInput(
          successBody({
            modelId: "openrouter-answer-model",
            params: {
              maxTokens: 256,
              provider: {
                allowFallbacks: true,
                dataCollection: "allow",
                only: ["Untrusted route"],
                zdr: false
              },
              reasoning: {
                effort: "low"
              },
              stream: false
            },
            provider: "openrouter"
          })
        )
      )
    );

    expect(prepared.normalizedRequest.params).toEqual({
      temperature: 1,
      maxOutputTokens: 256,
      provider: policy,
      reasoning: {
        effort: "low",
        enabled: true,
        exclude: false,
        maxTokens: 0
      },
      stream: false
    });

    const defaultsOnly = preparedFrom(
      await prepareRun(
        createHarness({
          defaultParams: {
            maxTokens: 512,
            provider: policy,
            stream: true
          }
        }).deps,
        sendInput(
          successBody({
            modelId: "openrouter-answer-model",
            params: undefined,
            provider: "openrouter"
          })
        )
      )
    );
    expect(defaultsOnly.normalizedRequest.params).toEqual({
      temperature: 1,
      maxOutputTokens: 512,
      provider: policy,
      stream: true
    });

    const trustedUnsupportedDefault = await prepareRun(
      createHarness({
        defaultParams: {
          provider: policy,
          temperature: 1
        }
      }).deps,
      sendInput(
        successBody({
          modelId: "anthropic/claude-opus-4.8",
          params: undefined,
          provider: "openrouter"
        })
      )
    );
    expect(trustedUnsupportedDefault.ok).toBe(true);
    expect(preparedFrom(trustedUnsupportedDefault).normalizedRequest.params.temperature).toBe(1);
  });

  it.each([
    {
      capabilities: { toolCalling: false },
      expectedCode: "mcp_tool_calling_not_supported",
      params: {}
    },
    {
      capabilities: { nativeBackground: false, toolCalling: true },
      expectedCode: "mcp_background_not_supported",
      params: { background: true }
    },
    {
      capabilities: {
        backgroundStreaming: false,
        nativeBackground: true,
        toolCalling: true
      },
      expectedCode: "mcp_background_streaming_not_supported",
      params: { background: true, stream: true }
    }
  ])("fails MCP preflight with $expectedCode", async ({ capabilities, expectedCode, params }) => {
    const harness = createHarness({
      capabilities: { ...baseCapabilities, ...capabilities },
      defaultParams: { background: false, maxOutputTokens: 512, stream: true },
      mcpPlan: readyMcpPlan()
    });
    const result = await prepareRun(
      harness.deps,
      sendInput(successBody({
        mcp: { mode: "load_all" },
        modelId: "openai-tool-model",
        params,
        provider: "openai"
      }))
    );

    expect(result).toMatchObject({ code: expectedCode, ok: false, status: 400 });
  });

  it("skips the persisted MCP plan when the run explicitly suppresses tools", async () => {
    const harness = createHarness({
      capabilities: { ...baseCapabilities, toolCalling: false },
      mcpPlan: readyMcpPlan()
    });
    const result = await prepareRun(
      harness.deps,
      sendInput(successBody({ tools: "none" }))
    );
    const prepared = preparedFrom(result);

    expect(prepared.normalizedRequest.mcp).toBeUndefined();
    expect(prepared.mcpBindings).toBeUndefined();
  });

  it("freezes current artifact capabilities independently of subsequent resource policy changes", async () => {
    const artifacts = { contextForChat: async () => [] } as unknown as NonNullable<RunPreparationDeps["artifacts"]>;
    const harness = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const body = successBody({ modelId: "openai-tool-model", provider: "openai" });
    try {
      vi.stubEnv("AIQSA_ARTIFACT_EXTERNAL_RESOURCES", "on");
      vi.stubEnv("AIQSA_ARTIFACT_LIBRARY_HOSTS", "cdnjs.cloudflare.com");
      vi.stubEnv("AIQSA_ARTIFACT_IMAGE_HOSTS", "images.example.com");
      const accepted = preparedFrom(await prepareRun({ ...harness.deps, artifacts }, sendInput(body)));
      const description = accepted.normalizedRequest.artifactToolDescription;
      expect(description).toContain("Every kind except image also requires an explicit entrypoint matching an included files[].path");
      expect(description).toContain("Omit entrypoint to keep the base version's startup file");
      expect(description).toContain("cdnjs.cloudflare.com");
      expect(description).toContain("images.example.com");
      expect(description).not.toContain("fonts.gstatic.com");
      expect(description).not.toContain("Google Fonts");
      expect(description).not.toContain("jsDelivr");
      expect(description).toContain("Forms may handle submit in JavaScript");
      expect(accepted.providerRequest.tools).toContainEqual(expect.objectContaining({ name: "create_artifact", description }));
      vi.stubEnv("AIQSA_ARTIFACT_EXTERNAL_RESOURCES", "off");
      const later = preparedFrom(await prepareRun({ ...harness.deps, artifacts }, sendInput(body)));
      expect(later.normalizedRequest.artifactToolDescription).toContain("New external resource downloads are disabled");
      expect(later.normalizedRequest.artifactToolDescription).toContain("localStorage persists");
      expect(later.normalizedRequest.artifactToolDescription).not.toContain("images.example.com");
      expect(accepted.normalizedRequest.artifactToolDescription).toBe(description);
    } finally { vi.unstubAllEnvs(); }
  });

  it("freezes explicit artifact creation and rejects incompatible or malformed intent", async () => {
    const artifacts = { contextForChat: async () => [] } as unknown as NonNullable<RunPreparationDeps["artifacts"]>;
    const harness = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const body = successBody({ modelId: "openai-tool-model", provider: "openai", artifactIntent: "create" });
    const prepared = preparedFrom(await prepareRun({ ...harness.deps, artifacts }, sendInput(body)));
    expect(prepared.normalizedRequest.artifactIntent).toBe("create");
    expect(prepared.normalizedRequest.prompt.system).toContain("The user explicitly asked for an artifact: call create_artifact");
    expect(prepared.providerRequest.tools).toContainEqual(expect.objectContaining({ name: "create_artifact" }));
    expect(prepared.providerRequest.toolChoice).not.toEqual({ type: "function", name: "create_artifact" });
    await expect(prepareRun({ ...harness.deps, artifacts }, sendInput({ ...body, artifactIntent: "other" }))).resolves.toMatchObject({ ok: false, code: "artifact_intent_invalid", status: 400 });
    await expect(prepareRun({ ...harness.deps, artifacts }, sendInput({ ...body, tools: "none" }))).resolves.toMatchObject({ ok: false, code: "artifact_intent_unavailable", status: 409 });
  });

  it("freezes an exact artifact edit target and revalidates it for regeneration", async () => {
    const artifactEdit = { artifactId: "artifact-one", versionId: "version-one" };
    const validateEditTarget = vi.fn(async () => ({ ok: true as const, ...artifactEdit }));
    const contextForChat = vi.fn(async () => [{ artifact_id: artifactEdit.artifactId,
      base_version_id: artifactEdit.versionId, kind: "html", title: "Page", version_number: 1,
      entrypoint: "index.html", files: [{ path: "index.html", mimeType: "text/html", text: "<p>Existing page</p>" }] }]);
    const artifacts = { validateEditTarget, contextForChat } as unknown as NonNullable<RunPreparationDeps["artifacts"]>;
    const harness = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const body = successBody({ modelId: "openai-tool-model", provider: "openai" });
    for (const request of [sendInput({ ...body, artifactEdit }), regenerateInput(body, { artifactEdit })]) {
      const prepared = preparedFrom(await prepareRun({ ...harness.deps, artifacts }, request));
      expect(prepared.normalizedRequest.artifactEdit).toEqual(artifactEdit);
      expect(prepared.normalizedRequest.artifactReferences).toContainEqual(artifactEdit);
      expect(prepared.normalizedRequest.artifactFocus).toEqual(artifactEdit);
      expect(Object.isFrozen(prepared.normalizedRequest.artifactFocus)).toBe(true);
      expect(prepared.normalizedRequest.prompt.system).toContain("The user's current message edits artifact_id=\"artifact-one\" from base_version_id=\"version-one\"");
      expect(prepared.normalizedRequest.content).toEqual(textMessageContent("Shared question"));
      expect(Object.isFrozen(prepared.normalizedRequest.artifactEdit)).toBe(true);
    }
    expect(validateEditTarget).toHaveBeenCalledTimes(2);
    expect(validateEditTarget).toHaveBeenLastCalledWith({ ...artifactEdit, chatId: "chat-1", ownerUserId: "user-1" });
    expect(contextForChat).toHaveBeenLastCalledWith({ chatId: "chat-1", ownerUserId: "user-1", requiredArtifactId: "artifact-one" });
  });

  it("rejects malformed, unavailable, stale, and missing-context explicit edit targets without substitution", async () => {
    const artifactEdit = { artifactId: "artifact-one", versionId: "version-one" };
    const harness = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const body = successBody({ modelId: "openai-tool-model", provider: "openai", artifactEdit });
    const validateEditTarget = vi.fn(async () => ({ ok: false as const, code: "artifact_edit_unavailable" as const }));
    const contextForChat = vi.fn(async () => []);
    const artifacts = { validateEditTarget, contextForChat } as unknown as NonNullable<RunPreparationDeps["artifacts"]>;
    expect(await prepareRun({ ...harness.deps, artifacts }, sendInput({ ...body, artifactEdit: { ...artifactEdit, versionId: "bad\n" } })))
      .toMatchObject({ ok: false, code: "artifact_edit_invalid", status: 400 });
    expect(validateEditTarget).not.toHaveBeenCalled();
    expect(await prepareRun({ ...harness.deps, artifacts }, sendInput(body)))
      .toMatchObject({ ok: false, code: "artifact_edit_unavailable", status: 404 });
    expect(contextForChat).not.toHaveBeenCalled();
    const staleArtifacts = { ...artifacts, validateEditTarget: vi.fn(async () => ({ ok: false as const, code: "artifact_version_conflict" as const })) };
    expect(await prepareRun({ ...harness.deps, artifacts: staleArtifacts }, regenerateInput(body)))
      .toMatchObject({ ok: false, code: "artifact_version_conflict", status: 409 });
    const missingContext = { ...artifacts, validateEditTarget: vi.fn(async () => ({ ok: true as const, ...artifactEdit })) };
    expect(await prepareRun({ ...harness.deps, artifacts: missingContext }, sendInput(body)))
      .toMatchObject({ ok: false, code: "artifact_edit_unavailable", status: 409 });
    expect(await prepareRun({ ...harness.deps, artifacts }, sendInput({ ...body, tools: "none" })))
      .toMatchObject({ ok: false, code: "artifact_edit_unavailable", status: 409 });
  });

  it("starts Auto with only schema-free discovery and no eager runtime plan", async () => {
    const harness = createHarness({
      capabilities: { ...baseCapabilities, toolCalling: true }
    });
    const prepare = vi.fn(async () => readyMcpPlan());
    const catalog = vi.fn(async () => ({
      servers: [{
        description: "Issue tracking",
        namespace: "jira",
        revisionId: "revision-jira",
        serverId: "server-jira",
        serverName: "Jira",
        tools: [{
          description: "Create an issue",
          namespacedName: "mcp_jira_create_issue_1",
          originalName: "create_issue"
        }]
      }],
      version: 1 as const
    }));
    const prepared = preparedFrom(await prepareRun(
      { ...harness.deps, mcp: { filterTools: allowMcpTools, catalog, prepare } },
      sendInput(successBody({ modelId: "openai-tool-model", provider: "openai" }))
    ));

    expect(catalog).toHaveBeenCalledWith("user-1");
    expect(prepare).not.toHaveBeenCalled();
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
      "find_tools"
    ]);
    expect(prepared.normalizedRequest.mcp).toBeUndefined();
    expect(prepared.mcpBindings).toBeUndefined();
    expect(JSON.stringify(prepared.normalizedRequest.mcpDiscovery?.catalog))
      .not.toContain("inputSchema");
  });

  it("keeps Off empty and materializes every enabled MCP in Load all", async () => {
    const harness = createHarness({
      capabilities: { ...baseCapabilities, toolCalling: true }
    });
    const prepare = vi.fn(async () => readyMcpPlan());
    const catalog = vi.fn(async () => ({ servers: [], version: 1 as const }));

    const off = preparedFrom(await prepareRun(
      { ...harness.deps, mcp: { filterTools: allowMcpTools, catalog, prepare } },
      sendInput(successBody({
        mcp: { mode: "off" },
        modelId: "openai-tool-model",
        provider: "openai"
      }))
    ));
    expect(off.normalizedRequest.mcp).toBeUndefined();
    expect(off.normalizedRequest.sessionStatusTool).toBe(true);
    expect(off.normalizedRequest.toolObservationVersion).toBe(0);
    expect(off.providerRequest.tools?.map((tool) => tool.name)).toEqual(["get_session_status"]);
    expect(off.normalizedRequest.mcpDiscovery).toBeUndefined();
    expect(off.providerRequest.tools?.filter((tool) => tool.capability !== "session") ?? []).toEqual([]);
    expect(catalog).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();

    const loadAll = preparedFrom(await prepareRun(
      { ...harness.deps, mcp: { filterTools: allowMcpTools, catalog, prepare } },
      sendInput(successBody({
        mcp: { mode: "load_all" },
        modelId: "openai-tool-model",
        provider: "openai"
      }))
    ));
    expect(prepare).toHaveBeenCalledWith("user-1");
    expect(loadAll.normalizedRequest.mcpDiscovery).toBeUndefined();
    expect(loadAll.providerRequest.tools?.some((tool) => tool.name === "get_session_status")).toBe(true);
    expect(loadAll.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
      "mcp_team_lookup_1"
    ]);
  });

  it.each(["off", "v1"] as const)("freezes the operator observation policy at acceptance: %s", async policy => {
    const harness = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    const load = vi.fn(async () => ({ ...DEFAULT_TOOL_RUN_BUDGETS, toolObservationPolicy: policy }));
    const deps = { ...harness.deps, runPolicy: { load } };
    const prepared = preparedFrom(await prepareRun(deps, sendInput(successBody({
      modelId: "openai-tool-model", provider: "openai"
    }))));
    expect(prepared.normalizedRequest.toolObservationVersion).toBe(policy === "v1" ? 1 : 0);
    expect(prepared.providerRequest.tools?.some(tool => tool.name === "read_tool_result")).toBe(policy === "v1");
  });

  it("rejects an irreducible hybrid current message at admission before a run exists", async () => {
    const harness = createHarness({ capabilities: { ...baseCapabilities, contextWindow: 20_000, defaultMaxOutputTokens: 512, toolCalling: true } });
    const load = vi.fn(async () => ({ ...DEFAULT_TOOL_RUN_BUDGETS, toolObservationPolicy: "v1" as const }));
    const deps = { ...harness.deps, runPolicy: { load } };
    const fitting = preparedFrom(await prepareRun(deps, sendInput(successBody({
      modelId: "openai-tool-model", provider: "openai"
    }))));
    expect(fitting.normalizedRequest.contextCompactionPolicy?.mode).toBe("hybrid");
    // About 30 000 estimated tokens: no summary or mask can make it fit.
    const result = await prepareRun(deps, sendInput(successBody({
      content: textMessageContent("q".repeat(121_000)), modelId: "openai-tool-model", provider: "openai"
    })));
    expect(result).toMatchObject({ code: "context_too_large", ok: false, status: 400 });
  });

  it("does not consult a new default for an already accepted run", async () => {
    const harness = createHarness({ capabilities: { ...baseCapabilities, toolCalling: true } });
    let policy: "off" | "v1" = "v1";
    const load = vi.fn(async () => ({ ...DEFAULT_TOOL_RUN_BUDGETS, toolObservationPolicy: policy }));
    const deps = { ...harness.deps, runPolicy: { load } };
    const accepted = preparedFrom(await prepareRun(deps, sendInput(successBody({
      modelId: "openai-tool-model", provider: "openai"
    }))));
    policy = "off";
    const later = preparedFrom(await prepareRun(deps, sendInput(successBody({
      modelId: "openai-tool-model", provider: "openai"
    }))));
    expect(accepted.normalizedRequest.toolObservationVersion).toBe(1);
    expect(accepted.providerRequest.tools?.some(tool => tool.name === "read_tool_result")).toBe(true);
    expect(later.normalizedRequest.toolObservationVersion).toBe(0);
    expect(later.providerRequest.tools?.some(tool => tool.name === "read_tool_result")).toBe(false);
  });

  it("accepts an MCP snapshot for a provider model with explicit effective tool capabilities", async () => {
    const mcpPlan = readyMcpPlan();
    const harness = createHarness({
      capabilities: {
        ...baseCapabilities,
        backgroundStreaming: true,
        nativeBackground: true,
        parallelToolCalls: true,
        toolCalling: true
      },
      defaultParams: { background: true, maxOutputTokens: 512, stream: true },
      mcpPlan
    });
    const result = await prepareRun(
      harness.deps,
      sendInput(successBody({
        mcp: { mode: "load_all" },
        modelId: "openai-tool-model",
        params: { background: true, stream: true },
        provider: "openai"
      }))
    );
    const prepared = preparedFrom(result);

    expect(prepared.normalizedRequest.mcp).toEqual(mcpPlan.ok ? mcpPlan.snapshot : undefined);
    expect(prepared.mcpBindings).toEqual(mcpPlan.ok ? mcpPlan.bindings : undefined);
  });

  it("retains an all-disabled MCP server snapshot without requiring tool calling or provider schemas", async () => {
    const base = readyMcpPlan();
    if (!base.ok) throw new Error("invalid MCP fixture");
    const mcpPlan: McpRunPlanResult = {
      ...base,
      snapshot: { ...base.snapshot, tools: [] }
    };
    const harness = createHarness({
      capabilities: { ...baseCapabilities, toolCalling: false },
      mcpPlan
    });

    const prepared = preparedFrom(await prepareRun(
      harness.deps,
      sendInput(successBody({
        mcp: { mode: "load_all" },
        modelId: "openai-no-tools",
        provider: "openai"
      }))
    ));

    expect(prepared.normalizedRequest.mcp).toEqual(mcpPlan.snapshot);
    expect(prepared.mcpBindings).toEqual(mcpPlan.bindings);
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session") ?? []).toEqual([]);
  });

  it.each(["openai_responses_compatible", "openai_chat_completions_compatible"] as const)(
    "carries ordinary defaults and explicit overrides through admission into %s requests", async (adapterKind) => {
      for (const [ceiling, override, expected] of [[undefined, undefined, 65536], [8192, undefined, 8192],
        [131072, undefined, 65536], [131072, 1024, 1024]] as const) {
        const original = compatibleAdmissionPlan(adapterKind);
        const capabilities = { ...baseCapabilities, contextWindow: 272_000, defaultMaxOutputTokens: undefined, maxOutputTokens: ceiling };
        const plan: ProviderAdmissionPlan = { ...original, answer: { ...original.answer,
          modelConfiguration: { ...original.answer.modelConfiguration, capabilities, defaultParams: {} },
          snapshot: { ...original.answer.snapshot, model: { ...original.answer.snapshot.model, capabilities, defaultParams: {} } }
        } };
        const harness = createHarness();
        const prepared = preparedFrom(await prepareRun({ ...harness.deps, allowFakeProvider: false,
          providerAdmission: { async load() { return plan; } }
        }, sendInput(successBody({ modelId: plan.selection.providerModelId, provider: plan.selection.providerConnectionId,
          controlDefaults: {}, params: override ? { maxOutputTokens: override, temperature: 0.4 } : {}
        }))));
        const body = adapterKind === "openai_responses_compatible"
          ? buildOpenAIResponsesRequest(materializePreparedRunData(prepared).providerRequest)
          : buildOpenAICompatibleChatRequest(materializePreparedRunData(prepared).providerRequest);
        expect(body).toMatchObject({ [adapterKind === "openai_responses_compatible" ? "max_output_tokens" : "max_completion_tokens"]: expected,
          temperature: override ? 0.4 : 1 });
        expect(plan.answer.snapshot.model.capabilities.maxOutputTokens).toBe(ceiling);
      }
    });

  it.each([
    "openai_responses_compatible",
    "openai_chat_completions_compatible"
  ] as const)("keeps the accepted %s tool bridge with the opaque deployment", async (adapterKind) => {
    const plan = compatibleAdmissionPlan(adapterKind);
    const harness = createHarness({ mcpPlan: readyMcpPlan() });
    const result = await prepareRun(
      {
        ...harness.deps,
        allowFakeProvider: false,
        providerAdmission: { async load() { return plan; } }
      },
      sendInput(successBody({
        mcp: { mode: "load_all" },
        modelId: plan.selection.providerModelId,
        provider: plan.selection.providerConnectionId
      }))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const prepared = materializePreparedRunData(result.prepared);
    expect(result.toolBridge?.provider).toBe("openai_compatible");
    expect(result.toolBridge?.supportsToolCalling({
      modelId: prepared.normalizedRequest.modelId,
      provider: prepared.normalizedRequest.provider
    })).toBe(true);
    expect(prepared.normalizedRequest).toMatchObject({
      modelId: "vendor/model",
      provider: "openai_compatible"
    });
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
      "mcp_team_lookup_1"
    ]);
  });

  it("keeps declared hosted web search on a compatible Responses run", async () => {
    const optionId = "openai-native-web-search";
    const base = compatibleAdmissionPlan("openai_responses_compatible", {
      nativeSearch: true
    });
    const plan: ProviderAdmissionPlan = {
      ...base,
      requestedSearchPlan: { mode: "model_choice", optionIds: [optionId] },
      searches: [{
        bindingKey: null,
        configuration: {
          adapterKind: "answer_provider_hosted",
          config: { maxResults: 8, queryMaxCharacters: 500, timeoutMs: 15_000 },
          credentialMode: "answer_provider",
          displayName: "OpenAI Web Search",
          executionModes: ["model_choice"],
          kind: "openai_native_web_search",
          modelId: null,
          protocol: "openai_responses_web_search",
          provider: "openai_compatible",
          providerModelId: null,
          revisionId: "revision-hosted",
          searchStrategyRowId: "integration-hosted",
          strategyId: optionId
        },
        integrationId: "integration-hosted",
        optionId,
        ordinal: 0,
        revisionId: "revision-hosted"
      }]
    };
    const harness = createHarness();
    const result = await prepareRun(
      {
        ...harness.deps,
        allowFakeProvider: false,
        providerAdmission: { async load() { return plan; } }
      },
      sendInput(successBody({
        modelId: plan.selection.providerModelId,
        provider: plan.selection.providerConnectionId,
        searchPlan: plan.requestedSearchPlan
      }))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const prepared = materializePreparedRunData(result.prepared);
    expect(prepared.normalizedRequest.searchPlan).toMatchObject({
      mode: "model_choice",
      options: [expect.objectContaining({ optionId })]
    });
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session") ?? []).toEqual([]);
  });

  it("re-admits hosted Gemini Search as a client route when MCP tools must coexist", async () => {
    const { client, hosted, optionId } = nativeSearchCoexistencePlans(
      "gemini_interactions_native"
    );
    const admissionLoad = vi.fn(async (input: {
      requiresClientToolCoexistence?: boolean;
    }) => input.requiresClientToolCoexistence ? client : hosted);
    const attachment = runAttachment({
      extractedText: "Private MCP coexistence evidence",
      id: "document-mcp-search",
      kind: "document",
      mimeType: "text/plain",
      storageKey: "private/document-mcp-search"
    });
    const harness = createHarness({
      attachments: [attachment],
      mcpPlan: readyMcpPlan()
    });
    const result = await prepareRun(
      {
        ...harness.deps,
        allowFakeProvider: false,
        providerAdmission: { load: admissionLoad }
      },
      sendInput(successBody({
        content: {
          blocks: [
            { text: "Question with private evidence", type: "text" },
            { attachmentId: attachment.id, type: "attachment" }
          ]
        },
        mcp: { mode: "load_all" },
        modelId: hosted.selection.providerModelId,
        params: {},
        provider: hosted.selection.providerConnectionId,
        searchPlan: { mode: "model_choice", optionIds: [optionId] }
      }))
    );

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    expect(result.ok).toBe(true);
    const prepared = materializePreparedRunData(result.prepared);
    expect(admissionLoad).toHaveBeenCalledTimes(2);
    expect(admissionLoad.mock.calls[0]?.[0]).not.toHaveProperty(
      "requiresClientToolCoexistence"
    );
    expect(admissionLoad.mock.calls[1]?.[0]).toMatchObject({
      requiresClientToolCoexistence: true,
      searchPlan: { mode: "model_choice", optionIds: [optionId] }
    });
    expect(prepared.normalizedRequest.searchPlan).toMatchObject({
      mode: "model_choice",
      options: [expect.objectContaining({
        adapterKind: "provider_model_client",
        optionId,
        protocol: "gemini_google_search",
        provider: "gemini",
        providerModelId: hosted.selection.providerModelId
      })]
    });
    expect(JSON.stringify(prepared.providerRequestPreview)).not.toContain('"type":"google_search"');
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
      "search_engine_1",
      "mcp_team_lookup_1"
    ]);
    expect(harness.attachmentLoads).toEqual([{
      attachmentIds: [attachment.id],
      userId: "user-1"
    }]);
  });

  it("keeps the final coexistence answer binding for Knowledge plus Search", async () => {
    const { client, hosted, optionId } = nativeSearchCoexistencePlans(
      "gemini_interactions_native"
    );
    const finalModelId = "gemini-3.6-flash-final-binding";
    const finalCapabilities = {
      ...client.answer.modelConfiguration.capabilities,
      contextWindow: 65_536
    };
    const finalAnswer: ProviderAdmissionPlan["answer"] = {
      ...client.answer,
      modelConfiguration: {
        ...client.answer.modelConfiguration,
        capabilities: finalCapabilities
      },
      snapshot: {
        ...client.answer.snapshot,
        credentialVersionId: "credential-version-gemini-final",
        model: {
          ...client.answer.snapshot.model,
          capabilities: finalCapabilities,
          upstreamModelId: finalModelId
        }
      }
    };
    const finalClient: ProviderAdmissionPlan = {
      ...client,
      answer: finalAnswer,
      fingerprint: "9".repeat(64),
      searches: client.searches?.map((candidate) => ({
        ...candidate,
        ...(candidate.role ? { role: finalAnswer } : {})
      }))
    };
    const admissionLoad = vi.fn(async (input: {
      requiresClientToolCoexistence?: boolean;
    }) => input.requiresClientToolCoexistence ? finalClient : hosted);
    const harness = createHarness();
    const result = await prepareRun(
      {
        ...harness.deps,
        allowFakeProvider: false,
        knowledgeAdmission: {
          async load(input) {
            return admittedKnowledge(input, "8");
          }
        },
        providerAdmission: { load: admissionLoad }
      },
      sendInput(successBody({
        knowledgePlan: knowledgeSelection(["knowledge-base-1"]),
        modelId: hosted.selection.providerModelId,
        params: {},
        provider: hosted.selection.providerConnectionId,
        searchPlan: { mode: "model_choice", optionIds: [optionId] }
      }))
    );

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const prepared = materializePreparedRunData(result.prepared);
    expect(admissionLoad).toHaveBeenCalledOnce();
    expect(prepared.providerAdmissionPlan).toEqual(finalClient);
    expect(prepared.normalizedRequest).toMatchObject({
      modelCapabilities: {
        contextWindow: 65_536
      },
      modelId: finalModelId,
      provider: "gemini"
    });
    expect(prepared.normalizedRequest.searchPlan.options).toEqual([
      expect.objectContaining({ adapterKind: "provider_model_client", optionId })
    ]);
    expect(prepared.normalizedRequest).not.toHaveProperty("knowledgeFocusedRequest");
    expect(prepared.normalizedRequest.toolMode).toBe("auto");
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
      "search_knowledge",
      "search_engine_1"
    ]);
    expect(result.toolBridge?.provider).toBe("gemini");
  });

  it.each([
    {
      adapterKind: "gemini_interactions_native" as const,
      hostedPreviewMarker: '"google_search"',
      provider: "gemini",
      protocol: "gemini_google_search"
    },
    {
      adapterKind: "anthropic_messages" as const,
      hostedPreviewMarker: '"web_search_20250305"',
      provider: "anthropic",
      protocol: "anthropic_web_search"
    }
  ])(
    "composes Knowledge with client-routed $provider Search",
    async ({ adapterKind, hostedPreviewMarker }) => {
      const { client, hosted, optionId } = nativeSearchCoexistencePlans(adapterKind);
      const admissionLoad = vi.fn(async (input: {
        requiresClientToolCoexistence?: boolean;
      }) => input.requiresClientToolCoexistence ? client : hosted);
      const knowledgeLoad = vi.fn(async (input: KnowledgeAdmissionInput) =>
        admittedKnowledge(input, "c"));
      const harness = createHarness();
      const result = await prepareRun(
        {
          ...harness.deps,
          allowFakeProvider: false,
          knowledgeAdmission: { load: knowledgeLoad },
          providerAdmission: { load: admissionLoad }
        },
        sendInput(successBody({
          knowledgePlan: knowledgeSelection(["knowledge-base-1"]),
          modelId: hosted.selection.providerModelId,
          params: {},
          provider: hosted.selection.providerConnectionId,
          searchPlan: { mode: "model_choice", optionIds: [optionId] }
        }))
      );

      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      const prepared = materializePreparedRunData(result.prepared);
      expect(admissionLoad).toHaveBeenCalledOnce();
      expect(admissionLoad.mock.calls[0]?.[0]).toMatchObject({
        requiresClientToolCoexistence: true
      });
      expect(knowledgeLoad).toHaveBeenCalledWith({
        knowledgePlan: knowledgeSelection(["knowledge-base-1"]),
        userId: "user-1"
      });
      expect(prepared.normalizedRequest.searchPlan).toMatchObject({
        mode: "model_choice",
        options: [expect.objectContaining({ adapterKind: "provider_model_client", optionId })]
      });
      expect(prepared.providerAdmissionPlan).toEqual(client);
      expect(prepared.normalizedRequest).not.toHaveProperty("mcp");
      expect(prepared.normalizedRequest).not.toHaveProperty("memoryActionTools");
      expect(prepared.normalizedRequest).not.toHaveProperty("memoryHistoryTool");
      expect(prepared.normalizedRequest).not.toHaveProperty("knowledgeFocusedRequest");
      expect(prepared.normalizedRequest.toolMode).toBe("auto");
      expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
        "search_knowledge",
        "search_engine_1"
      ]);
      expect(JSON.stringify(prepared.providerRequestPreview)).not.toContain(
        hostedPreviewMarker
      );
      expect(prepared.defaults?.searchPlan).toEqual({
        mode: "model_choice",
        optionIds: [optionId]
      });
    }
  );

  it("fails selected Knowledge pre-provider when the answer model lacks tool calling", async () => {
    const harness = createHarness({
      capabilities: { ...baseCapabilities, contextWindow: 16_000, toolCalling: false }
    });
    const result = await prepareRun(
      {
        ...harness.deps,
        knowledgeAdmission: {
          async load(input) {
            return admittedKnowledge(input, "b", [{
                approxTokens: 1_200,
                baseContentRevision: 1,
                embeddingCredentialSource: "default" as const,
                embeddingExecutionSnapshot: {} as never,
                embeddingProviderModelId: "embedding-model-1",
                includeWholeBase: true,
                indexedContentRevision: 1,
                indexGenerationId: "generation-1",
                knowledgeBaseId: "knowledge-base-1",
                ordinal: 0,
                passageCount: 6,
                readySourceCount: 1,
                selectedSourceIds: [],
                sourceCount: 1,
                targetDimension: 1024,
                vectorSpaceFingerprint: "a".repeat(64)
              }]);
          }
        }
      },
      sendInput(successBody({
        content: textMessageContent("Summarize this source"),
        knowledgePlan: knowledgeSelection(["knowledge-base-1"])
      }))
    );

    expect(result).toMatchObject({
      code: "knowledge_tool_calling_not_supported",
      ok: false,
      status: 400
    });
  });

  it("uses the complete small corpus alongside MCP Auto without a Knowledge tool call", async () => {
    const sourceId = "00000000-0000-4000-8000-000000000011";
    const sourceVersionId = "00000000-0000-4000-8000-000000000012";
    const sourceArtifactId = "00000000-0000-4000-8000-000000000013";
    const harness = createHarness({
      capabilities: { ...baseCapabilities, contextWindow: 16_000, toolCalling: true },
      fullContextPassages: [{
        baseName: "Health",
        contentHash: "d".repeat(64),
        documentContext: null,
        headingPath: ["Lipid panel"],
        page: 1,
        pageEnd: 1,
        passageId: "passage-1",
        passageOrdinal: 0,
        sectionId: "section-1",
        sourceArtifactId,
        sourceId,
        sourceOrdinal: 0,
        sourceVersionId,
        sourceVersionNumber: 1,
        text: "Total cholesterol 5.3 mmol/L",
        tokenCount: 8
      }]
    });
    const catalog = vi.fn(async () => ({
      servers: [{
        description: "Issue tracking",
        namespace: "jira",
        revisionId: "revision-jira",
        serverId: "server-jira",
        serverName: "Jira",
        tools: [{
          description: "Create an issue",
          namespacedName: "mcp_jira_create_issue_1",
          originalName: "create_issue"
        }]
      }],
      version: 1 as const
    }));
    const prepareMcp = vi.fn(async () => readyMcpPlan());
    const prepared = preparedFrom(await prepareRun(
      {
        ...harness.deps,
        mcp: { filterTools: allowMcpTools, catalog, prepare: prepareMcp },
        knowledgeAdmission: {
          async load(input) {
            return {
              ...admittedKnowledge(input, "e"),
              answerPolicy: {
                fullContextThresholdBasisPoints: 7_000 as const,
                maximumKnowledgeSearches: 12,
                revision: 1,
                version: 1 as const
              },
              profiles: [{
                embeddingCredentialSource: "default" as const,
                embeddingExecutionSnapshot: {} as never,
                embeddingProviderModelId: "embedding-model-1",
                ordinal: 0,
                profileRevisionId: "profile-revision-1",
                targetDimension: 1_024,
                vectorSpaceFingerprint: "a".repeat(64)
              }],
              resolvedSourceCount: 1,
              sources: [{
                approxTokens: 8,
                authority: {
                  knowledgeBaseIds: ["knowledge-base-1"],
                  owner: true,
                  projectId: null
                },
                baseProvenance: [{
                  indexGenerationId: "generation-1",
                  knowledgeBaseId: "knowledge-base-1"
                }],
                directSelected: false,
                ordinal: 0,
                passageCount: 1,
                privateLabels: { fileName: "lipids.pdf", sourceName: "Lipids" },
                profileOrdinal: 0,
                profileRevisionId: "profile-revision-1",
                selectionProvenance: ["base" as const],
                sourceAlias: "S1",
                sourceArtifactId,
                sourceId,
                sourceVersionId,
                sourceVersionNumber: 1
              }]
            };
          }
        }
      },
      sendInput(successBody({
        content: textMessageContent("What is my cholesterol?"),
        knowledgePlan: knowledgeSelection(["knowledge-base-1"]),
        modelId: "openai-tool-model",
        provider: "openai"
      }))
    ));

    expect(harness.calls).toContain("knowledge:full-context");
    expect(prepared.normalizedRequest.knowledgeAnswering).toMatchObject({
      evidenceCount: 1,
      route: "full_context_v1"
    });
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual(["find_tools"]);
    expect(catalog).toHaveBeenCalledWith("user-1");
    expect(prepareMcp).not.toHaveBeenCalled();
    expect(prepared.providerRequest.context?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "knowledge-evidence:v2", purpose: "knowledge_evidence" })
    ]));
    expect(prepared.providerRequest.toolChoice).toBeUndefined();
    expect(prepared.knowledgeAdmissionPlan?.answeringPlan?.route).toBe("full_context_v1");
  });

  it("does not double-count one canonical Source selected through a Base and directly", async () => {
    const sourceId = "00000000-0000-4000-8000-000000000001";
    const selection: KnowledgeSelection = {
      baseIds: ["knowledge-base-1"],
      mode: "explicit",
      sourceIds: [sourceId],
      version: 1
    };
    const harness = createHarness({
      capabilities: { ...baseCapabilities, toolCalling: true }
    });
    const prepared = preparedFrom(await prepareRun(
      {
        ...harness.deps,
        knowledgeAdmission: {
          async load(input) {
            return {
              ...admittedKnowledge(input, "9"),
              profiles: [{
                embeddingCredentialSource: "default" as const,
                embeddingExecutionSnapshot: {} as never,
                embeddingProviderModelId: "embedding-model-1",
                ordinal: 0,
                profileRevisionId: "profile-revision-1",
                targetDimension: 1024,
                vectorSpaceFingerprint: "a".repeat(64)
              }],
              resolvedSourceCount: 1,
              sources: [{
                approxTokens: 1_200,
                authority: {
                  knowledgeBaseIds: ["knowledge-base-1"],
                  owner: true,
                  projectId: null
                },
                baseProvenance: [{
                  indexGenerationId: "generation-1",
                  knowledgeBaseId: "knowledge-base-1"
                }],
                directSelected: true,
                ordinal: 0,
                passageCount: 6,
                privateLabels: { fileName: "source-1.md", sourceName: "Source 1" },
                profileOrdinal: 0,
                profileRevisionId: "profile-revision-1",
                selectionProvenance: ["base" as const, "explicit_source" as const],
                sourceAlias: "S1",
                sourceArtifactId: "artifact-1",
                sourceId,
                sourceVersionId: "source-version-1",
                sourceVersionNumber: 1
              }]
            };
          }
        }
      },
      sendInput(successBody({
        content: textMessageContent("Summarize this source"),
        knowledgePlan: selection,
        modelId: "openai-tool-model",
        provider: "openai"
      }))
    ));

    expect(prepared.normalizedRequest.knowledgePlan).toEqual(selection);
    expect(prepared.normalizedRequest.knowledgeEvidencePackingVersion).toBe(5);
    expect(prepared.providerRequest.knowledgeEvidencePackingVersion).toBe(5);
    expect(prepared.normalizedRequest.knowledgeAnswerWorkflowVersion).toBe(11);
    expect(prepared.providerRequest.knowledgeAnswerWorkflowVersion).toBe(11);
    expect(prepared.normalizedRequest.knowledgeReviewRepairFeedbackVersion).toBe(1);
    expect(prepared.providerRequest.knowledgeReviewRepairFeedbackVersion).toBe(1);
    expect(prepared.normalizedRequest.knowledgeSearchInstructionVersion).toBe(3);
    expect(prepared.providerRequest.knowledgeSearchInstructionVersion).toBe(3);
    expect(prepared.normalizedRequest.knowledgeQueryAnchorVersion).toBe(2);
    expect(prepared.providerRequest.knowledgeQueryAnchorVersion).toBe(2);
    expect(prepared.knowledgeAdmissionPlan?.sources).toEqual([
      expect.objectContaining({
        directSelected: true,
        selectionProvenance: ["base", "explicit_source"],
        sourceId
      })
    ]);
    expect(prepared.normalizedRequest).not.toHaveProperty("knowledgeFocusedRequest");
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toContain(
      "search_knowledge"
    );
    expect(prepared.providerRequest.toolChoice).toBe("required");
  });

  it("does not synthesize a hidden Knowledge query from conversation history", async () => {
    const harness = createHarness({
      capabilities: { ...baseCapabilities, toolCalling: true },
      sendContext: [
        {
          content: textMessageContent("Older user question"),
          id: "older-user-message",
          role: "user"
        },
        {
          content: textMessageContent("Assistant response"),
          id: "assistant-message",
          role: "assistant"
        },
        {
          content: textMessageContent("Nearest user question"),
          id: "nearest-user-message",
          role: "user"
        },
        {
          content: textMessageContent("Most recent assistant response"),
          id: "recent-assistant-message",
          role: "assistant"
        }
      ]
    });
    const prepared = preparedFrom(await prepareRun(
      {
        ...harness.deps,
        knowledgeAdmission: {
          async load(input) {
            return admittedKnowledge(input, "c");
          }
        }
      },
      sendInput(successBody({
        content: textMessageContent("What is the retention policy?"),
        knowledgePlan: knowledgeSelection(["knowledge-base-1"]),
        modelId: "openai-tool-model",
        provider: "openai"
      }))
    ));

    expect(prepared.normalizedRequest).not.toHaveProperty("knowledgeFocusedRequest");
    expect(prepared.normalizedRequest.context?.messages.map((message) => message.id)).toEqual([
      "older-user-message",
      "assistant-message",
      "nearest-user-message",
      "recent-assistant-message",
      "current-user-message"
    ]);
  });

  it("returns a terminal readiness state before provider preparation when no Source is ready", async () => {
    const harness = createHarness();
    const result = await prepareRun(
      {
        ...harness.deps,
        knowledgeAdmission: {
          async load(input) {
            const admitted = admittedKnowledge(input, "7");
            return {
              ...admitted,
              bindings: admitted.bindings.map((binding) => ({
                ...binding,
                approxTokens: null,
                passageCount: null,
                readySourceCount: 0,
                sourceCount: 1
              })),
              exclusions: [{ count: 1, reason: "not_ready" as const, resourceType: "source" as const }],
              profiles: [],
              sources: []
            };
          }
        }
      },
      sendInput(successBody({
        content: textMessageContent("What is the retention policy?"),
        knowledgePlan: knowledgeSelection(["knowledge-base-1"])
      }))
    );

    expect(result).toMatchObject({
      code: "sources_processing",
      message: "Selected Knowledge documents are still processing.",
      ok: false,
      status: 409
    });
    expect(harness.calls).not.toContain("entitlements");
    expect(harness.calls).not.toContain("capabilities");
    expect(harness.calls).not.toContain("context:send");
  });

  it("treats an empty All my knowledge scope as Knowledge Off", async () => {
    const harness = createHarness();
    const result = await prepareRun(
      {
        ...harness.deps,
        knowledgeAdmission: {
          async load(input) {
            const admitted = admittedKnowledge(input, "empty");
            return {
              ...admitted,
              bindings: [],
              exclusions: [],
              profiles: [],
              resolvedSourceCount: 0,
              sources: []
            };
          }
        }
      },
      sendInput(successBody({
        content: textMessageContent("What is new today?"),
        knowledgePlan: { baseIds: [], mode: "all_my_knowledge", sourceIds: [], version: 1 }
      }))
    );

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const prepared = materializePreparedRunData(result.prepared);
    expect(prepared.normalizedRequest.knowledgePlan).toEqual(EMPTY_KNOWLEDGE_SELECTION);
    expect(prepared.knowledgeAdmissionPlan).toBeUndefined();
    expect(prepared.providerRequest.tools?.some((tool) => tool.name === "search_knowledge") ?? false).toBe(false);
  });

  it("composes Knowledge, Search, and MCP without reintroducing Memory tools", async () => {
    const { client, hosted, optionId } = nativeSearchCoexistencePlans(
      "gemini_interactions_native"
    );
    const admissionLoad = vi.fn(async (input: {
      requiresClientToolCoexistence?: boolean;
    }) => input.requiresClientToolCoexistence ? client : hosted);
    const harness = createHarness({ mcpPlan: readyMcpPlan() });
    const result = await prepareRun(
      {
        ...harness.deps,
        allowFakeProvider: false,
        knowledgeAdmission: {
          async load(input) {
            return admittedKnowledge(input, "f");
          }
        },
        providerAdmission: { load: admissionLoad }
      },
      sendInput(successBody({
        knowledgePlan: knowledgeSelection(["knowledge-base-1"]),
        mcp: { mode: "load_all" },
        modelId: hosted.selection.providerModelId,
        params: {},
        provider: hosted.selection.providerConnectionId,
        searchPlan: { mode: "model_choice", optionIds: [optionId] }
      }))
    );

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const prepared = materializePreparedRunData(result.prepared);
    expect(admissionLoad).toHaveBeenCalledOnce();
    expect(prepared.normalizedRequest.searchPlan.options).toEqual([
      expect.objectContaining({ adapterKind: "provider_model_client", optionId })
    ]);
    expect(prepared.normalizedRequest.mcp?.tools).toHaveLength(1);
    expect(prepared.normalizedRequest).not.toHaveProperty("memoryActionTools");
    expect(prepared.normalizedRequest).not.toHaveProperty("memoryHistoryTool");
    expect(prepared.normalizedRequest.toolMode).toBe("auto");
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
      "search_knowledge",
      "search_engine_1",
      "mcp_team_lookup_1"
    ]);
    expect(harness.mcpPrepareCalls).toEqual([{ allowedServerIds: undefined, userId: "user-1" }]);
  });

  it("validates Search and MCP selections even when Knowledge is selected", async () => {
    const harness = createHarness({ mcpPlan: readyMcpPlan() });
    const result = await prepareRun(
      {
        ...harness.deps,
        knowledgeAdmission: {
          async load(input) {
            return admittedKnowledge(input, "d");
          }
        }
      },
      sendInput(successBody({
        knowledgePlan: knowledgeSelection(["knowledge-base-1"]),
        mcp: { mode: "retired-selection" } as never,
        searchPlan: { mode: "retired-selection", optionIds: ["stale"] } as never
      }))
    );

    expect(result).toMatchObject({ code: "search_plan_invalid", ok: false, status: 400 });
    expect(harness.mcpPrepareCalls).toEqual([]);
  });

  it("composes Assistant-owned Knowledge with the Assistant Search plan", async () => {
    const { client, hosted, optionId } = nativeSearchCoexistencePlans(
      "anthropic_messages"
    );
    const admissionLoad = vi.fn(async (input: {
      requiresClientToolCoexistence?: boolean;
    }) => input.requiresClientToolCoexistence ? client : hosted);
    const harness = createHarness();
    const result = await prepareRun(
      {
        ...harness.deps,
        allowFakeProvider: false,
        assistants: {
          async resolveForRun() {
            return {
              assistant: {
                assistantId: "assistant-1",
                developerPrompt: "Use the selected private Knowledge.",
                knowledgeSelection: knowledgeSelection(["knowledge-base-1"]),
                mcpServerIds: [],
                name: "Knowledge Assistant",
                provider: hosted.selection.providerConnectionId,
                providerModelId: hosted.selection.providerModelId,
                definitionVersion: 1,
                identity: { name: "Knowledge Assistant", avatar: { accents: [], backgroundShape: "circle", foregroundShape: "ring", kind: "generated", paletteId: "ember", recipeVersion: 1, rotations: [0, 0] } },
                runControls: { maxOutputTokens: 512 },
                searchPlan: { mode: "model_choice" as const, optionIds: [optionId] },
                skillIds: [],
                systemPrompt: "Answer from admitted evidence."
              },
              ok: true as const
            };
          }
        },
        knowledgeAdmission: {
          async load(input) {
            return admittedKnowledge(input, "1");
          }
        },
        providerAdmission: { load: admissionLoad }
      },
      sendInput({
        assistantId: "assistant-1",
        content: textMessageContent("Use my Knowledge"),
        timeZone: "Europe/Berlin"
      })
    );

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const prepared = materializePreparedRunData(result.prepared);
    expect(admissionLoad).toHaveBeenCalledOnce();
    expect(prepared.assistant).toEqual({
      assistantId: "assistant-1",
      definitionVersion: 1,
      identity: { name: "Knowledge Assistant", avatar: { accents: [], backgroundShape: "circle", foregroundShape: "ring", kind: "generated", paletteId: "ember", recipeVersion: 1, rotations: [0, 0] } }
    });
    expect(prepared.normalizedRequest).not.toHaveProperty("knowledgeFocusedRequest");
    expect(prepared.normalizedRequest.searchPlan.options).toEqual([
      expect.objectContaining({ adapterKind: "provider_model_client", optionId })
    ]);
    expect(prepared.normalizedRequest.toolMode).toBe("auto");
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
      "search_knowledge",
      "search_engine_1"
    ]);
  });

  it.each([
    "gemini_interactions_native" as const,
    "anthropic_messages" as const
  ])(
    "fails $0 Knowledge plus Search when no coexistence route exists",
    async (adapterKind) => {
      const { hosted, optionId } = nativeSearchCoexistencePlans(adapterKind);
      const admissionLoad = vi.fn(async (input: {
        requiresClientToolCoexistence?: boolean;
      }) => {
        if (input.requiresClientToolCoexistence) {
          throw new ProviderAdmissionError("search_strategy_not_available");
        }
        return hosted;
      });
      const harness = createHarness();
      const result = await prepareRun(
        {
          ...harness.deps,
          allowFakeProvider: false,
          knowledgeAdmission: {
            async load(input) {
              return admittedKnowledge(input, "d");
            }
          },
          providerAdmission: { load: admissionLoad }
        },
        sendInput(successBody({
          knowledgePlan: knowledgeSelection(["knowledge-base-1"]),
          modelId: hosted.selection.providerModelId,
          params: {},
          provider: hosted.selection.providerConnectionId,
          searchPlan: { mode: "model_choice", optionIds: [optionId] }
        }))
      );

      expect(admissionLoad).toHaveBeenCalledOnce();
      expect(admissionLoad.mock.calls[0]?.[0]).toMatchObject({
        requiresClientToolCoexistence: true
      });
      expect(result).toMatchObject({
        code: "search_strategy_not_available",
        ok: false
      });
    }
  );

  it.each([
    "gemini_interactions_native" as const,
    "anthropic_messages" as const
  ])(
    "keeps Knowledge and $0 Search active when ordinary tools are none",
    async (adapterKind) => {
      const { client, hosted, optionId } = nativeSearchCoexistencePlans(adapterKind);
      const admissionLoad = vi.fn(async (input: {
        requiresClientToolCoexistence?: boolean;
      }) => input.requiresClientToolCoexistence ? client : hosted);
      const harness = createHarness();
      const result = await prepareRun(
        {
          ...harness.deps,
          allowFakeProvider: false,
          knowledgeAdmission: {
            async load(input) {
              return admittedKnowledge(input, "e");
            }
          },
          providerAdmission: { load: admissionLoad }
        },
        sendInput(successBody({
          knowledgePlan: knowledgeSelection(["knowledge-base-1"]),
          modelId: hosted.selection.providerModelId,
          params: {},
          provider: hosted.selection.providerConnectionId,
          searchPlan: { mode: "model_choice", optionIds: [optionId] },
          tools: "none"
        }))
      );

      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      const prepared = materializePreparedRunData(result.prepared);
      expect(admissionLoad).toHaveBeenCalledTimes(1);
      expect(prepared.normalizedRequest).not.toHaveProperty("knowledgeFocusedRequest");
      expect(prepared.normalizedRequest.searchPlan.options).toEqual([
        expect.objectContaining({ adapterKind: "provider_model_client", optionId })
      ]);
      expect(prepared.normalizedRequest.toolMode).toBe("auto");
      expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
        "search_knowledge",
        "search_engine_1"
      ]);
    }
  );

  it.each([
    "gemini_interactions_native" as const,
    "anthropic_messages" as const
  ])("routes singleton $0 Search alongside the built-in session tool", async (adapterKind) => {
    const { client, hosted, optionId } = nativeSearchCoexistencePlans(adapterKind);
    const admissionLoad = vi.fn(async (input: {
      requiresClientToolCoexistence?: boolean;
    }) => input.requiresClientToolCoexistence ? client : hosted);
    const harness = createHarness();
    const result = await prepareRun(
      {
        ...harness.deps,
        allowFakeProvider: false,
        providerAdmission: { load: admissionLoad }
      },
      sendInput(successBody({
        modelId: hosted.selection.providerModelId,
        params: {},
        provider: hosted.selection.providerConnectionId,
        searchPlan: { mode: "model_choice", optionIds: [optionId] }
      }))
    );

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const prepared = materializePreparedRunData(result.prepared);
    expect(admissionLoad).toHaveBeenCalledTimes(2);
    expect(admissionLoad.mock.calls[0]?.[0]).not.toHaveProperty(
      "requiresClientToolCoexistence"
    );
    expect(prepared.normalizedRequest.searchPlan?.options[0]?.adapterKind).toBe(
      "provider_model_client"
    );
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual(["get_session_status", "search_engine_1"]);
  });

  it("routes a provider-admitted multi-engine plan", async () => {
    const base = compatibleAdmissionPlan("openai_responses_compatible");
    const optionIds = ["perplexity-tool-search", "company-search"];
    const searches: NonNullable<ProviderAdmissionPlan["searches"]> = optionIds.map(
      (optionId, ordinal) => ({
        bindingKey: `search:${optionId}`,
        configuration: {
          adapterKind: "provider_model_client",
          config: {
            maxResults: 8,
            modelCapabilities: { ...baseCapabilities, toolCalling: true },
            modelDefaultParams: {},
            queryMaxCharacters: 500,
            timeoutMs: 15_000
          },
          credentialMode: "provider_model",
          displayName: `Search ${ordinal + 1}`,
          executionModes: ["all_selected", "model_choice"],
          kind: optionId === "perplexity-tool-search"
            ? "perplexity_tool_search"
            : "provider_model_web_search",
          modelId: `search-model-${ordinal + 1}`,
          protocol: optionId === "perplexity-tool-search"
            ? "openrouter_perplexity_chat"
            : "openai_responses_web_search",
          provider: optionId === "perplexity-tool-search" ? "openrouter" : "openai_compatible",
          providerModelId: `technical-${ordinal + 1}`,
          revisionId: `revision-${ordinal + 1}`,
          searchStrategyRowId: `integration-${ordinal + 1}`,
          strategyId: optionId
        },
        integrationId: `integration-${ordinal + 1}`,
        optionId,
        ordinal,
        revisionId: `revision-${ordinal + 1}`,
        role: base.answer
      })
    );
    const plan: ProviderAdmissionPlan = {
      ...base,
      requestedSearchPlan: { mode: "all_selected", optionIds },
      searches
    };
    const harness = createHarness();
    const result = await prepareRun(
      {
        ...harness.deps,
        allowFakeProvider: false,
        providerAdmission: { async load() { return plan; } }
      },
      sendInput(successBody({
        modelId: plan.selection.providerModelId,
        provider: plan.selection.providerConnectionId,
        searchPlan: { mode: "all_selected", optionIds }
      }))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const prepared = materializePreparedRunData(result.prepared);
    expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
      "search_selected_engines"
    ]);
  });

  it.each([
    { adapterKind: "anthropic_messages" as const, provider: "anthropic" },
    { adapterKind: "gemini_interactions_native" as const, provider: "gemini" }
  ])(
    "serializes admitted OpenAI Search as a client tool for $provider answers",
    async ({ adapterKind, provider }) => {
      const plan = providerNeutralOpenAISearchPlan(adapterKind);
      const admissionLoad = vi.fn(async () => plan);
      const result = await prepareRun(
        {
          ...createHarness().deps,
          allowFakeProvider: false,
          providerAdmission: { load: admissionLoad }
        },
        sendInput(successBody({
          modelId: plan.selection.providerModelId,
          params: {},
          provider: plan.selection.providerConnectionId,
          searchPlan: plan.requestedSearchPlan
        }))
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      const prepared = materializePreparedRunData(result.prepared);
      expect(result.toolBridge?.provider).toBe(provider);
      expect(prepared.normalizedRequest.searchPlan).toMatchObject({
        mode: "model_choice",
        options: [expect.objectContaining({
          adapterKind: "provider_model_client",
          optionId: "openai-native-web-search",
          protocol: "openai_responses_web_search",
          provider: "openai",
          providerModelId: "technical-openai-search"
        })]
      });
      expect(prepared.defaults?.searchPlan).toEqual(plan.requestedSearchPlan);
      expect(admissionLoad).toHaveBeenCalledWith(expect.objectContaining({
        searchPlan: plan.requestedSearchPlan
      }));
      expect(prepared.providerRequest.tools?.filter((tool) => tool.capability !== "session").map((tool) => tool.name)).toEqual([
        "search_engine_1"
      ]);
      expect(JSON.stringify(prepared.providerRequestPreview))
        .toContain("search_engine_1");
    }
  );

  it("preserves the admitted custom Search destination in the prepared snapshot", async () => {
    const optionId = "custom-web-search:connection-custom-search";
    const plan = providerNeutralOpenAISearchPlan("anthropic_messages", {
      optionId,
      source: "custom"
    });
    const result = await prepareRun(
      {
        ...createHarness().deps,
        allowFakeProvider: false,
        providerAdmission: { async load() { return plan; } }
      },
      sendInput(successBody({
        modelId: plan.selection.providerModelId,
        params: {},
        provider: plan.selection.providerConnectionId,
        searchPlan: plan.requestedSearchPlan
      }))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const prepared = materializePreparedRunData(result.prepared);
    expect(prepared.normalizedRequest.searchPlan).toEqual({
      mode: "model_choice",
      options: [expect.objectContaining({
        optionId,
        provider: "openai_compatible",
        providerModelId: "technical-custom-search",
        revisionId: "revision-custom-search",
        searchStrategyRowId: "integration-custom-search"
      })]
    });
    expect(prepared.providerAdmissionPlan?.searches?.[0]?.role?.snapshot.connectionId)
      .toBe("connection-custom-search");
    expect(prepared.defaults?.searchPlan).toEqual({ mode: "model_choice", optionIds: [optionId] });
  });

  it("admits attachment-bearing client Search and loads the attachment for the answer request", async () => {
    const base = compatibleAdmissionPlan("openai_responses_compatible");
    const optionId = "perplexity-tool-search";
    const plan: ProviderAdmissionPlan = {
      ...base,
      requestedSearchPlan: { mode: "all_selected", optionIds: [optionId] },
      searches: [{
        bindingKey: `search:${optionId}`,
        configuration: {
          adapterKind: "provider_model_client",
          config: {
            maxResults: 8,
            modelCapabilities: { ...baseCapabilities, toolCalling: true },
            modelDefaultParams: {},
            queryMaxCharacters: 500,
            timeoutMs: 15_000
          },
          credentialMode: "provider_model",
          displayName: "Perplexity Search",
          executionModes: ["all_selected", "model_choice"],
          kind: "perplexity_tool_search",
          modelId: "perplexity/sonar-pro-search",
          protocol: "openrouter_perplexity_chat",
          provider: "openrouter",
          providerModelId: "technical-perplexity",
          revisionId: "revision-perplexity",
          searchStrategyRowId: "integration-perplexity",
          strategyId: optionId
        },
        integrationId: "integration-perplexity",
        optionId,
        ordinal: 0,
        revisionId: "revision-perplexity",
        role: base.answer
      }]
    };
    const attachment = runAttachment({
      extractedText: "Private attachment evidence",
      id: "document-1",
      kind: "document",
      mimeType: "text/plain",
      storageKey: "private/document-1"
    });
    const harness = createHarness({ attachments: [attachment] });
    const result = await prepareRun(
      {
        ...harness.deps,
        allowFakeProvider: false,
        providerAdmission: { async load() { return plan; } }
      },
      sendInput(successBody({
        content: {
          blocks: [
            { text: "Question with private evidence", type: "text" },
            { attachmentId: attachment.id, type: "attachment" }
          ]
        },
        modelId: plan.selection.providerModelId,
        provider: plan.selection.providerConnectionId,
        searchPlan: { mode: "all_selected", optionIds: [optionId] }
      }))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const prepared = materializePreparedRunData(result.prepared);
    expect(harness.attachmentLoads).toEqual([{
      attachmentIds: [attachment.id],
      userId: "user-1"
    }]);
    expect(prepared.providerRequest.attachments).toEqual([
      expect.objectContaining({
        extractedText: "Private attachment evidence",
        id: attachment.id
      })
    ]);
    expect(prepared.normalizedRequest.searchPlan).toMatchObject({
      mode: "all_selected",
      options: [expect.objectContaining({
        adapterKind: "provider_model_client",
        optionId
      })]
    });
  });

  it("keeps provider-hosted native Search available with attachments", async () => {
    const optionId = "openai-native-web-search";
    const base = compatibleAdmissionPlan("openai_responses_compatible", {
      nativeSearch: true
    });
    const plan: ProviderAdmissionPlan = {
      ...base,
      requestedSearchPlan: { mode: "model_choice", optionIds: [optionId] },
      searches: [{
        bindingKey: null,
        configuration: {
          adapterKind: "answer_provider_hosted",
          config: { maxResults: 8, queryMaxCharacters: 500, timeoutMs: 15_000 },
          credentialMode: "answer_provider",
          displayName: "OpenAI Web Search",
          executionModes: ["model_choice"],
          kind: "openai_native_web_search",
          modelId: null,
          protocol: "openai_responses_web_search",
          provider: "openai_compatible",
          providerModelId: null,
          revisionId: "revision-hosted",
          searchStrategyRowId: "integration-hosted",
          strategyId: optionId
        },
        integrationId: "integration-hosted",
        optionId,
        ordinal: 0,
        revisionId: "revision-hosted"
      }]
    };
    const harness = createHarness({
      attachments: [runAttachment({
        id: "pdf-1",
        kind: "pdf",
        mimeType: "application/pdf",
        storageKey: "private/pdf-1"
      })]
    });
    const result = await prepareRun(
      {
        ...harness.deps,
        allowFakeProvider: false,
        providerAdmission: { async load() { return plan; } }
      },
      sendInput(successBody({
        content: {
          blocks: [
            { text: "Question with a PDF", type: "text" },
            { attachmentId: "pdf-1", type: "attachment" }
          ]
        },
        modelId: plan.selection.providerModelId,
        provider: plan.selection.providerConnectionId,
        searchPlan: { mode: "model_choice", optionIds: [optionId] }
      }))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const prepared = materializePreparedRunData(result.prepared);
    expect(prepared.normalizedRequest.searchPlan.options).toEqual([
      expect.objectContaining({ optionId })
    ]);
    expect(prepared.providerRequest.attachments).toEqual([
      expect.objectContaining({ id: "pdf-1" })
    ]);
  });

  it("keeps a full personal Search preference separate from the effective run plan", async () => {
    const plan = compatibleAdmissionPlan("openai_responses_compatible");
    const admissionLoad = vi.fn(async () => plan);
    const preferencePlan = {
      mode: "model_choice" as const,
      optionIds: ["company-search", "secondary-search"]
    };
    const result = await prepareRun(
      {
        ...createHarness().deps,
        allowFakeProvider: false,
        providerAdmission: { load: admissionLoad }
      },
      sendInput(successBody({
        modelId: plan.selection.providerModelId,
        provider: plan.selection.providerConnectionId,
        searchPlan: { mode: "all_selected", optionIds: [] },
        searchPreferencePlan: preferencePlan,
        searchPreferenceSource: "personal"
      }))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const prepared = materializePreparedRunData(result.prepared);
    expect(admissionLoad).toHaveBeenCalledWith(expect.objectContaining({
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchPreferencePlan: preferencePlan,
      searchPreferenceSource: "personal"
    }));
    expect(prepared.defaults).not.toBeNull();
    expect(prepared.defaults?.searchPlan).toEqual({ mode: "all_selected", optionIds: [] });
    expect(prepared.defaults?.searchPreferencePlan).toEqual(preferencePlan);
    expect(prepared.defaults?.controlDefaults).not.toHaveProperty("searchStrategyId");
  });

  it("records organization inheritance as null without copying the current recommendation", async () => {
    const plan = compatibleAdmissionPlan("openai_responses_compatible");
    const admissionLoad = vi.fn(async () => plan);
    const result = await prepareRun(
      {
        ...createHarness().deps,
        allowFakeProvider: false,
        providerAdmission: { load: admissionLoad }
      },
      sendInput(successBody({
        modelId: plan.selection.providerModelId,
        provider: plan.selection.providerConnectionId,
        searchPlan: { mode: "all_selected", optionIds: [] },
        searchPreferencePlan: { mode: "all_selected", optionIds: ["current-default"] },
        searchPreferenceSource: "organization"
      }))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const prepared = materializePreparedRunData(result.prepared);
    expect(admissionLoad).toHaveBeenCalledWith(expect.objectContaining({
      searchPreferencePlan: null,
      searchPreferenceSource: "organization"
    }));
    expect(prepared.defaults?.searchPreferencePlan).toBeNull();
  });

  it("rejects an initial MCP request when its exact provider tool schema exceeds context", async () => {
    const basePlan = readyMcpPlan();
    if (!basePlan.ok) throw new Error("invalid MCP fixture");
    const mcpPlan: McpRunPlanResult = {
      ...basePlan,
      snapshot: {
        ...basePlan.snapshot,
        tools: basePlan.snapshot.tools.map((tool) => ({
          ...tool,
          description: "large schema description ".repeat(300)
        }))
      }
    };
    const harness = createHarness({
      capabilities: {
        ...baseCapabilities,
        contextWindow: 1_000,
        toolCalling: true
      },
      mcpPlan
    });

    const result = await prepareRun(
      harness.deps,
      sendInput(successBody({
        mcp: { mode: "load_all" },
        modelId: "openai-tool-model",
        provider: "openai"
      }))
    );

    expect(result).toMatchObject({ code: "context_too_large", ok: false, status: 400 });
  });

  it("returns each validation failure at its authoritative precedence and skips later work", async () => {
    await expectFailure({
      calls: [],
      expected: { code: "model_not_available", status: 403 },
      harness: { providerIds: [] }
    });
    await expectFailure({
      calls: ["entitlements"],
      expected: { code: "model_not_available", status: 403 },
      harness: { entitlements: emptyEntitlements() }
    });
    await expectFailure({
      calls: ["entitlements"],
      expected: { code: "search_strategy_not_available", status: 403 },
      harness: {
        entitlements: {
          modelKeys: new Set(),
          providerKeys: new Set(["openai"]),
          searchStrategies: new Set()
        }
      },
      request: sendInput(
        successBody({
          modelId: "openai-model",
          provider: "openai",
          searchPlan: {
            mode: "all_selected",
            optionIds: ["openai-native-web-search"]
          }
        })
      )
    });
    await expectFailure({
      calls: [],
      expected: { code: "search_plan_invalid", status: 400 },
      request: sendInput({ content: textMessageContent("Question") })
    });
    await expectFailure({
      calls: ["entitlements", "capabilities"],
      expected: { code: "content_required", status: 400 },
      request: sendInput({ searchPlan: { mode: "all_selected", optionIds: [] } })
    });
    await expectFailure({
      calls: ["entitlements", "capabilities"],
      expected: { code: "model_not_available", status: 403 },
      harness: { capabilities: null }
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send"],
      expected: { code: "invalid_run_params", status: 400 },
      request: sendInput(successBody({ params: { unknown: true } }))
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send", "attachments"],
      expected: { code: "attachment_reference_invalid", status: 400 },
      request: sendInput(
        successBody({
          content: {
            blocks: [{ attachmentId: "missing-attachment", type: "attachment" }]
          }
        })
      )
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send", "attachments"],
      expected: { code: "pdf_attachment_not_supported", status: 400 },
      harness: {
        attachments: [
          runAttachment({
            id: "pdf-1",
            kind: "pdf",
            mimeType: "application/pdf",
            storageKey: "private/pdf-1"
          })
        ],
        capabilities: {
          ...baseCapabilities,
          nativePdfInput: false,
          pdf: false
        }
      },
      request: sendInput(
        successBody({
          content: {
            blocks: [{ attachmentId: "pdf-1", type: "attachment" }]
          }
        })
      )
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send", "attachments"],
      expected: { code: "unsupported_attachment_type", status: 400 },
      harness: {
        attachments: [
          runAttachment({
            id: "opaque-1",
            kind: "file",
            mimeType: "application/x-aiqsa-opaque",
            storageKey: "private/opaque-1"
          })
        ]
      },
      request: sendInput(
        successBody({
          content: {
            blocks: [{ attachmentId: "opaque-1", type: "attachment" }]
          }
        })
      )
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send", "attachments"],
      expected: { code: "image_attachment_not_supported", status: 400 },
      harness: {
        attachments: [
          runAttachment({
            id: "image-1",
            kind: "image",
            mimeType: "image/png",
            storageKey: "private/image-1"
          })
        ],
        capabilities: {
          ...baseCapabilities,
          vision: false
        }
      },
      request: sendInput(
        successBody({
          content: {
            blocks: [{ attachmentId: "image-1", type: "attachment" }]
          }
        })
      )
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send"],
      expected: {
        code: "context_too_large",
        status: 400
      },
      harness: {
        capabilities: {
          ...baseCapabilities,
          contextWindow: 40,
          defaultMaxOutputTokens: 1
        }
      },
      messageContains: "exceed the model context budget"
    });

  });

  it("rejects typed no-text, zero-emitted partial, and stored blank PDFs for text-extraction models", async () => {
    const expected = {
      code: "pdf_text_unavailable",
      message:
        "No extractable text was found. Choose a model with native PDF support or remove this file.",
      status: 400 as const
    };
    const zeroPartialExpected = {
      code: "pdf_text_unavailable",
      message:
        "No PDF text could be retained within the configured limit. Choose a model with native PDF support or remove this file.",
      status: 400 as const
    };
    const content = {
      blocks: [{ attachmentId: "pdf-no-text", type: "attachment" }]
    };

    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send", "attachments"],
      expected,
      harness: {
        attachments: [
          runAttachment({
            extractedText: "stale text must not override authoritative processing status",
            id: "pdf-no-text",
            kind: "pdf",
            metadata: {
              pdf: {
                extractedCharacterCount: 0,
                pageCount: 3,
                pagesProcessed: 3,
                status: "no_text"
              }
            },
            mimeType: "application/pdf",
            storageKey: "private/pdf-no-text"
          })
        ]
      },
      request: sendInput(successBody({ content }))
    });

    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send", "attachments"],
      expected: zeroPartialExpected,
      harness: {
        attachments: [
          runAttachment({
            extractedText: "stale text must not override zero-emitted partial status",
            id: "pdf-no-text",
            kind: "pdf",
            metadata: {
              pdf: {
                extractedCharacterCount: 0,
                pageCount: 1,
                pagesProcessed: 1,
                status: "partial",
                truncationReason: "text_limit"
              }
            },
            mimeType: "application/pdf",
            storageKey: "private/pdf-no-text"
          })
        ]
      },
      request: sendInput(successBody({ content }))
    });

    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send", "attachments"],
      expected,
      harness: {
        attachments: [
          runAttachment({
            id: "pdf-with-text",
            kind: "pdf",
            mimeType: "application/pdf",
            storageKey: "private/pdf-with-text"
          }),
          runAttachment({
            extractedText: " \n\t ",
            id: "pdf-no-text",
            kind: "pdf",
            mimeType: "application/pdf",
            storageKey: "private/pdf-no-text"
          })
        ]
      },
      request: sendInput(
        successBody({
          content: {
            blocks: [
              { attachmentId: "pdf-with-text", type: "attachment" },
              { attachmentId: "pdf-no-text", type: "attachment" }
            ]
          }
        })
      )
    });
  });

  it("allows partial PDF text for extraction-mode models", async () => {
    const harness = createHarness({
      attachments: [
        runAttachment({
          extractedText: "Bounded partial PDF text",
          id: "pdf-partial",
          kind: "pdf",
          metadata: {
            pdf: {
              extractedCharacterCount: 24,
              pageCount: 12,
              pagesProcessed: 4,
              status: "partial",
              truncationReason: "text_limit"
            }
          },
          mimeType: "application/pdf",
          storageKey: "private/pdf-partial"
        })
      ]
    });

    const result = await prepareRun(
      harness.deps,
      sendInput(
        successBody({
          content: {
            blocks: [{ attachmentId: "pdf-partial", type: "attachment" }]
          }
        })
      )
    );

    const prepared = materializePreparedRunData(preparedFrom(result));
    expect(prepared.providerRequest.attachments).toEqual([
      expect.objectContaining({
        extractedText: "Bounded partial PDF text",
        id: "pdf-partial"
      })
    ]);
    expect(harness.storageReads).toEqual([]);
  });

  it("allows no-text PDFs for native-PDF models and hydrates the original bytes", async () => {
    const pdfBytes = Buffer.from("private-native-pdf-bytes");
    const harness = createHarness({
      attachments: [
        runAttachment({
          byteSize: pdfBytes.length,
          checksum: sha256(pdfBytes),
          extractedText: null,
          id: "pdf-no-text",
          kind: "pdf",
          metadata: {
            pdf: {
              extractedCharacterCount: 0,
              pageCount: 2,
              pagesProcessed: 2,
              status: "no_text"
            }
          },
          mimeType: "application/pdf",
          storageKey: "private/pdf-no-text"
        })
      ],
      capabilities: {
        ...baseCapabilities,
        nativePdfInput: true
      },
      storageObjects: {
        "private/pdf-no-text": {
          body: pdfBytes,
          contentType: "application/pdf"
        }
      }
    });

    const result = await prepareRun(
      harness.deps,
      sendInput(
        successBody({
          content: {
            blocks: [{ attachmentId: "pdf-no-text", type: "attachment" }]
          }
        })
      )
    );

    const prepared = materializePreparedRunData(preparedFrom(result));
    expect(prepared.providerRequest.attachments).toEqual([
      expect.objectContaining({
        base64Data: pdfBytes.toString("base64"),
        extractedText: null,
        id: "pdf-no-text"
      })
    ]);
    expect(harness.storageReads).toEqual(["private/pdf-no-text"]);
  });

  it("allows a zero-emitted partial PDF for native-PDF models and hydrates the original bytes", async () => {
    const pdfBytes = Buffer.from("private-native-zero-partial-pdf-bytes");
    const harness = createHarness({
      attachments: [
        runAttachment({
          byteSize: pdfBytes.length,
          checksum: sha256(pdfBytes),
          extractedText: null,
          id: "pdf-zero-partial",
          kind: "pdf",
          metadata: {
            pdf: {
              extractedCharacterCount: 0,
              pageCount: 1,
              pagesProcessed: 1,
              status: "partial",
              truncationReason: "text_limit"
            }
          },
          mimeType: "application/pdf",
          storageKey: "private/pdf-zero-partial"
        })
      ],
      capabilities: {
        ...baseCapabilities,
        nativePdfInput: true
      },
      storageObjects: {
        "private/pdf-zero-partial": {
          body: pdfBytes,
          contentType: "application/pdf"
        }
      }
    });

    const result = await prepareRun(
      harness.deps,
      sendInput(
        successBody({
          content: {
            blocks: [{ attachmentId: "pdf-zero-partial", type: "attachment" }]
          }
        })
      )
    );

    const prepared = materializePreparedRunData(preparedFrom(result));
    expect(prepared.providerRequest.attachments).toEqual([
      expect.objectContaining({
        base64Data: pdfBytes.toString("base64"),
        extractedText: null,
        id: "pdf-zero-partial"
      })
    ]);
    expect(harness.storageReads).toEqual(["private/pdf-zero-partial"]);
  });

  it("rejects duplicate attachment references before repository or storage reads", async () => {
    const harness = createHarness();
    const result = await prepareRun(
      harness.deps,
      sendInput(
        successBody({
          content: {
            blocks: [
              { attachmentId: "image-1", type: "attachment" },
              { attachmentId: "image-1", type: "attachment" }
            ]
          }
        })
      )
    );

    expect(result).toMatchObject({
      code: "attachment_reference_invalid",
      message: "Attachment references must be unique within one run.",
      status: 400
    });
    expect(harness.attachmentLoads).toEqual([]);
    expect(harness.storageReads).toEqual([]);
  });

  it("rejects an attachment-count overflow before repository or storage reads", async () => {
    await expectFailure({
      calls: ["entitlements", "capabilities"],
      expected: {
        actual: { count: 3 },
        code: "attachment_count_limit_exceeded",
        limits: { maxCount: 2 },
        message: "This run contains 3 attachments; the limit is 2.",
        status: 413
      },
      harness: {
        attachmentLimits: {
          maxCount: 2,
          maxEncodedBytes: 1_000,
          maxMaterializedBytes: 1_000,
          readConcurrency: 1
        }
      },
      request: sendInput(
        successBody({
          content: {
            blocks: ["one", "two", "three"].map((attachmentId) => ({
              attachmentId,
              type: "file"
            }))
          }
        })
      )
    });
  });

  it.each([
    {
      expected: {
        actual: { materializedBytes: 11 },
        code: "attachment_materialization_limit_exceeded",
        limits: { maxMaterializedBytes: 10 },
        message: "Selected attachments require 11 source bytes; the limit is 10."
      },
      limits: {
        maxCount: 20,
        maxEncodedBytes: 1_000,
        maxMaterializedBytes: 10,
        readConcurrency: 2
      }
    },
    {
      expected: {
        actual: { encodedBytes: 26 },
        code: "attachment_encoded_size_limit_exceeded",
        limits: { maxEncodedBytes: 25 },
        message: "Selected attachments require about 26 encoded bytes; the limit is 25."
      },
      limits: {
        maxCount: 20,
        maxEncodedBytes: 25,
        maxMaterializedBytes: 1_000,
        readConcurrency: 2
      }
    }
  ])("rejects $expected.code before an object read", async ({ expected, limits: attachmentLimits }) => {
    const first = runAttachment({
      byteSize: expected.code.includes("encoded") ? 3 : 6,
      id: "first",
      kind: "image",
      mimeType: "image/png",
      storageKey: "private/first"
    });
    const records = expected.code.includes("encoded")
      ? [first]
      : [
          first,
          runAttachment({
            byteSize: 5,
            id: "second",
            kind: "image",
            mimeType: "image/png",
            storageKey: "private/second"
          })
        ];
    const blocks = records.map(({ id }) => ({ attachmentId: id, type: "image" }));
    const storageObjects = Object.fromEntries(records.map((record) => [
      record.storageKey,
      { body: Buffer.alloc(record.byteSize), contentType: record.mimeType }
    ]));
    const harness = createHarness({
      attachmentLimits,
      attachments: records,
      storageObjects
    });
    const result = await prepareRun(
      harness.deps,
      sendInput(successBody({ content: { blocks } }))
    );

    expect(result).toMatchObject({
      ...expected,
      ok: false,
      status: 413
    });
    expect(harness.attachmentLoads).toHaveLength(1);
    expect(harness.storageReads).toEqual([]);
  });

  it("keeps ordered private payloads ephemeral outside the provider request", async () => {
    const imageBytes = Buffer.from("private-image-bytes");
    const pdfBytes = Buffer.from("private-pdf-bytes");
    const imageDataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
    const pdfBase64 = pdfBytes.toString("base64");
    const harness = createHarness({
      attachments: [
        runAttachment({
          byteSize: imageBytes.length,
          id: "image-1",
          kind: "image",
          mimeType: "image/png",
          storageKey: "private/image-1"
        }),
        runAttachment({
          byteSize: pdfBytes.length,
          checksum: sha256(pdfBytes),
          id: "pdf-1",
          kind: "pdf",
          mimeType: "application/pdf",
          storageKey: "private/pdf-1"
        })
      ],
      capabilities: {
        ...baseCapabilities,
        nativePdfInput: true
      },
      storageObjects: {
        "private/image-1": {
          body: imageBytes,
          contentType: "image/png"
        },
        "private/pdf-1": {
          body: pdfBytes,
          contentType: "application/pdf"
        }
      }
    });
    const result = await prepareRun(
      harness.deps,
      sendInput(
        successBody({
          content: {
            blocks: [
              { attachmentId: "image-1", type: "attachment" },
              { attachmentId: "pdf-1", type: "attachment" }
            ]
          },
          params: {}
        })
      )
    );
    const prepared = preparedFrom(result);

    expect(prepared.normalizedRequest.attachmentIds).toEqual(["image-1", "pdf-1"]);
    expect(harness.attachmentLoads).toEqual([
      {
        attachmentIds: ["image-1", "pdf-1"],
        userId: "user-1"
      }
    ]);
    expect(harness.storageReads).toEqual(["private/image-1", "private/pdf-1"]);
    expect(prepared.providerRequest.attachments).toEqual([
      expect.objectContaining({
        dataUrl: imageDataUrl,
        id: "image-1"
      }),
      expect.objectContaining({
        base64Data: pdfBase64,
        id: "pdf-1"
      })
    ]);
    expect(prepared.providerRequest.attachments.some((attachment) => "storageKey" in attachment)).toBe(false);
    expect(prepared.providerRequestPreview).toMatchObject({
      model: "fake-qsa",
      provider: "fake",
      searchOptionIds: []
    });

    const normalizedJson = JSON.stringify(prepared.normalizedRequest);
    const previewJson = JSON.stringify(prepared.providerRequestPreview);
    const providerJson = JSON.stringify(prepared.providerRequest);
    for (const privateValue of [imageDataUrl, pdfBase64, "private/image-1", "private/pdf-1"]) {
      expect(normalizedJson).not.toContain(privateValue);
      expect(previewJson).not.toContain(privateValue);
    }
    expect(providerJson).toContain(imageDataUrl);
    expect(providerJson).toContain(pdfBase64);
  });
});
