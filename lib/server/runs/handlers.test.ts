import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { getAuthConfig } from "../auth/config";
import type { ResolvedEntitlements } from "../auth/entitlements";
import { createTestAuth } from "@/tests/support/auth";
import {
  ProviderAdmissionError,
  type ProviderAdmissionPlan
} from "../providerRuntime/admission";
import { createFakeProviderAdapter } from "../providers/fakeProvider";
import { ProviderStreamTooLargeError } from "../providers/streamSafety";
import type {
  ProviderAdapter,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRequest,
  ProviderRunRefreshResult
} from "../providers/types";
import { PERSONAL_CONTEXT_HEADING } from "../providers/personalContext";
import { activeRunControllerRegistry } from "./runExecution";
import {
  activeRunControllersForTest,
  resetBootOrphanSweepForTest
} from "@/tests/support/runExecution";
import {
  createCancelModelRunHandler,
  createGetModelRunHandler as createProductionGetModelRunHandler,
  createRegenerateModelRunHandler as createProductionRegenerateModelRunHandler,
  createSendMessageHandler as createProductionSendMessageHandler,
  type RunHandlerDeps
} from "./handlers";
import { reconcileStaleRuns } from "./runRecovery";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AttachmentLinkConflictError,
  KnowledgeRunPlanConflictError,
  McpRunPlanConflictError,
  type DurableRunControlRecord,
  type ProjectRunAdmission,
  type RunRepository
} from "./runRepositoryContract";
import {
  toolLoopCheckpoint,
  type CheckpointedToolLoopRun,
  type PersistedToolLoopCall
} from "./toolLoopPersistence";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });
const authDeps = {
  getConfig: () => config,
  resolveAuth: auth.resolveAuth
};

const entitledFakeModel: ResolvedEntitlements = {
  modelKeys: new Set(["fake:fake-qsa"]),
  providerKeys: new Set(),
  searchStrategies: new Set()
};

function projectRunAdmission(projectId: string): ProjectRunAdmission {
  return {
    accessRevision: 1,
    assistantBindings: [],
    defaults: {
      assistantId: null,
      controlValues: {},
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpMode: "off",
      providerModelId: "fake-qsa",
      searchPlan: { mode: "all_selected", optionIds: [] }
    },
    instructions: "Shared Project instructions",
    instructionsRevision: 1,
    knowledgeBaseIds: [],
    mcpServerIds: [],
    memoryEnabled: false,
    memoryItems: [],
    memoryRevision: 0,
    modelIds: ["fake-qsa"],
    policy: { externalToolsEnabled: true },
    policyRevision: 1,
    projectId,
    executionScope: "project",
    role: "CONTRIBUTOR",
    searchOptionIds: []
  };
}

const repositoryHarnesses = new WeakMap<
  RunRepository,
  Readonly<{
    entitlements: ResolvedEntitlements;
    modelCapabilities: ProviderModelCapabilities;
  }>
>();

