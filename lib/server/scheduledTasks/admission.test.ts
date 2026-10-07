import { describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { getAuthConfig } from "../auth/config";
import type { AuthenticatedUser } from "../auth/requestAuth";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import { textConversationForRequest } from "../providers/context";
import { createFakeProviderAdapter } from "../providers/fakeProvider";
import type { ProviderAdapter, ProviderConversationMessage, ProviderModelCapabilities, ProviderRunRequest } from "../providers/types";
import { createSendMessageHandler, type RunHandlerDeps } from "../runs/handlers";
import {
  ScheduledOccurrenceConflictError,
  type CreateRunInput,
  type RunOwnedChatRecord,
  type RunRepository,
  type ScheduledOccurrenceAdmission
} from "../runs/runRepositoryContract";
import type { ToolHistorySnapshot } from "../runs/toolHistoryContract";
import type { UsageLimitStatus } from "../usageLimits/repository";
import { WorkspaceSecretError } from "../workspace/secrets/validation";
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
const occurrence: ScheduledOccurrenceAdmission = {
  occurrenceId: "occurrence-1", previousResult: null, relevantMcpServerIds: null, taskGeneration: 1, taskId: "task-1", taskRevision: 1
};
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

/** No usage limit set anywhere. */
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

/** The real send handler's dependencies around an in-memory repository and the fake provider. */
function fixture(options: Readonly<{
  chat?: RunOwnedChatRecord;
  /** The active branch of the chat, root first, as the repository loads it. */
  path?: readonly ProviderConversationMessage[];
  toolCalling?: boolean;
  toolHistory?: ToolHistorySnapshot;
  /** The owner's usage limit status at admission; none by default. */
  usage?: UsageLimitStatus;
}> = {}) {
  const state: {
    completedText: string | null; created: CreateRunInput | null; createRun?: (input: CreateRunInput) => void; failedCode: string | null;
    /** Every request the answer model received. */
    requests: ProviderRunRequest[];
  } = { completedText: null, created: null, failedCode: null, requests: [] };
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
      leaf === (options.chat?.activeLeafMessageId ?? null) ? [...(options.path ?? [])] : null,
    ...(options.toolHistory ? { loadToolHistory: async () => options.toolHistory! } : {}),
    loadEntitlements: async () => ({ modelKeys: new Set(["fake:fake-qsa"]), providerKeys: new Set(), searchStrategies: new Set() }),
    loadModelPricing: async () => null,
    loadPersonalFirstSend: async (input) => input.chatId === newChatId && input.userId === owner.id ? {
      activeLeafMessageId: null, defaultModelId: "fake-qsa", defaultProvider: "fake", folderId: input.folderId, id: input.chatId,
      memoryMode: input.memoryMode, messageCount: 0, projectMemory: null, title: "New Chat", workspaceEnabled: false
    } : null,
    loadRunUsageAttributions: async () => [],
    loadWorkspaceFileFacts: async () => ({ hasEarlierExports: false, hasFiles: false }),
    markRunAnswerStarted: async () => undefined,
    persistToolLoopCallBatch: async () => { throw new Error("tool_calls_not_expected"); },
    recordRunUsageEvents: async () => true,
    sweepBootOrphanedRuns: async () => 0,
    updateRunProviderResponseId: async () => "published"
  };
  // Everything else is absent, like the optional operations of a minimal repository;
  // a required operation the path needs would fail the run visibly.
  const repository = implemented as RunRepository;
  const fake = createFakeProviderAdapter();
  const adapter: ProviderAdapter = { ...fake, stream: (request, streamOptions) => {
    state.requests.push(request);
    return fake.stream(request, streamOptions);
  } };
  const sendDeps: Omit<RunHandlerDeps, "resolveAuth" | "scheduledOccurrence"> = {
    allowFakeProvider: true,
    getConfig: () => config,
    providerAdmission: { load: async (input) => admissionPlan(input, capabilities) },
    providerRuntime: { resolve: async () => ({ adapter, responseTimeoutMs: 300_000 }) } as unknown as RunHandlerDeps["providerRuntime"],
    providers: {},
    repository,
    usageLimits: { loadUsageLimitStatus: async () => options.usage ?? NO_USAGE_LIMITS }
  };
  const loadOwner = vi.fn(async () => owner as AuthenticatedUser | null);
  return { loadOwner, send: createScheduledTaskSend({ loadOwner, sendDeps }), sendDeps, state };
}

