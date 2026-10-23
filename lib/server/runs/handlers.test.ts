import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma, type PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { getAuthConfig } from "../auth/config";
import type { ResolvedEntitlements } from "../auth/entitlements";
import { createTestAuth } from "@/tests/support/auth";
import { assistantRowContextLoader } from "@/tests/support/assistantRuns";
import { assistantRowsFromLegacyFields, type AssistantRows } from "../../contracts/assistants";
import type { AssistantRunResolution } from "../assistants/runMaterialization";
import {
  ProviderAdmissionError,
  type ProviderAdmissionPlan
} from "../providerRuntime/admission";
import { createFakeProviderAdapter } from "../providers/fakeProvider";
import { NEUTRAL_FAMILY_PROMPT } from "../engine/prompts/neutral";
import { nativeEngineFake } from "@/tests/support/nativeEngine";
import { ProviderStreamTooLargeError } from "../providers/streamSafety";
import type {
  ProviderAdapter,
  ProviderConversationMessage,
  ProviderModelCapabilities,
  ProviderRunRequest,
  ProviderRunRefreshResult
} from "../providers/types";
import { PERSONAL_CONTEXT_HEADING } from "../providers/personalContext";
import { activeRunControllerRegistry } from "./activeRunControllerRegistry";
import { runWithContext } from "../observability";
import { createPrismaRunRepository } from "./prismaRepository";
import { activeRunControllersForTest } from "@/tests/support/runExecution";
import {
  createCancelModelRunHandler,
  createGetModelRunHandler as createProductionGetModelRunHandler,
  createRegenerateModelRunHandler as createProductionRegenerateModelRunHandler,
  createSendMessageHandler as createProductionSendMessageHandler,
  type RunHandlerDeps
} from "./handlers";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AnswerReviewStepConflictError,
  AssistantRunConflictError,
  AttachmentLinkConflictError,
  KnowledgeRunPlanConflictError,
  McpRunPlanConflictError,
  type DurableRunControlRecord,
  type ProjectRunAdmission,
  type RunRepository
} from "./runRepositoryContract";
import type { UsageLimitStatus } from "../usageLimits/repository";
import { decodeUsageLimitRefusal, type UsageLimitRefusalCode } from "../../contracts/usageLimits";

// Project sends stay tested as they worked; "while Projects are disabled" turns them off.
const areas = vi.hoisted(() => ({ projects: true }));
vi.mock("../../domain/disabledAreas", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../domain/disabledAreas")>(),
  get PROJECTS_ENABLED() {
    return areas.projects;
  }
}));

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

function handlerAssistant(rows: Partial<AssistantRows> = {}): AssistantRunResolution {
  const fields = {
    knowledgeSelection: { baseIds: [], mode: "none" as const, sourceIds: [], version: 1 as const },
    mcpServerIds: [],
    providerModelId: "fake-qsa",
    runControls: {},
    searchPlan: { mode: "all_selected" as const, optionIds: [] },
    skillIds: []
  };
  return {
    assistant: {
      ...fields,
      assistantId: "assistant-1",
      definitionVersion: 1,
      identity: { avatar: { accents: [], backgroundShape: "circle", foregroundShape: "ring", kind: "generated",
        paletteId: "ember", recipeVersion: 1, rotations: [0, 0] }, name: "Reviewer" },
      name: "Reviewer",
      provider: "fake",
      rows: { ...assistantRowsFromLegacyFields(fields), ...rows },
      systemPrompt: "Review carefully."
    },
    ok: true
  };
}

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
    /** The answers the agent engine published for runs of this repository. */
    published: string[];
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

/** An installation without any usage limit, as every admission reads it before limits are set. */
const NO_USAGE_LIMITS: UsageLimitStatus = {
  effective: {
    exempt: false,
    messagesPerDay: { source: null, value: null },
    messagesPerHour: { source: null, value: null },
    monthlyBudgetMicros: { source: null, value: null }
  },
  installationCapMicros: null,
  installationSpentMicros: 0,
  lastDay: { count: 0, freesAt: null },
  lastHour: { count: 0, freesAt: null },
  userSpentMicros: 0
};

/** Handler deps of a test; usage limits default to none. */
type TestRunHandlerDeps = Omit<RunHandlerDeps, "nativeEngine" | "usageLimits"> &
  Partial<Pick<RunHandlerDeps, "nativeEngine" | "usageLimits">>;