function currentAdmissionPlan(
  input: Parameters<NonNullable<RunHandlerDeps["providerAdmission"]>["load"]>[0],
  modelCapabilities: ProviderModelCapabilities
): ProviderAdmissionPlan {
  const adapterKind = input.providerConnectionId === "openrouter"
    ? "openrouter_chat_completions" as const
    : input.providerConnectionId === "fake"
      ? "fake" as const
      : "openai_responses_native" as const;
  const fake = adapterKind === "fake";
  const defaultParams = {};
  const openRouterRouting = adapterKind === "openrouter_chat_completions"
    ? { mode: "automatic" as const, providers: [] as [] }
    : undefined;

  return {
    answer: {
      credentialSource: "default",
      modelConfiguration: {
        adapterKind,
        capabilities: modelCapabilities,
        defaultParams,
        ...(openRouterRouting ? { openRouterRouting } : {})
      },
      snapshot: {
        connection: {
          allowPrivateNetwork: fake,
          apiRoot: fake ? "http://127.0.0.1" : "https://api.example.test/v1",
          authenticationMode: fake ? "none" : "bearer",
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
              adapterKind: "fake",
              capabilities: modelCapabilities,
              defaultParams,
              upstreamModelId: input.providerModelId
            }
          : {
              adapterKind,
              answerSelectable: true,
              capabilities: modelCapabilities,
              defaultParams,
              modelClass: "answer",
              ...(openRouterRouting ? { openRouterRouting } : {}),
              upstreamModelId: input.providerModelId
            },
        modelDisplayName: input.providerModelId,
        providerFamily: input.providerConnectionId,
        providerModelId: input.providerModelId,
        version: 1
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

function withTestRuntime(deps: RunHandlerDeps): RunHandlerDeps {
  const harness = repositoryHarnesses.get(deps.repository);
  return {
    ...deps,
    allowFakeProvider: deps.allowFakeProvider ?? true,
    providerAdmission: deps.providerAdmission ?? {
      async load(input) {
        if (!harness) {
          if (!deps.providers[input.providerConnectionId]) {
            throw new ProviderAdmissionError("model_not_available");
          }
          if (input.searchPlan.optionIds.length > 0) {
            throw new ProviderAdmissionError("search_strategy_not_available");
          }
          return currentAdmissionPlan(input, {
            nativePdfInput: false,
            nativeSearch: false,
            pdf: true,
            reasoning: true,
            streaming: true,
            toolCalling: true,
            vision: true
          });
        }
        const modelKey = `${input.providerConnectionId}:${input.providerModelId}`;
        if (
          !harness.entitlements.providerKeys.has(input.providerConnectionId) &&
          !harness.entitlements.modelKeys.has(modelKey)
        ) {
          throw new ProviderAdmissionError("model_not_available");
        }
        if (input.searchPlan.optionIds.length > 0) {
          throw new ProviderAdmissionError("search_strategy_not_available");
        }
        return currentAdmissionPlan(input, harness.modelCapabilities);
      }
    },
    providerRuntime: deps.providerRuntime ?? {
      async resolve(runId, role) {
        if (role === "search") throw new Error("provider_run_binding_not_found");
        const run = await deps.repository.getRunControlForUser(runId, config.bootstrapUserId);
        const adapter = run
          ? deps.providers[run.provider]
          : Object.values(deps.providers)[0];
        if (!adapter) throw new Error("provider_run_binding_not_found");
        return { adapter, responseTimeoutMs: 300_000 };
      }
    }
  };
}

async function withCurrentSearchPlan(request: Request): Promise<Request> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!request.body || !Number.isSafeInteger(declaredLength) || declaredLength > 1024 * 1024) {
    return request;
  }
  try {
    const body = await request.clone().json() as Record<string, unknown>;
    if (
      !body ||
      typeof body !== "object" ||
      "searchPlan" in body ||
      typeof body.assistantId === "string"
    ) {
      return request;
    }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    return new Request(request, {
      body: JSON.stringify({
        ...body,
        searchPlan: { mode: "all_selected", optionIds: [] }
      }),
      headers
    });
  } catch {
    return request;
  }
}

function createSendMessageHandler(deps: RunHandlerDeps) {
  const handler = createProductionSendMessageHandler(withTestRuntime(deps));
  return async (...args: Parameters<typeof handler>) =>
    handler(await withCurrentSearchPlan(args[0]), args[1]);
}

function createRegenerateModelRunHandler(deps: RunHandlerDeps) {
  const handler = createProductionRegenerateModelRunHandler(withTestRuntime(deps));
  return async (...args: Parameters<typeof handler>) =>
    handler(await withCurrentSearchPlan(args[0]), args[1]);
}

function createGetModelRunHandler(deps: RunHandlerDeps) {
  return createProductionGetModelRunHandler(withTestRuntime(deps));
}

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

function captureProviderRequest(
  adapter: ProviderAdapter,
  onStart: (request: ProviderRunRequest) => void
): ProviderAdapter {
  return {
    ...adapter,
    async *stream(request, options) {
      onStart(request);
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
    toolCalling: false,
    vision: true
  }
) {
  const state: {
    assistantText: string;
    assistantTextWrites: number;
    bootSweeps: { liveRunIds: string[]; sweptRunIds: string[] }[];
    cancelled: Parameters<RunRepository["cancelRun"]>[0]["payload"] | null;
    completed: Parameters<RunRepository["completeRun"]>[0] | null;
    created: Parameters<RunRepository["createRun"]>[0] | null;
    events: { event: ModelRunSseEvent; sequence: number }[];
    failed: { error: { code: string; message: string }; runId: string } | null;
    providerResponseId: string | null;
    recoverySettled: boolean;
    recentActiveRun: (ReturnType<typeof activeRunRecord> & { updatedAt: Date }) | null;
    regenerated: Parameters<RunRepository["createRegenerationRun"]>[0] | null;
    searchRuns: Parameters<RunRepository["createSearchRun"]>[0][];
    staleActiveRuns: (ReturnType<typeof activeRunRecord> & { updatedAt: Date })[];
    toolCalls: PersistedToolLoopCall[];
  } = {
    assistantText: "",
    assistantTextWrites: 0,
    bootSweeps: [],
    cancelled: null,
    completed: null,
    created: null,
    events: [],
    failed: null,
    providerResponseId: null,
    recoverySettled: false,
    recentActiveRun: null,
    regenerated: null,
    searchRuns: [],
    staleActiveRuns: [],
    toolCalls: []
  };
  const repository: RunRepository = {
    admitPreparingRun: async () => {
      throw new Error("preparing_run_not_supported_by_handler_harness");
    },
    advanceToolLoopCallBatch: async ({ roundIndex }) =>
      state.toolCalls.some((call) => call.roundIndex === roundIndex &&
        call.state !== "complete" && call.state !== "error")
        ? "incomplete"
        : "advanced",
    appendAssistantText: async (_assistantMessageId, text) => {
      state.assistantText = text;
      state.assistantTextWrites += 1;
    },
    appendRunOutputEvent: async (_runId, event) => {
      const sequence = state.events.reduce((max, entry) => Math.max(max, entry.sequence), -1) + 1;
      state.events.push({ event, sequence });
    },
    beginPreparingRunAttempt: async () => false,
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
    completePreparingRunAttempt: async () => false,
    completeRun: async (input) => {
      if (state.cancelled || state.completed || state.recoverySettled) {
        return false;
      }

      state.completed = input;
      state.providerResponseId = input.providerResponseId ?? null;
      let sequence = state.events.reduce((max, entry) => Math.max(max, entry.sequence), -1) + 1;
      for (const event of input.outputEvents ?? []) {
        state.events.push({ event, sequence });
        sequence += 1;
      }
      return true;
    },
    createRun: async (input) => {
      state.created = input;
      state.cancelled = null;
      state.completed = null;
      state.providerResponseId = null;
      state.recoverySettled = false;

      return {
        assistantMessageId: "assistant-message-1",
        runId: "run-1",
        userMessageId: "user-message-1"
      };
    },
    createRegenerationRun: async (input) => {
      state.regenerated = input;
      state.cancelled = null;
      state.completed = null;
      state.providerResponseId = null;
      state.recoverySettled = false;
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
    finalizePreparingRun: async () => false,
    failRun: async (runId, _assistantMessageId, error, options) => {
      state.failed = { error, runId };
      state.recoverySettled = options?.recoveryTerminal === true;
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
            status: state.cancelled
              ? "cancelled"
              : state.completed
                ? "complete"
                : state.failed?.runId === runId
                  ? "error"
                  : "streaming"
          }
        : null,
    getRunOutcomeForUser: async (runId, userId) =>
      runId === "run-1" && userId === config.bootstrapUserId
        ? {
            id: runId,
            status: state.cancelled
              ? "cancelled"
              : state.completed
                ? "complete"
                : state.failed
                  ? "error"
                  : "streaming"
          }
        : null,
    getChatUpdateForRun: async ({ assistantMessageId, chatId, userId, userMessageId }) =>
      userId === config.bootstrapUserId && state.completed
        ? {
            chat: {
              activeLeafMessageId: assistantMessageId,
              contextStats: { approximateActiveBranchInputTokens: 23 },
              createdAt: "2026-06-08T00:00:00.000Z",
              defaultModelId: "fake-qsa",
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
    recoverPreparingRun: async () => "not_preparing",
    isSearchStrategyEnabled: async () => true,
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
        checksum: null,
        extractedText: "Extracted PDF text",
        fileName: "brief.pdf",
        id,
        kind: "pdf",
        metadata: {},
        mimeType: "application/pdf",
        processingErrorCode: null,
        status: "ready",
        storageKey: `storage/${id}`
      })),
    loadEntitlements: async () => entitlements,
    loadModelPricing: async () => modelPricing,
    loadRunUsageAttributions: async () => [],
    loadCheckpointedToolLoopRun: async () => null,
    markAssistantMessageGroundedLiveOnly: async () => true,
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
      for (const event of input.outputEvents) {
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
    markRunAnswerStarted: async () => undefined,
    retryPreparingRunAttempt: async () => null,
    settlePreparingRunFailure: async () => false,
    updateRunProviderResponseId: async (_runId, providerResponseId) => {
      state.providerResponseId = providerResponseId;
      return "published";
    }
  };

  repositoryHarnesses.set(repository, { entitlements, modelCapabilities });

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

function staleRunRecord(input: Parameters<typeof activeRunRecord>[0] = {}) {
  return {
    ...activeRunRecord(input),
    updatedAt: new Date(0)
  };
}

function openAiCreatedRun(): Parameters<RunRepository["createRun"]>[0] {
  return {
    chatId: "chat-1",
    content: { blocks: [] },
    defaults: {
      controlDefaults: {},
      modelId: "gpt-5.5",
      provider: "openai",
      searchPlan: { mode: "all_selected", optionIds: [] },
      userId: config.bootstrapUserId
    },
    expectedActiveLeafId: null,
    modelId: "gpt-5.5",
    normalizedRequest: {
      attachmentIds: [],
      chatId: "chat-1",
      content: { blocks: [] },
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      toolMode: "auto",
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
        system: null
      },
      provider: "openai",
      searchPlan: { mode: "all_selected", options: [] }
    },
    provider: "openai",
    providerRequestPreview: {},
    userId: config.bootstrapUserId
  };
}

describe("model run route handlers", () => {
  beforeEach(() => {
    resetBootOrphanSweepForTest();
  });

  it.each(["send", "regenerate"] as const)(
    "rejects an oversized %s body before recovery or repository work",
    async (kind) => {
      const { repository, state } = createMemoryRepository();
      const findOwnedChat = vi.spyOn(repository, "findOwnedChat");
      const findRegenerationSource = vi.spyOn(repository, "findRegenerationSource");
      const deps = {
        ...authDeps,
        providers: { fake: createFakeProviderAdapter() },
        repository
      };
      const request = new Request("http://app.local/api/model-runs/oversized", {
        body: "{}",
        headers: {
          "content-length": "9007199254740992",
          cookie: authCookie()
        },
        method: "POST"
      });
      const response =
        kind === "send"
          ? await createSendMessageHandler(deps)(request, { params: { chatId: "chat-1" } })
          : await createRegenerateModelRunHandler(deps)(request, {
              params: { messageId: "assistant-1" }
            });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ error: "request_body_too_large" });
      expect(findOwnedChat).not.toHaveBeenCalled();
      expect(findRegenerationSource).not.toHaveBeenCalled();
      expect(state.bootSweeps).toEqual([]);
      expect(state.created).toBeNull();
      expect(state.regenerated).toBeNull();
    }
  );

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
          searchPlan: { mode: "all_selected", optionIds: [] }
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

  it("idempotently accepts a matching stale Project draft for an already-persisted chat", async () => {
    const projectId = "10000000-0000-4000-8000-000000000001";
    const folderId = "20000000-0000-4000-8000-000000000002";
    const { repository, state } = createMemoryRepository();
    repository.findOwnedChat = async (chatId, userId) =>
      userId === config.bootstrapUserId
        ? {
            activeLeafMessageId: null,
            defaultModelId: "fake-qsa",
            defaultProvider: "fake",
            id: chatId,
            messageCount: 0,
            project: projectRunAdmission(projectId),
            projectFolderId: folderId,
            projectMemory: null,
            title: "Persisted Project chat"
          }
        : null;
    const response = await createSendMessageHandler({
      ...authDeps,
      providers: { fake: createFakeProviderAdapter() },
      repository
    })(new Request("http://app.local/api/chats/chat-project/messages", {
      body: JSON.stringify({
        expectedActiveLeafId: null,
        modelId: "fake-qsa",
        projectDraft: { folderId, projectId },
        provider: "fake",
        text: "Retry the admitted Project send"
      }),
      headers: { cookie: authCookie() },
      method: "POST"
    }), { params: { chatId: "chat-project" } });

    expect(response.status).toBe(200);
    await response.text();
    expect(state.created).toMatchObject({
      chatId: "chat-project",
      project: { projectId }
    });
    expect(state.created?.projectChat).toBeUndefined();
  });

  it("carries a new personal chat reservation into the atomic first-send admission", async () => {
    const chatId = "30000000-0000-4000-8000-000000000003";
    const folderId = "20000000-0000-4000-8000-000000000002";
    const { repository, state } = createMemoryRepository();
    repository.findOwnedChat = async () => null;
    repository.loadPersonalFirstSend = async (input) => input.chatId === chatId
      ? {
          activeLeafMessageId: null,
          defaultModelId: "fake-qsa",
          defaultProvider: "fake",
          folderId,
          id: chatId,
          memoryMode: "NORMAL",
          messageCount: 0,
          projectMemory: null,
          title: "New Chat",
          workspaceEnabled: false
        }
      : null;

    const response = await createSendMessageHandler({
      ...authDeps,
      providers: { fake: createFakeProviderAdapter() },
      repository
    })(new Request(`http://app.local/api/chats/${chatId}/messages`, {
      body: JSON.stringify({
        expectedActiveLeafId: null,
        modelId: "fake-qsa",
        personalDraft: { folderId, memoryMode: "NORMAL" },
        provider: "fake",
        text: "Atomic first personal question"
      }),
      headers: { cookie: authCookie() },
      method: "POST"
    }), { params: { chatId } });

    expect(response.status).toBe(200);
    await response.text();
    expect(state.created).toMatchObject({
      chatId,
      expectedActiveLeafId: null,
      personalChat: {
        defaultProviderModelId: "fake-qsa",
        folderId,
        memoryMode: "NORMAL"
      }
    });
  });

  it("rejects a personal Temporary reservation without its reviewed retention payload", async () => {
    const chatId = "30000000-0000-4000-8000-000000000003";
    const { repository, state } = createMemoryRepository();
    repository.findOwnedChat = async () => null;
    const loadPersonalFirstSend = vi.fn();
    repository.loadPersonalFirstSend = loadPersonalFirstSend;

    const response = await createSendMessageHandler({
      ...authDeps,
      providers: { fake: createFakeProviderAdapter() },
      repository
    })(new Request(`http://app.local/api/chats/${chatId}/messages`, {
      body: JSON.stringify({
        expectedActiveLeafId: null,
        modelId: "fake-qsa",
        personalDraft: { folderId: null, memoryMode: "TEMPORARY" },
        provider: "fake",
        text: "Unreviewed Temporary send"
      }),
      headers: { cookie: authCookie() },
      method: "POST"
    }), { params: { chatId } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "personal_draft_invalid" });
    expect(loadPersonalFirstSend).not.toHaveBeenCalled();
    expect(state.created).toBeNull();
  });

  it("rejects a stale Project draft whose persisted folder does not match", async () => {
    const projectId = "10000000-0000-4000-8000-000000000001";
    const folderId = "20000000-0000-4000-8000-000000000002";
    const { repository, state } = createMemoryRepository();
    repository.findOwnedChat = async (chatId, userId) =>
      userId === config.bootstrapUserId
        ? {
            activeLeafMessageId: null,
            defaultModelId: "fake-qsa",
            defaultProvider: "fake",
            id: chatId,
            messageCount: 0,
            project: projectRunAdmission(projectId),
            projectFolderId: folderId,
            projectMemory: null,
            title: "Persisted Project chat"
          }
        : null;
    const response = await createSendMessageHandler({
      ...authDeps,
      providers: { fake: createFakeProviderAdapter() },
      repository
    })(new Request("http://app.local/api/chats/chat-project/messages", {
      body: JSON.stringify({
        expectedActiveLeafId: null,
        modelId: "fake-qsa",
        projectDraft: { folderId: null, projectId },
        provider: "fake",
        text: "Mismatched stale draft"
      }),
      headers: { cookie: authCookie() },
      method: "POST"
    }), { params: { chatId: "chat-project" } });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "project_draft_conflict" });
    expect(state.created).toBeNull();
  });

  it("returns a typed setup error before leaf checks for a first Project send without a default", async () => {
    const projectId = "10000000-0000-4000-8000-000000000001";
    const chatId = "30000000-0000-4000-8000-000000000003";
    const { repository, state } = createMemoryRepository();
    repository.findOwnedChat = async () => null;
    repository.loadProjectFirstSend = async () => {
      const project = projectRunAdmission(projectId);
      return {
        activeLeafMessageId: null,
        defaultModelId: "",
        defaultProvider: "",
        id: chatId,
        messageCount: 0,
        project: {
          ...project,
          defaults: { ...project.defaults, providerModelId: null }
        },
        projectFolderId: null,
        projectMemory: null,
        title: "New Project chat"
      };
    };
    const response = await createSendMessageHandler({
      ...authDeps,
      providers: { fake: createFakeProviderAdapter() },
      repository
    })(new Request(`http://app.local/api/chats/${chatId}/messages`, {
      body: JSON.stringify({
        expectedActiveLeafId: null,
        modelId: "fake-qsa",
        projectDraft: { folderId: null, projectId },
        provider: "fake",
        text: "First shared question"
      }),
      headers: { cookie: authCookie() },
      method: "POST"
    }), { params: { chatId } });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "project_setup_required" });
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
          searchPlan: { mode: "all_selected", optionIds: [] }
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

  it("returns safe structured attachment-limit details before run creation", async () => {
    const { repository, state } = createMemoryRepository();
    const POST = createSendMessageHandler({
      ...authDeps,
      getAttachmentLimits: () => ({
        maxCount: 2,
        maxEncodedBytes: 100_663_296,
        maxMaterializedBytes: 67_108_864,
        readConcurrency: 2
      }),
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: {
            blocks: ["one", "two", "three"].map((attachmentId) => ({
              attachmentId,
              type: "file"
            }))
          },
          modelId: "fake-qsa",
          provider: "fake",
          searchPlan: { mode: "all_selected", optionIds: [] }
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

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      actual: { count: 3 },
      error: "attachment_count_limit_exceeded",
      limits: { maxCount: 2 },
      message: "This run contains 3 attachments; the limit is 2."
    });
    expect(state.created).toBeNull();
  });

  it("sanitizes private storage failures in run-admission responses", async () => {
    const { repository, state } = createMemoryRepository();
    repository.loadAttachments = async () => [{
      byteSize: 3,
      checksum: null,
      extractedText: null,
      fileName: "private-diagram.png",
      id: "image-1",
      kind: "image",
      metadata: {},
      mimeType: "image/png",
      processingErrorCode: null,
      status: "ready",
      storageKey: "private/user/object-key"
    }];
    const privateFailure = "ENOENT /srv/private/user/object-key";
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: createFakeProviderAdapter()
      },
      repository,
      storage: {
        async deleteObject() {},
        async getObject() {
          throw new Error(privateFailure);
        },
        async putObject() {}
      }
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: {
            blocks: [{ attachmentId: "image-1", type: "image" }]
          },
          modelId: "fake-qsa",
          provider: "fake",
          searchPlan: { mode: "all_selected", optionIds: [] }
        }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      error: "attachment_object_read_failed",
      message: "An attachment object could not be read."
    });
    expect(JSON.stringify(body)).not.toContain(privateFailure);
    expect(JSON.stringify(body)).not.toContain("object-key");
    expect(state.created).toBeNull();
  });

  it("returns the same committed PDF run on duplicate admission without starting the answer", async () => {
    const { repository, state } = createMemoryRepository();
    const bytes = Buffer.from("%PDF-settled-original");
    repository.loadAttachments = async () => [{ byteSize: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"), extractedText: null,
      fileName: "report.pdf", id: "pdf-1", kind: "pdf", metadata: { pdfPageCount: 21 }, mimeType: "application/pdf",
      processingErrorCode: null, status: "ready", storageKey: "private/original" }];
    const createRun = repository.createRun;
    repository.createRun = vi.fn(async (input) => ({ ...await createRun(input), deferredPdf: true }));
    repository.getRunOutcomeForUser = async () => ({ id: "run-1", status: "queued", pdfPreparation: [{
      completedPages: 0, pageCount: 21, phase: "checking", retryable: false,
      route: "local_text", limitedReadingQuality: true, longDocument: true
    }] });
    const adapter = createFakeProviderAdapter();
    const stream = vi.spyOn(adapter, "stream");
    const kick = vi.fn();
    const POST = createSendMessageHandler({ ...authDeps, repository, providers: { fake: adapter },
      chatPdf: { kick, resolve: async () => ({ route: "local_text", authority: null, snapshot: null, policyVersion: null }),
        findAdmission: async (key) => state.created?.deferredPdf?.admissionKey === key ? {
          assistantMessageId: "assistant-message-1", userMessageId: "user-message-1", version: 1,
          run: (await repository.getRunOutcomeForUser("run-1", config.bootstrapUserId))!
        } : null },
      storage: { deleteObject: vi.fn(), putObject: vi.fn(), getObject: async (storageKey) => ({ body: bytes, contentType: "application/pdf", storageKey }) }
    });
    const request = () => new Request("http://app.local/api/chats/chat-1/messages", {
      method: "POST", headers: { cookie: authCookie() }, body: JSON.stringify({
        admissionId: "invocation-one", expectedActiveLeafId: null, provider: "fake", modelId: "fake-qsa",
        searchPlan: { mode: "all_selected", optionIds: [] }, content: { blocks: [{ attachmentId: "pdf-1", type: "file" }] }
      })
    });
    const first = await POST(request(), { params: { chatId: "chat-1" } });
    expect(first.status).toBe(202);
    const accepted = await first.json();
    expect(accepted).toMatchObject({ run: { id: "run-1", status: "queued" }, userMessageId: "user-message-1" });
    const second = await POST(request(), { params: { chatId: "chat-1" } });
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(accepted);
    expect(repository.createRun).toHaveBeenCalledOnce();
    expect(state.created?.chatPdfAdmissions).toMatchObject([{ attachmentId: "pdf-1", route: "local_text", pageCount: 21 }]);
    expect(stream).not.toHaveBeenCalled();
    expect(kick).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(accepted)).not.toMatch(/private|snapshot|checksum|credential/);

    const saved = state.created!.deferredPdf!.snapshot as { prepared: import("./runPreparation").MaterializedPreparedRunData };
    repository.createRegenerationRun = vi.fn(async () => ({ assistantMessageId: "retry-assistant", runId: "run-1",
      userMessageId: "user-message-1", deferredPdf: true }));
    const resolveCurrentRoute = vi.fn();
    const retry = createRegenerateModelRunHandler({ ...authDeps, repository, providers: { fake: adapter },
      chatPdf: { kick, findAdmission: async () => null, resolve: resolveCurrentRoute,
        loadRetry: async () => ({ adapter, prepared: { ...saved.prepared, defaults: null, sourceKind: "regenerate" } }) } });
    const retried = await retry(new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
      method: "POST", headers: { cookie: authCookie() }, body: JSON.stringify({
        retryPdfPreparation: true, admissionId: "retry-invocation", provider: "changed-provider", modelId: "changed-model"
      })
    }), { params: { messageId: "assistant-message-1" } });
    expect(retried.status).toBe(202);
    expect(repository.createRegenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "fake-qsa", provider: "fake", chatPdfAdmissions: saved.prepared.chatPdfAdmissions,
      normalizedRequest: saved.prepared.normalizedRequest
    }));
    expect(resolveCurrentRoute).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();

    const resolveAssistant = vi.fn().mockResolvedValue({ ok: false,
      code: "assistant_not_available", status: 404 });
    const assistantRetry = createRegenerateModelRunHandler({ ...authDeps, repository,
      providers: { fake: adapter }, assistants: { resolveForRun: resolveAssistant },
      chatPdf: { kick, findAdmission: async () => null, resolve: resolveCurrentRoute,
        loadRetry: async () => ({ assistantId: "saved-assistant", skillIds: [] }) } });
    const previousAdmissions = vi.mocked(repository.createRegenerationRun).mock.calls.length;
    const unavailable = await assistantRetry(new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
      method: "POST", headers: { cookie: authCookie() }, body: JSON.stringify({
        retryPdfPreparation: true, assistantId: "client-replacement", systemPrompt: "client override"
      })
    }), { params: { messageId: "assistant-message-1" } });
    expect(unavailable.status).toBe(404);
    expect(resolveAssistant).toHaveBeenCalledWith(config.bootstrapUserId, "saved-assistant");
    expect(vi.mocked(repository.createRegenerationRun).mock.calls).toHaveLength(previousAdmissions);
  });

  it("rejects a direct-PDF checksum mismatch before request building or provider execution", async () => {
    const directCapabilities: ProviderModelCapabilities = {
      nativePdfInput: true,
      nativeSearch: false,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: false,
      vision: true
    };
    const { repository, state } = createMemoryRepository(
      entitledFakeModel,
      [],
      { inputTokenPriceMicros: 2, outputTokenPriceMicros: 8 },
      directCapabilities
    );
    const bytes = Buffer.from("%PDF-private");
    repository.loadAttachments = async () => [{
      byteSize: bytes.length,
      checksum: "a".repeat(64),
      extractedText: null,
      fileName: "private.pdf",
      id: "pdf-1",
      kind: "pdf",
      metadata: {},
      mimeType: "application/pdf",
      processingErrorCode: null,
      status: "processing",
      storageKey: "private/user/pdf-1"
    }];
    const buildRequestPreview = vi.fn(() => ({}));
    const stream = vi.fn(async function* () {
      return {
        finalProviderResponsePreview: {},
        finalText: "must not run",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0
        }
      };
    });
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: { fake: { buildRequestPreview, stream } },
      repository,
      storage: {
        async deleteObject() {},
        async getObject(storageKey) {
          return { body: bytes, contentType: "application/pdf", storageKey };
        },
        async putObject() {}
      }
    });

    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: { blocks: [{ attachmentId: "pdf-1", type: "file" }] },
          modelId: "fake-qsa",
          provider: "fake",
          searchPlan: { mode: "all_selected", optionIds: [] }
        }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "attachment_checksum_mismatch"
    });
    expect(buildRequestPreview).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(state.created).toBeNull();
  });

  it("keeps runtime admission authoritative when a browser believed direct PDF was available", async () => {
    const { repository, state } = createMemoryRepository();
    repository.loadAttachments = async () => [{
      byteSize: 16,
      checksum: null,
      extractedText: null,
      fileName: "processing.pdf",
      id: "pdf-1",
      kind: "pdf",
      metadata: {},
      mimeType: "application/pdf",
      processingErrorCode: null,
      status: "processing",
      storageKey: "private/user/pdf-1"
    }];
    const buildRequestPreview = vi.fn(() => ({}));
    const stream = vi.fn(async function* () {
      return {
        finalProviderResponsePreview: {},
        finalText: "must not run",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0
        }
      };
    });
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: { fake: { buildRequestPreview, stream } },
      repository
    });

    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          content: { blocks: [{ attachmentId: "pdf-1", type: "file" }] },
          modelId: "fake-qsa",
          provider: "fake",
          searchPlan: { mode: "all_selected", optionIds: [] }
        }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "attachment_not_ready" });
    expect(buildRequestPreview).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(state.created).toBeNull();
  });

  it("allows provider-wide grants to run enabled catalog models", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(),
      providerKeys: new Set(["openai"]),
      searchStrategies: new Set()
    });
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
          searchPlan: { mode: "all_selected", optionIds: [] },
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
      providerAdmission: {
        async load() {
          throw new ProviderAdmissionError("model_not_available");
        }
      },
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
          searchPlan: { mode: "all_selected", optionIds: [] },
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
          searchPlan: { mode: "all_selected", optionIds: [] }
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
        checksum: null,
        extractedText: "Document body",
        fileName: "notes.md",
        id,
        kind: "document",
        metadata: {},
        mimeType: "text/plain",
        processingErrorCode: null,
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
      async *stream(runRequest) {
        providerAttachments = runRequest.attachments;
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
          searchPlan: { mode: "all_selected", optionIds: [] }
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
        checksum: null,
        extractedText: "large attachment text ".repeat(200),
        fileName: "large.md",
        id,
        kind: "document",
        metadata: {},
        mimeType: "text/markdown",
        processingErrorCode: null,
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
          searchPlan: { mode: "all_selected", optionIds: [] }
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
    const pdfBytes = Buffer.from("%PDF-1.4\nnative\n");
    repository.loadAttachments = async (_userId, attachmentIds) =>
      attachmentIds.map((id) => ({
        byteSize: pdfBytes.length,
        checksum: createHash("sha256").update(pdfBytes).digest("hex"),
        extractedText: "Extracted fallback text",
        fileName: "brief.pdf",
        id,
        kind: "pdf",
        metadata: {},
        mimeType: "application/pdf",
        processingErrorCode: null,
        status: "ready",
        storageKey: `storage/${id}`
      }));
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
      async *stream(runRequest) {
        providerAttachments = runRequest.attachments;
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
          searchPlan: { mode: "all_selected", optionIds: [] }
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
          provider: "fake",
          searchPlan: { mode: "all_selected", optionIds: [] },
          timeZone: "Europe/Berlin"
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
        baseline: {
          source: "standard_chat",
          timeZone: "Europe/Berlin",
          timeZoneSource: "client"
        },
        developer: expect.stringContaining("Visible answer contract"),
        system: expect.stringContaining("You are a helpful AI assistant. Today is ")
      },
      provider: "fake",
      searchPlan: { mode: "all_selected", options: [] }
    });
    expect(state.created?.normalizedRequest.prompt.system).not.toContain(
      "Project memory:\nProject prefers short bullet answers."
    );
    expect(state.completed?.usage.outputTokens).toBeGreaterThan(0);
    expect(state.completed?.provider).toBe("fake");
    expect(state.completed?.modelId).toBe("fake-qsa");
    expect(state.completed?.finalText).toBe("Fake answer: Hello QSA");
    expect(state.completed?.estimatedCostMicros).toBe(
      state.completed!.usage.inputTokens * 2 + state.completed!.usage.outputTokens * 8
    );
    expect(state.events).toEqual([]);
  });

  it("passes accepted run defaults from the accepted send", async () => {
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
          provider: "fake",
          searchPlan: { mode: "all_selected", optionIds: [] }
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
      provider: "fake",
      searchPlan: {
        mode: "all_selected",
        optionIds: []
      },
      userId: config.bootstrapUserId
    });
    expect(state.created?.assistant).toBeUndefined();
  });

  it("ignores client-sent prompt fields and applies the code-owned baseline", async () => {
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
            system: "Custom system prompt"
          },
          provider: "fake",
          searchPlan: { mode: "all_selected", optionIds: [] },
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
      baseline: {
        source: "standard_chat",
        timeZone: "UTC",
        timeZoneSource: "utc_fallback"
      },
      system: expect.stringContaining("You are a helpful AI assistant. Today is ")
    });
    expect(state.created?.normalizedRequest.prompt.system).not.toContain("Custom system prompt");
    expect(state.created?.normalizedRequest.prompt.developer).not.toContain("Custom developer prompt");
  });

  it("rejects an unavailable assistant selection before creating a run", async () => {
    const { repository, state } = createMemoryRepository();
    const provider: ProviderAdapter = {
      buildRequestPreview: vi.fn(() => ({
        provider: "fake"
      })),
      async *stream() {
        throw new Error("provider should not be called");
      }
    };
    // A real resolver outcome, not a missing dependency: the lookup ran and
    // reported the privacy-neutral failure shared by foreign, archived, and
    // nonexistent assistants.
    const resolveForRun = vi.fn(async () => ({
      code: "assistant_not_available" as const,
      ok: false as const,
      status: 404 as const
    }));
    const POST = createSendMessageHandler({
      ...authDeps,
      assistants: { resolveForRun },
      providers: {
        fake: provider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          assistantId: "foreign-assistant",
          text: "Assistant run"
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

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "assistant_not_available"
    });
    expect(resolveForRun).toHaveBeenCalledWith(config.bootstrapUserId, "foreign-assistant");
    expect(state.created).toBeNull();
    expect(provider.buildRequestPreview).not.toHaveBeenCalled();
  });

  it("rejects assistant-governed overrides sent alongside an assistant selection", async () => {
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
          assistantId: "assistant-1",
          modelId: "fake-qsa",
          text: "Assistant run with overrides"
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
      error: "assistant_overrides_not_allowed"
    });
    expect(state.created).toBeNull();
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
        expect(runRequest.searchPlan).toMatchObject({
          mode: "model_choice",
          options: [{ optionId: "openai-native-web-search" }]
        });
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
      providerAdmission: {
        async load(input) {
          const plan = currentAdmissionPlan(input, {
            nativePdfInput: false,
            nativeSearch: true,
            pdf: true,
            reasoning: true,
            streaming: true,
            vision: true
          });
          const optionId = "openai-native-web-search";
          return {
            ...plan,
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
                provider: "openai",
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
        }
      },
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
          searchPlan: { mode: "model_choice", optionIds: ["openai-native-web-search"] },
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
    expect(state.events).toEqual([]);
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
    expect(state.events).toEqual([]);
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
      contextWindow: 280,
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
    const liveEvents = parseSse(await response.text());
    expect(state.created?.normalizedRequest.context?.messages.map((message) => message.id)).toEqual([
      "recent-user",
      "recent-assistant",
      "current-user-message"
    ]);
    expect(state.created?.normalizedRequest.context?.summary?.truncation).toMatchObject({
      droppedMessages: 2,
      keptMessages: 3
    });
    const truncationEvent = liveEvents.find(
      (event) => event.type === "artifact" &&
        (event.data as { artifactType?: string }).artifactType === "context_truncated"
    );

    expect(truncationEvent?.type).toBe("artifact");
    expect((truncationEvent?.data as { payload?: unknown } | undefined)?.payload)
      .toMatchObject({ droppedMessages: 2 });
    expect(state.events).toEqual([]);
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

  it("checkpoints streamed text in batches while keeping live SSE token granularity", async () => {
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
    expect(persistedTokenEvents).toEqual([]);
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
    expect(state.events).toEqual([]);
    expect(state.failed).toMatchObject({
      error: {
        code: "provider_stream_failed",
        message: "provider exploded"
      },
      runId: "run-1"
    });
  });

  it("does not refresh a safety-failed run after its provider response id was published", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { repository, state } = createMemoryRepository();
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      status: "in_progress",
      terminal: false
    }));
    const provider: ProviderAdapter = {
      buildRequestPreview: () => ({ provider: "fake" }),
      refresh,
      async *stream() {
        yield {
          data: {
            artifactType: "summary",
            payload: { responseId: "response-before-safety-failure" }
          },
          type: "artifact"
        };
        yield { data: { delta: "durable partial" }, type: "token" };
        throw new ProviderStreamTooLargeError({
          maxBytes: 2048,
          observedBytes: 2049,
          snapshot: { durationMs: 40, totalStreamBytes: 2049 }
        });
      }
    };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: { fake: provider },
      repository
    });
    const postResponse = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "Fail safely after publishing an id"
        }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );
    const liveEvents = parseSse(await postResponse.text());

    expect(state.providerResponseId).toBe("response-before-safety-failure");
    expect(state.assistantText).toBe("durable partial");
    expect(state.assistantTextWrites).toBe(1);
    expect(state.recoverySettled).toBe(true);
    expect(liveEvents.at(-1)).toEqual({
      data: {
        code: "provider_stream_too_large",
        message: "The provider stream exceeded a safety limit."
      },
      type: "error"
    });

    const GET = createGetModelRunHandler({
      ...authDeps,
      providers: { fake: provider },
      repository
    });
    const getResponse = await GET(
      new Request("http://app.local/api/model-runs/run-1", {
        headers: { cookie: authCookie() }
      }),
      { params: { runId: "run-1" } }
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({
      run: {
        id: "run-1",
        status: "error"
      },
      version: 1
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(state.assistantTextWrites).toBe(1);
    expect(state.completed).toBeNull();
    expect(state.events.map(({ event }) => event.type)).not.toContain("done");
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
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

  it("carries a typed tool observation through the ordinary send HTTP boundary", async () => {
    const { repository, state } = createMemoryRepository();
    const secretCanary = "RAW_TOOL_RESULT_MUST_NOT_EGRESS";
    const safeObservation =
      "Tool observation — tool: http.request; operation: GET /limits; " +
      "outcome: FAILURE; occurred_at: 2026-08-28T12:00:02.000Z; " +
      "endpoint: https://api.example.test/limits; status_code: 429";
    const personalContext = {
      approxTokens: 96,
      itemCount: 1,
      memoryGeneration: 3,
      memoryRevision: 7,
      mode: "prefetched" as const,
      text: [
        PERSONAL_CONTEXT_HEADING,
        "EVIDENCE_ITEMS_JSONL",
        JSON.stringify({
          document_time: "2026-08-28T12:00:02.000Z",
          evidence_handle: "M1",
          evidence_type: "tool_observation",
          occurred_at: "2026-08-28T12:00:02.000Z",
          raw_safe_evidence: safeObservation,
          source_authority: "tool_observation",
          speaker_scope: "tool",
          tool_name: "http.request",
          tool_outcome: "failure"
        })
      ].join("\n")
    };
    const createRun = repository.createRun;
    repository.createRun = async (input) => {
      const materialized = input.memoryMaterializer?.(personalContext);
      if (!materialized) throw new Error("tool_observation_materialization_failed");
      const created = await createRun({
        ...input,
        normalizedRequest: materialized.normalizedRequest,
        providerRequestPreview: { ...materialized.providerRequestPreview }
      });
      return { ...created, materializedRequest: materialized };
    };
    const captured: { request: ProviderRunRequest | null } = { request: null };
    const POST = createSendMessageHandler({
      ...authDeps,
      providers: {
        fake: captureProviderRequest(createFakeProviderAdapter(), (request) => {
          captured.request = request;
        })
      },
      repository
    });

    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "fake-qsa",
          provider: "fake",
          text: "What happened when we called the limits endpoint?"
        }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(captured.request?.personalContext).toEqual(personalContext);
    expect(captured.request?.personalContext?.text).toContain(
      '"source_authority":"tool_observation"'
    );
    expect(captured.request?.personalContext?.text).toContain(
      '"speaker_scope":"tool"'
    );
    expect(captured.request?.personalContext?.text).toContain(safeObservation);
    expect(JSON.stringify(captured.request)).not.toContain(secretCanary);
    expect(state.created?.normalizedRequest.personalContext).toEqual(personalContext);
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
          searchPlan: { mode: "all_selected", optionIds: [] }
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

  it("serializes an owner-private run outcome from an explicit recursive allowlist", async () => {
    const privateKnowledgeValues = [
      "forbidden-read-receipt-sentinel",
      "forbidden-source-artifact-id-sentinel",
      "forbidden-source-id-sentinel",
      "forbidden-source-version-id-sentinel",
      "forbidden-source-locator-sentinel",
      "forbidden-secondary-base-id-sentinel"
    ];
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

    const getRunOutcomeForUser = repository.getRunOutcomeForUser;
    repository.getRunOutcomeForUser = async (runId, userId) => {
      const outcome = await getRunOutcomeForUser(runId, userId);
      return outcome
        ? Object.assign(outcome, {
            chatId: "forbidden-chat-sentinel",
            events: [{ payload: { secret: "forbidden-event-sentinel" } }],
            finalProviderResponsePreview: {
              text: "forbidden-response-preview-sentinel"
            },
            inspection: { acceptedAt: "forbidden-inspection-sentinel" },
            knowledgeRuns: [{
              query: "forbidden-knowledge-query-sentinel",
              readReceipt: {
                locator: "forbidden-source-locator-sentinel",
                receipt: "forbidden-read-receipt-sentinel",
                resolvedSource: {
                  sourceArtifactId: "forbidden-source-artifact-id-sentinel",
                  sourceId: "forbidden-source-id-sentinel",
                  sourceVersionId: "forbidden-source-version-id-sentinel"
                }
              },
              results: [{
                provenance: [{
                  source: {
                    artifactId: "forbidden-source-artifact-id-sentinel",
                    bindings: [
                      { baseName: "Primary", bindingOrdinal: 0, knowledgeBaseId: "primary-base" },
                      {
                        baseName: "Mirror",
                        bindingOrdinal: 1,
                        knowledgeBaseId: "forbidden-secondary-base-id-sentinel"
                      }
                    ],
                    primaryBindingOrdinal: 0,
                    sourceId: "forbidden-source-id-sentinel",
                    sourceVersionId: "forbidden-source-version-id-sentinel"
                  }
                }],
                sourceArtifactId: "forbidden-source-artifact-id-sentinel",
                sourceId: "forbidden-source-id-sentinel",
                sourceVersionId: "forbidden-source-version-id-sentinel"
              }]
            }],
            memoryReceipt: { includedText: "forbidden-memory-sentinel" },
            normalizedRequest: {
              content: "forbidden-normalized-request-sentinel"
            },
            providerRequestPreview: {
              prompt: "forbidden-provider-request-sentinel"
            },
            providerResponseId: "forbidden-provider-response-id-sentinel",
            searchRuns: [{ query: "forbidden-search-query-sentinel" }],
            toolCalls: [{ arguments: "forbidden-tool-arguments-sentinel" }],
            totalTokens: 123
          })
        : null;
    };

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
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const body = await response.json();
    expect(body).toEqual({
      run: {
        id: "run-1",
        status: "complete"
      },
      version: 1
    });
    for (const privateValue of privateKnowledgeValues) {
      expect(JSON.stringify(body)).not.toContain(privateValue);
    }
  });

  it("scopes model-run reads to the authenticated user and maps a missing run to 404", async () => {
    const { repository } = createMemoryRepository();
    const getRunOutcomeForUser = vi.fn<RunRepository["getRunOutcomeForUser"]>(async () => null);
    repository.getRunOutcomeForUser = getRunOutcomeForUser;
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

    expect(getRunOutcomeForUser).toHaveBeenCalledWith("missing-run", config.bootstrapUserId);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      error: "model_run_not_found"
    });
  });

  it("uses the handler's effective attachment limits during stale GET-assisted recovery", async () => {
    const { repository, state } = createMemoryRepository();
    const created = openAiCreatedRun();
    const normalizedRequest = {
      ...created.normalizedRequest,
      attachmentIds: ["one", "two"],
      content: {
        blocks: [
          { attachmentId: "one", type: "image" },
          { attachmentId: "two", type: "image" }
        ]
      }
    };
    state.created = { ...created, normalizedRequest };
    state.staleActiveRuns = [staleRunRecord({
      assistantMessageId: "assistant-message-1",
      chatId: "chat-1",
      id: "run-1",
      modelId: created.modelId,
      provider: created.provider
    })];
    const checkpoint = toolLoopCheckpoint({
      phase: "tools_pending",
      providerContinuation: {},
      roundIndex: 1
    });
    if (!checkpoint) throw new Error("invalid_test_checkpoint");
    repository.loadCheckpointedToolLoopRun = async () => ({
      assistantMessageId: "assistant-message-1",
      assistantText: "",
      calls: [],
      chatId: "chat-1",
      checkpoint,
      id: "run-1",
      modelId: created.modelId,
      normalizedRequest,
      provider: created.provider,
      providerResponseId: null,
      status: "streaming",
      userId: config.bootstrapUserId
    } satisfies CheckpointedToolLoopRun);
    const loadAttachments = vi.fn(repository.loadAttachments);
    repository.loadAttachments = loadAttachments;
    const GET = createGetModelRunHandler({
      ...authDeps,
      getAttachmentLimits: () => ({
        maxCount: 1,
        maxEncodedBytes: 100_663_296,
        maxMaterializedBytes: 67_108_864,
        readConcurrency: 2
      }),
      providers: {
        openai: createFakeProviderAdapter()
      },
      repository
    });

    const response = await GET(
      new Request("http://app.local/api/model-runs/run-1", {
        headers: { cookie: authCookie() }
      }),
      { params: { runId: "run-1" } }
    );

    expect(response.status).toBe(200);
    expect(loadAttachments).not.toHaveBeenCalled();
    expect(state.failed?.error).toMatchObject({
      code: "attachment_count_limit_exceeded",
      message: "This run contains 2 attachments; the limit is 1."
    });
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

            temperature: "0.6"
          },
          modelId: "fake-qsa",
          params: {
            maxOutputTokens: 4096,
            temperature: 0.6
          },
          provider: "fake",
          searchPlan: { mode: "all_selected", optionIds: [] }
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
      provider: "fake",
      searchPlan: {
        mode: "all_selected",
        optionIds: []
      },
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
          searchPlan: { mode: "all_selected", optionIds: [] }
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
      preSendAssistantMessageId: null,
      provider: "fake",
      userMessageId: "user-message-1"
    });
    expect(state.completed?.finalText).toContain("Fake answer: Original question");
  });

  it("rejects an unavailable assistant selection before creating a regeneration run", async () => {
    const { repository, state } = createMemoryRepository();
    const provider: ProviderAdapter = {
      buildRequestPreview: vi.fn(() => ({
        provider: "fake"
      })),
      async *stream() {
        throw new Error("provider should not be called");
      }
    };
    const resolveForRun = vi.fn(async () => ({
      code: "assistant_not_available" as const,
      ok: false as const,
      status: 404 as const
    }));
    const POST = createRegenerateModelRunHandler({
      ...authDeps,
      assistants: { resolveForRun },
      providers: {
        fake: provider
      },
      repository
    });
    const response = await POST(
      new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify({
          assistantId: "foreign-assistant"
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

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "assistant_not_available"
    });
    expect(resolveForRun).toHaveBeenCalledWith(config.bootstrapUserId, "foreign-assistant");
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

            temperature: "0.2"
          },
          modelId: "fake-qsa",
          provider: "fake",
          searchPlan: { mode: "all_selected", optionIds: [] }
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
          searchPlan: { mode: "all_selected", optionIds: [] }
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
          searchPlan: { mode: "all_selected", optionIds: [] }
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
          searchPlan: { mode: "all_selected", optionIds: [] }
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

  it("keeps a fresh active provider run read-only even when a response id exists", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    state.created = openAiCreatedRun();
    state.providerResponseId = "resp-fresh-1";
    const refresh = vi.fn();
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
              usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
            };
          }
        }
      },
      repository
    });

    const response = await GET(
      new Request("http://app.local/api/model-runs/run-1", {
        headers: { cookie: authCookie() }
      }),
      { params: { runId: "run-1" } }
    );

    expect(response.status).toBe(200);
    expect(refresh).not.toHaveBeenCalled();
    expect(state.completed).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      run: { id: "run-1", status: "streaming" }
    });
  });

  it("refreshes and finalizes a stale provider run when a provider response id exists", async () => {
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
        controlDefaults: {},
        modelId: "gpt-5.5",
        provider: "openai",
        searchPlan: { mode: "all_selected", optionIds: [] },
        userId: config.bootstrapUserId
      },
      modelId: "gpt-5.5",
      normalizedRequest: {
        attachmentIds: [],
        chatId: "chat-1",
        content: { blocks: [] },
        knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
        toolMode: "auto",
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
          system: null
        },
        provider: "openai",
        searchPlan: { mode: "all_selected", options: [] }
      },
      provider: "openai",
      providerRequestPreview: {},
      userId: config.bootstrapUserId
    };
    state.providerResponseId = "resp-refresh-1";
    state.staleActiveRuns = [staleRunRecord({
      assistantMessageId: "assistant-message-1",
      chatId: "chat-1",
      id: "run-1",
      modelId: "gpt-5.5",
      provider: "openai",
      providerResponseId: state.providerResponseId
    })];

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
    expect(state.events).toEqual([]);
    await expect(response.json()).resolves.toEqual({
      run: {
        id: "run-1",
        status: "complete"
      },
      version: 1
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
    state.staleActiveRuns = [staleRunRecord({
      assistantMessageId: "assistant-message-1",
      chatId: "chat-1",
      id: "run-1",
      providerResponseId: state.providerResponseId
    })];
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
    state.staleActiveRuns = [staleRunRecord({
      assistantMessageId: "assistant-message-1",
      chatId: "chat-1",
      id: "run-1",
      modelId: "gpt-5.5",
      provider: "openai",
      providerResponseId: state.providerResponseId
    })];
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

  it("completes a refreshed run without relying on chronological event appends", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    });
    state.created = openAiCreatedRun();
    state.providerResponseId = "resp-refresh-append-race";
    state.staleActiveRuns = [staleRunRecord({
      assistantMessageId: "assistant-message-1",
      chatId: "chat-1",
      id: "run-1",
      modelId: "gpt-5.5",
      provider: "openai",
      providerResponseId: state.providerResponseId
    })];
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
        controlDefaults: {},
        modelId: "gpt-5.5",
        provider: "openai",
        searchPlan: { mode: "all_selected", optionIds: [] },
        userId: config.bootstrapUserId
      },
      modelId: "gpt-5.5",
      normalizedRequest: {
        attachmentIds: [],
        chatId: "chat-1",
        content: { blocks: [] },
        knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
        toolMode: "auto",
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
          system: null
        },
        provider: "openai",
        searchPlan: { mode: "all_selected", options: [] }
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
    state.staleActiveRuns = [staleRunRecord({
      assistantMessageId: "assistant-message-1",
      chatId: "chat-1",
      id: "run-1",
      modelId: "gpt-5.5",
      provider: "openai",
      providerResponseId: state.providerResponseId,
      status: "error"
    })];

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
    expect(state.events).toEqual([]);
    await expect(response.json()).resolves.toEqual({
      run: {
        id: "run-1",
        status: "complete"
      },
      version: 1
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
    state.staleActiveRuns = [staleRunRecord({
      assistantMessageId: "assistant-message-1",
      chatId: "chat-1",
      id: "run-1",
      modelId: "gpt-5.5",
      provider: "openai",
      providerResponseId: state.providerResponseId,
      status: "error"
    })];
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
    expect(state.events).toEqual([]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        run: {
          id: "run-1",
          status: "error"
        },
        version: 1
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

            temperature: "0.2"
          },
          modelId: "fake-qsa",
          provider: "fake",
          text: "Rejected send defaults",
          searchPlan: { mode: "all_selected", optionIds: [] }
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
        chatId: "chat-1",
        status: "preparing"
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
    expect(state.events).toEqual([]);
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
    expect(state.events).toEqual([]);
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
    expect(state.events).toEqual([]);
  });

  it("cancels active runs without provider-native cancellation or a provider response id", async () => {
    const { repository, state } = createMemoryRepository();
    state.created = {
      chatId: "chat-1",
      content: { blocks: [] },
      expectedActiveLeafId: null,
      defaults: {
        controlDefaults: {},
        modelId: "fake-qsa",
        provider: "fake",
        searchPlan: { mode: "all_selected", optionIds: [] },
        userId: config.bootstrapUserId
      },
      modelId: "fake-qsa",
      normalizedRequest: {
        attachmentIds: [],
        chatId: "chat-1",
        content: { blocks: [] },
        knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
        toolMode: "auto",
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
          system: null
        },
        provider: "fake",
        searchPlan: { mode: "all_selected", options: [] }
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
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      run: {
        id: "run-1",
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
    expect(state.events).toEqual([]);
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
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(responseBody).toEqual({
      run: {
        id: "run-1",
        status: "cancelled"
      }
    });
    expect(JSON.stringify(responseBody)).not.toContain("secret raw cancel response");
    expect(JSON.stringify(responseBody)).not.toContain("provider_cancel_succeeded");
    expect(JSON.stringify(responseBody)).not.toContain("resp-1");
    expect(order).toEqual(["durable-cancel", "provider-cancel"]);
    expect(cancelledIds).toEqual(["resp-1"]);
    expect(state.cancelled).toMatchObject({
      code: "model_run_cancelled"
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
    } finally {
      activeRunControllersForTest().delete("run-1");
    }
  });

  it("does not persist or expose a provider-cancel failure after durable cancellation wins", async () => {
    const { repository, state } = createMemoryRepository();
    state.providerResponseId = "provider-response-1";
    const providerCancel = vi.fn(async () => {
      throw new Error("secret provider response body");
    });
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

    const response = await POST(
      new Request("http://app.local/api/model-runs/run-1/cancel", {
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { runId: "run-1" } }
    );

    expect(response.status).toBe(200);
    expect(providerCancel).toHaveBeenCalledWith("provider-response-1");
    const body = await response.json();
    expect(body).toEqual({ run: { id: "run-1", status: "cancelled" } });
    expect(JSON.stringify(body)).not.toContain("secret provider response body");
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
          mcp: { mode: "load_all" },
          provider: "openrouter",
          searchPlan: { mode: "all_selected", optionIds: [] },
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
        body: JSON.stringify({
          mcp: { mode: "load_all" },
          searchPlan: { mode: "all_selected", optionIds: [] }
        }),
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
        body: JSON.stringify({
          searchPlan: { mode: "all_selected", optionIds: [] },
          text: "Race"
        }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );
    const regenerateResponse = await regenerate(
      new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify({ searchPlan: { mode: "all_selected", optionIds: [] } }),
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

  it("maps send and regeneration Knowledge acceptance races to privacy-neutral conflicts", async () => {
    const memory = createMemoryRepository();
    const repository: RunRepository = {
      ...memory.repository,
      createRegenerationRun: async () => {
        throw new KnowledgeRunPlanConflictError();
      },
      createRun: async () => {
        throw new KnowledgeRunPlanConflictError();
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
        body: JSON.stringify({
          searchPlan: { mode: "all_selected", optionIds: [] },
          text: "Race"
        }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );
    const regenerateResponse = await regenerate(
      new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify({ searchPlan: { mode: "all_selected", optionIds: [] } }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { messageId: "assistant-message-1" } }
    );

    expect(sendResponse.status).toBe(409);
    await expect(sendResponse.json()).resolves.toEqual({
      error: "knowledge_base_not_available"
    });
    expect(regenerateResponse.status).toBe(409);
    await expect(regenerateResponse.json()).resolves.toEqual({
      error: "knowledge_base_not_available"
    });
  });
});