function body(target: ScheduledTaskSendTarget, toolCalling = true, tools: Readonly<{ toolsEnabled: boolean; workspaceEnabled: boolean }> =
  { toolsEnabled: false, workspaceEnabled: false }) {
  return scheduledTaskSendBody({
    admissionId: "40000000-0000-4000-8000-000000000004", modelId: "fake-qsa", prompt: "  Summarize the synthetic fixture\n",
    provider: "fake", searchPlan: { mode: "all_selected", optionIds: [] }, target, timeZone: "Europe/Moscow", toolCalling, ...tools
  });
}

/** An available Workspace admission for the run, as the installation's service plans it. */
const workspaceAdmission: NonNullable<RunHandlerDeps["workspace"]> = { prepare: vi.fn(async ({ signal: _signal, ...input }) => ({
  ok: true as const, tools: [], plan: {
  ...input, expiresAt: new Date(Date.now() + 60_000).toISOString(), policyRevision: 1, sandboxName: "scheduled-fixture",
  sessionId: "ws-scheduled", toolDefinitions: [],
  normalized: { enabled: true as const, imageRef: "fixture", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: true,
    maxToolCalls: 64, maxToolRounds: 16, mcpVersion: "fixture", messageManifestPath: `/workspace/inbox/messages/${input.userMessageId}/manifest.json`,
    outputDirectory: `/workspace/output/${input.runId}`, projectDirectory: "/workspace/project", runtimeVersion: "fixture",
    sessionId: "ws-scheduled", syncToolTimeoutSeconds: 30, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 300 }
} })) };

/** The owner's MCP: one connected personal server and one whose sign-in lapsed, so Auto had to leave it out. */
function ownerMcp() {
  const catalog = { servers: [{ description: "Synthetic tickets", instructions: "", namespace: "tracker", revisionId: "revision-tracker",
    serverId: "server-tracker", serverName: "Tracker",
    tools: [{ description: "Read a ticket", namespacedName: "mcp_tracker_read_ticket_1", originalName: "read_ticket" }] }], version: 1 as const };
  const omitted = [{ reason: "mcp_reauthorization_required" as const, serverId: "server-mail", serverName: "Synthetic Mail" }];
  return {
    catalog: vi.fn(async () => catalog),
    catalogWithOmissions: vi.fn(async () => ({ catalog, omitted })),
    filterTools: (async (_userId: string, tools: readonly unknown[]) => [...tools]) as NonNullable<RunHandlerDeps["mcp"]>["filterTools"],
    prepare: vi.fn(async () => ({ code: "mcp_not_ready" as const, issues: [], ok: false as const }))
  };
}

const taskChat: RunOwnedChatRecord = {
  activeLeafMessageId: "assistant-message-0", defaultModelId: "fake-qsa", defaultProvider: "fake", id: "chat-task",
  memoryMode: "EXCLUDED", messageCount: 2, projectMemory: null, title: "Synthetic brief"
};
const say = (id: string, role: "assistant" | "user", text: string): ProviderConversationMessage =>
  ({ content: textMessageContent(text), id, role });
/** Turns the owner wrote in the task's chat. */
const ownerTurns = (prefix: string, count: number) => Array.from({ length: count }, (_value, index) => [
  say(`${prefix}-user-${index}`, "user", `Owner question ${prefix} ${index}`),
  say(`${prefix}-answer-${index}`, "assistant", `Owner answer ${prefix} ${index}`)
]).flat();
const previousResult = { assistantMessageId: "previous-answer", userMessageId: "previous-user" };

