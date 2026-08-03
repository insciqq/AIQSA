import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { getAuthConfig } from "../auth/config";
import type { ResolvedEntitlements } from "../auth/entitlements";
import { createTestAuth } from "../auth/testRequestAuth";
import { createFakeProviderAdapter } from "../providers/fakeProvider";
import { createOpenAIResponsesAdapter, type OpenAIResponsesClient } from "../providers/openaiResponses";
import {
  createFakeOpenRouterPerplexitySearchAdapter,
  createOpenRouterChatAdapter,
  type OpenRouterChatClient
} from "../providers/openRouterChat";
import type {
  ProviderAdapter,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRefreshResult,
  ProviderSearchAdapter
} from "../providers/types";
import { activeRunControllerRegistry, activeRunControllersForTest } from "./runExecution";
import {
  createCancelModelRunHandler,
  createGetModelRunHandler,
  createRegenerateModelRunHandler,
  createSendMessageHandler
} from "./handlers";
import { reconcileStaleRuns, resetBootOrphanSweepForTest } from "./runRecovery";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AttachmentLinkConflictError,
  McpRunPlanConflictError,
  type DurableRunControlRecord,
  type RunRepository
} from "./runRepositoryContract";
import type { PersistedToolLoopCall } from "./toolLoopPersistence";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });
const authDeps = {
  getConfig: () => config,
  resolveAuth: auth.resolveAuth,
  searchProviders: {} as Record<string, ProviderSearchAdapter>
};

const entitledFakeModel: ResolvedEntitlements = {
  modelKeys: new Set(["fake:fake-qsa"]),
  providerKeys: new Set(),
  searchStrategies: new Set()
};

function authCookie() {
  return auth.cookie;
}

function parseSse(body: string): { data: unknown; type: string }[] {
  return body
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const type = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
      const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);

      return {
        data: data ? JSON.parse(data) : null,
        type: type ?? ""
      };
    });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });

  return { promise, resolve };
}

function recordProviderStreamStart(adapter: ProviderAdapter, onStart: () => void): ProviderAdapter {
  return {
    ...adapter,
    async *stream(request, options) {
      onStart();
      const stream = adapter.stream(request, options);

      while (true) {
        const next = await stream.next();
        if (next.done) {
          return next.value;
        }

        yield next.value;
      }
    }
  };
}

function createMemoryRepository(
  entitlements: ResolvedEntitlements = entitledFakeModel,
  conversationContext: ProviderConversationMessage[] = [],
  modelPricing: { inputTokenPriceMicros: number; outputTokenPriceMicros: number } | null = {
    inputTokenPriceMicros: 2,
    outputTokenPriceMicros: 8
  },
  modelCapabilities: ProviderModelCapabilities = {
    nativePdfInput: false,
    nativeSearch: true,
    parallelToolCalls: false,
    pdf: true,
    reasoning: true,
    toolCalling: true,
    vision: true
  }
) {
  const state: {
    assistantText: string;
    bootSweeps: { liveRunIds: string[]; sweptRunIds: string[] }[];
    cancelled: Parameters<RunRepository["cancelRun"]>[0]["payload"] | null;
    completed: Parameters<RunRepository["completeRun"]>[0] | null;
    created: Parameters<RunRepository["createRun"]>[0] | null;
    events: { event: ModelRunSseEvent; sequence: number }[];
    failed: { error: { code: string; message: string }; runId: string } | null;
    providerCancelPreview: Record<string, unknown> | null;
    providerResponseId: string | null;
    recoverySettled: boolean;
    recentActiveRun: (ReturnType<typeof activeRunRecord> & { updatedAt: Date }) | null;
    regenerated: Parameters<RunRepository["createRegenerationRun"]>[0] | null;
    searchRuns: Parameters<RunRepository["createSearchRun"]>[0][];
    staleActiveRuns: (ReturnType<typeof activeRunRecord> & { updatedAt: Date })[];
    toolCalls: PersistedToolLoopCall[];
    updatedProviderRequestPreview: Record<string, unknown> | null;
  } = {
    assistantText: "",
    bootSweeps: [],
    cancelled: null,
    completed: null,
    created: null,
    events: [],
    failed: null,
    providerCancelPreview: null,
    providerResponseId: null,
    recoverySettled: false,
    recentActiveRun: null,
    regenerated: null,
    searchRuns: [],
    staleActiveRuns: [],
    toolCalls: [],
    updatedProviderRequestPreview: null
  };
  const repository: RunRepository = {
    advanceToolLoopCallBatch: async ({ roundIndex }) =>
      state.toolCalls.some((call) => call.roundIndex === roundIndex &&
        call.state !== "complete" && call.state !== "error")
        ? "incomplete"
        : "advanced",
    appendAssistantText: async (_assistantMessageId, text) => {
      state.assistantText = text;
    },
    appendRunEvent: async (_runId, sequence, event) => {
      state.events.push({ event, sequence });
    },
    beginToolLoopProviderRound: async () => "started",
    cancelPendingToolLoopCalls: async () => {
      let cancelled = 0;
      state.toolCalls = state.toolCalls.map((call) => {
        if (call.state !== "pending") return call;
        cancelled += 1;
        return { ...call, completedAt: new Date().toISOString(), state: "cancelled" };
      });
      return cancelled;
    },
    claimToolLoopCall: async ({ callId }) => {
      const call = state.toolCalls.find((candidate) => candidate.id === callId);
      if (!call) return { kind: "not_found" };
      if (call.state === "complete" || call.state === "error") return { call, kind: "settled" };
      if (call.state === "running") return { call, kind: "ambiguous" };
      if (call.state === "cancelled") return { call, kind: "cancelled" };
      const claimed = { ...call, startedAt: new Date().toISOString(), state: "running" as const };
      state.toolCalls = state.toolCalls.map((candidate) => candidate.id === call.id ? claimed : candidate);
      return { call: claimed, kind: "claimed" };
    },
    sweepBootOrphanedRuns: async ({ liveRunIds }) => {
      const liveRunIdSet = new Set(liveRunIds);
      const sweptRuns = [
        ...(state.recentActiveRun && !liveRunIdSet.has(state.recentActiveRun.id)
          ? [state.recentActiveRun]
          : []),
        ...state.staleActiveRuns.filter((run) => !liveRunIdSet.has(run.id))
      ];

      state.bootSweeps.push({
        liveRunIds,
        sweptRunIds: sweptRuns.map((run) => run.id)
      });

      if (state.recentActiveRun && !liveRunIdSet.has(state.recentActiveRun.id)) {
        state.failed = {
          error: {
            code: "run_orphaned_on_boot",
            message: "Run was active when this server process started and was marked failed."
          },
          runId: state.recentActiveRun.id
        };
        state.recentActiveRun = null;
      }

      state.staleActiveRuns = state.staleActiveRuns.filter((run) => liveRunIdSet.has(run.id));
      return sweptRuns.length;
    },
    cancelRun: async (input) => {
      if (input.runId !== "run-1" || input.userId !== config.bootstrapUserId) {
        return { kind: "not_found" };
      }

      const currentStatus: DurableRunControlRecord["status"] = state.cancelled
        ? "cancelled"
        : state.completed
          ? "complete"
          : state.failed
            ? "error"
            : "streaming";
      const run: DurableRunControlRecord = {
        assistantMessageId: state.regenerated ? "assistant-regen-1" : "assistant-message-1",
        chatId: state.created?.chatId ?? "chat-1",
        id: input.runId,
        modelId: state.created?.modelId ?? "fake-qsa",
        provider: state.created?.provider ?? "fake",
        providerResponseId: state.providerResponseId,
        status: currentStatus
      };
      if (currentStatus !== "streaming") {
        return { kind: "current", run };
      }

      state.cancelled = input.payload;
      return {
        kind: "cancelled",
        run: {
          ...run,
          status: "cancelled"
        }
      };
    },
    completeRun: async (input) => {
      if (state.cancelled || state.completed || state.recoverySettled) {
        return false;
      }

      state.completed = input;
      state.providerResponseId = input.providerResponseId ?? null;
      let sequence = state.events.reduce((max, entry) => Math.max(max, entry.sequence), -1) + 1;
      for (const event of [
        ...(input.eventsBeforeTerminal ?? []),
        { data: input.usage, type: "usage" as const },
        {
          data: { runId: input.runId, status: "complete" as const },
          type: "done" as const
        }
      ]) {
        state.events.push({ event, sequence });
        sequence += 1;
      }
      return true;
    },
    createRun: async (input) => {
      state.created = input;

      return {
        assistantMessageId: "assistant-message-1",
        runId: "run-1",
        userMessageId: "user-message-1"
      };
    },
    createRegenerationRun: async (input) => {
      state.regenerated = input;
      state.created = {
        chatId: input.chatId,
        content: input.normalizedRequest.content,
        defaults: input.defaults,
        expectedActiveLeafId: null,
        modelId: input.modelId,
        normalizedRequest: input.normalizedRequest,
        provider: input.provider,
        providerRequestPreview: input.providerRequestPreview,
        userId: input.userId
      };

      return {
        assistantMessageId: "assistant-regen-1",
        runId: "run-1",
        userMessageId: input.userMessageId
      };
    },
    createSearchRun: async (input) => {
      state.searchRuns.push(input);
    },
    failRun: async (runId, _assistantMessageId, error) => {
      state.failed = { error, runId };
      const sequence = state.events.reduce((max, entry) => Math.max(max, entry.sequence), -1) + 1;
      state.events.push({ event: { data: error, type: "error" }, sequence });
      return true;
    },
    findOwnedChat: async (chatId, userId) =>
      userId === config.bootstrapUserId
	          ? {
	              activeLeafMessageId: conversationContext.at(-1)?.id ?? null,
	              defaultModelId: "fake-qsa",
	              defaultProvider: "fake",
	              id: chatId,
	              messageCount: 1,
	              projectMemory: "Project prefers short bullet answers.",
	              title: "Existing chat"
	            }
        : null,
    findRecentActiveRunForChat: async ({ chatId, since, userId }) =>
      userId === config.bootstrapUserId &&
      state.recentActiveRun &&
      state.recentActiveRun.chatId === chatId &&
      state.recentActiveRun.updatedAt > since
        ? state.recentActiveRun
        : null,
    findStaleActiveRunsForUser: async (input) =>
      input.userId === config.bootstrapUserId
        ? state.staleActiveRuns.filter(
            (run) =>
              run.updatedAt < input.staleBefore &&
              (!input.chatId || run.chatId === input.chatId) &&
              (!input.runId || run.id === input.runId)
          )
        : [],
    findRegenerationSource: async (sourceMessageId, userId) =>
      (sourceMessageId === "assistant-message-1" || sourceMessageId === "user-message-1") &&
      userId === config.bootstrapUserId
        ? {
            assistantMessage:
              sourceMessageId === "assistant-message-1"
                ? {
                    id: sourceMessageId,
                    modelId: "fake-qsa",
                    provider: "fake"
                  }
                : null,
            chat: {
              defaultModelId: "fake-qsa",
              defaultProvider: "fake",
              id: "chat-1",
              projectMemory: "Project prefers short bullet answers."
            },
            userMessage: {
              content: {
                blocks: [{ text: "Original question", type: "text" }]
              },
              id: "user-message-1"
            }
          }
        : null,
    getRunControlForUser: async (runId, userId) =>
      runId === "run-1" && userId === config.bootstrapUserId
        ? {
            assistantMessageId: state.regenerated ? "assistant-regen-1" : "assistant-message-1",
            chatId: state.created?.chatId ?? "chat-1",
            id: runId,
            modelId: state.created?.modelId ?? "fake-qsa",
            provider: state.created?.provider ?? "fake",
            providerResponseId: state.providerResponseId,
            recoverySettled: state.recoverySettled,
            status: state.cancelled ? "cancelled" : state.completed ? "complete" : state.failed ? "error" : "streaming"
          }
        : null,
    getRunForUser: async (runId, userId) =>
      runId === "run-1" && userId === config.bootstrapUserId
        ? (() => {
            const usage = state.completed?.usage;
            const inputTokens = usage?.inputTokens ?? 0;
            const outputTokens = usage?.outputTokens ?? 0;

            return {
              cachedInputTokens: usage?.cachedInputTokens ?? 0,
              cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? 0,
              errorPayload: state.cancelled
                ? {
                    ...state.cancelled,
                    ...(state.providerCancelPreview
                      ? { providerCancelPreview: state.providerCancelPreview }
                      : {})
                  }
                : state.failed
                  ? {
                      ...state.failed.error,
                      ...(state.recoverySettled ? { recoveryTerminal: true } : {})
                    }
                  : null,
              events: state.events.map(({ event, sequence }) => ({
                eventType: event.type,
                payload: event.data,
                sequence
              })),
              estimatedCostMicros: state.completed?.estimatedCostMicros ?? null,
              finalProviderResponsePreview: state.completed?.finalProviderResponsePreview ?? null,
              id: runId,
              inputTokens,
              modelId: state.created?.modelId ?? "fake-qsa",
              normalizedRequest: state.created?.normalizedRequest ?? null,
              outputTokens,
              provider: state.created?.provider ?? "fake",
              providerRequestPreview:
                state.updatedProviderRequestPreview ?? state.created?.providerRequestPreview ?? null,
              reasoningTokens: usage?.reasoningTokens ?? 0,
              searchRuns: state.searchRuns,
              status: state.cancelled
                ? "cancelled"
                : state.completed
                  ? "complete"
                  : state.failed
                    ? "error"
                    : "streaming",
              toolCalls: [],
              totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
              usage: state.completed?.usage ?? null
            };
          })()
        : null,
    getChatUpdateForRun: async ({ assistantMessageId, chatId, userId, userMessageId }) =>
      userId === config.bootstrapUserId && state.completed
        ? {
            chat: {
              activeLeafMessageId: assistantMessageId,
              createdAt: "2026-06-08T00:00:00.000Z",
              defaultModelId: "fake-qsa",
              defaultPromptPresetId: "prompt-1",
              defaultProvider: "fake",
              folderId: null,
              id: chatId,
              messageCount: state.regenerated ? 3 : 3,
              pinned: false,
              title: "Existing chat",
              updatedAt: "2026-06-08T00:00:01.000Z"
            },
            messages: [
              {
                content: state.created?.content ?? {
                  blocks: [{ text: "Original question", type: "text" }]
                },
                createdAt: "2026-06-08T00:00:00.000Z",
                errorMessage: null,
                id: userMessageId,
                modelId: state.created?.modelId ?? "fake-qsa",
                modelRunId: null,
                parentMessageId: null,
                provider: state.created?.provider ?? "fake",
                role: "user",
                status: "complete"
              },
              {
                artifactSummary: null,
                content: {
                  blocks: [{ text: state.completed.finalText, type: "text" }]
                },
                createdAt: "2026-06-08T00:00:01.000Z",
                errorMessage: null,
                id: assistantMessageId,
                modelId: state.completed.modelId,
                modelRunId: state.completed.runId,
                parentMessageId: userMessageId,
                provider: state.completed.provider,
                role: "assistant",
                status: "complete"
              }
            ],
          }
        : null,
    isPromptPresetAvailable: async (_userId, promptPresetId) =>
      new Set(["prompt-1", "prompt-regen"]).has(promptPresetId),
    isSearchStrategyEnabled: async () => true,
    loadSearchStrategyConfiguration: async (searchStrategyId) => ({
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
        }
      },
      kind: "perplexity_tool_search",
      modelId: "perplexity/sonar-pro-search",
      provider: "openrouter",
      strategyId: searchStrategyId
    }),
    loadConversationContext: async () => conversationContext,
    loadConversationContextForExpectedLeaf: async (_chatId, _userId, expectedActiveLeafMessageId) =>
      expectedActiveLeafMessageId === (conversationContext.at(-1)?.id ?? null)
        ? conversationContext
        : null,
    loadConversationContextForLeaf: async (_chatId, _userId, leafMessageId) => [
      ...conversationContext,
      {
        content: {
          blocks: [{ text: "Original question", type: "text" }]
        },
        id: leafMessageId,
        role: "user"
      }
    ],
    loadAttachments: async (_userId, attachmentIds) =>
      attachmentIds.map((id) => ({
        byteSize: 512,
        extractedText: "Extracted PDF text",
        fileName: "brief.pdf",
        id,
        kind: "pdf",
        metadata: {},
        mimeType: "application/pdf",
        status: "ready",
        storageKey: `storage/${id}`
      })),
    loadEntitlements: async () => entitlements,
    loadModelConfiguration: async () => ({
      capabilities: modelCapabilities,
      defaultParams: {}
    }),
    loadModelPricing: async () => modelPricing,
    loadRunUsageAttributions: async () => [],
    loadCheckpointedToolLoopRun: async () => null,
    markAssistantMessageGroundedLiveOnly: async () => true,
    nextRunEventSequence: async () =>
      state.events.reduce((max, event) => Math.max(max, event.sequence), -1) + 1,
    persistToolLoopCallBatch: async (input) => {
      const existing = state.toolCalls.filter((call) => call.roundIndex === input.roundIndex);
      if (existing.length > 0) return { calls: existing, kind: "reused" };
      const calls = input.calls.map((call, index): PersistedToolLoopCall => ({
        arguments: call.arguments,
        completedAt: null,
        id: `tool-call-${input.roundIndex}-${index}`,
        mcpBinding: call.runtimeGenerationFingerprint
          ? {
              id: `binding-${index}`,
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
      state.toolCalls.push(...calls);
      return { calls, kind: "persisted" };
    },
    recordRunUsageEvents: async () => true,
    settleRecoveredRunError: async (input) => {
      if (
        input.runId !== "run-1" ||
        input.userId !== config.bootstrapUserId ||
        state.cancelled ||
        state.completed ||
        state.recoverySettled
      ) {
        return false;
      }

      state.failed = {
        error: input.error,
        runId: input.runId
      };
      state.providerResponseId = input.providerResponseId ?? state.providerResponseId;
      state.recoverySettled = true;
      let sequence = state.events.reduce((max, event) => Math.max(max, event.sequence), -1) + 1;
      for (const event of [
        ...input.events,
        { data: input.error, type: "error" as const }
      ]) {
        state.events.push({ event, sequence });
        sequence += 1;
      }
      return true;
    },
    settleToolLoopCall: async ({ callId, result, state: callState }) => {
      const call = state.toolCalls.find((candidate) => candidate.id === callId);
      if (!call) return "not_found";
      state.toolCalls = state.toolCalls.map((candidate) => candidate.id === callId
        ? {
            ...candidate,
            completedAt: new Date().toISOString(),
            result,
            state: callState
          }
        : candidate);
      return "settled";
    },
    resetToolLoopAssistantDraft: async () => true,
    updateRunProviderResponseId: async (_runId, providerResponseId) => {
      state.providerResponseId = providerResponseId;
      return "published";
    },
    updateRunProviderRequestPreview: async (_runId, providerRequestPreview) => {
      state.updatedProviderRequestPreview = providerRequestPreview;
    },
    updateCancelledRunProviderPreview: async (input) => {
      if (
        input.runId !== "run-1" ||
        input.userId !== config.bootstrapUserId ||
        !state.cancelled
      ) {
        return false;
      }

      state.providerCancelPreview = input.providerCancelPreview;
      return true;
    }
  };

  return { repository, state };
}

function activeRunRecord(input: Partial<{
  assistantMessageId: string | null;
  chatId: string;
  id: string;
  modelId: string;
  provider: string;
  providerResponseId: string | null;
  status: string;
}> = {}) {
  return {
    assistantMessageId: input.assistantMessageId ?? "assistant-active",
    chatId: input.chatId ?? "chat-active",
    id: input.id ?? "run-active",
    modelId: input.modelId ?? "fake-qsa",
    provider: input.provider ?? "fake",
    providerResponseId: input.providerResponseId ?? null,
    status: input.status ?? "streaming"
  };
}

function openAiCreatedRun(): Parameters<RunRepository["createRun"]>[0] {
  return {
    chatId: "chat-1",
    content: { blocks: [] },
    defaults: {
      controlDefaults: {
        searchStrategyId: "search-disabled"
      },
      modelId: "gpt-5.5",
      promptPresetId: null,
      provider: "openai",
      searchStrategy: "search-disabled",
      userId: config.bootstrapUserId
    },
    expectedActiveLeafId: null,
    modelId: "gpt-5.5",
    normalizedRequest: {
      attachmentIds: [],
      chatId: "chat-1",
      content: { blocks: [] },
      modelCapabilities: {
        nativePdfInput: false,
        nativeSearch: true,
        pdf: true,
        reasoning: true,
        vision: true
      },
      modelId: "gpt-5.5",
      params: {},
      prompt: {
        developer: null,
        presetId: null,
        system: null
      },
      provider: "openai",
      searchStrategy: "search-disabled"
    },
    provider: "openai",
    providerRequestPreview: {},
    userId: config.bootstrapUserId
  };
}

function createOpenRouterToolHarness(
  responses: Record<string, unknown>[],
  searchStrategies: Set<string> = new Set(["perplexity-tool-search"]),
  searchAdapter = createFakeOpenRouterPerplexitySearchAdapter(),
  modelCapabilities: ProviderModelCapabilities = {
    nativePdfInput: false,
    nativeSearch: false,
    parallelToolCalls: false,
    pdf: true,
    reasoning: true,
    streaming: true,
    toolCalling: true,
    vision: true
  }
) {
  const bodies: Record<string, unknown>[] = [];
  const client: OpenRouterChatClient = {
    createChatCompletion: async (body) => {
      bodies.push(body);
      const next = responses.shift();
      if (!next) {
        throw new Error("unexpected_openrouter_request");
      }

      return next;
    }
  };
  const { repository, state } = createMemoryRepository(
    {
      modelKeys: new Set(["openrouter:anthropic/claude-opus-4.8"]),
      providerKeys: new Set(),
      searchStrategies
    },
    [
      {
        content: {
          blocks: [{ text: "Какая последняя модель Anthropic?", type: "text" }]
        },
        id: "previous-user-message",
        role: "user"
      }
    ],
    {
      inputTokenPriceMicros: 2,
      outputTokenPriceMicros: 8
    },
    modelCapabilities
  );
  const POST = createSendMessageHandler({
    ...authDeps,
    providers: {
      openrouter: createOpenRouterChatAdapter({ client })
    },
    repository,
    searchProviders: {
      openrouter: searchAdapter
    }
  });

  return { bodies, POST, state };
}

async function sendOpenRouterToolMessage(
  POST: ReturnType<typeof createSendMessageHandler>,
  text: string,
  searchStrategy = "perplexity-tool-search"
): Promise<Response> {
  return POST(
    new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({
        modelId: "anthropic/claude-opus-4.8",
        params: {
          maxTokens: 128,
          provider: {
            only: ["Anthropic"],
            order: ["anthropic"]
          },
          stream: true
        },
        provider: "openrouter",
        searchStrategy,
        text
      }),
      headers: {
        cookie: authCookie()
      },
      method: "POST"
    }),
    {
      params: {
        chatId: "chat-1"
      }
    }
  );
}

