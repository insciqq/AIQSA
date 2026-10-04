import { describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "../auth/config";
import type { AuthenticatedUser } from "../auth/requestAuth";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import { createFakeProviderAdapter } from "../providers/fakeProvider";
import type { ProviderModelCapabilities } from "../providers/types";
import { createSendMessageHandler, type RunHandlerDeps } from "../runs/handlers";
import {
  ScheduledOccurrenceConflictError,
  type CreateRunInput,
  type RunOwnedChatRecord,
  type RunRepository
} from "../runs/runRepositoryContract";
import { resetBootOrphanSweepForTest } from "@/tests/support/runExecution";
import {
  createScheduledTaskSend,
  scheduledTaskOwnerAuth,
  scheduledTaskSearchPlan,
  scheduledTaskSendBody,
  type ScheduledTaskSendTarget
} from "./admission";
import type { ScheduledTaskRunCatalog } from "./catalog";

const config = getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "secret", AIQSA_BOOTSTRAP_AUTH_TOKEN: "token" });
const owner: AuthenticatedUser = {
  displayName: "Synthetic owner", email: "owner@example.test", id: "00000000-0000-4000-8000-0000000000aa", role: "user", status: "active"
};
const occurrence = { occurrenceId: "occurrence-1", taskId: "task-1" };
const newChatId = "30000000-0000-4000-8000-000000000003";

function admissionPlan(input: Parameters<NonNullable<RunHandlerDeps["providerAdmission"]>["load"]>[0],
  capabilities: ProviderModelCapabilities): ProviderAdmissionPlan {
  return {
    answer: {
      credentialSource: "default",
      modelConfiguration: { adapterKind: "fake", capabilities, defaultParams: {} },
      snapshot: {
        connection: { allowPrivateNetwork: true, apiRoot: "http://127.0.0.1", authenticationMode: "none", responseTimeoutMs: 300_000 },
        connectionDisplayName: "fake", connectionId: input.providerConnectionId, credentialId: null, credentialVersionId: null,
        model: { adapterKind: "fake", capabilities, defaultParams: {}, upstreamModelId: input.providerModelId },
        modelDisplayName: input.providerModelId, providerFamily: "fake", providerModelId: input.providerModelId, version: 1
      }
    },
    fingerprint: "f".repeat(64),
    requestedSearchPlan: input.searchPlan,
    searches: [],
    selection: { providerConnectionId: input.providerConnectionId, providerModelId: input.providerModelId },
    userId: input.userId
  };
}

