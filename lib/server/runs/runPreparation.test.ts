import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeSelection } from "../../contracts/knowledge";
import { textMessageContent } from "../../domain/content";
import { resolveStandardChatBaseline } from "../../domain/promptTemplates";
import type { ResolvedEntitlements } from "../auth/entitlements";
import type { McpRunPlanResult } from "../mcp/runPlan";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../knowledge/knowledgeBudget";
import type { KnowledgeRunAdmissionPlan } from "../knowledge/runAdmission";
import {
  ProviderAdmissionError,
  type ProviderAdmissionPlan
} from "../providerRuntime/admission";
import { MEMORY_ACTION_NO_COMMIT_RESULT } from "../providers/memoryActionAnswer";
import type { ProviderAdapter, ProviderConversationMessage, ProviderModelCapabilities } from "../providers/types";
import type { ProjectRunAdmission, RunAttachmentRecord } from "./runRepositoryContract";
import type { RunAttachmentLimits } from "./attachmentLimits";
import { materializePreparedRunData, prepareRun, type PreparedRun, type RegenerateRunPreparationSource, type RunPreparationDeps, type RunPreparationInput, type RunPreparationResult, type SendRunPreparationSource } from "./runPreparation";

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
  kind: "document" | "image" | "pdf";
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
    fileName: `${input.id}.${input.kind === "pdf" ? "pdf" : input.kind === "image" ? "png" : "txt"}`,
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
    }
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
        async prepare(userId, prepareOptions) {
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

    expect(result).toMatchObject({ code: "context_too_large", ok: false });
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
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 200,
      maxToolRounds: 17
    });
    expect(prepared.providerRequest.toolBudgets).toEqual({
      mcpAutoDiscoveryTimeoutSeconds: 60,
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
      { revisionId: "skill-revision-2", skillId: "skill-editor" },
      { revisionId: "skill-revision-4", skillId: "skill-actions" }
    ]);
    expect(prepared.normalizedRequest.skills).toEqual([
      { name: "Careful editor", revisionId: "skill-revision-2", skillId: "skill-editor" },
      { name: "Action closer", revisionId: "skill-revision-4", skillId: "skill-actions" }
    ]);
    expect(prepared.providerRequest.prompt.developer).not.toContain("Careful editor");
    expect(prepared.providerRequest.context?.messages.slice(-2)).toEqual([
      {
        content: {
          blocks: [{
            text: [
              "<selected_skills>",
              "  <skill name=\"Careful editor\">",
              "Verify every factual claim before answering.",
              "  </skill>",
              "  <skill name=\"Action closer\">",
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
    expect(prepared.providerRequest.tools).toBeUndefined();
  });

  it("does not invent a language fallback when the answer model lacks tool calling", async () => {
    const prepared = preparedFrom(await prepareRun(
      createHarness().deps,
      sendInput(successBody({
        content: textMessageContent("Remember that my favorite color is teal")
      }))
    ));

    expect(prepared.normalizedRequest.memoryActionTools).toBeUndefined();
    expect(prepared.providerRequest.tools).toBeUndefined();
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

    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
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
    expect(prepared.providerRequest.tools).toBeUndefined();
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
      { ...harness.deps, mcp: { catalog, prepare } },
      sendInput(successBody({ modelId: "openai-tool-model", provider: "openai" }))
    ));

    expect(catalog).toHaveBeenCalledWith("user-1");
    expect(prepare).not.toHaveBeenCalled();
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
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
      { ...harness.deps, mcp: { catalog, prepare } },
      sendInput(successBody({
        mcp: { mode: "off" },
        modelId: "openai-tool-model",
        provider: "openai"
      }))
    ));
    expect(off.normalizedRequest.mcp).toBeUndefined();
    expect(off.normalizedRequest.mcpDiscovery).toBeUndefined();
    expect(off.providerRequest.tools).toBeUndefined();
    expect(catalog).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();

    const loadAll = preparedFrom(await prepareRun(
      { ...harness.deps, mcp: { catalog, prepare } },
      sendInput(successBody({
        mcp: { mode: "load_all" },
        modelId: "openai-tool-model",
        provider: "openai"
      }))
    ));
    expect(prepare).toHaveBeenCalledWith("user-1");
    expect(loadAll.normalizedRequest.mcpDiscovery).toBeUndefined();
    expect(loadAll.providerRequest.tools?.map((tool) => tool.name)).toEqual([
      "mcp_team_lookup_1"
    ]);
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
    expect(prepared.providerRequest.tools).toBeUndefined();
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
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
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
    expect(prepared.providerRequest.tools).toBeUndefined();
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
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
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
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
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
      expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
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
    expect(prepared.knowledgeAdmissionPlan?.sources).toEqual([
      expect.objectContaining({
        directSelected: true,
        selectionProvenance: ["base", "explicit_source"],
        sourceId
      })
    ]);
    expect(prepared.normalizedRequest).not.toHaveProperty("knowledgeFocusedRequest");
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toContain(
      "search_knowledge"
    );
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
      message: "Selected Knowledge sources are still processing.",
      ok: false,
      status: 409
    });
    expect(harness.calls).not.toContain("entitlements");
    expect(harness.calls).not.toContain("capabilities");
    expect(harness.calls).not.toContain("context:send");
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
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
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
                revisionId: "assistant-revision-1",
                revisionNumber: 1,
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
      revisionId: "assistant-revision-1"
    });
    expect(prepared.normalizedRequest).not.toHaveProperty("knowledgeFocusedRequest");
    expect(prepared.normalizedRequest.searchPlan.options).toEqual([
      expect.objectContaining({ adapterKind: "provider_model_client", optionId })
    ]);
    expect(prepared.normalizedRequest.toolMode).toBe("auto");
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
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
      expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
        "search_knowledge",
        "search_engine_1"
      ]);
    }
  );

  it.each([
    "gemini_interactions_native" as const,
    "anthropic_messages" as const
  ])("keeps singleton $0 Search hosted when no answer-model tools coexist", async (adapterKind) => {
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
    expect(admissionLoad).toHaveBeenCalledTimes(1);
    expect(admissionLoad.mock.calls[0]?.[0]).not.toHaveProperty(
      "requiresClientToolCoexistence"
    );
    expect(prepared.normalizedRequest.searchPlan?.options[0]?.adapterKind).toBe(
      "answer_provider_hosted"
    );
    expect(prepared.providerRequest.tools).toBeUndefined();
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
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
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
      expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
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
