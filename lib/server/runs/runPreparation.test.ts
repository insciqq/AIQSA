import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { resolveStandardChatBaseline } from "../../domain/promptTemplates";
import { invalidRunParamsError } from "../../domain/runParams";
import type { ResolvedEntitlements } from "../auth/entitlements";
import type { McpRunPlanResult } from "../mcp/runPlan";
import {
  ProviderAdmissionError,
  type ProviderAdmissionPlan
} from "../providerRuntime/admission";
import type {
  NormalizedRunRequest,
  ProviderAdapter,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRequest,
  ProviderSearchAdapter
} from "../providers/types";
import type { RunAttachmentRecord } from "./runRepositoryContract";
import type { RunAttachmentLimits } from "./attachmentLimits";
import {
  materializePreparedRunData,
  prepareRun,
  type DeepReadonly,
  type PreparedRun,
  type PreparedRunDefaults,
  type RegenerateRunPreparationSource,
  type RunPreparationDeps,
  type RunPreparationFailure,
  type RunPreparationInput,
  type RunPreparationResult,
  type SendRunPreparationSource
} from "./runPreparation";

type IfEqual<Left, Right, Equal, Different> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? Equal
    : Different;

type WritableKeys<Value> = {
  [Key in keyof Value]-?: IfEqual<
    { [Property in Key]: Value[Key] },
    { -readonly [Property in Key]: Value[Key] },
    Key,
    never
  >;
}[keyof Value];

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