/** The real send handler's dependencies around an in-memory repository and the fake provider. */
function fixture(options: Readonly<{ chat?: RunOwnedChatRecord; toolCalling?: boolean }> = {}) {
  const state: {
    completedText: string | null; created: CreateRunInput | null; createRun?: (input: CreateRunInput) => void; failedCode: string | null;
  } = { completedText: null, created: null, failedCode: null };
  const capabilities: ProviderModelCapabilities = {
    nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true,
    toolCalling: options.toolCalling ?? true, vision: false
  };
  const implemented: Partial<RunRepository> = {
    appendAssistantText: async () => undefined,
    appendRunOutputEvent: async (_runId, event) => event,
    beginToolLoopProviderRound: async () => "started",
    completeRun: async (input) => { state.completedText = input.finalText; return true; },
    createRun: async (input) => {
      state.createRun?.(input);
      state.created = input;
      return { assistantMessageId: "assistant-message-1", runId: "run-1", userMessageId: "user-message-1" };
    },
    failRun: async (_runId, _assistantMessageId, error) => { state.failedCode = error.code; return true; },
    findOwnedChat: async (chatId, userId) => userId === owner.id && options.chat?.id === chatId ? options.chat : null,
    findRecentActiveRunForChat: async () => null,
    findStaleActiveRunsForUser: async () => [],
    getChatUpdateForRun: async () => null,
    getRunControlForUser: async (runId, userId) => runId === "run-1" && userId === owner.id && state.created ? {
      assistantMessageId: "assistant-message-1", chatId: state.created.chatId, id: runId, modelId: state.created.modelId,
      provider: state.created.provider, providerResponseId: null,
      status: state.completedText !== null ? "complete" : state.failedCode ? "error" : "streaming"
    } : null,
    loadCheckpointedToolLoopRun: async () => null,
    loadConversationContextForExpectedLeaf: async (_chatId, _userId, leaf) =>
      leaf === (options.chat?.activeLeafMessageId ?? null) ? [] : null,
    loadEntitlements: async () => ({ modelKeys: new Set(["fake:fake-qsa"]), providerKeys: new Set(), searchStrategies: new Set() }),
    loadModelPricing: async () => null,
    loadPersonalFirstSend: async (input) => input.chatId === newChatId && input.userId === owner.id ? {
      activeLeafMessageId: null, defaultModelId: "fake-qsa", defaultProvider: "fake", folderId: input.folderId, id: input.chatId,
      memoryMode: input.memoryMode, messageCount: 0, projectMemory: null, title: "New Chat", workspaceEnabled: false
    } : null,
    loadRunUsageAttributions: async () => [],
    markRunAnswerStarted: async () => undefined,
    persistToolLoopCallBatch: async () => { throw new Error("tool_calls_not_expected"); },
    recordRunUsageEvents: async () => true,
    sweepBootOrphanedRuns: async () => 0,
    updateRunProviderResponseId: async () => "published"
  };
  // Everything else is absent, like the optional operations of a minimal repository;
  // a required operation the path needs would fail the run visibly.
  const repository = implemented as RunRepository;
  const adapter = createFakeProviderAdapter();
  const sendDeps: Omit<RunHandlerDeps, "resolveAuth" | "scheduledOccurrence"> = {
    allowFakeProvider: true,
    getConfig: () => config,
    providerAdmission: { load: async (input) => admissionPlan(input, capabilities) },
    providerRuntime: { resolve: async () => ({ adapter, responseTimeoutMs: 300_000 }) } as unknown as RunHandlerDeps["providerRuntime"],
    providers: {},
    repository
  };
  const loadOwner = vi.fn(async () => owner as AuthenticatedUser | null);
  return { loadOwner, send: createScheduledTaskSend({ loadOwner, sendDeps }), sendDeps, state };
}

function body(target: ScheduledTaskSendTarget, toolCalling = true) {
  return scheduledTaskSendBody({
    admissionId: "40000000-0000-4000-8000-000000000004", modelId: "fake-qsa", prompt: "  Summarize the synthetic fixture\n",
    provider: "fake", searchPlan: { mode: "all_selected", optionIds: [] }, target, timeZone: "Europe/Moscow", toolCalling
  });
}