function createOpenAIToolHarness(responses: Record<string, unknown>[]) {
  const bodies: Record<string, unknown>[] = [];
  const nextResponse = () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("unexpected_openai_request");
    }
    return next;
  };
  const client: OpenAIResponsesClient = {
    cancel: async () => ({}),
    create: async (body) => {
      bodies.push(body);
      return nextResponse();
    },
    retrieve: async () => ({}),
    stream: async (body) => {
      bodies.push(body);
      const response = nextResponse();
      const id = typeof response.id === "string" ? response.id : "response-test";
      return new Response([
        `event: response.created\ndata: ${JSON.stringify({
          response: { id, status: "in_progress" },
          type: "response.created"
        })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          response,
          type: "response.completed"
        })}\n\n`
      ].join(""), {
        headers: { "content-type": "text/event-stream" }
      });
    }
  };
  const { repository, state } = createMemoryRepository(
    {
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set(["perplexity-tool-search"])
    },
    [
      {
        content: {
          blocks: [{ text: "Какая последняя модель Anthropic?", type: "text" }]
        },
        id: "previous-user-message",
        role: "user"
      }
    ],
    {
      inputTokenPriceMicros: 2,
      outputTokenPriceMicros: 8
    },
    {
      backgroundStreaming: true,
      nativePdfInput: false,
      nativeBackground: true,
      nativeSearch: true,
      parallelToolCalls: false,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    }
  );
  const POST = createSendMessageHandler({
    ...authDeps,
    providers: {
      openai: createOpenAIResponsesAdapter({ client, pollIntervalMs: 0 })
    },
    repository,
    searchProviders: {
      openrouter: createFakeOpenRouterPerplexitySearchAdapter()
    }
  });

  return { bodies, POST, state };
}

async function sendOpenAIToolMessage(
  POST: ReturnType<typeof createSendMessageHandler>,
  text: string
): Promise<Response> {
  return POST(
    new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({
        modelId: "gpt-5.5",
        params: {
          background: true,
          maxOutputTokens: 128,
          reasoning: {
            effort: "medium"
          },
          stream: true
        },
        provider: "openai",
        searchStrategy: "perplexity-tool-search",
        text
      }),
      headers: {
        cookie: authCookie()
      },
      method: "POST"
    }),
    {
      params: {
        chatId: "chat-1"
      }
    }
  );
}