/** What the answer model's request holds as conversation, oldest first. */
function conversation(request: ProviderRunRequest): string[][] {
  return textConversationForRequest(request).map((message) => [message.role, message.content]);
}

/** Sends the task prompt into the task's existing chat, whose active branch is `path`. */
async function sendIntoChat(path: readonly ProviderConversationMessage[], origin: ScheduledOccurrenceAdmission,
  chatOverrides: Partial<RunOwnedChatRecord> = {}) {
  const chat: RunOwnedChatRecord = { ...taskChat, activeLeafMessageId: path.at(-1)?.id ?? null, ...chatOverrides };
  const f = fixture({ chat, path });
  const response = await f.send({
    body: body({ activeLeafMessageId: chat.activeLeafMessageId, chatId: chat.id, kind: "existing" }),
    chatId: chat.id, occurrence: origin, userId: owner.id
  });
  expect(response.status).toBe(200);
  await response.text();
  return { chat, f };
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
    // A new chat's run is a first send: its model sees the prompt alone.
    expect(f.state.requests.map(conversation)).toEqual([[["user", "Summarize the synthetic fixture"]]]);
  });

  it("gives a same-chat run only the task's previous result and its prompt, however long the chat grows", async () => {
    const path = [
      ...ownerTurns("before", 40),
      say("previous-user", "user", "Summarize the synthetic fixture"),
      say("previous-answer", "assistant", "Previous synthetic summary"),
      // The owner kept chatting after the result: none of it reaches the task's next run.
      ...ownerTurns("after", 40)
    ];
    const { chat, f } = await sendIntoChat(path, { ...occurrence, previousResult });
    expect(f.state.requests.map(conversation)).toEqual([[
      ["user", "Summarize the synthetic fixture"], ["assistant", "Previous synthetic summary"], ["user", "Summarize the synthetic fixture"]
    ]]);
    expect(f.state.completedText).toBe("Fake answer: Summarize the synthetic fixture\nContext memory: Summarize the synthetic fixture");
    // The selection is frozen with the run, so recovery rebuilds the same context; branch notes are never carried.
    const frozen = f.state.created!.normalizedRequest;
    expect(frozen.context!.messages.map((message) => message.id)).toEqual(["previous-user", "previous-answer", "current-user-message"]);
    expect(frozen.contextCompactionPolicy).toMatchObject({ mode: "hybrid", source: { leafMessageId: null, messageCount: 3 } });
    // The new turn still continues the chat's active leaf, so the transcript stays linear.
    expect(f.state.created).toMatchObject({ expectedActiveLeafId: chat.activeLeafMessageId, scheduledOccurrence: { previousResult } });
  });

  it("starts from the prompt alone once the previous result has left the chat's active path", async () => {
    // An edit or regeneration moved the active branch away from the result, or deleted it.
    const edited = await sendIntoChat(ownerTurns("branch", 3), { ...occurrence, previousResult });
    expect(edited.f.state.requests.map(conversation)).toEqual([[["user", "Summarize the synthetic fixture"]]]);
    // Half a result (its answer regenerated away) is not shown either.
    const regenerated = await sendIntoChat([say("previous-user", "user", "Summarize the synthetic fixture"),
      say("regenerated-answer", "assistant", "Another answer")], { ...occurrence, previousResult });
    expect(regenerated.f.state.requests.map(conversation)).toEqual([[["user", "Summarize the synthetic fixture"]]]);
    // Without a previous result (the first run of a generation) only the prompt is sent, too.
    const first = await sendIntoChat(ownerTurns("before", 5), occurrence);
    expect(first.f.state.requests.map(conversation)).toEqual([[["user", "Summarize the synthetic fixture"]]]);
  });

  it("never applies Memory to a scheduled run, even after the owner turned Memory on in its chat", async () => {
    const snapshot = { version: "memory-search-v1" as const, maxCalls: 3 as const, resultTokens: 6000 as const,
      comparisonResultTokens: 12000 as const, timeoutSeconds: 30, memoryGeneration: 1, referenceChatHistory: true, destinations: [] };
    const chat: RunOwnedChatRecord = { ...taskChat, memoryMode: "NORMAL" };
    const f = fixture({ chat });
    const admit = vi.fn(async () => snapshot);
    const sendDeps = { ...f.sendDeps, memorySearchAdmission: { admit } };
    const scheduled = await createScheduledTaskSend({ loadOwner: f.loadOwner, sendDeps })({
      body: body({ activeLeafMessageId: chat.activeLeafMessageId, chatId: chat.id, kind: "existing" }),
      chatId: chat.id, occurrence, userId: owner.id
    });
    expect(scheduled.status).toBe(200);
    await scheduled.text();
    expect(admit).not.toHaveBeenCalled();
    expect(f.state.created!.normalizedRequest.memoryStandingVersion).toBeUndefined();
    expect(f.state.created!.normalizedRequest.memorySearch).toBeUndefined();
    // The owner's own message in the same chat keeps standing Memory.
    const ordinary = await createSendMessageHandler({ ...sendDeps,
      resolveAuth: scheduledTaskOwnerAuth(f.loadOwner, { taskId: "task-1", userId: owner.id }) })(
      new Request(`http://localhost/api/chats/${chat.id}/messages`, { body: JSON.stringify(
        body({ activeLeafMessageId: chat.activeLeafMessageId, chatId: chat.id, kind: "existing" })), method: "POST" }),
      { params: { chatId: chat.id } });
    expect(ordinary.status).toBe(200);
    await ordinary.text();
    expect(f.state.created!.normalizedRequest.memoryStandingVersion).toBe(1);
    expect(f.state.created).not.toHaveProperty("scheduledOccurrence");
  });

  it("appends a later run to the task's chat after its current leaf", async () => {
    const chat = taskChat;
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

  it("admits the owner's MCP tools and Skills in Auto and the task's Workspace like an ordinary message", async () => {
    const f = fixture();
    const mcp = ownerMcp();
    const sendDeps = { ...f.sendDeps, mcp, workspace: workspaceAdmission };
    const response = await createScheduledTaskSend({ loadOwner: f.loadOwner, sendDeps })({
      body: body({ chatId: newChatId, kind: "new" }, true, { toolsEnabled: true, workspaceEnabled: true }),
      chatId: newChatId, occurrence: { ...occurrence, relevantMcpServerIds: ["server-mail"] }, userId: owner.id
    });
    expect(response.status).toBe(200);
    await response.text();
    const created = f.state.created!;
    // The Auto catalog is frozen, never a Load all plan; Skills run in Auto; the chat gets its Workspace.
    expect(created.normalizedRequest.mcpDiscovery?.catalog.servers.map((server) => server.serverId)).toEqual(["server-tracker"]);
    expect(mcp.prepare).not.toHaveBeenCalled();
    expect(created.normalizedRequest.skills).toMatchObject({ mode: "auto" });
    expect(created.normalizedRequest.workspace).toMatchObject({ enabled: true, sessionId: "ws-scheduled" });
    expect(created).toMatchObject({ personalChat: { memoryMode: "EXCLUDED" }, workspaceEnabled: true });
    expect(created.workspaceAdmissionPlan).toBeDefined();
    expect(created.normalizedRequest.knowledgePlan).toMatchObject({ mode: "none" });
    expect(created.normalizedRequest.agent).toBeUndefined();
    // The lapsed server the previous result relied on: named to the model and frozen with the occurrence.
    expect(created.scheduledUnavailableSources).toEqual([
      { name: "Synthetic Mail", reason: "mcp_reauthorization_required", relied: true, serverId: "server-mail" }
    ]);
    expect(created.normalizedRequest.prompt.system).toContain("\"Synthetic Mail\" (needs the user to sign in again)");
  });

  it("keeps tools and Workspace off for a task that has them off", async () => {
    const f = fixture();
    const mcp = ownerMcp();
    const response = await createScheduledTaskSend({ loadOwner: f.loadOwner, sendDeps: { ...f.sendDeps, mcp, workspace: workspaceAdmission } })({
      body: body({ chatId: newChatId, kind: "new" }), chatId: newChatId, occurrence, userId: owner.id
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(f.state.created!.normalizedRequest.mcpDiscovery).toBeUndefined();
    expect(f.state.created!.normalizedRequest.skills).toMatchObject({ mode: "off" });
    expect(f.state.created).toMatchObject({ workspaceEnabled: false });
    expect(f.state.created).not.toHaveProperty("scheduledUnavailableSources");
    expect(mcp.catalogWithOmissions).not.toHaveBeenCalled();
  });

  it("answers Workspace secret failures at admission with stable codes, a limit permanent and storage transient", async () => {
    for (const [code, status] of [["workspace_secret_limit", 409], ["workspace_secret_unavailable", 503]] as const) {
      const f = fixture();
      f.state.createRun = () => { throw new WorkspaceSecretError(code); };
      const response = await createScheduledTaskSend({ loadOwner: f.loadOwner, sendDeps: { ...f.sendDeps, workspace: workspaceAdmission } })({
        body: body({ chatId: newChatId, kind: "new" }, true, { toolsEnabled: false, workspaceEnabled: true }),
        chatId: newChatId, occurrence, userId: owner.id
      });
      expect([response.status, await response.json()]).toEqual([status, { error: code }]);
    }
  });

  it("applies budgets to a scheduled send but never the owner's message limits", async () => {
    resetBootOrphanSweepForTest();
    const messagesUsedUp: UsageLimitStatus = {
      ...NO_USAGE_LIMITS,
      effective: { ...NO_USAGE_LIMITS.effective, messagesPerDay: { source: { kind: "installation" }, value: 1 } },
      lastDay: { count: 1, freesAt: new Date(Date.now() + 60 * 60_000) }
    };
    const scheduled = fixture({ usage: messagesUsedUp });
    const admitted = await scheduled.send({ body: body({ chatId: newChatId, kind: "new" }), chatId: newChatId, occurrence, userId: owner.id });
    expect(admitted.status).toBe(200);
    await admitted.text();
    expect(scheduled.state.created).toMatchObject({ scheduledOccurrence: occurrence });

    // The owner's own message in the same state is an interactive run and is refused.
    const interactive = fixture({ usage: messagesUsedUp });
    const ownMessage = await createSendMessageHandler({
      ...interactive.sendDeps, resolveAuth: scheduledTaskOwnerAuth(interactive.loadOwner, { taskId: "task-1", userId: owner.id })
    })(new Request(`http://localhost/api/chats/${newChatId}/messages`, {
      body: JSON.stringify(body({ chatId: newChatId, kind: "new" })), method: "POST"
    }), { params: { chatId: newChatId } });
    expect(ownMessage.status).toBe(429);
    expect(await ownMessage.json()).toMatchObject({ error: "message_rate_limited", usageLimit: { limit: 1, used: 1, window: "day" } });
    expect(interactive.state.created).toBeNull();

    const budgetSpent = fixture({ usage: {
      ...NO_USAGE_LIMITS,
      effective: { ...NO_USAGE_LIMITS.effective,
        monthlyBudgetMicros: { source: { groupId: "group-1", kind: "group", name: "Synthetic team" }, value: 1_000_000 } },
      userSpentMicros: 1_000_000
    } });
    const refused = await budgetSpent.send({ body: body({ chatId: newChatId, kind: "new" }), chatId: newChatId, occurrence, userId: owner.id });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({
      error: "usage_budget_exhausted", usageLimit: { limit: 1_000_000, scope: "user", used: 1_000_000, window: "month" }
    });
    expect(budgetSpent.state.created).toBeNull();
    expect(budgetSpent.state.requests).toEqual([]);
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