function withTestRuntime(deps: TestRunHandlerDeps): RunHandlerDeps {
  const harness = repositoryHarnesses.get(deps.repository);
  return {
    ...deps,
    nativeEngine: deps.nativeEngine ?? nativeEngineFake({ ...(harness ? { published: harness.published } : {}) }).deps,
    usageLimits: deps.usageLimits ?? { loadUsageLimitStatus: async () => NO_USAGE_LIMITS },
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

function createSendMessageHandler(deps: TestRunHandlerDeps) {
  const handler = createProductionSendMessageHandler(withTestRuntime(deps));
  return async (...args: Parameters<typeof handler>) =>
    handler(await withCurrentSearchPlan(args[0]), args[1]);
}

function createRegenerateModelRunHandler(deps: TestRunHandlerDeps) {
  const handler = createProductionRegenerateModelRunHandler(withTestRuntime(deps));
  return async (...args: Parameters<typeof handler>) =>
    handler(await withCurrentSearchPlan(args[0]), args[1]);
}

function createGetModelRunHandler(deps: TestRunHandlerDeps) {
  return createProductionGetModelRunHandler(withTestRuntime(deps));
}

function authCookie() {
  return auth.cookie;
}

function parseSse(body: string): { data: unknown; type: string }[] {
  return body
    .trim()
    .split("\n\n")
    .filter((chunk) => chunk && !chunk.startsWith(":"))
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
  modelPricing: { inputTokenPriceUsdPerMillion: number | null; outputTokenPriceUsdPerMillion: number | null } | null = {
    inputTokenPriceUsdPerMillion: 2,
    outputTokenPriceUsdPerMillion: 8
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
    assistantTextWrites: number;
    cancelled: Parameters<RunRepository["cancelRun"]>[0]["payload"] | null;
    /** A completed answer a test plants; the agent engine fake completes nothing here. */
    completed: Readonly<{ finalText: string; modelId: string; provider: string; runId: string }> | null;
    created: Parameters<RunRepository["createRun"]>[0] | null;
    events: { event: ModelRunSseEvent; sequence: number }[];
    failed: { error: { code: string; message: string }; runId: string } | null;
    providerResponseId: string | null;
    published: string[];
    recoverySettled: boolean;
    recentActiveRun: (ReturnType<typeof activeRunRecord> & { updatedAt: Date }) | null;
    regenerated: Parameters<RunRepository["createRegenerationRun"]>[0] | null;
    searchRuns: Parameters<RunRepository["createSearchRun"]>[0][];
  } = {
    assistantText: "",
    assistantTextWrites: 0,
    cancelled: null,
    completed: null,
    created: null,
    events: [],
    failed: null,
    providerResponseId: null,
    published: [],
    recoverySettled: false,
    recentActiveRun: null,
    regenerated: null,
    searchRuns: []
  };
  const repository: RunRepository = {
    admitPreparingRun: async () => {
      throw new Error("preparing_run_not_supported_by_handler_harness");
    },
    appendAssistantText: async (_assistantMessageId, text) => {
      state.assistantText = text;
      state.assistantTextWrites += 1;
    },
    appendRunOutputEvent: async (_runId, event) => {
      const sequence = state.events.reduce((max, entry) => Math.max(max, entry.sequence), -1) + 1;
      state.events.push({ event, sequence });
      return event;
    },
    beginPreparingRunAttempt: async () => false,
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
              id: "user-message-1",
              scheduledTaskPrompt: false
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
    loadWorkspaceFileFacts: async () => ({ hasFiles: false, hasEarlierExports: false }),
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
    loadProviderModelCostBasis: async () => null,
    markRunAnswerStarted: async () => undefined,
    retryPreparingRunAttempt: async () => null,
    settlePreparingRunFailure: async () => false,
  };

  repositoryHarnesses.set(repository, { entitlements, modelCapabilities, published: state.published });

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
        toolCalling: true,
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

  it.each(["send", "regenerate"] as const)("reauthorizes the request owner and source during optional catalog relevance for %s", async kind => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [], null, {
      toolCalling: true, contextWindow: 32_768, nativePdfInput: false, nativeSearch: false,
      pdf: true, reasoning: true, streaming: true, vision: true
    });
    const resolveAuth = vi.fn(auth.resolveAuth);
    let admissionKey = "";
    let query = "";
    let authorizationError: unknown;
    const skillCatalogRelevance: NonNullable<RunHandlerDeps["skillCatalogRelevance"]> = async input => {
      query = input.query;
      admissionKey = input.operationKey;
      try { await input.authorize(); } catch (error) { authorizationError = error; throw error; }
      resolveAuth.mockResolvedValueOnce(null);
      await input.authorize();
      return [];
    };
    const skills = { resolveForRun: vi.fn(async () => ({ ok: true as const, skills: [] })),
      listEnabledForRun: vi.fn(async () => [{ skillId: "a", revisionId: "r", name: "A", description: "Procedure A" }]) };
    const deps = { ...authDeps, resolveAuth, repository, providers: { fake: createFakeProviderAdapter() }, skills, skillCatalogRelevance };
    const request = new Request("http://app.local/api/model-runs/relevance", {
      method: "POST", headers: { cookie: authCookie() },
      body: JSON.stringify({ text: "New question", expectedActiveLeafId: null, admissionId: "relevance-request" })
    });
    const response = kind === "send"
      ? await createSendMessageHandler(deps)(request, { params: { chatId: "chat-1" } })
      : await createRegenerateModelRunHandler(deps)(request, { params: { messageId: "assistant-message-1" } });
    expect(authorizationError).toBeUndefined();
    expect(query).toBe(kind === "send" ? "New question" : "Original question");
    expect(admissionKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "skill_not_available" });
    expect(admissionKey).not.toBe("");
    expect(state.created).toBeNull(); expect(state.regenerated).toBeNull();
  });

  it.each(["send", "regenerate"] as const)("rejects malformed artifact edit intent before %s admission", async (kind) => {
    const { repository, state } = createMemoryRepository();
    const deps = { ...authDeps, repository, providers: { fake: createFakeProviderAdapter() } };
    const request = new Request("http://app.local/api/model-runs/artifact-edit", {
      method: "POST", headers: { cookie: authCookie() }, body: JSON.stringify({
        text: "Change the title", artifactEdit: { artifactId: "artifact", versionId: "version\n" }, retryPdfPreparation: true
      })
    });
    const response = kind === "send"
      ? await createSendMessageHandler(deps)(request, { params: { chatId: "chat-1" } })
      : await createRegenerateModelRunHandler(deps)(request, { params: { messageId: "assistant-1" } });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "artifact_edit_invalid" });
    expect(state.created).toBeNull();
    expect(state.regenerated).toBeNull();
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

  describe("while Projects are disabled", () => {
    beforeEach(() => {
      areas.projects = false;
      return () => {
        areas.projects = true;
      };
    });

    function projectSend(chatId: string, body: Record<string, unknown>, repository: RunRepository) {
      return createSendMessageHandler({
        ...authDeps,
        providers: { fake: createFakeProviderAdapter() },
        repository
      })(new Request(`http://app.local/api/chats/${chatId}/messages`, {
        body: JSON.stringify({ modelId: "fake-qsa", provider: "fake", text: "Shared question", ...body }),
        headers: { cookie: authCookie() },
        method: "POST"
      }), { params: { chatId } });
    }

    it("refuses a first Project send before loading the Project", async () => {
      const chatId = "30000000-0000-4000-8000-000000000003";
      const { repository, state } = createMemoryRepository();
      repository.findOwnedChat = async () => null;
      const loadProjectFirstSend = vi.fn();
      repository.loadProjectFirstSend = loadProjectFirstSend;

      const response = await projectSend(chatId, {
        expectedActiveLeafId: null,
        projectDraft: { folderId: null, projectId: "10000000-0000-4000-8000-000000000001" }
      }, repository);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "projects_disabled" });
      expect(loadProjectFirstSend).not.toHaveBeenCalled();
      expect(state.created).toBeNull();
    });

    it("refuses a message in an existing Project chat the caller can open", async () => {
      const projectId = "10000000-0000-4000-8000-000000000001";
      const { repository, state } = createMemoryRepository();
      repository.findOwnedChat = async (chatId, userId) =>
        userId === config.bootstrapUserId
          ? {
              activeLeafMessageId: "assistant-message-1",
              defaultModelId: "fake-qsa",
              defaultProvider: "fake",
              id: chatId,
              messageCount: 2,
              project: projectRunAdmission(projectId),
              projectFolderId: null,
              projectMemory: null,
              title: "Shared chat"
            }
          : null;

      const response = await projectSend("chat-project", { expectedActiveLeafId: "assistant-message-1" }, repository);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "projects_disabled" });
      expect(state.created).toBeNull();
    });

    it("refuses regenerating, editing or retrying in a Project chat", async () => {
      const { repository, state } = createMemoryRepository();
      const findSource = repository.findRegenerationSource;
      repository.findRegenerationSource = async (...args) => {
        const source = await findSource(...args);
        return source
          ? { ...source, chat: { ...source.chat, project: projectRunAdmission("10000000-0000-4000-8000-000000000001") } }
          : null;
      };

      const response = await createRegenerateModelRunHandler({
        ...authDeps,
        providers: { fake: createFakeProviderAdapter() },
        repository
      })(new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify({}),
        headers: { cookie: authCookie(), "content-type": "application/json" },
        method: "POST"
      }), { params: { messageId: "assistant-message-1" } });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "projects_disabled" });
      expect(state.regenerated).toBeNull();
    });
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

  it("returns an actionable PDF configuration error from a separately loaded resolver", async () => {
    const { repository, state } = createMemoryRepository();
    const adapter = createFakeProviderAdapter();
    const stream = vi.spyOn(adapter, "stream");
    const kick = vi.fn();
    const POST = createSendMessageHandler({ ...authDeps, repository, providers: { fake: adapter },
      chatPdf: { kick, findAdmission: async () => null, resolve: async () => {
        // The process-wide coordinator and Next route bundle may load separate
        // copies of the class. Its owned name and code remain the same.
        throw Object.assign(new Error("pdf_processing_configuration_incomplete"), {
          name: "ChatPdfPolicyUnavailableError", code: "pdf_processing_configuration_incomplete"
        });
      } }
    });
    const response = await POST(new Request("http://app.local/api/chats/chat-1/messages", {
      method: "POST", headers: { cookie: authCookie() }, body: JSON.stringify({
        provider: "fake", modelId: "fake-qsa", searchPlan: { mode: "all_selected", optionIds: [] },
        content: { blocks: [{ attachmentId: "pdf-1", type: "file" }] }
      })
    }), { params: { chatId: "chat-1" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "pdf_processing_configuration_incomplete" });
    expect(state.created).toBeNull();
    expect(stream).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

  it("returns the same committed PDF run on duplicate admission without starting the answer", async () => {
    const { repository, state } = createMemoryRepository();
    const bytes = Buffer.from("%PDF-settled-original");
    repository.loadAttachments = async () => [{ byteSize: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"), extractedText: null,
      fileName: "report.pdf", id: "pdf-1", kind: "pdf", metadata: { pdfPageCount: 21 }, mimeType: "application/pdf",
      processingErrorCode: null, status: "ready", storageKey: "private/original" }];
    const createRun = repository.createRun;
    repository.createRun = vi.fn<typeof repository.createRun>(async (input) => ({
      ...await createRun(input), deferredPdf: true
    }));
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
    repository.createRegenerationRun = vi.fn<typeof repository.createRegenerationRun>(async () => ({ assistantMessageId: "retry-assistant", runId: "run-1",
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

    const artifactEdit = { artifactId: "artifact-one", versionId: "version-one" };
    const validateEditTarget = vi.fn(async () => ({ ok: false as const, code: "artifact_version_conflict" as const }));
    const artifactRetry = createRegenerateModelRunHandler({ ...authDeps, repository, providers: { fake: adapter },
      artifacts: { validateEditTarget } as unknown as NonNullable<RunHandlerDeps["artifacts"]>,
      chatPdf: { kick, findAdmission: async () => null, resolve: resolveCurrentRoute,
        loadRetry: async () => ({ adapter, prepared: { ...saved.prepared, defaults: null, sourceKind: "regenerate",
          normalizedRequest: { ...saved.prepared.normalizedRequest, artifactTool: true, artifactReferences: [artifactEdit], artifactEdit } } }) } });
    const admissionsBeforeArtifactRetry = vi.mocked(repository.createRegenerationRun).mock.calls.length;
    const staleArtifactRetry = await artifactRetry(new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
      method: "POST", headers: { cookie: authCookie() }, body: JSON.stringify({ retryPdfPreparation: true })
    }), { params: { messageId: "assistant-message-1" } });
    expect(staleArtifactRetry.status).toBe(409);
    await expect(staleArtifactRetry.json()).resolves.toEqual({ error: "artifact_version_conflict" });
    expect(validateEditTarget).toHaveBeenCalledWith({ ...artifactEdit, chatId: "chat-1", ownerUserId: config.bootstrapUserId });
    expect(repository.createRegenerationRun).toHaveBeenCalledTimes(admissionsBeforeArtifactRetry);

    // A frozen snapshot of a since-deleted Assistant fails provenance at
    // admission and reports the neutral unavailability, never an internal error.
    const frozenAssistant: NonNullable<import("./runPreparation").MaterializedPreparedRunData["assistant"]> = {
      assistantId: "deleted-assistant", definitionVersion: 4,
      identity: { avatar: { accents: [], backgroundShape: "circle", foregroundShape: "ring", kind: "generated",
        paletteId: "ember", recipeVersion: 1, rotations: [0, 0] }, name: "Deleted" } };
    repository.createRegenerationRun = vi.fn<typeof repository.createRegenerationRun>(async () => {
      throw new AssistantRunConflictError();
    });
    const deletedRetry = createRegenerateModelRunHandler({ ...authDeps, repository, providers: { fake: adapter },
      chatPdf: { kick, findAdmission: async () => null, resolve: resolveCurrentRoute,
        loadRetry: async () => ({ adapter, prepared: { ...saved.prepared, assistant: frozenAssistant,
          chatAssistant: { assistantId: "deleted-assistant", bind: true, overridesPatch: { search: { mode: "off" } } },
          defaults: null, sourceKind: "regenerate" } }) } });
    const deleted = await deletedRetry(new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
      method: "POST", headers: { cookie: authCookie() }, body: JSON.stringify({ retryPdfPreparation: true })
    }), { params: { messageId: "assistant-message-1" } });
    expect(deleted.status).toBe(409);
    await expect(deleted.json()).resolves.toEqual({ error: "assistant_not_available" });
    expect(repository.createRegenerationRun).toHaveBeenCalledWith(expect.objectContaining({
      assistant: expect.objectContaining({ assistantId: "deleted-assistant", definitionVersion: 4 }),
      // The retry rechecks the binding but never replays the frozen override change.
      chatAssistant: { assistantId: "deleted-assistant", bind: false, overridesPatch: {} }
    }));
    expect(stream).not.toHaveBeenCalled();
  });

  it("accepts one follow-up after answer publication and acknowledges the same durable message on retry", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [{
      id: "previous-answer", role: "assistant", content: { blocks: [{ type: "text", text: "File saved." }] }
    }]);
    repository.findRecentActiveRunForChat = async () => ({ ...activeRunRecord({
      id: "previous-run", chatId: "chat-1", assistantMessageId: "previous-answer"
    }), answerComplete: true });
    const create = repository.createRun;
    repository.createRun = vi.fn(async (input) => ({ ...await create(input), deferredWorkspace: true as const }));
    repository.getRunOutcomeForUser = async () => ({ id: "run-1", status: "queued", workspacePreparation: true });
    const adapter = createFakeProviderAdapter();
    const stream = vi.spyOn(adapter, "stream");
    const kick = vi.fn();
    const POST = createSendMessageHandler({ ...authDeps, repository, providers: { fake: adapter }, workspaceFollowup: {
      kick, findAdmission: async (key) => state.created?.workspaceFollowup?.admissionKey === key ? {
        version: 1, assistantMessageId: "assistant-message-1", userMessageId: "user-message-1",
        run: { id: "run-1", status: "queued", workspacePreparation: true }
      } : null
    } });
    const request = () => new Request("http://app.local/api/chats/chat-1/messages", {
      method: "POST", headers: { cookie: authCookie() }, body: JSON.stringify({ admissionId: "next-invocation",
        expectedActiveLeafId: "previous-answer", provider: "fake", modelId: "fake-qsa", text: "Update that file." })
    });
    const first = await POST(request(), { params: { chatId: "chat-1" } });
    expect(first.status).toBe(202);
    const accepted = await first.json();
    expect(accepted).toEqual({ version: 1, assistantMessageId: "assistant-message-1", userMessageId: "user-message-1",
      run: { id: "run-1", status: "queued", workspacePreparation: true } });
    const retry = await POST(request(), { params: { chatId: "chat-1" } });
    expect(await retry.json()).toEqual(accepted);
    expect(repository.createRun).toHaveBeenCalledOnce();
    expect(state.created?.workspaceFollowup).toMatchObject({ predecessorRunId: "previous-run", snapshot: { version: 1 } });
    expect(state.created?.expectedActiveLeafId).toBe("previous-answer");
    expect(stream).not.toHaveBeenCalled();
    expect(kick).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(accepted)).not.toMatch(/snapshot|predecessor|admissionKey/);
  });

  it.each(["generating", "waiting"] as const)("rejects a follow-up while the current run is %s", async (phase) => {
    const { repository, state } = createMemoryRepository();
    repository.findRecentActiveRunForChat = async () => ({ ...activeRunRecord({ chatId: "chat-1",
      status: phase === "waiting" ? "preparing" : "streaming" }), ...(phase === "waiting" ? { workspaceWaitPending: true } : {}) });
    const adapter = createFakeProviderAdapter();
    const stream = vi.spyOn(adapter, "stream");
    const kick = vi.fn();
    const response = await createSendMessageHandler({ ...authDeps, repository, providers: { fake: adapter },
      workspaceFollowup: { kick, findAdmission: async () => null } })(new Request("http://app.local/api/chats/chat-1/messages", {
      method: "POST", headers: { cookie: authCookie() }, body: JSON.stringify({ provider: "fake", modelId: "fake-qsa", text: "Next" })
    }), { params: { chatId: "chat-1" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "active_run_in_progress" });
    expect(state.created).toBeNull();
    expect(stream).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
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
      { inputTokenPriceUsdPerMillion: 2, outputTokenPriceUsdPerMillion: 8 },
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
        inputTokenPriceUsdPerMillion: 2,
        outputTokenPriceUsdPerMillion: 8
      },
      {
        nativePdfInput: false,
        nativeSearch: true,
        pdf: false,
        reasoning: true,
        toolCalling: true,
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
        inputTokenPriceUsdPerMillion: 2,
        outputTokenPriceUsdPerMillion: 8
      },
      {
        nativePdfInput: true,
        nativeSearch: true,
        pdf: false,
        reasoning: true,
        toolCalling: true,
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

  it("writes the continuation turn after an MCP approval from the user's own Allow, never from the body", async () => {
    const { repository, state } = createMemoryRepository();
    const loadMcpApprovalContinuation = vi.fn(async (input: { approvalId: string }) => input.approvalId === "approval-1"
      ? { serverName: "Records", toolName: "delete_record" } : null);
    repository.loadMcpApprovalContinuation = loadMcpApprovalContinuation;
    const POST = createSendMessageHandler({ ...authDeps, providers: { fake: createFakeProviderAdapter() }, repository });
    const send = (systemTurn: unknown) => POST(new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({ modelId: "fake-qsa", provider: "fake", searchPlan: { mode: "all_selected", optionIds: [] },
        systemTurn, text: "Text the browser must not decide" }),
      headers: { cookie: authCookie() },
      method: "POST"
    }), { params: { chatId: "chat-1" } });

    for (const malformed of [{ approvalId: "approval-1", kind: "other" }, { approvalId: "a/b", kind: "mcp_approval_continuation" },
      { approvalId: "approval-1", extra: true, kind: "mcp_approval_continuation" }, "approval-1"]) {
      expect((await send(malformed)).status, JSON.stringify(malformed)).toBe(400);
    }
    const unavailable = await send({ approvalId: "approval-2", kind: "mcp_approval_continuation" });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual({ error: "mcp_approval_continuation_unavailable" });
    expect(state.created).toBeNull();

    const accepted = await send({ approvalId: "approval-1", kind: "mcp_approval_continuation" });
    expect(accepted.status).toBe(200);
    await accepted.text();
    expect(loadMcpApprovalContinuation).toHaveBeenLastCalledWith({ approvalId: "approval-1", chatId: "chat-1",
      userId: config.bootstrapUserId });
    expect(state.created).toMatchObject({ systemTurnKind: "mcp_approval_continuation",
      content: { blocks: [{ type: "text", text: "The user approved `delete_record` on `Records`. Continue the task." }] } });
  });

  it("admits an answer review step as the server's turn: it claims the step, counts no message window and takes no systemTurn", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [], null, {
      toolCalling: true, contextWindow: 32_768, nativePdfInput: false, nativeSearch: false,
      pdf: true, reasoning: true, streaming: true, vision: true
    });
    const answerReviewStep = {
      preparation: { kind: "review" as const, reviewer: 0, round: 1, sessionId: "session-1", step: 0 },
      turnKind: "answer_review_request" as const
    };
    // The user's own messages filled this hour's window; a step is the server's turn.
    const windowFull = (now: Date): UsageLimitStatus => ({
      ...NO_USAGE_LIMITS,
      effective: { ...NO_USAGE_LIMITS.effective, messagesPerHour: { source: { kind: "installation" }, value: 2 } },
      lastHour: { count: 2, freesAt: new Date(now.getTime() + 60_000) }
    });
    const usageLimits = { loadUsageLimitStatus: vi.fn(async (_userId: string, now: Date) => windowFull(now)) };
    const POST = createSendMessageHandler({ ...authDeps, answerReviewStep, providers: { fake: createFakeProviderAdapter() }, repository,
      usageLimits });
    const send = (extra: Record<string, unknown> = {}) => POST(new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({ content: { blocks: [{ text: "Review the answer.", type: "text" }] }, modelId: "fake-qsa", provider: "fake",
        searchPlan: { mode: "all_selected", optionIds: [] }, ...extra }),
      headers: { cookie: authCookie() },
      method: "POST"
    }), { params: { chatId: "chat-1" } });

    const withSystemTurn = await send({ systemTurn: { approvalId: "approval-1", kind: "mcp_approval_continuation" } });
    expect(withSystemTurn.status).toBe(400);
    expect(state.created).toBeNull();

    const accepted = await send();
    expect(accepted.status).toBe(200);
    await accepted.text();
    expect(state.created).toMatchObject({
      answerReviewStep: { round: 1, sessionId: "session-1", step: 0 },
      normalizedRequest: { answerReviewStep: { kind: "review", modelName: "fake-qsa", reviewer: 0, round: 1, version: 1 } },
      systemTurnKind: "answer_review_request"
    });
  });

  it("refuses an answer review step at a reached budget and when its step was already claimed", async () => {
    const answerReviewStep = {
      preparation: { kind: "review" as const, reviewer: 0, round: 1, sessionId: "session-1", step: 0 },
      turnKind: "answer_review_request" as const
    };
    const capabilities = { toolCalling: true, contextWindow: 32_768, nativePdfInput: false, nativeSearch: false,
      pdf: true, reasoning: true, streaming: true, vision: true };
    const request = () => new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({ content: { blocks: [{ text: "Review the answer.", type: "text" }] }, modelId: "fake-qsa", provider: "fake",
        searchPlan: { mode: "all_selected", optionIds: [] } }),
      headers: { cookie: authCookie() },
      method: "POST"
    });
    const budget = createMemoryRepository(entitledFakeModel, [], null, capabilities);
    const exhausted = await createSendMessageHandler({ ...authDeps, answerReviewStep, providers: { fake: createFakeProviderAdapter() },
      repository: budget.repository, usageLimits: { loadUsageLimitStatus: async () => ({
        ...NO_USAGE_LIMITS,
        effective: { ...NO_USAGE_LIMITS.effective, monthlyBudgetMicros: { source: { kind: "user" }, value: 5_000_000 } },
        userSpentMicros: 5_250_000
      }) } })(request(), { params: { chatId: "chat-1" } });
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toMatchObject({ error: "usage_budget_exhausted" });
    expect(budget.state.created).toBeNull();

    const claimed = createMemoryRepository(entitledFakeModel, [], null, capabilities);
    claimed.repository.createRun = async () => { throw new AnswerReviewStepConflictError("answer_review_step_unavailable"); };
    const conflict = await createSendMessageHandler({ ...authDeps, answerReviewStep, providers: { fake: createFakeProviderAdapter() },
      repository: claimed.repository })(request(), { params: { chatId: "chat-1" } });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "answer_review_step_unavailable" });
  });

  it("freezes a send's automatic review into its admission and refuses a reviewer the answer's own model", async () => {
    const { repository, state } = createMemoryRepository({
      modelKeys: new Set(["fake:fake-qsa", "fake:fake-reviewer"]), providerKeys: new Set(), searchStrategies: new Set()
    }, [], null, {
      toolCalling: true, contextWindow: 32_768, nativePdfInput: false, nativeSearch: false,
      pdf: true, reasoning: true, streaming: true, vision: true
    });
    const POST = createSendMessageHandler({ ...authDeps, providers: { fake: createFakeProviderAdapter() }, repository });
    const send = (reviewer: string) => POST(new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({
        answerReview: { maxRounds: 2, reviewers: [{ modelId: reviewer, provider: "fake",
          searchPlan: { mode: "all_selected", optionIds: [] } }] },
        content: { blocks: [{ text: "Check the total.", type: "text" }] }, mcp: { mode: "off" }, modelId: "fake-qsa", provider: "fake",
        searchPlan: { mode: "all_selected", optionIds: [] }
      }),
      headers: { cookie: authCookie() },
      method: "POST"
    }), { params: { chatId: "chat-1" } });

    const own = await send("fake-qsa");
    expect(own.status).toBe(409);
    expect(await own.json()).toEqual({ error: "answer_review_reviewer_unavailable" });
    expect(state.created).toBeNull();

    const accepted = await send("fake-reviewer");
    expect(accepted.status).toBe(200);
    await accepted.text();
    expect(state.created).toMatchObject({ answerReviewAuto: {
      authorModel: { modelId: "fake-qsa", provider: "fake" },
      controls: { controls: { mcp: { mode: "off" } }, reviewerSearchPlans: [{ mode: "all_selected", optionIds: [] }], version: 1 },
      maxRounds: 2,
      reviewers: [{ modelId: "fake-reviewer", name: "fake-reviewer", provider: "fake" }]
    } });
    expect(state.created).not.toHaveProperty("answerReviewStep");
  });

  it("starts no automatic review from a review step's own send", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [], null, {
      toolCalling: true, contextWindow: 32_768, nativePdfInput: false, nativeSearch: false,
      pdf: true, reasoning: true, streaming: true, vision: true
    });
    const response = await createSendMessageHandler({ ...authDeps, answerReviewStep: {
      preparation: { kind: "review", reviewer: 0, round: 1, sessionId: "session-1", step: 0 }, turnKind: "answer_review_request"
    }, providers: { fake: createFakeProviderAdapter() }, repository })(new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({ answerReview: { maxRounds: 1, reviewers: [{ modelId: "missing", provider: "fake",
        searchPlan: { mode: "all_selected", optionIds: [] } }] }, content: { blocks: [{ text: "Review the answer.", type: "text" }] },
        modelId: "fake-qsa", provider: "fake", searchPlan: { mode: "all_selected", optionIds: [] } }),
      headers: { cookie: authCookie() },
      method: "POST"
    }), { params: { chatId: "chat-1" } });
    expect(response.status).toBe(200);
    await response.text();
    expect(state.created).not.toHaveProperty("answerReviewAuto");
  });

  it("stops an answer review step whose provider has not answered yet, at once", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [], null, {
      toolCalling: true, contextWindow: 32_768, nativePdfInput: false, nativeSearch: false,
      pdf: true, reasoning: true, streaming: true, vision: true
    });
    let signal: AbortSignal | undefined;
    // A slow reviewer: no output until the request is aborted, then the transport's abort error.
    const heldProvider: ProviderAdapter = {
      buildRequestPreview: () => ({ provider: "fake" }),
      async *stream(_request, options = {}) {
        signal = options.signal;
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw options.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }
    };
    const send = createSendMessageHandler({ ...authDeps, answerReviewStep: {
      preparation: { kind: "review", reviewer: 0, round: 1, sessionId: "session-1", step: 0 }, turnKind: "answer_review_request"
    }, providers: { fake: heldProvider }, repository });
    const cancel = createCancelModelRunHandler({ ...authDeps, providers: { fake: heldProvider }, repository });
    const response = await send(new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({ content: { blocks: [{ text: "Review the answer.", type: "text" }] }, modelId: "fake-qsa", provider: "fake",
        searchPlan: { mode: "all_selected", optionIds: [] } }),
      headers: { cookie: authCookie() },
      method: "POST"
    }), { params: { chatId: "chat-1" } });
    expect(response.status).toBe(200);
    for (let attempt = 0; attempt < 50 && !signal; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signal).toBeDefined();

    const started = Date.now();
    const cancelled = await cancel(new Request("http://app.local/api/model-runs/run-1/cancel", {
      headers: { cookie: authCookie() }, method: "POST"
    }), { params: { runId: "run-1" } });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ run: { id: "run-1", status: "cancelled" } });
    // The step's run settled with the Stop, never waiting out the provider.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(signal?.aborted).toBe(true);
    const events = parseSse(await response.text());
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["run_start", "message_start"]));
    expect(state.cancelled).toMatchObject({ code: "model_run_cancelled" });
    expect(state.completed).toBeNull();
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

  it("refuses a value for a fixed Assistant row and stores an adjustable one for the chat", async () => {
    for (const policy of ["fixed", "adjustable"] as const) {
      const { repository, state } = createMemoryRepository();
      repository.loadAssistantRowContext = assistantRowContextLoader({
        defaultModelId: "fake-qsa", models: { "fake-qsa": "fake" }
      });
      const POST = createSendMessageHandler({
        ...authDeps,
        assistants: { resolveForRun: async () => handlerAssistant({ search: { policy, value: { mode: "all_selected", optionIds: ["web"] } } }) },
        providers: {
          fake: createFakeProviderAdapter()
        },
        repository
      });
      const response = await POST(
        new Request("http://app.local/api/chats/chat-1/messages", {
          body: JSON.stringify({
            assistantId: "assistant-1",
            searchPlan: { mode: "all_selected", optionIds: [] },
            text: "Assistant run with a Search change"
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

      if (policy === "fixed") {
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: "assistant_overrides_not_allowed"
        });
        expect(state.created).toBeNull();
        continue;
      }
      expect(response.status).toBe(200);
      await response.text();
      expect(state.created?.chatAssistant).toEqual({
        assistantId: "assistant-1", bind: true, overridesPatch: { search: { mode: "off" } }
      });
      expect(state.created?.assistant?.rows?.search).toBe("chat");
      expect(state.created?.defaults).toBeUndefined();
    }
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
      message: "Prompt, pinned context, current message, tools, and selected attachments exceed the model context budget " +
        "(13 estimated tokens available)."
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
    ).resolves.toMatchObject({ status: 500 });
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
    expect(state.published.at(-1)).toContain("Context memory: First turn secret: violet harbor");
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
    expect(eventTypes.slice(-2)).toEqual(["answer_complete", "done"]);
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
            status: "complete" as const,
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
    expect(events.map((event) => event.type).slice(0, 3)).toEqual(["run_start", "artifact", "message_start"]);
    expect(events.map((event) => event.type).slice(-2)).toEqual(["answer_complete", "done"]);
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
    expect(state.published).toEqual(["Fake answer: Original question\nContext memory: Earlier context"]);
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
    expect(events.map((event) => event.type).slice(-2)).toEqual(["answer_complete", "done"]);
    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(state.regenerated).toMatchObject({
      chatId: "chat-1",
      modelId: "fake-qsa",
      preSendAssistantMessageId: null,
      provider: "fake",
      userMessageId: "user-message-1"
    });
    expect(state.published.at(-1)).toContain("Fake answer: Original question");
  });

  it("regenerates with the chat's binding and refuses a different request Assistant", async () => {
    const { repository, state } = createMemoryRepository();
    const findSource = repository.findRegenerationSource;
    repository.findRegenerationSource = async (...args) => {
      const source = await findSource(...args);
      return source ? { ...source, chat: { ...source.chat, assistantId: "assistant-1" } } : null;
    };
    repository.loadAssistantRowContext = assistantRowContextLoader({
      defaultModelId: "fake-qsa", models: { "fake-qsa": "fake" }
    });
    const resolveForRun = vi.fn(async () => handlerAssistant({
      search: { policy: "adjustable", value: { mode: "all_selected", optionIds: ["web"] } }
    }));
    const POST = createRegenerateModelRunHandler({
      ...authDeps,
      assistants: { resolveForRun },
      providers: { fake: createFakeProviderAdapter() },
      repository
    });
    const regenerate = (body: Record<string, unknown>) => POST(
      new Request("http://app.local/api/messages/assistant-message-1/regenerate", {
        body: JSON.stringify(body),
        headers: { cookie: authCookie(), "content-type": "application/json" },
        method: "POST"
      }),
      { params: { messageId: "assistant-message-1" } }
    );

    const conflict = await regenerate({ assistantId: "assistant-2" });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "assistant_binding_conflict" });
    expect(state.regenerated).toBeNull();

    // The full ordinary composer payload is refused and admits nothing.
    const ordinary = await regenerate({
      controlDefaults: { temperature: "0.7" }, modelId: "fake-qsa", params: { temperature: 0.7 }, provider: "fake",
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchPreferencePlan: { mode: "all_selected", optionIds: [] }, searchPreferenceSource: "personal",
      workspace: { enabled: false }
    });
    expect(ordinary.status).toBe(400);
    await expect(ordinary.json()).resolves.toEqual({ error: "assistant_overrides_not_allowed" });
    expect(state.regenerated).toBeNull();

    // The current client in a bound chat: changed-row keys only, no Assistant id.
    const response = await regenerate({
      searchPlan: { mode: "all_selected", optionIds: [] }, timeZone: "Europe/Berlin", workspace: { enabled: false }
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(resolveForRun).toHaveBeenCalledWith(config.bootstrapUserId, "assistant-1");
    expect(state.regenerated?.chatAssistant).toEqual({
      assistantId: "assistant-1", bind: false, overridesPatch: { search: { mode: "off" } }
    });
    expect(state.regenerated?.assistant?.assistantId).toBe("assistant-1");
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
          toolCalling: true,
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

  it("settles Workspace when a cancelled PDF worker has a controller but no answer settlement promise", async () => {
    const { repository } = createMemoryRepository();
    const registration = activeRunControllerRegistry.register("run-1");
    expect(registration).not.toBeNull();
    expect(activeRunControllerRegistry.settled("run-1")).toBeNull();
    const settle = vi.fn(async () => ({ quiesced: true, sessionSettled: true, stoppedVm: false }));
    const POST = createCancelModelRunHandler({
      ...authDeps, repository, providers: {},
      workspaceCoordinator: { settle } as unknown as NonNullable<Parameters<typeof createCancelModelRunHandler>[0]["workspaceCoordinator"]>
    });
    try {
      const response = await POST(new Request("http://app.local/api/model-runs/run-1/cancel", {
        headers: { cookie: authCookie() }, method: "POST"
      }), { params: { runId: "run-1" } });
      expect(response.status).toBe(200);
      expect(registration?.signal.aborted).toBe(true);
      expect(settle).toHaveBeenCalledExactlyOnceWith({ outcome: "cancelled", runId: "run-1", userId: config.bootstrapUserId });
    } finally { registration?.release(); }
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
                id: "user-message-1",
                scheduledTaskPrompt: false
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
      filterTools: (async (_userId, tools) => [...tools]) as import("../mcp/toolAccess").McpToolAccessFilter,
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
    await regenerateResponse.text();
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

describe("Stop diagnostics", () => {
  beforeEach(() => {
    const shared = globalThis as typeof globalThis & { [key: symbol]: unknown };
    delete shared[Symbol.for("aiqsa.run-stop-rejections.v1")];
  });

  it("records admission and abort delivery under the Stop trace using only the repository-owned run id", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const registration = activeRunControllerRegistry.register("run-1");
    try {
      expect(registration).not.toBeNull();
      const { repository } = createMemoryRepository();
      const POST = createCancelModelRunHandler({ ...authDeps, repository, providers: {} });
      const response = await runWithContext({ trace_id: "4".repeat(32) }, () => POST(new Request(
        "http://app.local/api/model-runs/run-1/cancel?PRIVATE_QUERY_CANARY", {
          method: "POST", headers: { cookie: authCookie(), authorization: "Bearer PRIVATE_AUTH_CANARY" }
        }), { params: { runId: "run-1" } }));
      expect(response.status).toBe(200);
      const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
      expect(records.map(({ event }) => event)).toEqual([
        "run_stop_requested", "run_stop_admission", "run_persistence", "run_abort_delivery"
      ]);
      expect(records[0]).not.toHaveProperty("run_id");
      expect(records.slice(1).every((record) => record.run_id === "run-1")).toBe(true);
      expect(records.every((record) => record.trace_id === "4".repeat(32))).toBe(true);
      expect(records[1]).toMatchObject({ outcome: "accepted" });
      expect(records[2]).toMatchObject({ stage: "cancel", outcome: "confirmed" });
      expect(records[3]).toMatchObject({ outcome: "delivered" });
      expect(JSON.stringify(records)).not.toContain("PRIVATE_");
    } finally { registration?.release(); writer.mockRestore(); }
  });

  it("does not log a caller-controlled run id for unauthorized Stop", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { repository } = createMemoryRepository();
      const POST = createCancelModelRunHandler({ ...authDeps, resolveAuth: async () => null, repository, providers: {} });
      const response = await POST(new Request("http://app.local/cancel", { method: "POST" }), {
        params: { runId: "PRIVATE_CALLER_CONTROLLED_ID_CANARY" }
      });
      expect(response.status).toBe(401);
      const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
      expect(records).toHaveLength(2);
      expect(records[1]).toMatchObject({ event: "run_stop_admission", outcome: "unauthorized" });
      expect(records.every((record) => record.run_id === undefined)).toBe(true);
      expect(JSON.stringify(records)).not.toContain("PRIVATE_");
    } finally { writer.mockRestore(); }
  });

  it("bounds each rejected admission across handlers and reloads, then reports again after 30 seconds", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let now = 1_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { repository } = createMemoryRepository();
      const deps = { ...authDeps, repository, providers: {} };
      const unauthorized = createCancelModelRunHandler({ ...deps, resolveAuth: async () => null });
      const unconfigured = createCancelModelRunHandler({ ...deps, getConfig: () => ({ ...config, configured: false }) });
      const missing = createCancelModelRunHandler(deps);
      let sequence = 0;
      const invoke = (POST: typeof missing) => {
        sequence += 1;
        return runWithContext({ trace_id: sequence.toString(16).padStart(32, "0") }, () => POST(new Request(
          `http://app.local/PRIVATE_PATH_CANARY_${sequence}?query=PRIVATE_QUERY_CANARY`, {
            method: "POST", headers: { cookie: authCookie() }
          }), { params: { runId: `PRIVATE_UNVERIFIED_RUN_CANARY_${sequence}` } }));
      };
      const records = () => writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
      for (let index = 0; index < 10; index += 1) {
        expect((await invoke(index % 2 ? unauthorized : unconfigured)).status).toBe(401);
        expect((await invoke(missing)).status).toBe(404);
      }
      expect(records().map(({ event }) => event)).toEqual([
        "run_stop_requested", "run_stop_admission", "run_stop_requested", "run_stop_admission"
      ]);
      expect(records().filter(({ event }) => event === "run_stop_admission").map(({ outcome }) => outcome))
        .toEqual(["unauthorized", "not_found"]);

      vi.resetModules();
      const reloaded = await import("./handlers");
      const reloadedUnauthorized = reloaded.createCancelModelRunHandler({ ...deps, resolveAuth: async () => null });
      const reloadedMissing = reloaded.createCancelModelRunHandler(deps);
      now = 30_999;
      expect((await invoke(reloadedUnauthorized)).status).toBe(401);
      expect((await invoke(reloadedMissing)).status).toBe(404);
      expect(records()).toHaveLength(4);
      now = 31_000;
      expect((await invoke(reloadedUnauthorized)).status).toBe(401);
      expect((await invoke(reloadedMissing)).status).toBe(404);
      expect(records()).toHaveLength(8);
      for (let index = 0; index < records().length; index += 2) {
        expect(records()[index]?.event).toBe("run_stop_requested");
        expect(records()[index + 1]?.event).toBe("run_stop_admission");
        expect(records()[index]?.trace_id).toBe(records()[index + 1]?.trace_id);
      }
      expect(records().every((record) => record.run_id === undefined)).toBe(true);
      expect(JSON.stringify(records())).not.toContain("PRIVATE_");
    } finally { clock.mockRestore(); writer.mockRestore(); }
  });

  it("keeps accepted cancellations and admission failures visible while rejection suppression is active", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const invoke = (POST: ReturnType<typeof createCancelModelRunHandler>) => POST(new Request("http://app.local/cancel", {
        method: "POST", headers: { cookie: authCookie() }
      }), { params: { runId: "run-1" } });
      const { repository: rejected } = createMemoryRepository();
      expect((await invoke(createCancelModelRunHandler({ ...authDeps, resolveAuth: async () => null,
        repository: rejected, providers: {} }))).status).toBe(401);
      for (let index = 0; index < 2; index += 1) {
        const { repository } = createMemoryRepository();
        const cancel = repository.cancelRun;
        repository.cancelRun = async (input) => {
          const result = await cancel(input);
          if (result.kind !== "not_found") result.run.id = `verified-run-${index}`;
          return result;
        };
        const POST = createCancelModelRunHandler({ ...authDeps, repository, providers: {} });
        expect((await invoke(POST)).status).toBe(200);
        expect((await invoke(POST)).status).toBe(409);
        repository.cancelRun = async () => { throw new Error("PRIVATE_DATABASE_FAILURE_CANARY"); };
        expect((await invoke(POST)).status).toBe(500);
      }
      const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
      expect(records.filter(({ event }) => event === "run_stop_requested")).toHaveLength(7);
      expect(records.filter(({ event }) => event === "run_stop_admission").map(({ outcome }) => outcome))
        .toEqual(["unauthorized", "accepted", "not_cancelable", "failed", "accepted", "not_cancelable", "failed"]);
      expect(records.filter(({ event }) => event === "run_abort_delivery").map(({ run_id }) => run_id))
        .toEqual(["verified-run-0", "verified-run-1"]);
      expect(records.filter(({ event }) => event === "run_http_failed")).toHaveLength(2);
      expect(JSON.stringify(records)).not.toContain("PRIVATE_");
    } finally { writer.mockRestore(); }
  });
});

