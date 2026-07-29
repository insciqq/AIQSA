import { describe, expect, expectTypeOf, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { invalidRunParamsError } from "../../domain/runParams";
import type { ResolvedEntitlements } from "../auth/entitlements";
import type { McpRunPlanResult } from "../mcp/runPlan";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import type {
  NormalizedRunRequest,
  ProviderAdapter,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRequest,
  ProviderSearchAdapter
} from "../providers/types";
import type { RunAttachmentRecord } from "./runRepositoryContract";
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
          capabilities,
          defaultParams,
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

function runAttachment(input: {
  id: string;
  kind: "image" | "pdf";
  mimeType: string;
  storageKey: string;
}): RunAttachmentRecord {
  return {
    byteSize: 32,
    extractedText: input.kind === "pdf" ? "Extracted PDF fallback" : null,
    fileName: `${input.id}.${input.kind === "pdf" ? "pdf" : "png"}`,
    id: input.id,
    kind: input.kind,
    metadata: {},
    mimeType: input.mimeType,
    status: "ready",
    storageKey: input.storageKey
  };
}

type HarnessOptions = Readonly<{
  attachments?: readonly RunAttachmentRecord[];
  capabilities?: ProviderModelCapabilities | null;
  defaultParams?: Readonly<Record<string, unknown>>;
  entitlements?: ResolvedEntitlements;
  mcpPlan?: McpRunPlanResult;
  previewError?: Error;
  promptAvailable?: boolean;
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
  const promptAvailabilityChecks: { promptPresetId: string; userId: string }[] = [];
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
        finalText: "unused",
        requestPreview: {},
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
    async isPromptPresetAvailable(userId, promptPresetId) {
      calls.push("prompt");
      promptAvailabilityChecks.push({ promptPresetId, userId });
      return options.promptAvailable ?? true;
    },
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
        async getObject(storageKey: string) {
          calls.push(`storage:${storageKey}`);
          storageReads.push(storageKey);
          const object = options.storageObjects?.[storageKey];
          if (!object) {
            throw new Error("stored_object_not_found");
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
    promptAvailabilityChecks,
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
      presetId: " preset-1 ",
      system: "Client system prompt"
    },
    searchStrategy: "search-disabled",
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

async function expectFailure(input: {
  calls: readonly string[];
  expected: Readonly<{ code: string; message?: string; status: 400 | 403 }>;
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
    expectTypeOf<PreparedRun["defaults"]>().toEqualTypeOf<PreparedRunDefaults>();
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
    expect(Object.isFrozen(prepared.defaults)).toBe(true);
    expect(Object.isFrozen(prepared.defaults.controlDefaults)).toBe(true);
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
    const sendPrepared = preparedFrom(await prepareRun(sendHarness.deps, sendInput()));
    const regeneratePrepared = preparedFrom(
      await prepareRun(regenerateHarness.deps, regenerateInput(successBody({ text: "Ignored client text" })))
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
      developer: expect.stringContaining("Client developer prompt"),
      presetId: "preset-1",
      system: "Client system prompt\n\nProject memory:\nServer project memory"
    });
    expect(sendPrepared.normalizedRequest.prompt.developer).toContain("Visible answer contract:");
    expect(regeneratePrepared.normalizedRequest.prompt).toEqual(sendPrepared.normalizedRequest.prompt);
    expect(sendPrepared.defaults).toEqual(regeneratePrepared.defaults);
    expect(sendPrepared.defaults).toEqual({
      controlDefaults: {
        maxOutputTokens: "8192",
        reasoningEffort: "high",
        searchStrategyId: "search-disabled",
        temperature: "0"
      },
      modelId: "fake-qsa",
      promptPresetId: "preset-1",
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
      "prompt",
      "context:send",
      "preview"
    ]);
    expect(regenerateHarness.calls).toEqual([
      "entitlements",
      "capabilities",
      "prompt",
      "context:regenerate",
      "preview"
    ]);
    expect(sendHarness.entitlementLoads).toEqual(["user-1"]);
    expect(regenerateHarness.entitlementLoads).toEqual(["user-1"]);
    expect(sendHarness.promptAvailabilityChecks).toEqual([{ promptPresetId: "preset-1", userId: "user-1" }]);
    expect(regenerateHarness.promptAvailabilityChecks).toEqual([
      { promptPresetId: "preset-1", userId: "user-1" }
    ]);
    expect(sendHarness.sendContextLoads).toEqual([{ chatId: "chat-1", userId: "user-1" }]);
    expect(sendHarness.regenerateContextLoads).toEqual([]);
    expect(regenerateHarness.sendContextLoads).toEqual([]);
    expect(regenerateHarness.regenerateContextLoads).toEqual([
      { chatId: "chat-1", leafMessageId: "stored-user-message", userId: "user-1" }
    ]);
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
    expect(prepared.normalizedRequest.searchStrategy).toBe("openai-native-web-search");
    expect(prepared.defaults.searchPlan).toEqual({ mode: "model_choice", optionIds });
    expect(prepared.defaults.searchStrategy).toBe("company-search");
    expect(prepared.defaults.controlDefaults.searchStrategyId).toBe("company-search");
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
      calls: ["entitlements", "capabilities", "prompt"],
      expected: { code: "default_prompt_unavailable", status: 400 },
      harness: { promptAvailable: false }
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "prompt", "context:send"],
      expected: { code: "invalid_run_params", status: 400 },
      request: sendInput(successBody({ params: { unknown: true } }))
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "prompt", "context:send"],
      expected: { code: "search_strategy_unknown", status: 400 },
      request: sendInput(successBody({ searchStrategy: "unknown-search" }))
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "prompt", "context:send"],
      expected: { code: "search_strategy_not_supported_by_model", status: 400 },
      request: sendInput(successBody({ searchStrategy: "openai-native-web-search" }))
    });
    await expectFailure({
      calls: ["entitlements", "capabilities", "prompt", "context:send"],
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
      calls: ["entitlements", "capabilities", "prompt", "context:send", "attachments"],
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
      calls: ["entitlements", "capabilities", "prompt", "context:send", "attachments"],
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
      calls: ["entitlements", "capabilities", "prompt", "context:send", "attachments"],
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
      calls: ["entitlements", "capabilities", "prompt", "context:send"],
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
      "prompt",
      "context:send",
      "preview"
    ]);
  });

  it("deduplicates private loads while keeping normalized ids and private payloads ephemeral", async () => {
    const imageBytes = Buffer.from("private-image-bytes");
    const pdfBytes = Buffer.from("private-pdf-bytes");
    const imageDataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
    const pdfBase64 = pdfBytes.toString("base64");
    const harness = createHarness({
      attachments: [
        runAttachment({
          id: "image-1",
          kind: "image",
          mimeType: "image/png",
          storageKey: "private/image-1"
        }),
        runAttachment({
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
              { attachmentId: "image-1", type: "attachment" },
              { attachmentId: "pdf-1", type: "attachment" }
            ]
          },
          params: {}
        })
      )
    );
    const prepared = preparedFrom(result);

    expect(prepared.normalizedRequest.attachmentIds).toEqual(["image-1", "image-1", "pdf-1"]);
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