describe("model run route handlers", () => {
  beforeEach(() => {
    resetBootOrphanSweepForTest();
  });

  it("returns a retryable conflict when the requested or commit-time active leaf no longer matches", async () => {
    const context: ProviderConversationMessage[] = [
      {
        content: { blocks: [{ text: "Branch A", type: "text" }] },
        id: "leaf-a",
        role: "assistant"
      }
    ];
    const staleHarness = createMemoryRepository(entitledFakeModel, context);
    const stalePOST = createSendMessageHandler({
      ...authDeps,
      providers: { fake: createFakeProviderAdapter() },
      repository: staleHarness.repository
    });
    const staleResponse = await stalePOST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          expectedActiveLeafId: "leaf-b",
          modelId: "fake-qsa",
          provider: "fake",
          text: "Continue this branch"
        }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );

    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toEqual({ error: "active_leaf_changed" });
    expect(staleHarness.state.created).toBeNull();

    const commitHarness = createMemoryRepository(entitledFakeModel, context);
    commitHarness.repository.createRun = async () => {
      throw new ActiveLeafConflictError();
    };
    const commitPOST = createSendMessageHandler({
      ...authDeps,
      providers: { fake: createFakeProviderAdapter() },
      repository: commitHarness.repository
    });
    const commitResponse = await commitPOST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          expectedActiveLeafId: "leaf-a",
          modelId: "fake-qsa",
          provider: "fake",
          text: "Continue this branch"
        }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );

    expect(commitResponse.status).toBe(409);
    await expect(commitResponse.json()).resolves.toEqual({ error: "active_leaf_changed" });

    const attachmentHarness = createMemoryRepository();
    attachmentHarness.repository.createRun = async () => {
      throw new AttachmentLinkConflictError();
    };
    const attachmentPOST = createSendMessageHandler({
      ...authDeps,
      providers: { fake: createFakeProviderAdapter() },
      repository: attachmentHarness.repository
    });
    const attachmentResponse = await attachmentPOST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({ modelId: "fake-qsa", provider: "fake", text: "Attachment race" }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );
    expect(attachmentResponse.status).toBe(409);
    await expect(attachmentResponse.json()).resolves.toEqual({ error: "attachment_not_available" });
  });

  it("rejects sends when the target chat is archived or unavailable", async () => {
    const { repository, state } = createMemoryRepository();
    repository.findOwnedChat = async () => null;
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-archived/messages", {
        body: JSON.stringify({
          content: {
            blocks: [{ text: "Archived send", type: "text" }]
          },
          modelId: "fake-qsa",
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-archived"
        }
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "chat_not_found"
    });
    expect(state.created).toBeNull();
  });

  it("rejects empty sends with no text or attachments", async () => {
    const { repository, state } = createMemoryRepository();
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: {
            blocks: []
          },
          modelId: "fake-qsa",
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "content_required"
    });
    expect(state.created).toBeNull();
  });

  it("allows provider-wide grants to run enabled catalog models", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(),
      providerKeys: new Set(["openai"]),
      searchStrategies: new Set()
    });
    repository.loadModelConfiguration = async (provider, modelId) =>
      provider === "openai" && modelId === "gpt-5.5"
        ? {
            capabilities: {
              contextWindow: 400000,
              nativePdfInput: false,
              nativeSearch: true,
              pdf: true,
              reasoning: true,
              streaming: true,
              vision: true
            },
            defaultParams: {}
          }
        : null;
    const provider: ProviderAdapter = {
      buildRequestPreview: vi.fn(() => ({
        provider: "openai"
      })),
      async *stream() {
        return {
          finalProviderResponsePreview: {},
          finalText: "ok",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 2
          }
        };
      }
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        openai: provider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "gpt-5.5",
          provider: "openai",
          text: "Allowed catalog model"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(state.created?.modelId).toBe("gpt-5.5");
    expect(provider.buildRequestPreview).toHaveBeenCalledOnce();
  });

  it.each([
    ["unknown", "not-in-catalog", new Set(["openai"])],
    ["disabled", "disabled-model", new Set(["openai"])],
    ["model-specific disabled", "disabled-model", new Set<string>()]
  ])("rejects %s model ids before provider dispatch", async (_label, modelId, providerKeys) => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set([`openai:${modelId}`]),
      providerKeys,
      searchStrategies: new Set()
    });
    repository.loadModelConfiguration = async () => null;
    const provider: ProviderAdapter = {
      buildRequestPreview: vi.fn(() => ({
        provider: "openai"
      })),
      async *stream() {
        throw new Error("provider should not be called");
      }
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        openai: provider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId,
          provider: "openai",
          text: "Do not dispatch"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "model_not_available"
    });
    expect(state.created).toBeNull();
    expect(provider.buildRequestPreview).not.toHaveBeenCalled();
  });

  it("keeps attachment-only sends as the latest provider user turn", async () => {
    const { repository, state } = createMemoryRepository();
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: {
            blocks: [{ attachmentId: "attachment-1", fileName: "brief.pdf", type: "file" }]
          },
          modelId: "fake-qsa",
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    parseSse(await response.text());
    expect(state.created?.normalizedRequest.attachmentIds).toEqual(["attachment-1"]);
    expect(state.created?.providerRequestPreview).toMatchObject({
      replayedContext: [
        {
          id: "current-user-message",
          role: "user",
          text: ""
        }
      ]
    });
  });

  it("passes text document attachments without requiring PDF model capability", async () => {
    const { repository, state } = createMemoryRepository(
      entitledFakeModel,
      [],
      {
        inputTokenPriceMicros: 2,
        outputTokenPriceMicros: 8
      },
      {
        nativePdfInput: false,
        nativeSearch: true,
        pdf: false,
        reasoning: true,
        vision: true
      }
    );
    repository.loadAttachments = async (_userId, attachmentIds) =>
      attachmentIds.map((id) => ({
        byteSize: 42,
        extractedText: "Document body",
        fileName: "notes.md",
        id,
        kind: "document",
        metadata: {},
        mimeType: "text/plain",
        status: "ready",
        storageKey: `storage/${id}`
      }));
    let providerAttachments: unknown[] = [];
    const provider: ProviderAdapter = {
      buildRequestPreview: (runRequest) => {
        providerAttachments = runRequest.attachments;

        return {
          attachments: runRequest.attachments
        };
      },
      async *stream() {
        return {
          finalProviderResponsePreview: {
            text: "ok"
          },
          finalText: "ok",
          usage: {
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 2
          }
        };
      }
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: provider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: {
            blocks: [{ attachmentId: "attachment-1", fileName: "notes.md", type: "file" }]
          },
          modelId: "fake-qsa",
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    parseSse(await response.text());
    expect(providerAttachments).toEqual([
      expect.objectContaining({
        extractedText: "Document body",
        fileName: "notes.md",
        kind: "document",
        mimeType: "text/plain"
      })
    ]);
    expect(JSON.stringify(state.created?.normalizedRequest.context)).not.toContain("Document body");
  });

  it("rejects oversized extracted attachment text before provider dispatch", async () => {
    const { repository, state } = createMemoryRepository(
      entitledFakeModel,
      [],
      null,
      {
        contextWindow: 120,
        defaultMaxOutputTokens: 20,
        nativePdfInput: false,
        nativeSearch: true,
        pdf: true,
        reasoning: true,
        vision: true
      }
    );
    repository.loadAttachments = async (_userId, attachmentIds) =>
      attachmentIds.map((id) => ({
        byteSize: 8000,
        extractedText: "large attachment text ".repeat(200),
        fileName: "large.md",
        id,
        kind: "document",
        metadata: {},
        mimeType: "text/markdown",
        status: "ready",
        storageKey: `storage/${id}`
      }));
    const buildRequestPreview = vi.fn(() => ({
      provider: "fake"
    }));
    const provider: ProviderAdapter = {
      buildRequestPreview,
      async *stream() {
        throw new Error("provider should not be called");
      }
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: provider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: {
            blocks: [{ attachmentId: "attachment-large", fileName: "large.md", type: "file" }]
          },
          modelId: "fake-qsa",
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "context_too_large"
    });
    expect(state.created).toBeNull();
    expect(buildRequestPreview).not.toHaveBeenCalled();
  });

  it("loads PDF bytes for native PDF models without requiring extracted-PDF capability", async () => {
    const { repository } = createMemoryRepository(
      entitledFakeModel,
      [],
      {
        inputTokenPriceMicros: 2,
        outputTokenPriceMicros: 8
      },
      {
        nativePdfInput: true,
        nativeSearch: true,
        pdf: false,
        reasoning: true,
        vision: true
      }
    );
    repository.loadAttachments = async (_userId, attachmentIds) =>
      attachmentIds.map((id) => ({
        byteSize: 64,
        extractedText: "Extracted fallback text",
        fileName: "brief.pdf",
        id,
        kind: "pdf",
        metadata: {},
        mimeType: "application/pdf",
        status: "ready",
        storageKey: `storage/${id}`
      }));
    const pdfBytes = Buffer.from("%PDF-1.4\nnative\n");
    let providerAttachments: unknown[] = [];
    const provider: ProviderAdapter = {
      buildRequestPreview: (runRequest) => {
        providerAttachments = runRequest.attachments;

        return {
          attachments: runRequest.attachments.map((attachment) => ({
            fileName: attachment.fileName,
            hasBase64Data: Boolean(attachment.base64Data),
            id: attachment.id,
            kind: attachment.kind
          }))
        };
      },
      async *stream() {
        return {
          finalProviderResponsePreview: {
            text: "ok"
          },
          finalText: "ok",
          usage: {
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 2
          }
        };
      }
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: provider
      },
      repository,
      storage: {
        deleteObject: async () => {},
        getObject: async (storageKey) => ({
          body: pdfBytes,
          contentType: "application/pdf",
          storageKey
        }),
        putObject: async () => {}
      }
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: {
            blocks: [{ attachmentId: "attachment-1", fileName: "brief.pdf", type: "file" }]
          },
          modelId: "fake-qsa",
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    parseSse(await response.text());
    expect(providerAttachments).toEqual([
      expect.objectContaining({
        base64Data: pdfBytes.toString("base64"),
        fileName: "brief.pdf",
        kind: "pdf"
      })
    ]);
  });

  it("streams a complete fake provider SSE run and persists run artifacts", async () => {
    const { repository, state } = createMemoryRepository();
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: {
            blocks: [
              { text: "Hello QSA", type: "text" },
              { attachmentId: "attachment-1", fileName: "brief.pdf", type: "file" }
            ]
          },
          modelId: "fake-qsa",
          params: {
            temperature: 0
          },
          prompt: {
            developer: "Developer draft",
            presetId: "prompt-1",
            system: "System draft"
          },
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = parseSse(await response.text());
    const eventTypes = events.map((event) => event.type);

    expect(eventTypes.slice(0, 3)).toEqual(["run_start", "message_start", "artifact"]);
    expect(eventTypes).toContain("token");
    expect(eventTypes.slice(-3)).toEqual(["usage", "chat_update", "done"]);
    expect(events.find((event) => event.type === "chat_update")?.data).toMatchObject({
      chat: {
        activeLeafMessageId: "assistant-message-1",
        id: "chat-1",
        messageCount: 3
      },
      messages: [
        {
          id: "user-message-1",
          role: "user",
          status: "complete"
        },
        {
          id: "assistant-message-1",
          modelRunId: "run-1",
          role: "assistant",
          status: "complete"
        }
      ]
    });
    expect(state.created?.normalizedRequest).toMatchObject({
      attachmentIds: ["attachment-1"],
      context: {
        messages: [
          {
            role: "user"
          }
        ],
        mode: "branch_path"
      },
      modelId: "fake-qsa",
      params: {
        temperature: 0
      },
      prompt: {
        developer: expect.stringContaining("Developer draft"),
        presetId: "prompt-1",
        system: "System draft\n\nProject memory:\nProject prefers short bullet answers."
      },
      provider: "fake",
      searchStrategy: "search-disabled"
    });
    expect(state.created?.normalizedRequest.prompt.developer).toContain("Visible answer contract");
    expect(state.created?.normalizedRequest.prompt.system).toContain("Project memory");
    expect(state.completed?.usage.outputTokens).toBeGreaterThan(0);
    expect(state.completed?.provider).toBe("fake");
    expect(state.completed?.modelId).toBe("fake-qsa");
    expect(state.completed?.finalText).toBe("Fake answer: Hello QSA");
    expect(state.completed?.estimatedCostMicros).toBe(
      state.completed!.usage.inputTokens * 2 + state.completed!.usage.outputTokens * 8
    );
    expect(state.events.find(({ event }) => event.type === "usage")?.event.data).toMatchObject({
      estimatedCostMicros: state.completed?.estimatedCostMicros
    });
    expect(state.events.map(({ event }) => event.type)).toEqual([
      "run_start",
      "message_start",
      "artifact",
      "token",
      "usage",
      "done"
    ]);
  });

  it("passes non-prompt defaults and prompt provenance from the accepted send", async () => {
    const { repository, state } = createMemoryRepository();
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: {
            blocks: [{ text: "Save these defaults", type: "text" }]
          },
          controlDefaults: {
            maxOutputTokens: "999999",
            reasoningEffort: "high",
            searchStrategyId: "search-disabled",
            streamMode: true,
            temperature: "0.4"
          },
          modelId: "fake-qsa",
          params: {
            maxOutputTokens: 8192,
            reasoning: {
              effort: "high"
            },
            temperature: 0.4
          },
          prompt: {
            presetId: "prompt-1"
          },
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(state.created?.defaults).toEqual({
      controlDefaults: {
        maxOutputTokens: "8192",
        reasoningEffort: "high",
        temperature: "0.4"
      },
      modelId: "fake-qsa",
      promptPresetId: "prompt-1",
      provider: "fake",
      searchPlan: {
        mode: "all_selected",
        optionIds: []
      },
      searchStrategy: "search-disabled",
      userId: config.bootstrapUserId
    });
    expect(state.created?.normalizedRequest.prompt.presetId).toBe("prompt-1");
  });

  it("allows a freeform send with intentionally null prompt provenance", async () => {
    const { repository, state } = createMemoryRepository();
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          prompt: {
            developer: "Custom developer prompt",
            presetId: null,
            system: "Custom system prompt"
          },
          provider: "fake",
          searchStrategy: "search-disabled",
          text: "Custom prompt run"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(state.created?.normalizedRequest.prompt).toMatchObject({
      presetId: null,
      system: expect.stringContaining("Custom system prompt")
    });
  });

  it("rejects foreign send prompt preset ids before creating a run", async () => {
    const { repository, state } = createMemoryRepository();
    repository.isPromptPresetAvailable = async () => false;
    const provider: ProviderAdapter = {
      buildRequestPreview: vi.fn(() => ({
        provider: "fake"
      })),
      async *stream() {
        throw new Error("provider should not be called");
      }
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: provider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          prompt: {
            presetId: "foreign-prompt"
          },
          provider: "fake",
          searchStrategy: "search-disabled",
          text: "Foreign prompt"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "default_prompt_unavailable"
    });
    expect(state.created).toBeNull();
    expect(provider.buildRequestPreview).not.toHaveBeenCalled();
  });

  it("persists normalized OpenAI streaming token, artifact, usage, and done events", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set(["openai-native-web-search"])
    });
    const openaiAdapter: ProviderAdapter = {
      buildRequestPreview: (runRequest) => ({
        body: {
          model: runRequest.modelId,
          stream: runRequest.params.stream
        },
        provider: "openai"
      }),
      async *stream(runRequest) {
        expect(runRequest.params.stream).toBe(true);
        expect(runRequest.searchStrategy).toBe("openai-native-web-search");
        yield {
          data: {
            artifactType: "summary",
            payload: {
              provider: "openai",
              responseId: "resp-stream-route",
              status: "in_progress",
              stream: true
            }
          },
          type: "artifact"
        };
        yield {
          data: {
            artifactType: "search",
            payload: {
              provider: "openai",
              responseId: "resp-stream-route",
              status: "searching",
              type: "web_search_call"
            }
          },
          type: "artifact"
        };
        yield {
          data: {
            delta: "Hel"
          },
          type: "token"
        };
        yield {
          data: {
            delta: "lo"
          },
          type: "token"
        };

        return {
          finalProviderResponsePreview: {
            provider: "openai",
            text: "Hello"
          },
          finalText: "Hello",
          providerResponseId: "resp-stream-route",
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            reasoningTokens: 0
          }
        };
      }
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        openai: openaiAdapter
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "gpt-5.5",
          params: {
            maxOutputTokens: 64,
            reasoning: {
              effort: "medium"
            },
            stream: true
          },
          provider: "openai",
          searchStrategy: "openai-native-web-search",
          text: "Stream with search"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    const liveEvents = parseSse(await response.text());

    expect(liveEvents.filter((event) => event.type === "token").map((event) => event.data)).toEqual([
      { delta: "Hel" },
      { delta: "lo" }
    ]);
    expect(state.created?.providerRequestPreview).toMatchObject({
      body: {
        stream: true
      }
    });
    expect(state.providerResponseId).toBe("resp-stream-route");
    expect(state.completed).toMatchObject({
      finalText: "Hello",
      provider: "openai",
      providerResponseId: "resp-stream-route",
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        reasoningTokens: 0
      }
    });
    expect(state.events.map(({ event }) => event.type)).toEqual([
      "run_start",
      "message_start",
      "artifact",
      "artifact",
      "token",
      "usage",
      "done"
    ]);
  });

  it.each([
    ["temperature", { temperature: 999 }],
    ["maxOutputTokens", { maxOutputTokens: -5 }],
    ["reasoning effort", { reasoning: { effort: "extreme" } }]
  ])("rejects invalid send %s params before creating a run", async (_label, paramsBody) => {
    const { repository, state } = createMemoryRepository();
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          params: paramsBody,
          provider: "fake",
          text: "Invalid params"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_run_params"
    });
    expect(state.created).toBeNull();
  });

  it("rejects gpt-5.5 minimal reasoning effort before creating a run", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        openai: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "gpt-5.5",
          params: {
            reasoning: {
              effort: "minimal"
            }
          },
          provider: "openai",
          text: "Invalid GPT effort"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_run_params"
    });
    expect(state.created).toBeNull();
  });

  it("uses null estimated cost metadata for zero-priced models", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [], {
      inputTokenPriceMicros: 0,
      outputTokenPriceMicros: 0
    });
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Zero price"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(state.completed?.estimatedCostMicros).toBeNull();
    expect(state.events.find(({ event }) => event.type === "usage")?.event.data).toMatchObject({
      estimatedCostMicros: null
    });
  });

  it("trims oldest branch context for tiny context windows and emits a truncation artifact", async () => {
    const conversationContext: ProviderConversationMessage[] = [
      {
        content: { blocks: [{ text: "old user ".repeat(50), type: "text" }] },
        id: "old-user",
        role: "user"
      },
      {
        content: { blocks: [{ text: "old assistant ".repeat(50), type: "text" }] },
        id: "old-assistant",
        role: "assistant"
      },
      {
        content: { blocks: [{ text: "recent user", type: "text" }] },
        id: "recent-user",
        role: "user"
      },
      {
        content: { blocks: [{ text: "recent assistant", type: "text" }] },
        id: "recent-assistant",
        role: "assistant"
      }
    ];
    const { repository, state } = createMemoryRepository(entitledFakeModel, conversationContext, null, {
      contextWindow: 260,
      defaultMaxOutputTokens: 20,
      nativePdfInput: false,
      nativeSearch: true,
      pdf: true,
      reasoning: true,
      vision: true
    });
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "current"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(state.created?.normalizedRequest.context?.messages.map((message) => message.id)).toEqual([
      "recent-user",
      "recent-assistant",
      "current-user-message"
    ]);
    expect(state.created?.normalizedRequest.context?.summary?.truncation).toMatchObject({
      droppedMessages: 2,
      keptMessages: 3
    });
    const truncationEvent = state.events.find(
      ({ event }) => event.type === "artifact" && event.data.artifactType === "context_truncated"
    )?.event;

    expect(truncationEvent?.type).toBe("artifact");
    expect(truncationEvent?.type === "artifact" ? truncationEvent.data.payload : null).toMatchObject({
      droppedMessages: 2
    });
  });

  it("fails before run creation when irreducible context exceeds the budget", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [], null, {
      contextWindow: 20,
      defaultMaxOutputTokens: 10,
      nativePdfInput: false,
      nativeSearch: true,
      pdf: true,
      reasoning: true,
      vision: true
    });
    repository.findOwnedChat = async (chatId, userId) =>
      userId === config.bootstrapUserId
        ? {
            activeLeafMessageId: null,
            defaultModelId: "fake-qsa",
            defaultProvider: "fake",
            id: chatId,
            messageCount: 0,
            projectMemory: null,
            title: "New Chat"
          }
        : null;
    const buildRequestPreview = vi.fn(() => ({
      provider: "fake"
    }));
    const provider: ProviderAdapter = {
      buildRequestPreview,
      async *stream() {
        throw new Error("should not call provider");
      }
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: provider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "current"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "context_too_large",
      message: "Prompt and current message exceed the model context budget (8 estimated tokens available)."
    });
    expect(state.created).toBeNull();
    expect(buildRequestPreview).not.toHaveBeenCalled();
  });

  it("persists streamed tokens in batches while keeping live SSE token granularity", async () => {
    const { repository, state } = createMemoryRepository();
    const tokenCount = 65;
    const batchedProvider: ProviderAdapter = {
      buildRequestPreview: () => ({
        provider: "fake"
      }),
      async *stream() {
        yield {
          data: {
            artifactType: "summary",
            payload: {
              provider: "fake"
            }
          },
          type: "artifact"
        };

        for (let index = 0; index < tokenCount; index += 1) {
          yield {
            data: {
              delta: "x"
            },
            type: "token"
          };
        }

        return {
          finalProviderResponsePreview: {},
          finalText: "x".repeat(tokenCount),
          usage: {
            inputTokens: 1,
            outputTokens: tokenCount,
            reasoningTokens: 0
          }
        };
      }
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: batchedProvider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Batch tokens"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );
    const liveEvents = parseSse(await response.text());
    const persistedTokenEvents = state.events.filter(({ event }) => event.type === "token");

    expect(liveEvents.filter((event) => event.type === "token")).toHaveLength(tokenCount);
    expect(persistedTokenEvents).toHaveLength(Math.ceil(tokenCount / 32));
    expect(
      persistedTokenEvents.map(({ event }) => ("delta" in event.data ? event.data.delta : "")).join("")
    ).toBe("x".repeat(tokenCount));
    expect(state.assistantText).toBe("x".repeat(tokenCount));
    expect(state.events.map(({ sequence }) => sequence)).toEqual(state.events.map((_event, index) => index));
  });

  it("flushes buffered tokens before marking a provider stream error", async () => {
    const { repository, state } = createMemoryRepository();
    const failingProvider: ProviderAdapter = {
      buildRequestPreview: () => ({
        provider: "fake"
      }),
      async *stream() {
        yield {
          data: {
            delta: "partial "
          },
          type: "token"
        };
        yield {
          data: {
            delta: "answer"
          },
          type: "token"
        };
        throw new Error("provider exploded");
      }
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: failingProvider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Fail after tokens"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );
    const liveEvents = parseSse(await response.text());

    expect(liveEvents.filter((event) => event.type === "token")).toHaveLength(2);
    expect(state.assistantText).toBe("partial answer");
    expect(state.events.filter(({ event }) => event.type === "token")).toHaveLength(1);
    expect(state.failed).toMatchObject({
      error: {
        code: "provider_stream_failed",
        message: "provider exploded"
      },
      runId: "run-1"
    });
  });

  it("starts a first-message stream only after atomic run persistence resolves", async () => {
    const { repository, state } = createMemoryRepository();
    const routeOrder: string[] = [];
    const createStarted = deferred();
    const createCommitted = deferred();
    repository.findOwnedChat = async (chatId, userId) =>
      userId === config.bootstrapUserId
        ? {
            activeLeafMessageId: null,
            defaultModelId: "fake-qsa",
            defaultProvider: "fake",
            id: chatId,
            messageCount: 0,
            projectMemory: null,
            title: "New Chat"
          }
        : null;
    const createRun = repository.createRun;
    repository.createRun = async (input) => {
      routeOrder.push("createRun");
      createStarted.resolve();
      await createCommitted.promise;
      return createRun(input);
    };
    const provider = recordProviderStreamStart(createFakeProviderAdapter(), () => {
      routeOrder.push("providerStream");
    });
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: provider
      },
      repository
    });
    const responsePromise = POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Explain local title generation"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );
    await createStarted.promise;
    expect(routeOrder).toEqual(["createRun"]);

    createCommitted.resolve();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    await response.text();
    expect(routeOrder).toEqual(["createRun", "providerStream"]);
    expect(state.failed).toBeNull();
  });

  it("does not start the provider when atomic run persistence fails", async () => {
    const { repository, state } = createMemoryRepository();
    const providerStarted = vi.fn();
    repository.createRun = async () => {
      throw new Error("run_defaults_commit_failed");
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: recordProviderStreamStart(createFakeProviderAdapter(), providerStarted)
      },
      repository
    });

    await expect(
      POST(
        new Request("http://app.local/api/chats/chat-1/messages", {
          body: JSON.stringify({
            modelId: "fake-qsa",
            provider: "fake",
            text: "Do not start this provider"
          }),
          headers: {
            cookie: authCookie()
          },
          method: "POST"
        }),
        {
          params: {
            chatId: "chat-1"
          }
        }
      )
    ).rejects.toThrow("run_defaults_commit_failed");
    expect(providerStarted).not.toHaveBeenCalled();
    expect(state.created).toBeNull();
  });

  it("replays prior active-branch messages as same-chat provider context", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [
      {
        content: {
          blocks: [{ text: "First turn secret: violet harbor", type: "text" }]
        },
        id: "prior-user-1",
        role: "user"
      },
      {
        content: {
          blocks: [{ text: "I will remember violet harbor.", type: "text" }]
        },
        id: "prior-assistant-1",
        role: "assistant"
      }
    ]);
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "What was the first turn secret?"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(state.created?.normalizedRequest.context?.messages.map((message) => message.id)).toEqual([
      "prior-user-1",
      "prior-assistant-1",
      "current-user-message"
    ]);
    expect(JSON.stringify(state.created?.providerRequestPreview)).toContain("prior-user-1");
    expect(JSON.stringify(state.created?.providerRequestPreview)).toContain("violet harbor");
    expect(state.completed?.finalText).toContain("Context memory: First turn secret: violet harbor");
  });

  it("still completes foreground streams when the transient chat update cannot be built", async () => {
    const { repository } = createMemoryRepository();
    repository.getChatUpdateForRun = async () => {
      throw new Error("snapshot failed");
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: {
            blocks: [{ text: "Hello QSA", type: "text" }]
          },
          modelId: "fake-qsa",
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    const eventTypes = parseSse(await response.text()).map((event) => event.type);
    expect(eventTypes).not.toContain("chat_update");
    expect(eventTypes.slice(-2)).toEqual(["usage", "done"]);
  });

  it("lets OpenRouter answer models complete without running Perplexity when no tool is called", async () => {
    const { bodies, POST, state } = createOpenRouterToolHarness([
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Direct OpenRouter answer",
              role: "assistant"
            }
          }
        ],
        id: "or-no-tool-1",
        model: "anthropic/claude-opus-4.8",
        object: "chat.completion",
        usage: {
          completion_tokens: 4,
          prompt_tokens: 12
        }
      }
    ]);
    const response = await sendOpenRouterToolMessage(POST, "Ответь без поиска.");

    expect(response.status).toBe(200);
    await response.text();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      parallel_tool_calls: false,
      provider: {
        only: ["Anthropic"]
      },
      stream: true,
      tool_choice: "auto"
    });
    expect(state.searchRuns).toHaveLength(0);
    expect(state.completed?.finalText).toBe("Direct OpenRouter answer");
  });

  it("lets OpenAI answer models complete without running Perplexity when no function tool is called", async () => {
    const { bodies, POST, state } = createOpenAIToolHarness([
      {
        id: "resp-no-tool-1",
        output: [
          {
            content: [
              {
                text: "Direct OpenAI answer",
                type: "output_text"
              }
            ],
            role: "assistant",
            type: "message"
          }
        ],
        status: "completed",
        usage: {
          input_tokens: 12,
          output_tokens: 4
        }
      }
    ]);
    const response = await sendOpenAIToolMessage(POST, "Ответь без поиска.");

    expect(response.status).toBe(200);
    await response.text();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      background: true,
      parallel_tool_calls: false,
      stream: true,
      tool_choice: "auto",
      tools: [
        {
          name: "search_via_perplexity",
          type: "function"
        }
      ]
    });
    expect(JSON.stringify(bodies[0])).not.toContain("web_search");
    expect(state.searchRuns).toHaveLength(0);
    expect(state.completed?.finalText).toBe("Direct OpenAI answer");
  });

  it("executes Perplexity when OpenRouter emits a search_via_perplexity tool call", async () => {
    const { bodies, POST, state } = createOpenRouterToolHarness([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: "{\"query\":\"latest Anthropic model\"}",
                    name: "search_via_perplexity"
                  },
                  id: "call-search-1",
                  type: "function"
                }
              ]
            }
          }
        ],
        id: "or-tool-1",
        model: "anthropic/claude-opus-4.8",
        object: "chat.completion",
        usage: {
          completion_tokens: 1,
          prompt_tokens: 20
        }
      },
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Anthropic latest model answer with search context.",
              role: "assistant"
            }
          }
        ],
        id: "or-tool-final",
        model: "anthropic/claude-opus-4.8",
        object: "chat.completion",
        usage: {
          completion_tokens: 9,
          prompt_tokens: 36
        }
      }
    ]);
    const response = await sendOpenRouterToolMessage(POST, "какая последняя модель антропика");

    expect(response.status).toBe(200);
    const events = parseSse(await response.text());

    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[0])).not.toContain("Search findings from");
    expect(bodies[0]).toMatchObject({
      stream: true,
      tool_choice: "auto",
      tools: [
        {
          function: {
            name: "search_via_perplexity"
          },
          type: "function"
        }
      ]
    });
    expect(JSON.stringify(bodies[0].messages)).toContain("Какая последняя модель Anthropic?");
    expect(JSON.stringify(bodies[1].messages)).toContain("tool_call_id");
    expect(JSON.stringify(bodies[1].messages)).toContain("Fake Perplexity search findings");
    expect(state.searchRuns).toHaveLength(1);
    expect(state.searchRuns[0]).toMatchObject({
      modelId: "perplexity/sonar-pro-search",
      provider: "openrouter",
      status: "complete",
      strategyId: "perplexity-tool-search"
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "tool_call",
          payload: expect.objectContaining({
            name: "search_via_perplexity"
          })
        }),
        type: "artifact"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "search"
        }),
        type: "artifact"
      })
    );
    expect(state.completed?.finalText).toBe("Anthropic latest model answer with search context.");
  });

  it("allows the maximum tool searches plus a final synthesis and sums usage", async () => {
    const toolCallResponse = (id: string, query: string, promptTokens: number) => ({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify({ query }),
                  name: "search_via_perplexity"
                },
                id,
                type: "function"
              }
            ]
          }
        }
      ],
      id: `or-${id}`,
      model: "anthropic/claude-opus-4.8",
      object: "chat.completion",
      usage: {
        completion_tokens: 1,
        prompt_tokens: promptTokens
      }
    });
    const { bodies, POST, state } = createOpenRouterToolHarness([
      toolCallResponse("call-search-1", "first", 20),
      toolCallResponse("call-search-2", "second", 30),
      toolCallResponse("call-search-3", "third", 40),
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Final answer after three searches.",
              role: "assistant"
            }
          }
        ],
        id: "or-tool-final",
        model: "anthropic/claude-opus-4.8",
        object: "chat.completion",
        usage: {
          completion_tokens: 5,
          prompt_tokens: 50
        }
      }
    ]);

    const response = await sendOpenRouterToolMessage(POST, "search three times");

    expect(response.status).toBe(200);
    await response.text();
    expect(bodies).toHaveLength(4);
    expect(bodies[3]).toMatchObject({
      tool_choice: "none"
    });
    expect(state.searchRuns).toHaveLength(3);

    const searchUsage = state.searchRuns
      .map((run) => (run.artifacts as { usage?: { totalTokens?: number } }).usage?.totalTokens ?? 0)
      .reduce((total, value) => total + value, 0);
    expect(state.completed?.usage.totalTokens).toBe(20 + 1 + 30 + 1 + 40 + 1 + 50 + 5 + searchUsage);
    expect(state.completed?.finalText).toBe("Final answer after three searches.");
  });

  it("persists failed tool searches and lets the model synthesize from the error result", async () => {
    const failingSearchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({
        provider: "openrouter",
        stage: "tool_search"
      }),
      async search() {
        throw new Error("perplexity timeout");
      }
    };
    const { bodies, POST, state } = createOpenRouterToolHarness(
      [
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                role: "assistant",
                tool_calls: [
                  {
                    function: {
                      arguments: "{\"query\":\"latest Anthropic model\"}",
                      name: "search_via_perplexity"
                    },
                    id: "call-search-1",
                    type: "function"
                  }
                ]
              }
            }
          ],
          id: "or-tool-1",
          model: "anthropic/claude-opus-4.8",
          object: "chat.completion",
          usage: {
            completion_tokens: 1,
            prompt_tokens: 20
          }
        },
        {
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "Answer without live search.",
                role: "assistant"
              }
            }
          ],
          id: "or-tool-final",
          model: "anthropic/claude-opus-4.8",
          object: "chat.completion",
          usage: {
            completion_tokens: 4,
            prompt_tokens: 25
          }
        }
      ],
      new Set(["perplexity-tool-search"]),
      failingSearchAdapter
    );

    const response = await sendOpenRouterToolMessage(POST, "search but tolerate failure");

    expect(response.status).toBe(200);
    const events = parseSse(await response.text());

    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1].messages)).toContain("Search failed: perplexity timeout");
    expect(state.searchRuns).toHaveLength(1);
    expect(state.searchRuns[0]).toMatchObject({
      status: "error"
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "tool_result",
          payload: expect.objectContaining({
            message: "perplexity timeout",
            status: "error"
          })
        }),
        type: "artifact"
      })
    );
    expect(state.completed?.finalText).toBe("Answer without live search.");
  });

  it("fails as context_too_large when a tool result exceeds the next answer-model budget", async () => {
    const oversizedSearchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({
        provider: "openrouter",
        stage: "tool_search"
      }),
      async search() {
        return {
          artifacts: [],
          finalProviderResponsePreview: {
            provider: "openrouter"
          },
          findings: "very large search result ".repeat(1000),
          requestPreview: {
            provider: "openrouter"
          },
          sources: [{
            rank: 1,
            title: "Large result source",
            url: "https://example.com/large-result"
          }],
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            reasoningTokens: 0,
            totalTokens: 10
          }
        };
      }
    };
    const { bodies, POST, state } = createOpenRouterToolHarness(
      [
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                role: "assistant",
                tool_calls: [
                  {
                    function: {
                      arguments: "{\"query\":\"latest Anthropic model\"}",
                      name: "search_via_perplexity"
                    },
                    id: "call-search-1",
                    type: "function"
                  }
                ]
              }
            }
          ],
          id: "or-tool-1",
          model: "anthropic/claude-opus-4.8",
          object: "chat.completion",
          usage: {
            completion_tokens: 1,
            prompt_tokens: 20
          }
        }
      ],
      new Set(["perplexity-tool-search"]),
      oversizedSearchAdapter,
      {
        contextWindow: 800,
        nativePdfInput: false,
        nativeSearch: false,
        pdf: true,
        reasoning: true,
        streaming: true,
        vision: true
      }
    );

    const response = await sendOpenRouterToolMessage(POST, "search with a huge result");

    expect(response.status).toBe(200);
    const events = parseSse(await response.text());

    expect(bodies).toHaveLength(1);
    expect(state.searchRuns).toHaveLength(1);
    expect(state.searchRuns[0]).toMatchObject({
      status: "complete"
    });
    expect(state.completed).toBeNull();
    expect(state.failed?.error.code).toBe("context_too_large");
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          code: "context_too_large"
        }),
        type: "error"
      })
    );
  });

  it("executes Perplexity when OpenAI emits a search_via_perplexity function call", async () => {
    const { bodies, POST, state } = createOpenAIToolHarness([
      {
        id: "resp-tool-1",
        output: [
          {
            id: "rs-1",
            summary: [],
            type: "reasoning"
          },
          {
            arguments: "{\"query\":\"latest Anthropic model\"}",
            call_id: "call-search-1",
            id: "fc-1",
            name: "search_via_perplexity",
            status: "completed",
            type: "function_call"
          }
        ],
        status: "completed",
        usage: {
          input_tokens: 20,
          output_tokens: 2
        }
      },
      {
        id: "resp-tool-final",
        output: [
          {
            content: [
              {
                text: "OpenAI synthesized answer with Perplexity search context.",
                type: "output_text"
              }
            ],
            role: "assistant",
            type: "message"
          }
        ],
        status: "completed",
        usage: {
          input_tokens: 40,
          output_tokens: 8
        }
      }
    ]);
    const response = await sendOpenAIToolMessage(POST, "у тебя же поиск есть");

    expect(response.status).toBe(200);
    const events = parseSse(await response.text());

    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[0])).not.toContain("Search findings from");
    expect(JSON.stringify(bodies[0].input)).toContain("Какая последняя модель Anthropic?");
    expect(bodies[0]).toMatchObject({
      background: true,
      stream: true,
      tool_choice: "auto",
      tools: [
        {
          name: "search_via_perplexity",
          type: "function"
        }
      ]
    });
    expect(JSON.stringify(bodies[1].input)).toContain("function_call_output");
    expect(JSON.stringify(bodies[1].input)).toContain("Fake Perplexity search findings");
    expect(state.searchRuns).toHaveLength(1);
    expect(state.searchRuns[0]).toMatchObject({
      modelId: "perplexity/sonar-pro-search",
      provider: "openrouter",
      status: "complete",
      strategyId: "perplexity-tool-search"
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "tool_call",
          payload: expect.objectContaining({
            name: "search_via_perplexity"
          })
        }),
        type: "artifact"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "search"
        }),
        type: "artifact"
      })
    );
    expect(state.completed?.finalText).toBe("OpenAI synthesized answer with Perplexity search context.");
  });

  it("rejects unsupported search/model combinations before creating a run", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["fake:fake-qsa"]),
      providerKeys: new Set(),
      searchStrategies: new Set(["openai-native-web-search"])
    });
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          searchStrategy: "openai-native-web-search",
          text: "Search with an unsupported route"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "search_strategy_not_supported_by_model"
    });
    expect(state.created).toBeNull();
  });

  it("rejects unavailable models before creating a run", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Hello"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "model_not_available"
    });
    expect(state.created).toBeNull();
  });

  it("rejects unconfigured real providers before creating a run", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set(["search-disabled"])
    });
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "gpt-5.5",
          provider: "openai",
          text: "Hello"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "provider_not_available"
    });
    expect(state.created).toBeNull();
  });

  it("returns persisted model run artifacts for the current user", async () => {
    const { repository } = createMemoryRepository();
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    await (
      await POST(
        new Request("http://app.local/api/chats/chat-1/messages", {
          body: JSON.stringify({
            modelId: "fake-qsa",
            provider: "fake",
            text: "Inspect this run"
          }),
          headers: {
            cookie: authCookie()
          },
          method: "POST"
        }),
        {
          params: {
            chatId: "chat-1"
          }
        }
      )
    ).text();

    const GET = createGetModelRunHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await GET(
      new Request("http://app.local/api/model-runs/run-1", {
        headers: {
          cookie: authCookie()
        }
      }),
      {
        params: {
          runId: "run-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      run: {
        finalProviderResponsePreview: {
          provider: "fake",
          text: "Fake answer: Inspect this run"
        },
        normalizedRequest: {
          content: {
            blocks: [{ text: "Inspect this run", type: "text" }]
          },
          modelId: "fake-qsa",
          provider: "fake"
        },
        status: "complete"
      }
    });
  });

  it("scopes model-run reads to the authenticated user and maps a missing run to 404", async () => {
    const { repository } = createMemoryRepository();
    const getRunForUser = vi.fn<RunRepository["getRunForUser"]>(async () => null);
    repository.getRunForUser = getRunForUser;
    const GET = createGetModelRunHandler({
      ...authDeps,
      providers: {},
      repository
    });

    const response = await GET(
      new Request("http://app.local/api/model-runs/missing-run", {
        headers: {
          cookie: authCookie()
        }
      }),
      {
        params: {
          runId: "missing-run"
        }
      }
    );

    expect(getRunForUser).toHaveBeenCalledWith("missing-run", config.bootstrapUserId);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "model_run_not_found"
    });
  });

  it("leaves a Perplexity and MCP checkpoint untouched when GET lacks search adapters", async () => {
    const { repository, state } = createMemoryRepository();
    const created = openAiCreatedRun();
    state.created = {
      ...created,
      normalizedRequest: {
        ...created.normalizedRequest,
        mcp: { servers: [], tools: [], version: 1 },
        searchStrategy: "perplexity-tool-search"
      }
    };
    state.providerResponseId = "response-tool-round";
    const loadCheckpoint = vi.fn(async () => {
      throw new Error("partial GET dependencies must not own recovery");
    });
    repository.loadCheckpointedToolLoopRun = loadCheckpoint;
    const GET = createGetModelRunHandler({
      ...authDeps,
      providers: {},
      repository,
      searchProviders: undefined
    });

    const response = await GET(
      new Request("http://app.local/api/model-runs/run-1", {
        headers: { cookie: authCookie() }
      }),
      { params: { runId: "run-1" } }
    );

    expect(response.status).toBe(200);
    expect(loadCheckpoint).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ run: { status: "streaming" } });
  });

  it("regenerates an assistant message by streaming a sibling assistant run", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [
      {
        content: {
          blocks: [{ text: "Earlier context", type: "text" }]
        },
        id: "prior-user-1",
        role: "user"
      }
    ]);
    const routeOrder: string[] = [];
    const createRegenerationRun = repository.createRegenerationRun;
    repository.createRegenerationRun = async (input) => {
      routeOrder.push("createRegenerationRun");
      return createRegenerationRun(input);
    };
    const provider = recordProviderStreamStart(createFakeProviderAdapter(), () => {
      routeOrder.push("providerStream");
    });
    const POST = createRegenerateModelRunHandler({
      ...authDeps,
      providers: {
        fake: provider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify({
          controlDefaults: {
            maxOutputTokens: "4096",
            reasoningEffort: "medium",
            searchStrategyId: "search-disabled",
            temperature: "0.6"
          },
          modelId: "fake-qsa",
          params: {
            maxOutputTokens: 4096,
            temperature: 0.6
          },
          prompt: {
            presetId: "prompt-regen"
          },
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie(),
          "content-type": "application/json"
        },
        method: "POST"
      }),
      {
        params: {
          messageId: "assistant-message-1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = parseSse(await response.text());
    expect(events.map((event) => event.type).slice(0, 3)).toEqual(["run_start", "message_start", "artifact"]);
    expect(events.map((event) => event.type).slice(-3)).toEqual(["usage", "chat_update", "done"]);
    expect(events.find((event) => event.type === "chat_update")?.data).toMatchObject({
      chat: {
        activeLeafMessageId: "assistant-regen-1",
        id: "chat-1"
      },
      messages: [
        {
          id: "user-message-1",
          role: "user"
        },
        {
          id: "assistant-regen-1",
          modelRunId: "run-1",
          role: "assistant",
          status: "complete"
        }
      ]
    });
    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(state.regenerated).toMatchObject({
      chatId: "chat-1",
      modelId: "fake-qsa",
      provider: "fake",
      userMessageId: "user-message-1"
    });
    expect(state.regenerated?.normalizedRequest.context?.messages.map((message) => message.id)).toEqual([
      "prior-user-1",
      "user-message-1"
    ]);
    expect(state.regenerated?.defaults).toEqual({
      controlDefaults: {
        maxOutputTokens: "4096",
        reasoningEffort: "medium",
        temperature: "0.6"
      },
      modelId: "fake-qsa",
      promptPresetId: "prompt-regen",
      provider: "fake",
      searchPlan: {
        mode: "all_selected",
        optionIds: []
      },
      searchStrategy: "search-disabled",
      userId: config.bootstrapUserId
    });
    expect(state.completed?.finalText).toBe("Fake answer: Original question\nContext memory: Earlier context");
    expect(routeOrder).toEqual(["createRegenerationRun", "providerStream"]);
  });

  it("streams an answer run for an edited user message with no assistant sibling", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel);
    const POST = createRegenerateModelRunHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/messages/user-message-1/regenerate", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          params: {},
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie(),
          "content-type": "application/json"
        },
        method: "POST"
      }),
      {
        params: {
          messageId: "user-message-1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await response.text());
    expect(events.map((event) => event.type).slice(-3)).toEqual(["usage", "chat_update", "done"]);
    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(state.regenerated).toMatchObject({
      chatId: "chat-1",
      modelId: "fake-qsa",
      provider: "fake",
      userMessageId: "user-message-1"
    });
    expect(state.completed?.finalText).toContain("Fake answer: Original question");
  });

  it("rejects foreign regenerate prompt preset ids before creating a run", async () => {
    const { repository, state } = createMemoryRepository();
    repository.isPromptPresetAvailable = async () => false;
    const provider: ProviderAdapter = {
      buildRequestPreview: vi.fn(() => ({
        provider: "fake"
      })),
      async *stream() {
        throw new Error("provider should not be called");
      }
    };
    const POST = createRegenerateModelRunHandler({
      ...authDeps,
      providers: {
        fake: provider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          prompt: {
            presetId: "foreign-prompt"
          },
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie(),
          "content-type": "application/json"
        },
        method: "POST"
      }),
      {
        params: {
          messageId: "assistant-message-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "default_prompt_unavailable"
    });
    expect(state.regenerated).toBeNull();
    expect(provider.buildRequestPreview).not.toHaveBeenCalled();
  });

  it("does not persist regenerate defaults when the run insert hits the active-run gate", async () => {
    const { repository, state } = createMemoryRepository();
    let recentRunLookups = 0;
    repository.findRecentActiveRunForChat = async (input) => {
      recentRunLookups += 1;
      if (recentRunLookups === 1) {
        return null;
      }

      return {
        ...activeRunRecord({
          chatId: input.chatId,
          id: "run-conflict"
        }),
        updatedAt: new Date()
      };
    };
    repository.createRegenerationRun = async () => {
      throw new ActiveRunConflictError();
    };
    const POST = createRegenerateModelRunHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify({
          controlDefaults: {
            reasoningEffort: "high",
            searchStrategyId: "search-disabled",
            temperature: "0.2"
          },
          modelId: "fake-qsa",
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie(),
          "content-type": "application/json"
        },
        method: "POST"
      }),
      {
        params: {
          messageId: "assistant-message-1"
        }
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "active_run_in_progress",
      run: {
        id: "run-conflict",
        status: "streaming"
      }
    });
    expect(state.regenerated).toBeNull();
  });

  it.each([
    ["temperature", { temperature: 999 }],
    ["maxOutputTokens", { maxOutputTokens: -5 }],
    ["reasoning effort", { reasoning: { effort: "extreme" } }]
  ])("rejects invalid regenerate %s params before creating a run", async (_label, paramsBody) => {
    const { repository, state } = createMemoryRepository();
    const POST = createRegenerateModelRunHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          params: paramsBody,
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie(),
          "content-type": "application/json"
        },
        method: "POST"
      }),
      {
        params: {
          messageId: "assistant-message-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_run_params"
    });
    expect(state.regenerated).toBeNull();
  });

  it("rejects gpt-5.5 minimal reasoning effort before creating a regeneration run", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    const POST = createRegenerateModelRunHandler({
      ...authDeps,
      providers: {
        openai: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify({
          modelId: "gpt-5.5",
          params: {
            reasoning: {
              effort: "minimal"
            }
          },
          provider: "openai",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie(),
          "content-type": "application/json"
        },
        method: "POST"
      }),
      {
        params: {
          messageId: "assistant-message-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_run_params"
    });
    expect(state.regenerated).toBeNull();
  });

  it("rejects regeneration when the source chat is archived or unavailable", async () => {
    const { repository, state } = createMemoryRepository();
    repository.findRegenerationSource = async () => null;
    const POST = createRegenerateModelRunHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/messages/assistant-message-archived/regenerate", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie(),
          "content-type": "application/json"
        },
        method: "POST"
      }),
      {
        params: {
          messageId: "assistant-message-archived"
        }
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "message_not_found_or_not_regeneratable"
    });
    expect(state.regenerated).toBeNull();
  });

  it("refreshes and finalizes an active provider run when a provider response id exists", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    state.created = {
      chatId: "chat-1",
      content: { blocks: [] },
      expectedActiveLeafId: null,
      defaults: {
        controlDefaults: {
          searchStrategyId: "search-disabled"
        },
        modelId: "gpt-5.5",
        promptPresetId: null,
        provider: "openai",
        searchStrategy: "search-disabled",
        userId: config.bootstrapUserId
      },
      modelId: "gpt-5.5",
      normalizedRequest: {
        attachmentIds: [],
        chatId: "chat-1",
        content: { blocks: [] },
        modelCapabilities: {
          nativePdfInput: false,
          nativeSearch: true,
          pdf: true,
          reasoning: true,
          vision: true
        },
        modelId: "gpt-5.5",
        params: {},
        prompt: {
          developer: null,
          presetId: null,
          system: null
        },
        provider: "openai",
        searchStrategy: "search-disabled"
      },
      provider: "openai",
      providerRequestPreview: {},
      userId: config.bootstrapUserId
    };
    state.providerResponseId = "resp-refresh-1";

    const GET = createGetModelRunHandler({
      ...authDeps,
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          refresh: async (providerResponseId) => ({
            events: [
              {
                data: {
                  artifactType: "summary",
                  payload: {
                    provider: "openai",
                    responseId: providerResponseId,
                    status: "completed"
                  }
                },
                type: "artifact"
              },
              {
                data: {
                  delta: "Recovered answer"
                },
                type: "token"
              }
            ],
            providerResponseId,
            result: {
              finalProviderResponsePreview: {
                provider: "openai",
                text: "Recovered answer"
              },
              finalText: "Recovered answer",
              providerResponseId,
              usage: {
                inputTokens: 3,
                outputTokens: 2,
                reasoningTokens: 1
              }
            },
            status: "completed",
            terminal: true
          }),
          async *stream() {
            return {
              finalProviderResponsePreview: {},
              finalText: "",
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0
              }
            };
          }
        }
      },
      repository
    });
    const response = await GET(
      new Request("http://app.local/api/model-runs/run-1", {
        headers: {
          cookie: authCookie()
        }
      }),
      {
        params: {
          runId: "run-1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(state.completed).toMatchObject({
      chatId: "chat-1",
      estimatedCostMicros: 22,
      finalText: "Recovered answer",
      modelId: "gpt-5.5",
      provider: "openai",
      providerResponseId: "resp-refresh-1",
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        reasoningTokens: 1
      }
    });
    expect(state.events.map(({ event }) => event.type)).toEqual(["artifact", "token", "usage", "done"]);
    await expect(response.json()).resolves.toMatchObject({
      run: {
        finalProviderResponsePreview: {
          provider: "openai",
          text: "Recovered answer"
        },
        status: "complete"
      }
    });
  });

  it("skips provider refresh while a local foreground stream owns the run", async () => {
    const { repository, state } = createMemoryRepository();
    const refresh = vi.fn(async () => {
      throw new Error("GET should not refresh a locally owned stream");
    });
    const foregroundProvider: ProviderAdapter = {
      buildRequestPreview: () => ({
        provider: "fake"
      }),
      refresh,
      async *stream(_request, options = {}) {
        yield {
          data: {
            artifactType: "summary",
            payload: {
              provider: "fake",
              responseId: "resp-live-foreground",
              status: "in_progress"
            }
          },
          type: "artifact"
        };
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });

        return {
          finalProviderResponsePreview: {},
          finalText: "",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0
          }
        };
      }
    };
    const send = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: foregroundProvider
      },
      repository
    });
    const GET = createGetModelRunHandler({
      ...authDeps,
      providers: {
        fake: foregroundProvider
      },
      repository
    });
    const cancel = createCancelModelRunHandler({
      ...authDeps,
      providers: {
        fake: foregroundProvider
      },
      repository
    });

    const streamResponse = await send(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Keep running"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );
    for (let attempt = 0; attempt < 10 && state.providerResponseId !== "resp-live-foreground"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(state.providerResponseId).toBe("resp-live-foreground");
    const getResponse = await GET(
      new Request("http://app.local/api/model-runs/run-1", {
        headers: {
          cookie: authCookie()
        }
      }),
      {
        params: {
          runId: "run-1"
        }
      }
    );

    expect(getResponse.status).toBe(200);
    expect(refresh).not.toHaveBeenCalled();

    await cancel(
      new Request("http://app.local/api/model-runs/run-1/cancel", {
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          runId: "run-1"
        }
      }
    );
    await streamResponse.text();
  });

  it("does not append terminal refresh events when another writer already completed", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    state.created = openAiCreatedRun();
    state.providerResponseId = "resp-refresh-lost";
    repository.completeRun = async () => false;

    const GET = createGetModelRunHandler({
      ...authDeps,
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          refresh: async (providerResponseId) => ({
            events: [
              {
                data: {
                  delta: "Duplicate final answer"
                },
                type: "token"
              }
            ],
            providerResponseId,
            result: {
              finalProviderResponsePreview: {
                provider: "openai",
                text: "Duplicate final answer"
              },
              finalText: "Duplicate final answer",
              providerResponseId,
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                reasoningTokens: 0
              }
            },
            status: "completed",
            terminal: true
          }),
          async *stream() {
            return {
              finalProviderResponsePreview: {},
              finalText: "",
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0
              }
            };
          }
        }
      },
      repository
    });
    const response = await GET(
      new Request("http://app.local/api/model-runs/run-1", {
        headers: {
          cookie: authCookie()
        }
      }),
      {
        params: {
          runId: "run-1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(state.events).toEqual([]);
    expect(state.completed).toBeNull();
  });

  it("returns a stale run instead of failing when refresh event appends collide", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    state.created = openAiCreatedRun();
    state.providerResponseId = "resp-refresh-append-race";
    repository.appendRunEvent = async () => {
      throw new Error("sequence collision");
    };

    const GET = createGetModelRunHandler({
      ...authDeps,
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          refresh: async (providerResponseId) => ({
            events: [
              {
                data: {
                  delta: "Recovered despite append race"
                },
                type: "token"
              }
            ],
            providerResponseId,
            result: {
              finalProviderResponsePreview: {
                provider: "openai",
                text: "Recovered despite append race"
              },
              finalText: "Recovered despite append race",
              providerResponseId,
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                reasoningTokens: 0
              }
            },
            status: "completed",
            terminal: true
          }),
          async *stream() {
            return {
              finalProviderResponsePreview: {},
              finalText: "",
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0
              }
            };
          }
        }
      },
      repository
    });
    const response = await GET(
      new Request("http://app.local/api/model-runs/run-1", {
        headers: {
          cookie: authCookie()
        }
      }),
      {
        params: {
          runId: "run-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      run: {
        status: "complete"
      }
    });
  });

  it("recovers an errored background provider run when the stored response later completes", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    state.created = {
      chatId: "chat-1",
      content: { blocks: [] },
      expectedActiveLeafId: null,
      defaults: {
        controlDefaults: {
          searchStrategyId: "search-disabled"
        },
        modelId: "gpt-5.5",
        promptPresetId: null,
        provider: "openai",
        searchStrategy: "search-disabled",
        userId: config.bootstrapUserId
      },
      modelId: "gpt-5.5",
      normalizedRequest: {
        attachmentIds: [],
        chatId: "chat-1",
        content: { blocks: [] },
        modelCapabilities: {
          nativePdfInput: false,
          nativeSearch: true,
          pdf: true,
          reasoning: true,
          vision: true
        },
        modelId: "gpt-5.5",
        params: {},
        prompt: {
          developer: null,
          presetId: null,
          system: null
        },
        provider: "openai",
        searchStrategy: "search-disabled"
      },
      provider: "openai",
      providerRequestPreview: {},
      userId: config.bootstrapUserId
    };
    state.providerResponseId = "resp-recover-after-503";
    state.failed = {
      error: {
        code: "provider_stream_failed",
        message: "OpenAI request failed with status 503"
      },
      runId: "run-1"
    };

    const GET = createGetModelRunHandler({
      ...authDeps,
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          refresh: async (providerResponseId) => ({
            events: [
              {
                data: {
                  artifactType: "summary",
                  payload: {
                    provider: "openai",
                    responseId: providerResponseId,
                    status: "completed"
                  }
                },
                type: "artifact"
              },
              {
                data: {
                  delta: "Recovered after retry"
                },
                type: "token"
              }
            ],
            providerResponseId,
            result: {
              finalProviderResponsePreview: {
                provider: "openai",
                text: "Recovered after retry"
              },
              finalText: "Recovered after retry",
              providerResponseId,
              usage: {
                inputTokens: 5,
                outputTokens: 3,
                reasoningTokens: 0
              }
            },
            status: "completed",
            terminal: true
          }),
          async *stream() {
            return {
              finalProviderResponsePreview: {},
              finalText: "",
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0
              }
            };
          }
        }
      },
      repository
    });
    const response = await GET(
      new Request("http://app.local/api/model-runs/run-1", {
        headers: {
          cookie: authCookie()
        }
      }),
      {
        params: {
          runId: "run-1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(state.completed).toMatchObject({
      finalText: "Recovered after retry",
      providerResponseId: "resp-recover-after-503"
    });
    expect(state.events.map(({ event }) => event.type)).toEqual(["artifact", "token", "usage", "done"]);
    await expect(response.json()).resolves.toMatchObject({
      run: {
        finalProviderResponsePreview: {
          text: "Recovered after retry"
        },
        status: "complete"
      }
    });
  });

  it("settles a terminal recovery error once across repeated GET reads", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    state.created = openAiCreatedRun();
    state.providerResponseId = "resp-terminal-error";
    state.failed = {
      error: {
        code: "provider_stream_failed",
        message: "Transient local failure"
      },
      runId: "run-1"
    };
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      error: {
        code: "provider_terminal_error",
        message: "Provider stopped"
      },
      events: [
        {
          data: {
            artifactType: "summary",
            payload: { status: "failed" }
          },
          type: "artifact"
        }
      ],
      status: "failed",
      terminal: true
    }));
    const GET = createGetModelRunHandler({
      ...authDeps,
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          refresh,
          async *stream() {
            return {
              finalProviderResponsePreview: {},
              finalText: "",
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0
              }
            };
          }
        }
      },
      repository
    });

    const responses = [];
    for (let index = 0; index < 2; index += 1) {
      responses.push(
        await GET(
          new Request("http://app.local/api/model-runs/run-1", {
            headers: { cookie: authCookie() }
          }),
          { params: { runId: "run-1" } }
        )
      );
    }

    expect(refresh).toHaveBeenCalledOnce();
    expect(state.events.map(({ event }) => event.type)).toEqual([
      "artifact",
      "error"
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        run: {
          errorPayload: {
            code: "provider_terminal_error",
            recoveryTerminal: true
          },
          status: "error"
        }
      });
    }
  });

  it("sweeps fresh orphaned active runs before the send gate", async () => {
    const { repository, state } = createMemoryRepository();
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    state.recentActiveRun = {
      ...activeRunRecord({
        chatId: "chat-1",
        id: "run-orphaned-on-boot"
      }),
      updatedAt: new Date()
    };

    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Send after restart"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(state.bootSweeps).toEqual([
      {
        liveRunIds: [],
        sweptRunIds: ["run-orphaned-on-boot"]
      }
    ]);
    expect(state.failed).toEqual({
      error: {
        code: "run_orphaned_on_boot",
        message: "Run was active when this server process started and was marked failed."
      },
      runId: "run-orphaned-on-boot"
    });
    expect(state.created?.content).toEqual({
      blocks: [{ text: "Send after restart", type: "text" }]
    });
  });

  it("returns one active-run conflict when concurrent sends race at insert", async () => {
    const { repository, state } = createMemoryRepository();
    const originalCreateRun = repository.createRun;
    const originalFindRecentActiveRunForChat = repository.findRecentActiveRunForChat;
    const bothPrechecksReached = deferred();
    let precheckCalls = 0;
    let createAttempts = 0;
    let successfulCreates = 0;
    let inserted = false;

    repository.findRecentActiveRunForChat = async (input) => {
      precheckCalls += 1;
      if (precheckCalls <= 2) {
        if (precheckCalls === 2) {
          bothPrechecksReached.resolve();
        }
        await bothPrechecksReached.promise;
        return null;
      }

      return originalFindRecentActiveRunForChat(input);
    };
    repository.createRun = async (input) => {
      createAttempts += 1;
      if (inserted) {
        throw new ActiveRunConflictError();
      }

      inserted = true;
      successfulCreates += 1;
      state.recentActiveRun = {
        ...activeRunRecord({
          chatId: input.chatId,
          id: "run-1"
        }),
        updatedAt: new Date()
      };

      return originalCreateRun(input);
    };

    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const responses = await Promise.all([
      POST(
        new Request("http://app.local/api/chats/chat-1/messages", {
          body: JSON.stringify({
            modelId: "fake-qsa",
            provider: "fake",
            text: "First concurrent send"
          }),
          headers: {
            cookie: authCookie()
          },
          method: "POST"
        }),
        {
          params: {
            chatId: "chat-1"
          }
        }
      ),
      POST(
        new Request("http://app.local/api/chats/chat-1/messages", {
          body: JSON.stringify({
            modelId: "fake-qsa",
            provider: "fake",
            text: "Second concurrent send"
          }),
          headers: {
            cookie: authCookie()
          },
          method: "POST"
        }),
        {
          params: {
            chatId: "chat-1"
          }
        }
      )
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const okResponse = responses.find((response) => response.status === 200);
    const conflictResponse = responses.find((response) => response.status === 409);
    if (!okResponse || !conflictResponse) {
      throw new Error("Expected one successful stream and one active-run conflict");
    }
    await okResponse.text();
    await expect(conflictResponse.json()).resolves.toMatchObject({
      error: "active_run_in_progress",
      run: {
        id: "run-1",
        status: "streaming"
      }
    });
    expect(createAttempts).toBe(2);
    expect(successfulCreates).toBe(1);
  });

  it("does not persist send defaults when the run insert hits the active-run gate", async () => {
    const { repository, state } = createMemoryRepository();
    repository.findOwnedChat = async (chatId, userId) =>
      userId === config.bootstrapUserId
        ? {
            activeLeafMessageId: null,
            defaultModelId: "fake-qsa",
            defaultProvider: "fake",
            id: chatId,
            messageCount: 0,
            projectMemory: null,
            title: "New Chat"
          }
        : null;
    let recentRunLookups = 0;
    repository.findRecentActiveRunForChat = async (input) => {
      recentRunLookups += 1;
      if (recentRunLookups === 1) {
        return null;
      }

      return {
        ...activeRunRecord({
          chatId: input.chatId,
          id: "run-conflict"
        }),
        updatedAt: new Date()
      };
    };
    repository.createRun = async () => {
      throw new ActiveRunConflictError();
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          controlDefaults: {
            reasoningEffort: "high",
            searchStrategyId: "search-disabled",
            temperature: "0.2"
          },
          modelId: "fake-qsa",
          provider: "fake",
          text: "Rejected send defaults",
          searchStrategy: "search-disabled"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "active_run_in_progress",
      run: {
        id: "run-conflict",
        status: "streaming"
      }
    });
    expect(state.created).toBeNull();
  });

  it("reconciles stale active runs before creating a new send", async () => {
    const { repository, state } = createMemoryRepository();
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const warmupResponse = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Warm up boot sweep"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );
    expect(warmupResponse.status).toBe(200);
    await warmupResponse.text();

    state.failed = null;
    state.events = [];
    state.staleActiveRuns = [
      {
        ...activeRunRecord({
          assistantMessageId: "assistant-stale",
          chatId: "chat-1",
          id: "run-stale-before-insert"
        }),
        updatedAt: new Date(Date.now() - 11 * 60 * 1000)
      }
    ];

    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Send after stale reconcile"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(state.failed).toEqual({
      error: {
        code: "run_orphaned",
        message: "Run stopped reporting progress and was marked failed."
      },
      runId: "run-stale-before-insert"
    });
    expect(state.created?.content).toEqual({
      blocks: [{ text: "Send after stale reconcile", type: "text" }]
    });
  });

  it("rejects new sends while a recent active run exists and ignores stale active runs", async () => {
    const { repository, state } = createMemoryRepository();
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const warmupResponse = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Warm up boot sweep"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );
    expect(warmupResponse.status).toBe(200);
    await warmupResponse.text();
    const warmupCreated = state.created;

    state.completed = null;
    state.events = [];
    state.assistantText = "";
    state.recentActiveRun = {
      ...activeRunRecord({
        chatId: "chat-1"
      }),
      updatedAt: new Date()
    };

    const blockedResponse = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Should wait"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(blockedResponse.status).toBe(409);
    await expect(blockedResponse.json()).resolves.toMatchObject({
      error: "active_run_in_progress",
      run: {
        id: "run-active",
        status: "streaming"
      }
    });
    expect(state.created).toBe(warmupCreated);

    state.recentActiveRun = {
      ...activeRunRecord({
        id: "run-stale"
      }),
      updatedAt: new Date(Date.now() - 11 * 60 * 1000)
    };
    const allowedResponse = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Stale runs should not block"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(allowedResponse.status).toBe(200);
    await allowedResponse.text();
    expect(state.created?.content).toEqual({
      blocks: [{ text: "Stale runs should not block", type: "text" }]
    });
  });

  it("allows a new send when a different chat has a recent active run", async () => {
    const { repository, state } = createMemoryRepository();
    state.recentActiveRun = {
      ...activeRunRecord({
        chatId: "chat-other",
        id: "run-other-chat"
      }),
      updatedAt: new Date()
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });

    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Different chat should run"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(state.created?.content).toEqual({
      blocks: [{ text: "Different chat should run", type: "text" }]
    });
  });

  it("marks stale active runs without provider refresh as orphaned", async () => {
    const { repository, state } = createMemoryRepository();
    state.staleActiveRuns = [
      {
        ...activeRunRecord({
          assistantMessageId: "assistant-orphan",
          chatId: "chat-1",
          id: "run-orphan"
        }),
        updatedAt: new Date("2026-06-10T00:00:00.000Z")
      }
    ];

    await reconcileStaleRuns(
      {
        registry: activeRunControllerRegistry,
        providers: {
          fake: createFakeProviderAdapter()
        },
        repository
      },
      {
        now: new Date("2026-06-10T00:11:00.000Z"),
        userId: config.bootstrapUserId
      }
    );

    expect(state.failed).toEqual({
      error: {
        code: "run_orphaned",
        message: "Run stopped reporting progress and was marked failed."
      },
      runId: "run-orphan"
    });
    expect(state.events).toEqual([
      {
        event: {
          data: {
            code: "run_orphaned",
            message: "Run stopped reporting progress and was marked failed."
          },
          type: "error"
        },
        sequence: 0
      }
    ]);
  });

  it("skips stale active runs that still have a local foreground controller", async () => {
    const { repository, state } = createMemoryRepository();
    const controllers = activeRunControllersForTest();
    const controller = new AbortController();
    state.staleActiveRuns = [
      {
        ...activeRunRecord({
          assistantMessageId: "assistant-live",
          chatId: "chat-1",
          id: "run-live"
        }),
        updatedAt: new Date("2026-06-10T00:00:00.000Z")
      }
    ];
    controllers.set("run-live", controller);

    try {
      await reconcileStaleRuns(
        {
          registry: activeRunControllerRegistry,
          providers: {
            fake: createFakeProviderAdapter()
          },
          repository
        },
        {
          now: new Date("2026-06-10T00:11:00.000Z"),
          userId: config.bootstrapUserId
        }
      );
    } finally {
      controllers.delete("run-live");
    }

    expect(state.failed).toBeNull();
    expect(state.events).toEqual([]);
  });

  it("leaves fresh active runs untouched during stale reconciliation", async () => {
    const { repository, state } = createMemoryRepository();
    state.staleActiveRuns = [
      {
        ...activeRunRecord({
          assistantMessageId: "assistant-fresh",
          chatId: "chat-1",
          id: "run-fresh"
        }),
        updatedAt: new Date("2026-06-10T00:05:00.000Z")
      }
    ];

    await reconcileStaleRuns(
      {
        registry: activeRunControllerRegistry,
        providers: {
          fake: createFakeProviderAdapter()
        },
        repository
      },
      {
        now: new Date("2026-06-10T00:11:00.000Z"),
        userId: config.bootstrapUserId
      }
    );

    expect(state.failed).toBeNull();
    expect(state.events).toEqual([]);
  });

  it("refreshes stale active provider runs that can report background status", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    state.created = openAiCreatedRun();
    state.providerResponseId = "resp-stale-complete";
    state.staleActiveRuns = [
      {
        ...activeRunRecord({
          assistantMessageId: "assistant-message-1",
          chatId: "chat-1",
          id: "run-1",
          modelId: "gpt-5.5",
          provider: "openai",
          providerResponseId: "resp-stale-complete"
        }),
        updatedAt: new Date("2026-06-10T00:00:00.000Z")
      }
    ];

    await reconcileStaleRuns(
      {
        registry: activeRunControllerRegistry,
        providers: {
          openai: {
            buildRequestPreview: () => ({}),
            refresh: async (providerResponseId) => ({
              events: [
                {
                  data: {
                    delta: "Recovered stale answer"
                  },
                  type: "token"
                }
              ],
              providerResponseId,
              result: {
                finalProviderResponsePreview: {
                  provider: "openai",
                  text: "Recovered stale answer"
                },
                finalText: "Recovered stale answer",
                providerResponseId,
                usage: {
                  inputTokens: 2,
                  outputTokens: 3,
                  reasoningTokens: 0
                }
              },
              status: "completed",
              terminal: true
            }),
            async *stream() {
              return {
                finalProviderResponsePreview: {},
                finalText: "",
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  reasoningTokens: 0
                }
              };
            }
          }
        },
        repository
      },
      {
        now: new Date("2026-06-10T00:11:00.000Z"),
        userId: config.bootstrapUserId
      }
    );

    expect(state.failed).toBeNull();
    expect(state.completed).toMatchObject({
      finalText: "Recovered stale answer",
      provider: "openai",
      providerResponseId: "resp-stale-complete",
      runId: "run-1"
    });
    expect(state.events.map(({ event }) => event.type)).toEqual(["token", "usage", "done"]);
  });

  it("keeps refreshable stale provider runs active when provider status is not terminal", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    state.created = openAiCreatedRun();
    state.providerResponseId = "resp-stale-running";
    state.staleActiveRuns = [
      {
        ...activeRunRecord({
          assistantMessageId: "assistant-message-1",
          chatId: "chat-1",
          id: "run-1",
          modelId: "gpt-5.5",
          provider: "openai",
          providerResponseId: "resp-stale-running"
        }),
        updatedAt: new Date("2026-06-10T00:00:00.000Z")
      }
    ];

    await reconcileStaleRuns(
      {
        registry: activeRunControllerRegistry,
        providers: {
          openai: {
            buildRequestPreview: () => ({}),
            refresh: async (providerResponseId) => ({
              events: [
                {
                  data: {
                    artifactType: "summary",
                    payload: {
                      provider: "openai",
                      responseId: providerResponseId,
                      status: "in_progress"
                    }
                  },
                  type: "artifact"
                }
              ],
              providerResponseId,
              status: "in_progress",
              terminal: false
            }),
            async *stream() {
              return {
                finalProviderResponsePreview: {},
                finalText: "",
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  reasoningTokens: 0
                }
              };
            }
          }
        },
        repository
      },
      {
        now: new Date("2026-06-10T00:11:00.000Z"),
        userId: config.bootstrapUserId
      }
    );

    expect(state.failed).toBeNull();
    expect(state.completed).toBeNull();
    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.event).toMatchObject({
      data: {
        artifactType: "summary",
        payload: {
          status: "in_progress"
        }
      },
      type: "artifact"
    });
  });

  it("cancels active runs without provider-native cancellation or a provider response id", async () => {
    const { repository, state } = createMemoryRepository();
    state.created = {
      chatId: "chat-1",
      content: { blocks: [] },
      expectedActiveLeafId: null,
      defaults: {
        controlDefaults: {
          searchStrategyId: "search-disabled"
        },
        modelId: "fake-qsa",
        promptPresetId: null,
        provider: "fake",
        searchStrategy: "search-disabled",
        userId: config.bootstrapUserId
      },
      modelId: "fake-qsa",
      normalizedRequest: {
        attachmentIds: [],
        chatId: "chat-1",
        content: { blocks: [] },
        modelCapabilities: {
          nativePdfInput: false,
          nativeSearch: true,
          pdf: true,
          reasoning: true,
          vision: true
        },
        modelId: "fake-qsa",
        params: {},
        prompt: {
          developer: null,
          presetId: null,
          system: null
        },
        provider: "fake",
        searchStrategy: "search-disabled"
      },
      provider: "fake",
      providerRequestPreview: {},
      userId: config.bootstrapUserId
    };
    const POST = createCancelModelRunHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });

    const response = await POST(
      new Request("http://app.local/api/model-runs/run-1/cancel", {
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          runId: "run-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      run: {
        id: "run-1",
        providerResponseId: null,
        status: "cancelled"
      }
    });
    expect(state.cancelled).toEqual({
      code: "model_run_cancelled",
      message: "Model run cancelled"
    });

    const missingResponse = await POST(
      new Request("http://app.local/api/model-runs/missing/cancel", {
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { runId: "missing" } }
    );
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toEqual({ error: "model_run_not_found" });
  });

  it("aborts the active provider stream and suppresses tokens after cancellation", async () => {
    const { repository, state } = createMemoryRepository();
    let signal: AbortSignal | undefined;
    let attemptedLateToken = false;
    const abortAwareProvider: ProviderAdapter = {
      buildRequestPreview: () => ({
        provider: "fake"
      }),
      async *stream(_request, options = {}) {
        signal = options.signal;
        yield {
          data: {
            artifactType: "summary",
            payload: {
              provider: "fake"
            }
          },
          type: "artifact"
        };
        yield {
          data: {
            delta: "before "
          },
          type: "token"
        };
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        attemptedLateToken = true;
        yield {
          data: {
            delta: "after "
          },
          type: "token"
        };

        return {
          finalProviderResponsePreview: {},
          finalText: "before after",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            reasoningTokens: 0
          }
        };
      }
    };
    const send = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: abortAwareProvider
      },
      repository
    });
    const cancel = createCancelModelRunHandler({
      ...authDeps,
      providers: {
        fake: abortAwareProvider
      },
      repository
    });

    const response = await send(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Cancel me"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );
    for (let attempt = 0; attempt < 10 && !signal; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(signal).toBeDefined();
    const cancelResponse = await cancel(
      new Request("http://app.local/api/model-runs/run-1/cancel", {
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          runId: "run-1"
        }
      }
    );

    expect(cancelResponse.status).toBe(200);
    expect(signal?.aborted).toBe(true);
    await response.text();
    expect(attemptedLateToken).toBe(true);
    expect(state.assistantText).toBe("before ");
    expect(state.completed).toBeNull();
    expect(state.cancelled).toMatchObject({
      code: "model_run_cancelled"
    });
    expect(
      state.events
        .filter(({ event }) => event.type === "token")
        .map(({ event }) => ("delta" in event.data ? event.data.delta : ""))
    ).toEqual(["before "]);
  });

  it("cancels an owned streaming provider run through the provider adapter", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    state.created = openAiCreatedRun();
    state.providerResponseId = "resp-1";
    const order: string[] = [];
    const cancelledIds: string[] = [];
    const cancelRun = repository.cancelRun;
    repository.cancelRun = async (input) => {
      order.push("durable-cancel");
      return cancelRun(input);
    };
    const updateCancelledRunProviderPreview = repository.updateCancelledRunProviderPreview;
    repository.updateCancelledRunProviderPreview = async (input) => {
      order.push("persist-provider-preview");
      return updateCancelledRunProviderPreview(input);
    };
    const POST = createCancelModelRunHandler({
      ...authDeps,
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          cancel: async (providerResponseId) => {
            order.push("provider-cancel");
            cancelledIds.push(providerResponseId);

            return {
              id: providerResponseId,
              output: "secret raw cancel response",
              status: "cancelled"
            };
          },
          async *stream() {
            return {
              finalProviderResponsePreview: {},
              finalText: "",
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0
              }
            };
          }
        }
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/model-runs/run-1/cancel", {
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          runId: "run-1"
        }
      }
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      run: {
        id: "run-1",
        providerCancelPreview: {
          provider: "openai",
          status: "provider_cancel_succeeded"
        },
        status: "cancelled"
      }
    });
    expect(JSON.stringify(responseBody)).not.toContain("secret raw cancel response");
    expect(order).toEqual(["durable-cancel", "provider-cancel", "persist-provider-preview"]);
    expect(cancelledIds).toEqual(["resp-1"]);
    expect(state.cancelled).toMatchObject({
      code: "model_run_cancelled"
    });
    expect(state.providerCancelPreview).toEqual({
      provider: "openai",
      status: "provider_cancel_succeeded"
    });
  });

  it("leaves controller and provider untouched when durable completion already won", async () => {
    const { repository, state } = createMemoryRepository();
    const controller = new AbortController();
    const providerCancel = vi.fn(async () => ({}));
    repository.cancelRun = async () => ({
      kind: "current",
      run: {
        assistantMessageId: "assistant-message-1",
        chatId: "chat-1",
        id: "run-1",
        modelId: "fake-qsa",
        provider: "fake",
        providerResponseId: "provider-response-1",
        status: "complete"
      }
    });
    activeRunControllersForTest().set("run-1", controller);
    const POST = createCancelModelRunHandler({
      ...authDeps,
      providers: {
        fake: {
          buildRequestPreview: () => ({}),
          cancel: providerCancel,
          async *stream() {
            return {
              finalProviderResponsePreview: {},
              finalText: "",
              usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
            };
          }
        }
      },
      repository
    });

    try {
      const response = await POST(
        new Request("http://app.local/api/model-runs/run-1/cancel", {
          headers: { cookie: authCookie() },
          method: "POST"
        }),
        { params: { runId: "run-1" } }
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "model_run_not_cancelable",
        run: { id: "run-1", status: "complete" }
      });
      expect(controller.signal.aborted).toBe(false);
      expect(activeRunControllerRegistry.has("run-1")).toBe(true);
      expect(providerCancel).not.toHaveBeenCalled();
      expect(state.cancelled).toBeNull();
      expect(state.providerCancelPreview).toBeNull();
    } finally {
      activeRunControllersForTest().delete("run-1");
    }
  });

  it("stores a sanitized provider-cancel failure after durable cancellation wins", async () => {
    const { repository, state } = createMemoryRepository();
    state.providerResponseId = "provider-response-1";
    const POST = createCancelModelRunHandler({
      ...authDeps,
      providers: {
        fake: {
          buildRequestPreview: () => ({}),
          cancel: async () => {
            throw new Error("secret provider response body");
          },
          async *stream() {
            return {
              finalProviderResponsePreview: {},
              finalText: "",
              usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
            };
          }
        }
      },
      repository
    });

    const response = await POST(
      new Request("http://app.local/api/model-runs/run-1/cancel", {
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { runId: "run-1" } }
    );

    expect(response.status).toBe(200);
    expect(state.providerCancelPreview).toEqual({
      error: "Provider cancellation failed",
      provider: "fake",
      status: "provider_cancel_failed"
    });
    expect(JSON.stringify(await response.json())).not.toContain("secret provider response body");
  });

  it("passes the exact prepared MCP bindings to both send and regeneration acceptance", async () => {
    const memory = createMemoryRepository({
      modelKeys: new Set(["openrouter:anthropic/claude-opus-4.8"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    const repository: RunRepository = {
      ...memory.repository,
      findRegenerationSource: async (assistantMessageId, userId) =>
        assistantMessageId === "assistant-message-1" && userId === config.bootstrapUserId
          ? {
              assistantMessage: {
                id: assistantMessageId,
                modelId: "anthropic/claude-opus-4.8",
                provider: "openrouter"
              },
              chat: {
                defaultModelId: "anthropic/claude-opus-4.8",
                defaultProvider: "openrouter",
                id: "chat-1",
                projectMemory: "Project prefers short bullet answers."
              },
              userMessage: {
                content: { blocks: [{ text: "Original question", type: "text" }] },
                id: "user-message-1"
              }
            }
          : null
    };
    const { state } = memory;
    const bindings = [{
      fingerprint: "fingerprint-1",
      runtimeGenerationId: "generation-1",
      serverId: "server-1"
    }];
    const mcp = {
      prepare: vi.fn(async () => ({
        bindings,
        ok: true as const,
        snapshot: {
          servers: [{
            fingerprint: "fingerprint-1",
            revisionId: "revision-1",
            serverId: "server-1",
            serverName: "Example MCP"
          }],
          tools: [],
          version: 1 as const
        }
      }))
    };
    const deps = {
      ...authDeps,
      mcp,
      providers: { openrouter: createFakeProviderAdapter() },
      repository
    };
    const send = createSendMessageHandler(deps);
    const regenerate = createRegenerateModelRunHandler(deps);

    const sendResponse = await send(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "anthropic/claude-opus-4.8",
          provider: "openrouter",
          searchStrategy: "search-disabled",
          text: "Use MCP"
        }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );
    expect(sendResponse.status, await sendResponse.clone().text()).toBe(200);
    expect(state.created?.mcpBindings).toEqual(bindings);

    const regenerateResponse = await regenerate(
      new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify({ searchStrategy: "search-disabled" }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { messageId: "assistant-message-1" } }
    );
    expect(regenerateResponse.status).toBe(200);
    expect(state.regenerated?.mcpBindings).toEqual(bindings);
    expect(mcp.prepare).toHaveBeenCalledTimes(2);
    expect(mcp.prepare).toHaveBeenCalledWith(config.bootstrapUserId);
  });

  it("maps send and regeneration MCP acceptance races to retryable mcp_not_ready conflicts", async () => {
    const memory = createMemoryRepository();
    const repository: RunRepository = {
      ...memory.repository,
      createRegenerationRun: async () => {
        throw new McpRunPlanConflictError();
      },
      createRun: async () => {
        throw new McpRunPlanConflictError();
      }
    };
    const deps = {
      ...authDeps,
      providers: { fake: createFakeProviderAdapter() },
      repository
    };
    const send = createSendMessageHandler(deps);
    const regenerate = createRegenerateModelRunHandler(deps);

    const sendResponse = await send(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({ searchStrategy: "search-disabled", text: "Race" }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );
    const regenerateResponse = await regenerate(
      new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify({ searchStrategy: "search-disabled" }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { messageId: "assistant-message-1" } }
    );

    expect(sendResponse.status).toBe(409);
    await expect(sendResponse.json()).resolves.toEqual({ error: "mcp_not_ready" });
    expect(regenerateResponse.status).toBe(409);
    await expect(regenerateResponse.json()).resolves.toEqual({ error: "mcp_not_ready" });
  });
});