describe("run HTTP failure containment", () => {
  it.each(["send", "regenerate", "cancel"] as const)("contains an unexpected %s auth resolver rejection", async (stage) => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { repository } = createMemoryRepository();
      const deps = { ...authDeps, repository, providers: {}, usageLimits: { loadUsageLimitStatus: async () => NO_USAGE_LIMITS },
        resolveAuth: async () => { throw new TypeError("PRIVATE_RESOLVER_MESSAGE_CANARY"); } };
      const POST = stage === "send" ? createProductionSendMessageHandler(deps)
        : stage === "regenerate" ? createProductionRegenerateModelRunHandler(deps) : createCancelModelRunHandler(deps);
      const response = await POST(new Request("http://app.local/PRIVATE_PATH_CANARY", { method: "POST" }), {
        params: { chatId: "PRIVATE_CHAT_ID_CANARY", messageId: "PRIVATE_MESSAGE_ID_CANARY", runId: "PRIVATE_RUN_ID_CANARY" }
      });
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(await response.json()).toEqual({ error: "internal_error" });
      const records = stdout.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
      expect(records).toContainEqual(expect.objectContaining({ event: "run_http_failed", stage, code: "unknown", reason: "unknown" }));
      expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toContain("PRIVATE_");
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  });

  it("contains a Prisma Stop rejection and reports its proven code without the unverified run id", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const error = new Prisma.PrismaClientInitializationError("PRIVATE_DATABASE_CONNECTION_CANARY", "test", "P1001");
      const prisma = { $transaction: async () => { throw error; } } as unknown as PrismaClient;
      const repository = createPrismaRunRepository(prisma);
      const POST = createCancelModelRunHandler({ ...authDeps, repository, providers: {} });
      const response = await POST(new Request("http://app.local/cancel", {
        method: "POST", headers: { cookie: authCookie() }
      }), { params: { runId: "PRIVATE_UNVERIFIED_RUN_ID_CANARY" } });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
      const records = stdout.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
      expect(records).toContainEqual(expect.objectContaining({ event: "run_stop_admission", outcome: "failed", prisma_code: "P1001" }));
      expect(records).toContainEqual(expect.objectContaining({ event: "run_http_failed", stage: "cancel", prisma_code: "P1001" }));
      expect(records.every((entry) => entry.run_id === undefined)).toBe(true);
      expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toContain("PRIVATE_");
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  });
});