function readyMcpPlan(): McpRunPlanResult {
  return {
    bindings: [{
      fingerprint: "fingerprint-1",
      runtimeGenerationId: "generation-1",
      serverId: "server-1"
    }],
    ok: true,
    snapshot: {
      servers: [{
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
    searchStrategyId?: string;
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
          apiRoot: "https://compatible.example.test/v1"
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
    requestedSearchStrategyId: options.searchStrategyId ?? "search-disabled",
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
          : "https://api.openai.com/v1"
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
            : "https://generativelanguage.googleapis.com/v1beta"
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
    requestedSearchStrategyId: optionId,
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
    requestedSearchStrategyId: optionId,
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
    requestedSearchStrategyId: optionId,
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
  extractedText?: string | null;
  id: string;
  kind: "document" | "image" | "pdf";
  metadata?: unknown;
  mimeType: string;
  storageKey: string;
}): RunAttachmentRecord {
  return {
    byteSize: input.byteSize ?? 32,
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
  previewError?: Error;
  providerIds?: readonly string[];
  regenerateContext?: readonly ProviderConversationMessage[];
  searchStrategyEnabled?: boolean;
  searchProviderAvailable?: boolean;
  searchStrategyConfig?: Readonly<Record<string, unknown>>;
  searchStrategyKind?: string;
  searchStrategyModelId?: string | null;
  searchStrategyProvider?: string;
  sendContext?: readonly ProviderConversationMessage[];
  storageObjects?: Readonly<Record<string, Readonly<{ body: Buffer; contentType: string }>>>;
}>;

function createHarness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const attachmentLoads: { attachmentIds: string[]; userId: string }[] = [];
  const capabilityLoads: { modelId: string; provider: string }[] = [];
  const entitlementLoads: string[] = [];
  const previewRequests: ProviderRunRequest[] = [];
  const regenerateContextLoads: { chatId: string; leafMessageId: string; userId: string }[] = [];
  const sendContextLoads: { chatId: string; userId: string }[] = [];
  const storageReads: string[] = [];
  const searchStrategyChecks: string[] = [];
  const attachments = options.attachments ?? [];
  const capabilities = Object.prototype.hasOwnProperty.call(options, "capabilities")
    ? (options.capabilities ?? null)
    : baseCapabilities;
  const adapter: ProviderAdapter = {
    buildRequestPreview(request) {
      calls.push("preview");
      previewRequests.push(request);
      if (options.previewError) {
        throw options.previewError;
      }

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
  const searchAdapter: ProviderSearchAdapter = {
    buildRequestPreview: () => ({}),
    async search() {
      return {
        artifacts: [],
        finalProviderResponsePreview: {},
        findings: "unused",
        requestPreview: {},
        sources: [],
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
    async isSearchStrategyEnabled(searchStrategyId) {
      searchStrategyChecks.push(searchStrategyId);
      return options.searchStrategyEnabled ?? true;
    },
    async loadSearchStrategyConfiguration(searchStrategyId) {
      return {
        config: {
          executor: {
            modelId: "perplexity/sonar-pro-search",
            provider: "openrouter"
          },
          params: {
            maxOutputTokens: 1024,
            temperature: 0
          },
          routeProvider: {
            allowFallbacks: true,
            dataCollection: "deny",
            order: ["perplexity"],
            requireParameters: false,
            sort: "throughput",
            zdr: false
          },
          ...(options.searchStrategyConfig ?? {})
        },
        kind: options.searchStrategyKind ?? "perplexity_tool_search",
        modelId:
          options.searchStrategyModelId === undefined
            ? "perplexity/sonar-pro-search"
            : options.searchStrategyModelId,
        provider: options.searchStrategyProvider ?? "openrouter",
        strategyId: searchStrategyId
      };
    },
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
    async loadEntitlements(userId) {
      calls.push("entitlements");
      entitlementLoads.push(userId);
      return options.entitlements ?? defaultEntitlements();
    },
    async loadModelConfiguration(provider, modelId) {
      calls.push("capabilities");
      capabilityLoads.push({ modelId, provider });
      if (provider === "openrouter" && modelId === "perplexity/sonar-pro-search") {
        return {
          capabilities: {
            ...baseCapabilities,
            contextWindow: 200_000,
            defaultMaxOutputTokens: 8192,
            reasoning: false
          },
          defaultParams: {
            maxTokens: 8192,
            provider: {
              dataCollection: "deny",
              order: ["perplexity"]
            },
            reasoning: {
              exclude: true
            },
            temperature: 1
          }
        };
      }
      return capabilities
        ? {
            capabilities,
            defaultParams: { ...(options.defaultParams ?? {}) }
          }
        : null;
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
    ...(options.attachmentLimits
      ? { getAttachmentLimits: () => options.attachmentLimits! }
      : {}),
    ...(options.mcpPlan ? { mcp: { async prepare() { return options.mcpPlan!; } } } : {}),
    providers,
    repository,
    searchProviders:
      options.searchProviderAvailable === false
        ? {}
        : {
            openrouter: searchAdapter
          },
    ...(storage ? { storage } : {})
  };

  return {
    adapter,
    attachmentLoads,
    calls,
    capabilityLoads,
    deps,
    entitlementLoads,
    previewRequests,
    regenerateContextLoads,
    searchStrategyChecks,
    searchAdapter,
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
    searchStrategy: "search-disabled",
    timeZone: "Europe/Berlin",
    ...overrides
  };
}

function sendInput(body: Readonly<Record<string, unknown>> | null = successBody()): RunPreparationInput {
  const source: SendRunPreparationSource = {
    chat: {
      activeLeafMessageId: "prior-user-message",
      defaultModelId: "fake-qsa",
      defaultProvider: "fake",
      id: "chat-1",
      projectMemory: "  Server project memory  "
    },
    kind: "send"
  };

  return {
    body,
    source,
    userId: "user-1"
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
  it("exposes a readonly prepared-run boundary", () => {
    expectTypeOf<WritableKeys<PreparedRun>>().toEqualTypeOf<never>();
    expectTypeOf<WritableKeys<PreparedRunDefaults>>().toEqualTypeOf<never>();
    expectTypeOf<WritableKeys<RunPreparationFailure>>().toEqualTypeOf<never>();
    expectTypeOf<WritableKeys<PreparedRun["normalizedRequest"]>>().toEqualTypeOf<never>();
    expectTypeOf<WritableKeys<PreparedRun["providerRequest"]>>().toEqualTypeOf<never>();
    expectTypeOf<PreparedRun["normalizedRequest"]>().toEqualTypeOf<DeepReadonly<NormalizedRunRequest>>();
    expectTypeOf<PreparedRun["providerRequest"]>().toEqualTypeOf<DeepReadonly<ProviderRunRequest>>();
    expectTypeOf<Extract<keyof PreparedRun, "adapter" | "searchAdapter">>().toEqualTypeOf<never>();
    expectTypeOf<PreparedRun["defaults"]>().toEqualTypeOf<PreparedRunDefaults | null>();
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
          provider: "openai",
          searchStrategy: "perplexity-tool-search"
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
    expect(result.adapter).toBe(harness.adapter);
    expect(result.searchAdapter).toBe(harness.searchAdapter);
    expect(Object.isFrozen(result.adapter)).toBe(false);
    expect(Object.isFrozen(result.searchAdapter)).toBe(false);
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
      system: `${expectedBaseline.renderedSystemPrompt}\n\nProject memory:\nServer project memory`
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
      searchStrategy: "search-disabled",
      userId: "user-1"
    });
    expect(sendPrepared.sourceKind).toBe("send");
    expect(regeneratePrepared.sourceKind).toBe("regenerate");
    expect(sendHarness.calls).toEqual([
      "entitlements",
      "capabilities",
      "context:send",
      "preview"
    ]);
    expect(regenerateHarness.calls).toEqual([
      "entitlements",
      "capabilities",
      "context:regenerate",
      "preview"
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
        system: `${expectedBaseline.renderedSystemPrompt}\n\nProject memory:\nServer project memory`
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

  it("prepares the same server-owned Perplexity policy for send and regenerate", async () => {
    const body = successBody({
      modelId: "openai-answer-model",
      params: {
        search: {
          maxOutputTokens: 2048,
          temperature: 0.25
        }
      },
      provider: "openai",
      searchStrategy: "perplexity-tool-search"
    });
    const sendPrepared = preparedFrom(
      await prepareRun(createHarness().deps, sendInput(body))
    );
    const regeneratePrepared = preparedFrom(
      await prepareRun(createHarness().deps, regenerateInput(body))
    );

    expect(sendPrepared.normalizedRequest.params.search).toEqual({
      maxOutputTokens: 2048,
      temperature: 0.25
    });
    expect(sendPrepared.normalizedRequest.searchPolicy).toEqual({
      controls: {
        maxOutputTokens: {
          defaultValue: 8192,
          maxValue: 8192
        },
        temperature: {
          defaultValue: 1,
          maxValue: 2,
          minValue: 0,
          supported: true
        }
      },
      defaultParams: {
        maxOutputTokens: 1024,
        provider: {
          allowFallbacks: true,
          dataCollection: "deny",
          order: ["perplexity"],
          only: [],
          requireParameters: false,
          sort: "throughput",
          zdr: false
        },
        reasoning: {
          effort: "medium",
          enabled: false,
          exclude: true,
          maxTokens: 0
        },
        stream: false,
        temperature: 0
      },
      modelId: "perplexity/sonar-pro-search",
      provider: "openrouter",
      strategyId: "perplexity-tool-search"
    });
    expect(regeneratePrepared.normalizedRequest.searchPolicy).toEqual(
      sendPrepared.normalizedRequest.searchPolicy
    );
  });

  it("rejects tool-search aliases, routing/privacy objects, unknown keys, and excessive output", async () => {
    for (const search of [
      { maxTokens: 1024 },
      { maxOutputTokens: 8193 },
      { maxOutputTokens: 1024, unknown: true },
      { provider: { dataCollection: "allow", order: ["untrusted"] } },
      { reasoning: { exclude: false } }
    ]) {
      const result = await prepareRun(
        createHarness().deps,
        sendInput(
          successBody({
            modelId: "openai-answer-model",
            params: { search },
            provider: "openai",
            searchStrategy: "perplexity-tool-search"
          })
        )
      );

      expect(result).toMatchObject({
        code: invalidRunParamsError,
        ok: false,
        status: 400
      });
    }
  });

  it("rejects a stale search grant when the concrete strategy is disabled or missing", async () => {
    const harness = createHarness({ searchStrategyEnabled: false });
    const result = await prepareRun(
      harness.deps,
      sendInput(
        successBody({
          modelId: "openai-answer-model",
          provider: "openai",
          searchStrategy: "openai-native-web-search"
        })
      )
    );

    expect(result).toMatchObject({
      code: "search_strategy_not_available",
      ok: false,
      status: 403
    });
    expect(harness.searchStrategyChecks).toEqual(["openai-native-web-search"]);
    expect(harness.calls).toEqual(["entitlements", "capabilities"]);
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
        modelId: "openai-tool-model",
        params,
        provider: "openai"
      }))
    );

    expect(result).toMatchObject({ code: expectedCode, ok: false, status: 400 });
    expect(harness.previewRequests).toHaveLength(0);
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
    expect(harness.previewRequests[0]?.tools).toBeUndefined();
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
      sendInput(successBody({ modelId: "openai-no-tools", provider: "openai" }))
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
    const plan = compatibleAdmissionPlan("openai_responses_compatible", {
      nativeSearch: true,
      searchStrategyId: "openai-native-web-search"
    });
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
        searchStrategy: "openai-native-web-search"
      }))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const prepared = materializePreparedRunData(result.prepared);
    expect(prepared.normalizedRequest.searchStrategy).toBe("openai-native-web-search");
    expect(prepared.providerRequest.searchStrategy).toBe("openai-native-web-search");
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
    expect(prepared.providerRequest.searchStrategy).toBe(optionId);
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

  it("materializes request runtime only from the final coexistence admission binding", async () => {
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
          async load({ knowledgePlan, userId }) {
            return {
              bindings: [],
              fingerprint: "8".repeat(64),
              knowledgePlan,
              userId
            };
          }
        },
        providerAdmission: { load: admissionLoad }
      },
      sendInput(successBody({
        knowledgePlan: { baseIds: ["knowledge-base-1"] },
        modelId: hosted.selection.providerModelId,
        params: {},
        provider: hosted.selection.providerConnectionId,
        searchPlan: { mode: "model_choice", optionIds: [optionId] }
      }))
    );

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const prepared = materializePreparedRunData(result.prepared);
    expect(admissionLoad).toHaveBeenCalledTimes(2);
    expect(prepared.providerAdmissionPlan).toEqual(finalClient);
    expect(prepared.normalizedRequest).toMatchObject({
      modelCapabilities: { contextWindow: 65_536 },
      modelId: finalModelId,
      provider: "gemini"
    });
    expect(prepared.providerRequest).toMatchObject({
      modelCapabilities: { contextWindow: 65_536 },
      modelId: finalModelId,
      provider: "gemini"
    });
    expect(prepared.providerRequestPreview).toMatchObject({
      body: { model: finalModelId },
      provider: "gemini"
    });
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
    "re-admits hosted $provider Search as a query-only route when Knowledge must coexist",
    async ({ adapterKind, hostedPreviewMarker, protocol, provider }) => {
      const { client, hosted, optionId } = nativeSearchCoexistencePlans(adapterKind);
      const admissionLoad = vi.fn(async (input: {
        requiresClientToolCoexistence?: boolean;
      }) => input.requiresClientToolCoexistence ? client : hosted);
      const knowledgeLoad = vi.fn(async ({ knowledgePlan, userId }) => ({
        bindings: [],
        fingerprint: "c".repeat(64),
        knowledgePlan,
        userId
      }));
      const harness = createHarness();
      const result = await prepareRun(
        {
          ...harness.deps,
          allowFakeProvider: false,
          knowledgeAdmission: { load: knowledgeLoad },
          providerAdmission: { load: admissionLoad }
        },
        sendInput(successBody({
          knowledgePlan: { baseIds: ["knowledge-base-1"] },
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
      expect(admissionLoad.mock.calls[1]?.[0]).toMatchObject({
        requiresClientToolCoexistence: true,
        searchPlan: { mode: "model_choice", optionIds: [optionId] }
      });
      expect(knowledgeLoad).toHaveBeenCalledWith({
        knowledgePlan: { baseIds: ["knowledge-base-1"] },
        userId: "user-1"
      });
      expect(prepared.normalizedRequest.searchPlan).toMatchObject({
        mode: "model_choice",
        options: [expect.objectContaining({
          adapterKind: "provider_model_client",
          optionId,
          protocol,
          provider,
          providerModelId: hosted.selection.providerModelId
        })]
      });
      expect(prepared.providerAdmissionPlan).toEqual(client);
      expect(prepared.providerRequest.searchStrategy).toBe(optionId);
      expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
        "retrieve_knowledge",
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

  it("re-admits hosted Search once when Knowledge and MCP tools both coexist", async () => {
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
          async load({ knowledgePlan, userId }) {
            return {
              bindings: [],
              fingerprint: "f".repeat(64),
              knowledgePlan,
              userId
            };
          }
        },
        providerAdmission: { load: admissionLoad }
      },
      sendInput(successBody({
        knowledgePlan: { baseIds: ["knowledge-base-1"] },
        modelId: hosted.selection.providerModelId,
        params: {},
        provider: hosted.selection.providerConnectionId,
        searchPlan: { mode: "model_choice", optionIds: [optionId] }
      }))
    );

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const prepared = materializePreparedRunData(result.prepared);
    expect(admissionLoad).toHaveBeenCalledTimes(2);
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
      "retrieve_knowledge",
      "search_engine_1",
      "mcp_team_lookup_1"
    ]);
  });

  it("uses the same query-only coexistence path for Assistant-owned Knowledge", async () => {
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
                knowledgeBaseIds: ["knowledge-base-1"],
                mcpServerIds: [],
                name: "Knowledge Assistant",
                provider: hosted.selection.providerConnectionId,
                providerModelId: hosted.selection.providerModelId,
                revisionId: "assistant-revision-1",
                revisionNumber: 1,
                runControls: { maxOutputTokens: 512 },
                searchPlan: { mode: "model_choice" as const, optionIds: [optionId] },
                systemPrompt: "Answer from admitted evidence."
              },
              ok: true as const
            };
          }
        },
        knowledgeAdmission: {
          async load({ knowledgePlan, userId }) {
            return {
              bindings: [],
              fingerprint: "1".repeat(64),
              knowledgePlan,
              userId
            };
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
    expect(admissionLoad).toHaveBeenCalledTimes(2);
    expect(prepared.assistant).toEqual({
      assistantId: "assistant-1",
      revisionId: "assistant-revision-1"
    });
    expect(prepared.normalizedRequest.searchPlan?.options[0]?.adapterKind).toBe(
      "provider_model_client"
    );
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
      "retrieve_knowledge",
      "search_engine_1"
    ]);
  });

  it.each([
    "gemini_interactions_native" as const,
    "anthropic_messages" as const
  ])(
    "returns a typed failure when $0 hosted Search has no Knowledge-compatible route",
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
            async load({ knowledgePlan, userId }) {
              return {
                bindings: [],
                fingerprint: "d".repeat(64),
                knowledgePlan,
                userId
              };
            }
          },
          providerAdmission: { load: admissionLoad }
        },
        sendInput(successBody({
          knowledgePlan: { baseIds: ["knowledge-base-1"] },
          modelId: hosted.selection.providerModelId,
          params: {},
          provider: hosted.selection.providerConnectionId,
          searchPlan: { mode: "model_choice", optionIds: [optionId] }
        }))
      );

      expect(result).toMatchObject({
        code: "search_strategy_not_available",
        ok: false,
        status: 403
      });
      expect(admissionLoad).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    "gemini_interactions_native" as const,
    "anthropic_messages" as const
  ])(
    "keeps $0 hosted Search when an admitted Knowledge plan is suppressed by tools none",
    async (adapterKind) => {
      const { hosted, optionId } = nativeSearchCoexistencePlans(adapterKind);
      const admissionLoad = vi.fn(async () => hosted);
      const harness = createHarness();
      const result = await prepareRun(
        {
          ...harness.deps,
          allowFakeProvider: false,
          knowledgeAdmission: {
            async load({ knowledgePlan, userId }) {
              return {
                bindings: [],
                fingerprint: "e".repeat(64),
                knowledgePlan,
                userId
              };
            }
          },
          providerAdmission: { load: admissionLoad }
        },
        sendInput(successBody({
          knowledgePlan: { baseIds: ["knowledge-base-1"] },
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
      expect(prepared.normalizedRequest.searchPlan?.options[0]?.adapterKind).toBe(
        "answer_provider_hosted"
      );
      expect(prepared.providerRequest.tools).toBeUndefined();
    }
  );

  it.each([
    "gemini_interactions_native" as const,
    "anthropic_messages" as const
  ])("keeps singleton $0 Search hosted when no client tools are planned", async (adapterKind) => {
    const { hosted, optionId } = nativeSearchCoexistencePlans(adapterKind);
    const admissionLoad = vi.fn(async () => hosted);
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
    expect(prepared.normalizedRequest.searchPlan?.options[0]?.adapterKind).toBe(
      "answer_provider_hosted"
    );
    expect(prepared.providerRequest.tools).toBeUndefined();
  });

  it("routes a provider-admitted multi-engine plan without requiring the legacy Perplexity service", async () => {
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
      requestedSearchStrategyId: optionIds[0]!,
      searches
    };
    const harness = createHarness({ searchProviderAvailable: false });
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
    expect(prepared.normalizedRequest.searchPolicy).toBeUndefined();
    expect(prepared.providerRequest.tools?.map((tool) => tool.name)).toEqual([
      "search_selected_engines"
    ]);
  });

  it.each([
    { adapterKind: "anthropic_messages" as const, provider: "anthropic" },
    { adapterKind: "gemini_interactions_native" as const, provider: "gemini" }
  ])(
    "serializes logical OpenAI Search as a client tool for $provider answers",
    async ({ adapterKind, provider }) => {
      const plan = providerNeutralOpenAISearchPlan(adapterKind);
      const admissionLoad = vi.fn(async () => plan);
      const legacyPlan = {
        mode: "model_choice" as const,
        optionIds: ["openai-provider-web-search"]
      };
      const result = await prepareRun(
        {
          ...createHarness({ searchProviderAvailable: false }).deps,
          allowFakeProvider: false,
          providerAdmission: { load: admissionLoad }
        },
        sendInput(successBody({
          modelId: plan.selection.providerModelId,
          params: {},
          provider: plan.selection.providerConnectionId,
          searchPlan: legacyPlan
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
      expect(prepared.normalizedRequest.searchStrategy).toBe("openai-native-web-search");
      expect(prepared.defaults?.searchPlan).toEqual(plan.requestedSearchPlan);
      expect(prepared.defaults?.searchStrategy).toBe("openai-native-web-search");
      expect(admissionLoad).toHaveBeenCalledWith(expect.objectContaining({
        searchPlan: legacyPlan,
        searchStrategyId: "openai-provider-web-search"
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
        ...createHarness({ searchProviderAvailable: false }).deps,
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
    expect(prepared.normalizedRequest.searchStrategy).toBe(optionId);
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
      requestedSearchStrategyId: optionId,
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
      nativeSearch: true,
      searchStrategyId: optionId
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
    expect(prepared.normalizedRequest.searchStrategy).toBe(optionId);
    expect(prepared.providerRequest.attachments).toEqual([
      expect.objectContaining({ id: "pdf-1" })
    ]);
  });

  it("keeps the first selected option as the legacy default mirror in a mixed hosted plan", async () => {
    const base = compatibleAdmissionPlan("openai_responses_compatible", {
      nativeSearch: true
    });
    const optionIds = ["company-search", "openai-native-web-search"];
    const plan: ProviderAdmissionPlan = {
      ...base,
      requestedSearchPlan: { mode: "model_choice", optionIds },
      requestedSearchStrategyId: optionIds[0]!,
      searches: [
        {
          bindingKey: "search:company-search",
          configuration: {
            adapterKind: "provider_model_client",
            config: {
              maxResults: 8,
              modelCapabilities: { ...baseCapabilities, nativeSearch: true },
              modelDefaultParams: {},
              queryMaxCharacters: 500,
              timeoutMs: 15_000
            },
            credentialMode: "provider_model",
            executionModes: ["all_selected", "model_choice"],
            kind: "provider_model_web_search",
            modelId: "search-model",
            protocol: "openai_responses_web_search",
            provider: "openai_compatible",
            providerModelId: "technical-search-model",
            revisionId: "revision-client",
            searchStrategyRowId: "integration-client",
            strategyId: optionIds[0]!
          },
          integrationId: "integration-client",
          optionId: optionIds[0]!,
          ordinal: 0,
          revisionId: "revision-client",
          role: base.answer
        },
        {
          bindingKey: null,
          configuration: {
            adapterKind: "answer_provider_hosted",
            config: {
              maxResults: 8,
              queryMaxCharacters: 500,
              timeoutMs: 15_000
            },
            credentialMode: "answer_provider",
            executionModes: ["model_choice"],
            kind: "openai_native_web_search",
            modelId: null,
            protocol: "openai_responses_web_search",
            provider: "openai_compatible",
            providerModelId: null,
            revisionId: "revision-hosted",
            searchStrategyRowId: "integration-hosted",
            strategyId: optionIds[1]!
          },
          integrationId: "integration-hosted",
          optionId: optionIds[1]!,
          ordinal: 1,
          revisionId: "revision-hosted"
        }
      ]
    };
    const result = await prepareRun(
      {
        ...createHarness().deps,
        allowFakeProvider: false,
        providerAdmission: { async load() { return plan; } }
      },
      sendInput(successBody({
        modelId: plan.selection.providerModelId,
        provider: plan.selection.providerConnectionId,
        searchPlan: { mode: "model_choice", optionIds }
      }))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const prepared = materializePreparedRunData(result.prepared);
    expect(prepared.normalizedRequest.searchStrategy).toBe("company-search");
    expect(prepared.defaults).not.toBeNull();
    expect(prepared.defaults?.searchPlan).toEqual({ mode: "model_choice", optionIds });
    expect(prepared.defaults?.searchStrategy).toBe("company-search");
    expect(prepared.defaults?.controlDefaults).not.toHaveProperty("searchStrategyId");
    expect(prepared.providerRequestPreview).toMatchObject({
      body: {
        tools: expect.arrayContaining([
          { type: "web_search" },
          expect.objectContaining({ type: "function" })
        ])
      }
    });
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
      sendInput(successBody({ modelId: "openai-tool-model", provider: "openai" }))
    );

    expect(result).toMatchObject({ code: "context_too_large", ok: false, status: 400 });
    expect(harness.previewRequests).toHaveLength(0);
  });

  it("returns each validation failure at its authoritative precedence and skips later work", async () => {
    await expectFailure({
      calls: [],
      expected: { code: "provider_not_available", status: 400 },
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
          searchStrategy: "openai-native-web-search"
        })
      )
    });
    await expectFailure({
      calls: ["entitlements"],
      expected: { code: "content_required", status: 400 },
      request: sendInput({})
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
      calls: ["entitlements", "capabilities", "context:send"],
      expected: { code: "search_strategy_unknown", status: 400 },
      request: sendInput(successBody({ searchStrategy: "unknown-search" }))
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send"],
      expected: { code: "search_strategy_not_supported_by_model", status: 400 },
      request: sendInput(successBody({ searchStrategy: "openai-native-web-search" }))
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send"],
      expected: { code: "search_provider_not_available", status: 400 },
      harness: { searchProviderAvailable: false },
      request: sendInput(
        successBody({
          modelId: "openai-answer-model",
          provider: "openai",
          searchStrategy: "perplexity-tool-search"
        })
      )
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "context:send", "attachments"],
      expected: { code: "attachment_not_found", status: 400 },
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
          defaultMaxOutputTokens: 0
        }
      },
      messageContains: "exceed the model context budget"
    });

    const previewHarness = createHarness({
      previewError: new Error("preview_failed")
    });
    await expect(prepareRun(previewHarness.deps, sendInput())).rejects.toThrow("preview_failed");
    expect(previewHarness.calls).toEqual([
      "entitlements",
      "capabilities",
      "context:send",
      "preview"
    ]);
  });

  it("rejects typed no-text, zero-emitted partial, and legacy blank PDFs for text-extraction models", async () => {
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
      calls: ["entitlements"],
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
    expect(harness.previewRequests).toEqual([]);
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
    expect(harness.previewRequests).toEqual([prepared.providerRequest]);
    expect(prepared.providerRequestPreview).toEqual({
      attachments: [
        { fileName: "image-1.png", id: "image-1", kind: "image" },
        { fileName: "pdf-1.pdf", id: "pdf-1", kind: "pdf" }
      ],
      modelId: "fake-qsa",
      provider: "fake"
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