describe("scheduled task admission through the ordinary send handler", () => {
  it("admits the first run as a Memory-excluded personal first send bound to its occurrence", async () => {
    resetBootOrphanSweepForTest();
    const f = fixture();
    const response = await f.send({ body: body({ chatId: newChatId, kind: "new" }), chatId: newChatId, occurrence, userId: owner.id });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.text();
    expect(f.state.created).toMatchObject({
      chatId: newChatId,
      content: { blocks: [{ text: "Summarize the synthetic fixture", type: "text" }] },
      expectedActiveLeafId: null,
      modelId: "fake-qsa",
      personalChat: { defaultProviderModelId: "fake-qsa", folderId: null, memoryMode: "EXCLUDED" },
      provider: "fake",
      scheduledOccurrence: occurrence,
      userId: owner.id,
      workspaceEnabled: false
    });
    const request = f.state.created!.normalizedRequest;
    expect(request).toMatchObject({
      knowledgePlan: { mode: "none" },
      prompt: { baseline: { source: "standard_chat", timeZone: "Europe/Moscow" } },
      searchPlan: { options: [] },
      skills: { mode: "off" },
      toolMode: "auto"
    });
    expect(request.mcp).toBeUndefined();
    expect(request.mcpDiscovery).toBeUndefined();
    expect(request.agent).toBeUndefined();
    expect(request.workspace).toBeUndefined();
    expect(request.memoryStandingVersion).toBeUndefined();
    expect(f.state.failedCode).toBeNull();
    expect(f.state.completedText).toBe("Fake answer: Summarize the synthetic fixture");
    expect(f.loadOwner).toHaveBeenCalledWith({ taskId: "task-1", userId: owner.id });
  });

  it("appends a later run to the task's chat after its current leaf", async () => {
    const chat: RunOwnedChatRecord = {
      activeLeafMessageId: "assistant-message-0", defaultModelId: "fake-qsa", defaultProvider: "fake", id: "chat-task",
      memoryMode: "EXCLUDED", messageCount: 2, projectMemory: null, title: "Synthetic brief"
    };
    const f = fixture({ chat });
    const response = await f.send({
      body: body({ activeLeafMessageId: "assistant-message-0", chatId: "chat-task", kind: "existing" }),
      chatId: "chat-task", occurrence, userId: owner.id
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(f.state.created).toMatchObject({ chatId: "chat-task", expectedActiveLeafId: "assistant-message-0", scheduledOccurrence: occurrence });
    expect(f.state.created!.personalChat).toBeUndefined();
    expect(f.state.completedText).toBe("Fake answer: Summarize the synthetic fixture");
  });

  it("asks a model without tool calling for no tools, as the composer does", async () => {
    const f = fixture({ toolCalling: false });
    const response = await f.send({ body: body({ chatId: newChatId, kind: "new" }, false), chatId: newChatId, occurrence, userId: owner.id });
    expect(response.status).toBe(200);
    await response.text();
    expect(f.state.created!.normalizedRequest.toolMode).toBe("none");
    expect(f.state.completedText).toBe("Fake answer: Summarize the synthetic fixture");
  });

  it("refuses without an active owner before any run", async () => {
    const f = fixture();
    f.loadOwner.mockResolvedValueOnce(null);
    const response = await f.send({ body: body({ chatId: newChatId, kind: "new" }), chatId: newChatId, occurrence, userId: owner.id });
    expect(response.status).toBe(401);
    expect(f.state.created).toBeNull();
    f.loadOwner.mockResolvedValueOnce({ ...owner, status: "disabled" });
    expect((await f.send({ body: body({ chatId: newChatId, kind: "new" }), chatId: newChatId, occurrence, userId: owner.id })).status)
      .toBe(401);
  });

  it("reports an occurrence that is gone or already linked with a stable code", async () => {
    const f = fixture();
    f.state.createRun = () => { throw new ScheduledOccurrenceConflictError(); };
    const response = await f.send({ body: body({ chatId: newChatId, kind: "new" }), chatId: newChatId, occurrence, userId: owner.id });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "scheduled_task_occurrence_unavailable" });
  });

  it("never takes an occurrence from the request body", async () => {
    const f = fixture();
    const handler = createSendMessageHandler({ ...f.sendDeps, resolveAuth: scheduledTaskOwnerAuth(f.loadOwner, { taskId: "task-1", userId: owner.id }) });
    const response = await handler(new Request(`http://localhost/api/chats/${newChatId}/messages`, {
      body: JSON.stringify({ ...body({ chatId: newChatId, kind: "new" }), scheduledOccurrence: occurrence }), method: "POST"
    }), { params: { chatId: newChatId } });
    expect(response.status).toBe(200);
    await response.text();
    expect(f.state.created).not.toHaveProperty("scheduledOccurrence");
  });
});

describe("scheduled task search plan", () => {
  const capabilities = { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false,
    openRouterPerplexitySearch: false, reasoning: false, streaming: true, text: true, toolCalling: true } as const;
  const options = ["alpha", "beta"].map((strategyId) => ({
    displayName: strategyId, executionModes: ["all_selected" as const, "model_choice" as const], kind: "web_search" as const, strategyId
  }));
  const catalog = (preferred: string[]): ScheduledTaskRunCatalog => ({
    models: [{ capabilities, modelId: "m", provider: "p", searchStrategyIds: ["beta", "alpha"] }],
    searchPlan: { mode: "all_selected", optionIds: preferred }, searchStrategies: options
  });

  it("is off when the task has Search off and otherwise follows the owner's preference within the model", () => {
    const model = catalog([]).models[0]!;
    expect(scheduledTaskSearchPlan({ catalog: catalog(["alpha"]), model, searchEnabled: false })).toEqual({ mode: "all_selected", optionIds: [] });
    expect(scheduledTaskSearchPlan({ catalog: catalog(["alpha"]), model, searchEnabled: true })).toEqual({ mode: "all_selected", optionIds: ["alpha"] });
    // No usable preference: the model's first usable option, never none.
    expect(scheduledTaskSearchPlan({ catalog: catalog(["gamma"]), model, searchEnabled: true })).toEqual({ mode: "all_selected", optionIds: ["beta"] });
    expect(scheduledTaskSearchPlan({ catalog: { ...catalog([]), searchStrategies: [] }, model, searchEnabled: true })).toBeNull();
  });
});