describe("usage limit admission", () => {

  const minute = 60_000;
  /** The start of the UTC month after `now`, when budgets reset. */
  const nextUtcMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const secondsUntil = (now: Date, at: Date) => String(Math.ceil((at.getTime() - now.getTime()) / 1000));

  /** A reached limit as the admission reads it at `now`, with the facts its refusal carries. */
  const reached: Record<UsageLimitRefusalCode, Readonly<{
    facts(now: Date): Record<string, unknown>;
    status(now: Date): UsageLimitStatus;
  }>> = {
    installation_budget_exhausted: {
      facts: (now) => ({ limit: null, resetsAt: nextUtcMonth(now).toISOString(), scope: "installation", used: null, window: "month" }),
      status: () => ({ ...NO_USAGE_LIMITS, installationCapMicros: 50_000_000, installationSpentMicros: 50_000_001 })
    },
    message_rate_limited: {
      facts: (now) => ({ limit: 2, resetsAt: new Date(now.getTime() + 10 * minute).toISOString(), scope: "user", used: 2, window: "hour" }),
      status: (now) => ({
        ...NO_USAGE_LIMITS,
        effective: { ...NO_USAGE_LIMITS.effective, messagesPerHour: { source: { kind: "installation" }, value: 2 } },
        lastHour: { count: 2, freesAt: new Date(now.getTime() + 10 * minute) }
      })
    },
    usage_budget_exhausted: {
      facts: (now) => ({ limit: 5_000_000, resetsAt: nextUtcMonth(now).toISOString(), scope: "user", used: 5_250_000, window: "month" }),
      status: () => ({
        ...NO_USAGE_LIMITS,
        effective: { ...NO_USAGE_LIMITS.effective, monthlyBudgetMicros: { source: { kind: "user" }, value: 5_000_000 } },
        userSpentMicros: 5_250_000
      })
    }
  };

  function limitsReading(status: (now: Date) => UsageLimitStatus) {
    return { loadUsageLimitStatus: vi.fn(async (_userId: string, now: Date) => status(now)) };
  }

  function send(body: Record<string, unknown> = {}, cookie: string | null = authCookie()) {
    return new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({ modelId: "fake-qsa", provider: "fake", text: "One more question", ...body }),
      headers: cookie ? { cookie } : {},
      method: "POST"
    });
  }

  function regenerate(messageId: string, body: Record<string, unknown> = {}) {
    return new Request(`http://app.local/api/messages/${messageId}/regenerate`, {
      body: JSON.stringify({ modelId: "fake-qsa", provider: "fake", ...body }),
      headers: { cookie: authCookie() },
      method: "POST"
    });
  }

  it.each(Object.keys(reached) as UsageLimitRefusalCode[])(
    "refuses a send at %s with its facts and retry-after, before any run, provider call or usage",
    async (code) => {
      const { repository, state } = createMemoryRepository();
      const adapter = createFakeProviderAdapter();
      const stream = vi.spyOn(adapter, "stream");
      const usageLimits = limitsReading(reached[code].status);
      const response = await createSendMessageHandler({ ...authDeps, providers: { fake: adapter }, repository, usageLimits })(
        send(), { params: { chatId: "chat-1" } });

      expect(response.status).toBe(429);
      expect(usageLimits.loadUsageLimitStatus).toHaveBeenCalledOnce();
      const [userId, now] = usageLimits.loadUsageLimitStatus.mock.calls[0]!;
      expect(userId).toBe(config.bootstrapUserId);
      const facts = reached[code].facts(now);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(response.headers.get("retry-after")).toBe(secondsUntil(now, new Date(String(facts.resetsAt))));
      const body: unknown = await response.json();
      expect(body).toEqual({ error: code, usageLimit: facts });
      expect(decodeUsageLimitRefusal(body)).toEqual(body);
      expect(state.created).toBeNull();
      expect(stream).not.toHaveBeenCalled();
    }
  );

  it("refuses a Workspace turn before its Workspace is prepared", async () => {
    const { repository, state } = createMemoryRepository();
    const prepare = vi.fn();
    const usageLimits = limitsReading(reached.installation_budget_exhausted.status);
    const response = await createSendMessageHandler({
      ...authDeps, providers: { fake: createFakeProviderAdapter() }, repository, usageLimits,
      workspace: { prepare } as unknown as NonNullable<RunHandlerDeps["workspace"]>
    })(send({ workspace: { enabled: true } }), { params: { chatId: "chat-1" } });

    expect(response.status).toBe(429);
    // The pooled cap never discloses installation amounts.
    expect(await response.json()).toMatchObject({
      error: "installation_budget_exhausted", usageLimit: { limit: null, scope: "installation", used: null }
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(state.created).toBeNull();
  });

  it("counts regenerations, edits and document retries as interactive and refuses them before loading anything", async () => {
    const { repository, state } = createMemoryRepository();
    const adapter = createFakeProviderAdapter();
    const stream = vi.spyOn(adapter, "stream");
    const loadRetry = vi.fn();
    const usageLimits = limitsReading(reached.message_rate_limited.status);
    const POST = createRegenerateModelRunHandler({
      ...authDeps, providers: { fake: adapter }, repository, usageLimits,
      chatPdf: { findAdmission: async () => null, kick: vi.fn(), loadRetry, resolve: vi.fn() }
    });
    // A regeneration, the run of an edited message (its user message is the source) and a document retry.
    for (const [messageId, body] of [
      ["assistant-message-1", {}], ["user-message-1", {}], ["assistant-message-1", { retryPdfPreparation: true }]
    ] as const) {
      const response = await POST(regenerate(messageId, body), { params: { messageId } });
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: "message_rate_limited", usageLimit: { limit: 2, used: 2, window: "hour" } });
    }
    expect(usageLimits.loadUsageLimitStatus).toHaveBeenCalledTimes(3);
    expect(loadRetry).not.toHaveBeenCalled();
    expect(state.regenerated).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  it("keeps earlier refusals and an accepted admission's retry first, never reading limits for them", async () => {
    const usageLimits = limitsReading(() => { throw new Error("limits_must_not_be_read"); });
    const expectRefusal = async (response: Response, status: number, body: Record<string, unknown>) => {
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject(body);
    };
    const { repository, state } = createMemoryRepository();
    const deps = { ...authDeps, providers: { fake: createFakeProviderAdapter() }, repository, usageLimits };
    const POST = createSendMessageHandler(deps);

    await expectRefusal(await POST(send({}, null), { params: { chatId: "chat-1" } }), 401, { error: "unauthorized" });
    await expectRefusal(await POST(send({ expectedActiveLeafId: "" }), { params: { chatId: "chat-1" } }), 400,
      { error: "expected_active_leaf_invalid" });
    const findOwnedChat = repository.findOwnedChat;
    repository.findOwnedChat = async () => null;
    await expectRefusal(await POST(send(), { params: { chatId: "chat-1" } }), 404, { error: "chat_not_found" });
    repository.findOwnedChat = findOwnedChat;
    state.recentActiveRun = { ...activeRunRecord({ chatId: "chat-1" }), updatedAt: new Date() };
    await expectRefusal(await POST(send(), { params: { chatId: "chat-1" } }), 409, { error: "active_run_in_progress" });
    const REGENERATE = createRegenerateModelRunHandler(deps);
    await expectRefusal(await REGENERATE(regenerate("assistant-message-1"), { params: { messageId: "assistant-message-1" } }), 409,
      { error: "active_run_in_progress" });
    await expectRefusal(await REGENERATE(regenerate("missing-message"), { params: { messageId: "missing-message" } }), 404,
      { error: "message_not_found_or_not_regeneratable" });
    state.recentActiveRun = null;

    // A retried send whose admission was already accepted answers with that run.
    const accepted = { assistantMessageId: "assistant-message-1", run: { id: "run-1", status: "queued" as const },
      userMessageId: "user-message-1", version: 1 as const };
    const kick = vi.fn();
    const duplicate = await createSendMessageHandler({ ...deps,
      chatPdf: { findAdmission: async () => accepted, kick, resolve: vi.fn() } })(send({ admissionId: "accepted-invocation" }),
      { params: { chatId: "chat-1" } });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual(accepted);
    expect(kick).toHaveBeenCalledOnce();

    expect(usageLimits.loadUsageLimitStatus).not.toHaveBeenCalled();
    expect(state.created).toBeNull();
    expect(state.regenerated).toBeNull();
  });

  it("refuses as unavailable, never admitting, when the limits cannot be read", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { repository, state } = createMemoryRepository();
      const error = new Prisma.PrismaClientInitializationError("PRIVATE_LIMITS_CONNECTION_CANARY", "test", "P1001");
      const usageLimits = { loadUsageLimitStatus: vi.fn(async (): Promise<UsageLimitStatus> => { throw error; }) };
      const deps = { ...authDeps, providers: { fake: createFakeProviderAdapter() }, repository, usageLimits };
      const responses = [
        await createSendMessageHandler(deps)(send(), { params: { chatId: "chat-1" } }),
        await createRegenerateModelRunHandler(deps)(regenerate("assistant-message-1"), { params: { messageId: "assistant-message-1" } })
      ];
      for (const response of responses) {
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
        expect(await response.json()).toEqual({ error: "usage_limits_unavailable" });
      }
      expect(state.created).toBeNull();
      expect(state.regenerated).toBeNull();
      const records = stdout.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
      for (const stage of ["send", "regenerate"]) {
        expect(records).toContainEqual(expect.objectContaining({
          code: "usage_limits_unavailable", event: "run_http_failed", prisma_code: "P1001", stage
        }));
      }
      expect(JSON.stringify(stdout.mock.calls)).not.toContain("PRIVATE_");
    } finally { stdout.mockRestore(); }
  });

  it("admits exactly as before without limits, reading them once per admission", async () => {
    const { repository, state } = createMemoryRepository();
    const usageLimits = limitsReading(() => NO_USAGE_LIMITS);
    const response = await createSendMessageHandler({ ...authDeps, providers: { fake: createFakeProviderAdapter() }, repository,
      usageLimits })(send(), { params: { chatId: "chat-1" } });
    expect(response.status).toBe(200);
    await response.text();
    expect(state.created).toMatchObject({ chatId: "chat-1", userId: config.bootstrapUserId });
    expect(state.published).toHaveLength(1);
    expect(usageLimits.loadUsageLimitStatus).toHaveBeenCalledOnce();
  });
});

describe("interactive sends on the agent engine", () => {

  const toolCallingModel = { contextWindow: 32_768, nativePdfInput: false, nativeSearch: false, pdf: true, reasoning: true,
    streaming: true, toolCalling: true, vision: true };
  const send = (deps: TestRunHandlerDeps) => createSendMessageHandler(deps)(new Request("http://app.local/api/chats/chat-1/messages", {
    body: JSON.stringify({ content: { blocks: [{ text: "Hello QSA", type: "text" }] }, modelId: "fake-qsa", provider: "fake",
      searchPlan: { mode: "all_selected", optionIds: [] } }),
    headers: { cookie: authCookie() }, method: "POST"
  }), { params: { chatId: "chat-1" } });

  it("admits a send with the agent engine marker and answers on it", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [], null, toolCallingModel);
    const native = nativeEngineFake();
    const response = await send({ ...authDeps, nativeEngine: native.deps, providers: { fake: createFakeProviderAdapter() }, repository });
    const events = parseSse(await response.text());
    expect(state.created).toMatchObject({ engine: "native" });
    expect(native.published).toEqual(["Fake answer: Hello QSA"]);
    expect(events.map((event) => event.type)).toContain("answer_complete");
    expect(events.at(-1)).toMatchObject({ data: { status: "complete" }, type: "done" });
    expect(state.completed).toBeNull();
  });

  it("admits a quick send behind a settling answer as a Workspace follow-up, which nothing runs before", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [{
      id: "previous-answer", role: "assistant", content: { blocks: [{ type: "text", text: "File saved." }] }
    }], null, toolCallingModel);
    // The previous answer is published and still hands its Workspace off.
    repository.findRecentActiveRunForChat = async () => ({ ...activeRunRecord({
      id: "previous-run", chatId: "chat-1", assistantMessageId: "previous-answer"
    }), answerComplete: true });
    const create = repository.createRun;
    repository.createRun = vi.fn(async (input) => ({ ...await create(input), deferredWorkspace: true as const }));
    repository.getRunOutcomeForUser = async () => ({ id: "run-1", status: "queued", workspacePreparation: true });
    const native = nativeEngineFake();
    const provider = recordingProvider();
    const kick = vi.fn();
    const response = await createSendMessageHandler({ ...authDeps, nativeEngine: native.deps, providers: { fake: provider.adapter },
      repository, workspaceFollowup: { kick, findAdmission: async () => null } })(new Request("http://app.local/api/chats/chat-1/messages", {
      method: "POST", headers: { cookie: authCookie() }, body: JSON.stringify({ admissionId: "next-invocation",
        expectedActiveLeafId: "previous-answer", provider: "fake", modelId: "fake-qsa", text: "Update that file." })
    }), { params: { chatId: "chat-1" } });
    expect(response.status).toBe(202);
    // The native engine takes it once the follow-up starts it, after the predecessor's hand-off.
    expect(state.created).toMatchObject({ engine: "native", workspaceFollowup: { predecessorRunId: "previous-run",
      snapshot: { native: {}, version: 1 } } });
    expect(provider.requests).toEqual([]);
    expect(native.published).toEqual([]);
    expect(kick).toHaveBeenCalled();
  });

  it("refuses a model without verified tool calling visibly, before creating a run", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [], null, { ...toolCallingModel, toolCalling: false });
    const native = nativeEngineFake();
    const response = await send({ ...authDeps, nativeEngine: native.deps, providers: { fake: createFakeProviderAdapter() }, repository });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "model_tool_calling_required" });
    expect(state.created).toBeNull();
    expect(native.published).toEqual([]);
  });

  /** The fake provider, recording every request it is sent. */
  function recordingProvider() {
    const fake = createFakeProviderAdapter();
    const requests: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = { ...fake, stream: (request, options) => {
      requests.push(request);
      return fake.stream(request, options);
    } };
    return { adapter, requests };
  }
  const toolNames = (request: ProviderRunRequest | undefined) => (request?.tools ?? []).map((tool) => tool.name);

  it("runs Assistant chat natively, under the Assistant's own instructions and rows", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [], null, toolCallingModel);
    repository.loadAssistantRowContext = assistantRowContextLoader({ defaultModelId: "fake-qsa", models: { "fake-qsa": "fake" } });
    const native = nativeEngineFake({ tools: true });
    const provider = recordingProvider();
    const response = await createSendMessageHandler({ ...authDeps, assistants: { resolveForRun: async () => handlerAssistant() },
      nativeEngine: native.deps, providers: { fake: provider.adapter }, repository
    })(new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({ assistantId: "assistant-1", text: "Assistant run" }), headers: { cookie: authCookie() }, method: "POST"
    }), { params: { chatId: "chat-1" } });
    await response.text();
    expect(state.created).toMatchObject({ assistant: expect.objectContaining({ assistantId: "assistant-1" }), engine: "native" });
    expect(native.published).toHaveLength(1);
    // The family prompt is the persona; the Assistant's instructions follow it.
    const system = provider.requests[0]!.prompt.system!;
    expect(system.startsWith(NEUTRAL_FAMILY_PROMPT)).toBe(true);
    expect(system.indexOf("Review carefully.")).toBeGreaterThan(NEUTRAL_FAMILY_PROMPT.length);
    // Its fixed rows hold: no MCP or Search of its own, and an Assistant chat takes no self-service tools.
    const tools = toolNames(provider.requests[0]);
    expect(tools).toContain("read_secret");
    expect(tools.some((name) => name.startsWith("mcp_") || name === "find_tools")).toBe(false);
    expect(provider.requests[0]!.searchPlan.options).toEqual([]);
    expect(tools).not.toContain("manage_assistant");
  });

  it("gives personal chat the self-service tools", async () => {
    const { repository } = createMemoryRepository(entitledFakeModel, [], null, toolCallingModel);
    const native = nativeEngineFake({ tools: true });
    const provider = recordingProvider();
    const response = await send({ ...authDeps, nativeEngine: native.deps, providers: { fake: provider.adapter }, repository });
    await response.text();
    expect(toolNames(provider.requests[0])).toEqual(expect.arrayContaining(["read_secret", "manage_assistant", "manage_secret"]));
  });

  it("gives Telegram turn no self-service tools, whose cards the bridge cannot show, and keeps read_secret", async () => {
    const { repository } = createMemoryRepository(entitledFakeModel, [], null, toolCallingModel);
    const native = nativeEngineFake({ tools: true });
    const provider = recordingProvider();
    const response = await send({ ...authDeps, nativeEngine: native.deps, providers: { fake: provider.adapter }, repository,
      telegramTurn: true });
    await response.text();
    const tools = toolNames(provider.requests[0]);
    expect(tools).toContain("read_secret");
    for (const name of ["read_aiqsa_guide", "manage_secret", "manage_skill", "manage_assistant"]) expect(tools).not.toContain(name);
  });

  it("continues turn natively after an Allow, naming the approval, as the web and Telegram send it", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [], null, toolCallingModel);
    repository.loadMcpApprovalContinuation = vi.fn(async (input: { approvalId: string }) => input.approvalId === "approval-1"
      ? { serverName: "Records", toolName: "create_record" } : null);
    const native = nativeEngineFake();
    const response = await createSendMessageHandler({ ...authDeps, nativeEngine: native.deps, providers: { fake: createFakeProviderAdapter() },
      repository })(new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({ content: { blocks: [] }, modelId: "fake-qsa", provider: "fake", searchPlan: { mode: "all_selected", optionIds: [] },
        systemTurn: { approvalId: "approval-1", kind: "mcp_approval_continuation" } }),
      headers: { cookie: authCookie() }, method: "POST"
    }), { params: { chatId: "chat-1" } });
    await response.text();
    expect(state.created).toMatchObject({ engine: "native", systemTurnKind: "mcp_approval_continuation" });
    // The native run looks the Allow up itself; the body only names it.
    expect(native.deps.engine.approvedCall).toHaveBeenCalledWith({ approvalId: "approval-1", chatId: "chat-1",
      userId: config.bootstrapUserId });
    expect(native.published).toHaveLength(1);
  });

  it("runs answer review step natively with the step's reserved report", async () => {
    const { repository, state } = createMemoryRepository(entitledFakeModel, [], null, toolCallingModel);
    const native = nativeEngineFake({ tools: true });
    const provider = recordingProvider();
    const response = await createSendMessageHandler({ ...authDeps, answerReviewStep: {
      preparation: { kind: "review", reviewer: 0, round: 1, sessionId: "session-1", step: 0 }, turnKind: "answer_review_request"
    }, nativeEngine: native.deps, providers: { fake: provider.adapter }, repository })(new Request("http://app.local/api/chats/chat-1/messages", {
      body: JSON.stringify({ content: { blocks: [{ text: "Review the answer.", type: "text" }] }, modelId: "fake-qsa", provider: "fake",
        searchPlan: { mode: "all_selected", optionIds: [] } }),
      headers: { cookie: authCookie() }, method: "POST"
    }), { params: { chatId: "chat-1" } });
    await response.text();
    expect(state.created).toMatchObject({ answerReviewStep: { round: 1, sessionId: "session-1", step: 0 }, engine: "native" });
    const tools = toolNames(provider.requests[0]);
    expect(tools).toContain("submit_answer_review");
    expect(tools).not.toContain("manage_secret");
    expect(native.published).toHaveLength(1);
  });
});
