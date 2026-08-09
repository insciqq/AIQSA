import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composerSessionKey,
  resetComposerSessionStoreForTest,
  selectActiveComposerSession,
  selectComposerSession,
  useComposerSessionStore,
  type ComposerSessionKey
} from "./composerSessionStore";
import { resetRunSurfaceStoreForTest, useRunSurfaceStore } from "./runSurfaceStore";
import { useWorkspaceActions } from "./workspaceActions";
import { resetThreadStoreForTest, useThreadStore } from "./threadStore";
import { resetWorkspaceStoreForTest, useWorkspaceStore } from "./workspaceStore";
import type { ComposerAttachment } from "@/components/chat/Composer";
import type { Catalog, ChatDetail, ChatSummary, ThreadMessage } from "./types";

function chat(input: Partial<ChatSummary> & { id: string; title: string }): ChatSummary {
  return {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    messageCount: 0,
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...input
  };
}

function message(input: Partial<ThreadMessage> & { id: string }): ThreadMessage {
  return {
    content: input.id,
    parentMessageId: null,
    role: "user",
    status: "complete",
    ...input
  };
}

function catalogModel(modelId: string, displayName: string): Catalog["models"][number] {
  return {
    capabilities: {
      background: false,
      documentInputMode: "none",
      imageInput: false,
      nativeWebSearch: false,
      openRouterPerplexitySearch: false,
      reasoning: false,
      streaming: true,
      toolCalling: false
    },
    contextWindow: 32_000,
    defaultParams: {},
    displayName,
    modelId,
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 4_096, maxValue: 4_096 },
      reasoningEffort: { defaultValue: "none", options: ["none"], supported: false },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "openai",
    searchStrategyIds: ["search-disabled"]
  };
}

function apiChatSummary(summary: ChatSummary) {
  return {
    activeLeafMessageId: summary.activeLeafMessageId,
    createdAt: summary.createdAt,
    defaultKnowledgePlan: summary.defaultKnowledgePlan ?? null,
    defaultModelId: summary.defaultModelId,
    defaultProvider: summary.defaultProvider,
    folderId: summary.folderId,
    id: summary.id,
    messageCount: summary.messageCount,
    pinned: summary.pinned ?? false,
    title: summary.title,
    updatedAt: summary.updatedAt
  };
}

function apiChatDetail(summary: ChatSummary, messages: ThreadMessage[]) {
  return {
    ...apiChatSummary(summary),
    messageCount: messages.length,
    messages: messages.map((candidate) => ({
      artifactSummary: candidate.artifactSummary ?? null,
      content: candidate.content,
      createdAt: "2026-06-10T00:00:00.000Z",
      errorMessage: null,
      id: candidate.id,
      modelId: candidate.modelId ?? null,
      modelRunId: candidate.runId ?? null,
      parentMessageId: candidate.parentMessageId,
      provider: candidate.provider ?? null,
      role: candidate.role,
      status: candidate.status
    })),
    usageStats: null
  };
}

function useWorkspaceActionsForTest(input: {
  activeChatId?: string | null;
  attachments: ComposerAttachment[];
  draft: string;
  includeConcurrentChat?: boolean;
  activeStreamChatIds?: string[];
}) {
  const catalog = {
    defaults: {
      controlValues: {},
      hasPersonalModelDefault: true,
      modelId: "gpt-5.5",
      modelPreferenceSource: "personal",
      organizationModelDefault: null,
      personalModelDefault: { modelId: "gpt-5.5", provider: "openai" },
      provider: "openai",
      searchStrategyId: "search-disabled",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
    },
    models: [],
    providers: [],
    searchStrategies: []
  } satisfies Catalog;
  const chatA = chat({ id: "chat-a", title: "Chat A" });
  const chatB = chat({ id: "chat-b", title: "Chat B" });
  const chatC = chat({ id: "chat-c", title: "Streamed Chat" });
  const activeChatId = input.activeChatId === undefined ? "chat-a" : input.activeChatId;
  const activeChatIdRef = { current: activeChatId };
  const initialChats = [chatA, chatB, ...(input.includeConcurrentChat ? [chatC] : [])];
  resetComposerSessionStoreForTest();
  resetRunSurfaceStoreForTest();
  resetThreadStoreForTest();
  resetWorkspaceStoreForTest();
  useWorkspaceStore.setState({
    activeChatId,
    catalog,
    chats: initialChats
  });
  useComposerSessionStore
    .getState()
    .activateSession(composerSessionKey(activeChatId));
  useComposerSessionStore.getState().setAttachments(input.attachments);
  useComposerSessionStore.getState().setDraft(input.draft);
  const confirmDeleteChat = vi.fn(async () => true);
  const applyModelControlDefaults = vi.fn();
  const resumeChatRun = vi.fn();
  const setSelectedModelId = vi.fn();
  const setSelectedKnowledgePlan = vi.fn();
  const setSelectedProvider = vi.fn();
  const setSelectedSearchPlan = vi.fn();
  const setNotice = vi.fn();
  const chatMutation = {
    closeActions: vi.fn(),
    editingTitle: "",
    finishEditing: vi.fn()
  };
  const activeStreamChatIds = new Set(input.activeStreamChatIds ?? []);
  const chatHasActiveStream = vi.fn((chatId: string) => activeStreamChatIds.has(chatId));
  const workspaceRefreshPromiseRef = { current: null } as {
    current: Promise<ChatDetail | null> | null;
  };
  const actions = useWorkspaceActions({
    activeChatIdRef,
    applyModelControlDefaults,
    chatDetailRequestsRef: { current: new Map() },
    chatHasActiveStream,
    chatMutation,
    confirmDeleteChat,
    loadingChatDetailIdRef: { current: null },
    resumeChatRun,
    setNotice,
    setSelectedModelId,
    setSelectedKnowledgePlan,
    setSelectedProvider,
    setSelectedSearchPlan,
    workspaceRefreshPromiseRef
  });

  return {
    actions,
    applyModelControlDefaults,
    activeComposer: () => selectActiveComposerSession(useComposerSessionStore.getState()),
    attachments: () => selectActiveComposerSession(useComposerSessionStore.getState()).attachments,
    chatA,
    chatB,
    chatC,
    chatHasActiveStream,
    chats: () => useWorkspaceStore.getState().chats,
    confirmDeleteChat,
    draft: () => selectActiveComposerSession(useComposerSessionStore.getState()).draft,
    resumeChatRun,
    session: (key: ComposerSessionKey) =>
      selectComposerSession(useComposerSessionStore.getState(), key),
    setNotice,
    setSelectedModelId,
    setSelectedKnowledgePlan,
    setSelectedProvider,
    setSelectedSearchPlan,
    setComposerState(
      nextDraft: string,
      nextAttachments: ComposerAttachment[],
      editingMessageId: string | null = null
    ) {
      useComposerSessionStore.getState().setDraft(nextDraft);
      useComposerSessionStore.getState().setAttachments(nextAttachments);
      useComposerSessionStore.getState().setEditingMessageId(editingMessageId);
    }
  };
}

describe("workspace actions", () => {
  afterEach(() => {
    resetComposerSessionStoreForTest();
    resetRunSurfaceStoreForTest();
    resetThreadStoreForTest();
    resetWorkspaceStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("selects independent saved, root, and folder composer sessions", async () => {
    const attachmentA = {
      fileName: "a.pdf",
      id: "attachment-a",
      kind: "pdf" as const
    };
    const attachmentB = {
      fileName: "b.pdf",
      id: "attachment-b",
      kind: "pdf" as const
    };
    const state = useWorkspaceActionsForTest({
      attachments: [attachmentA],
      draft: "Draft A"
    });
    useComposerSessionStore.getState().setEditingMessageId("message-a");
    const chatAKey = composerSessionKey("chat-a");
    const chatBKey = composerSessionKey("chat-b");
    const blankRootKey = composerSessionKey(null);
    const blankFolderKey = composerSessionKey(null, "folder-1");

    await state.actions.activateChat(state.chatB, { resumeRuns: false });
    expect(state.session(chatAKey)).toMatchObject({
      attachments: [attachmentA],
      draft: "Draft A",
      editingMessageId: "message-a"
    });
    expect(state.draft()).toBe("");
    expect(state.attachments()).toEqual([]);

    state.setComposerState("Draft B", [attachmentB], "message-b");
    state.actions.activateBlankWorkspace();
    state.setComposerState("Root draft", [], null);
    state.actions.activateBlankWorkspace("folder-1");
    state.setComposerState("Folder draft", [attachmentA], null);

    await state.actions.activateChat(state.chatA, { resumeRuns: false });
    expect(state.activeComposer()).toMatchObject({
      attachments: [attachmentA],
      draft: "Draft A",
      editingMessageId: "message-a"
    });

    state.actions.activateBlankWorkspace();
    expect(state.activeComposer()).toMatchObject({
      attachments: [],
      draft: "Root draft",
      editingMessageId: null
    });

    state.actions.activateBlankWorkspace("folder-1");
    expect(state.activeComposer()).toMatchObject({
      attachments: [attachmentA],
      draft: "Folder draft",
      editingMessageId: null
    });

    await state.actions.activateChat(state.chatB, { resumeRuns: false });
    expect(state.session(chatBKey)).toMatchObject({
      attachments: [attachmentB],
      draft: "Draft B",
      editingMessageId: "message-b"
    });
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(chatBKey);
    expect(state.session(blankRootKey).draft).toBe("Root draft");
    expect(state.session(blankFolderKey).draft).toBe("Folder draft");
  });

  it("deletes chats with a functional list update so concurrent rows survive", async () => {
    const state = useWorkspaceActionsForTest({
      activeChatId: "chat-b",
      attachments: [],
      draft: "",
      includeConcurrentChat: true
    });
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-a"));
    useComposerSessionStore.getState().setDraft("Deleted chat draft");
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-b"));
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "message-a",
      messages: [message({ id: "message-a" })],
      usageStats: null
    });
    useRunSurfaceStore.getState().appendEvent("chat-a", {
      data: { runId: "run-a" },
      type: "run_start"
    });
    useRunSurfaceStore.getState().appendEvent("chat-b", {
      data: { runId: "run-b" },
      type: "run_start"
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await state.actions.deleteChat(state.chatA);

    expect(state.confirmDeleteChat).toHaveBeenCalledWith(state.chatA);
    expect(state.chats().map((candidate) => candidate.id)).toEqual(["chat-b", "chat-c"]);
    expect(useThreadStore.getState().threadsByChatId["chat-a"]).toBeUndefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-a"]).toBeUndefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-b"]?.events).toHaveLength(1);
    expect(useComposerSessionStore.getState().sessionsByKey[composerSessionKey("chat-a")]).toBeUndefined();
  });

  it("blocks deletion of an inactive chat while that chat owns a stream", async () => {
    const state = useWorkspaceActionsForTest({
      activeChatId: "chat-b",
      activeStreamChatIds: ["chat-a"],
      attachments: [],
      draft: ""
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.deleteChat(state.chatA);

    expect(state.chatHasActiveStream).toHaveBeenCalledWith("chat-a");
    expect(state.confirmDeleteChat).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.chats().map((candidate) => candidate.id)).toEqual(["chat-a", "chat-b"]);
    expect(state.setNotice).toHaveBeenCalledWith({
      kind: "error",
      text: "Stop the running response before deleting this chat."
    });
  });

  it("does not let an older detail response resurrect a deleted chat", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    let resolveDetail!: (response: Response) => void;
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "/api/chats/chat-a" && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      return new Promise<Response>((resolve) => {
        resolveDetail = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pendingDetail = state.actions.fetchChatDetail("chat-a");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a"));
    await state.actions.deleteChat(state.chatA);
    resolveDetail(
      Response.json({
        chat: apiChatDetail(state.chatA, [message({ id: "late-message" })])
      })
    );

    await expect(pendingDetail).resolves.toBeNull();
    expect(state.chats().some((candidate) => candidate.id === "chat-a")).toBe(false);
    expect(useThreadStore.getState().threadsByChatId["chat-a"]).toBeUndefined();
  });

  it("waits out a pre-terminal detail request before forcing post-terminal detail", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const older = state.actions.fetchChatDetail("chat-a");
    const forced = state.actions.refreshActiveChat("chat-a", {
      forceDetail: true,
      preserveControls: true,
      resumeRuns: false
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers.shift()?.(
      Response.json({
        chat: {
          ...apiChatDetail(state.chatA, [message({ id: "old-leaf" })]),
          usageStats: {
            activeBranchMessageCount: 1,
            cachedInputTokens: 1,
            cacheWriteInputTokens: 0,
            totalTokens: 4
          }
        }
      })
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolvers.shift()?.(
      Response.json({
        chat: {
          ...apiChatDetail(state.chatA, [message({ id: "new-leaf" })]),
          usageStats: {
            activeBranchMessageCount: 1,
            cachedInputTokens: 2,
            cacheWriteInputTokens: 0,
            totalTokens: 8
          }
        }
      })
    );

    await older;
    await expect(forced).resolves.toMatchObject({
      messages: [{ id: "new-leaf" }],
      usageStats: { totalTokens: 8 }
    });
  });

  it("cancels chat deletion when the custom confirmation is dismissed", async () => {
    const state = useWorkspaceActionsForTest({
      activeChatId: "chat-b",
      attachments: [],
      draft: ""
    });
    state.confirmDeleteChat.mockResolvedValueOnce(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.deleteChat(state.chatA);

    expect(state.confirmDeleteChat).toHaveBeenCalledWith(state.chatA);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.chats().map((candidate) => candidate.id)).toEqual(["chat-a", "chat-b"]);
  });

  it("activates a blank workspace without creating a persisted chat", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: "Draft A"
    });
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "message-1",
      messages: [
        {
          content: "Question",
          id: "message-1",
          parentMessageId: null,
          role: "user",
          status: "complete"
        }
      ],
      usageStats: null
    });

    state.actions.activateBlankWorkspace();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeChatId: null,
      pendingChatFolderId: null
    });
    expect(useThreadStore.getState().threadsByChatId["chat-a"]).toMatchObject({
      activeLeafId: "message-1",
      messages: [expect.objectContaining({ id: "message-1" })]
    });
  });

  it("reapplies recovered catalog defaults without repeating chat activation or run resume", () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    const recoveredCatalog: Catalog = {
      defaults: {
        controlValues: {
          "openai:gpt-5.5": {
            maxOutputTokens: "2048",
            temperature: "0.25"
          }
        },
        hasPersonalModelDefault: true,
        modelId: "catalog-startup",
        modelPreferenceSource: "personal",
        organizationModelDefault: null,
        personalModelDefault: { modelId: "catalog-startup", provider: "openai" },
        provider: "openai",
        searchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true,
      },
      models: [
        {
          capabilities: {
            background: false,
            documentInputMode: "none",
            imageInput: false,
            nativeWebSearch: false,
            openRouterPerplexitySearch: false,
            reasoning: false,
            streaming: true,
            toolCalling: false
          },
          contextWindow: 8_192,
          defaultParams: {},
          displayName: "Recovered chat model",
          modelId: "gpt-5.5",
          parameterControls: {
            background: { defaultValue: false, supported: false },
            maxOutputTokens: { defaultValue: 1_024, maxValue: 4_096 },
            reasoningEffort: { defaultValue: "none", options: ["none"], supported: false },
            stream: { defaultValue: true, supported: true },
            temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
          },
          provider: "openai",
          searchStrategyIds: ["search-disabled"]
        }
      ],
      providers: [{ id: "openai", models: ["gpt-5.5"], name: "OpenAI" }],
      searchStrategies: [{ displayName: "No Search", kind: "none", strategyId: "search-disabled" }]
    };

    expect(state.actions.reapplyActiveChatDefaults(recoveredCatalog)).toBe(true);
    expect(state.setSelectedProvider).toHaveBeenCalledWith("openai", "system");
    expect(state.setSelectedModelId).toHaveBeenCalledWith("gpt-5.5", "system");
    expect(state.setSelectedSearchPlan).toHaveBeenCalledWith([], "all_selected", "system");
    expect(state.applyModelControlDefaults).toHaveBeenCalledWith(
      recoveredCatalog.models[0],
      recoveredCatalog.defaults.controlValues
    );
    expect(state.resumeChatRun).not.toHaveBeenCalled();
  });

  it("remembers a pending folder for folder-scoped blank chats", () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });

    state.actions.activateBlankWorkspace("folder-1");

    expect(useWorkspaceStore.getState().pendingChatFolderId).toBe("folder-1");
  });

  it("applies only the exact runnable catalog default when a new blank chat opens", () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const previous = catalogModel("gpt-5.5", "GPT-5.5");
    const luna = catalogModel("gpt-5.6-luna", "GPT-5.6 Luna");
    const currentCatalog = useWorkspaceStore.getState().catalog!;
    useWorkspaceStore.setState({
      catalog: {
        ...currentCatalog,
        defaults: {
          ...currentCatalog.defaults,
          modelId: luna.modelId,
          personalModelDefault: { modelId: luna.modelId, provider: luna.provider },
          provider: luna.provider
        },
        models: [previous, luna],
        providers: [{ id: "openai", models: [previous.modelId, luna.modelId], name: "OpenAI" }]
      }
    });
    state.setSelectedModelId.mockClear();
    state.setSelectedProvider.mockClear();
    state.applyModelControlDefaults.mockClear();

    state.actions.activateBlankWorkspace();

    expect(state.setSelectedProvider).toHaveBeenCalledWith("openai", "system");
    expect(state.setSelectedModelId).toHaveBeenCalledWith("gpt-5.6-luna", "system");
    expect(state.applyModelControlDefaults).toHaveBeenCalledWith(
      luna,
      currentCatalog.defaults.controlValues
    );

    useWorkspaceStore.setState((workspace) => ({
      catalog: workspace.catalog
        ? {
            ...workspace.catalog,
            defaults: { ...workspace.catalog.defaults, modelId: "hidden-model", provider: "hidden" }
          }
        : null
    }));
    state.setSelectedModelId.mockClear();
    state.setSelectedProvider.mockClear();
    state.actions.activateBlankWorkspace();
    expect(state.setSelectedProvider).toHaveBeenCalledWith("", "system");
    expect(state.setSelectedModelId).toHaveBeenCalledWith("", "system");
  });

  it("transfers the selected blank session only after chat creation succeeds", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const sourceKey = composerSessionKey(null, "folder-1");
    const attachment = {
      fileName: "first-send.pdf",
      id: "attachment-first-send",
      kind: "pdf" as const
    };
    state.actions.activateBlankWorkspace("folder-1");
    state.setSelectedModelId.mockClear();
    state.setSelectedProvider.mockClear();
    state.setComposerState("First send", [attachment]);
    const created = chat({
      folderId: "folder-1",
      id: "chat-created",
      title: "Created chat"
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ chat: { id: "malformed-chat" } }))
      .mockResolvedValueOnce(
        Response.json({
          chat: {
            ...apiChatSummary(created),
            defaultModelId: "server-model-a",
            defaultProvider: "server-provider-a"
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(state.actions.createChat("folder-1", sourceKey)).resolves.toBeNull();
    expect(state.chats().some((candidate) => candidate.id === "malformed-chat")).toBe(false);
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(sourceKey);
    expect(state.session(sourceKey)).toMatchObject({
      attachments: [attachment],
      draft: "First send"
    });
    expect(state.setSelectedModelId).not.toHaveBeenCalled();
    expect(state.setSelectedProvider).not.toHaveBeenCalled();

    await expect(state.actions.createChat("folder-1", sourceKey)).resolves.toMatchObject({
      defaultModelId: "server-model-a",
      defaultProvider: "server-provider-a",
      id: "chat-created"
    });
    const targetKey = composerSessionKey("chat-created");
    expect(useWorkspaceStore.getState().activeChatId).toBe("chat-created");
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(targetKey);
    expect(useComposerSessionStore.getState().sessionsByKey[sourceKey]).toBeUndefined();
    expect(state.session(targetKey)).toMatchObject({
      attachments: [attachment],
      draft: "First send"
    });
    expect(state.setSelectedModelId).not.toHaveBeenCalled();
    expect(state.setSelectedProvider).not.toHaveBeenCalled();
  });

  it("still applies saved defaults during ordinary chat activation", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const savedChat = {
      ...state.chatB,
      defaultModelId: "saved-model-a",
      defaultProvider: "saved-provider-a"
    };

    await state.actions.activateChat(savedChat, { resumeRuns: false });

    expect(state.setSelectedModelId).toHaveBeenCalledWith("saved-model-a", "system");
    expect(state.setSelectedProvider).toHaveBeenCalledWith("saved-provider-a", "system");
  });

  it("resolves Knowledge defaults as chat, then project, then Off", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    useWorkspaceStore.setState({
      folders: [{
        defaultKnowledgePlan: { baseIds: ["project-base"] },
        id: "folder-1",
        name: "Research",
        parentId: null,
        projectMemory: "",
        sortOrder: 0
      }]
    });

    await state.actions.activateChat({
      ...state.chatB,
      defaultKnowledgePlan: { baseIds: ["chat-base"] },
      folderId: "folder-1"
    }, { resumeRuns: false });
    expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith(
      ["chat-base"], "chat", "system"
    );

    await state.actions.activateChat({
      ...state.chatA,
      defaultKnowledgePlan: null,
      folderId: "folder-1"
    }, { resumeRuns: false });
    expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith(
      ["project-base"], "project", "system"
    );

    state.actions.activateBlankWorkspace();
    expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith([], "off", "system");
    state.actions.activateBlankWorkspace("folder-1");
    expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith(
      ["project-base"], "project", "system"
    );
  });

  it("persists a chat Knowledge default and reapplies its effective source", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const updated = {
      ...state.chatA,
      defaultKnowledgePlan: { baseIds: ["base-policies"] },
      updatedAt: "2026-06-10T00:01:00.000Z"
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ chat: apiChatSummary(updated) }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(state.actions.setChatKnowledgeDefault({
      baseIds: ["base-policies"]
    })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a", expect.objectContaining({
      body: JSON.stringify({ defaultKnowledgePlan: { baseIds: ["base-policies"] } }),
      method: "PATCH"
    }));
    expect(state.chats().find((chat) => chat.id === "chat-a")?.defaultKnowledgePlan).toEqual({
      baseIds: ["base-policies"]
    });
    expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith(
      ["base-policies"], "chat", "system"
    );
  });

  it("does not let a late chat Knowledge save replace a newer workspace plan", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    let resolveSave!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveSave = resolve;
    })));

    const pendingSave = state.actions.setChatKnowledgeDefault({ baseIds: ["base-policies"] });
    await vi.waitFor(() => expect(resolveSave).toBeTypeOf("function"));
    state.actions.activateBlankWorkspace();
    state.setSelectedKnowledgePlan.mockClear();
    resolveSave(Response.json({
      chat: apiChatSummary({
        ...state.chatA,
        defaultKnowledgePlan: { baseIds: ["base-policies"] }
      })
    }));

    await expect(pendingSave).resolves.toBe(true);
    expect(state.setSelectedKnowledgePlan).not.toHaveBeenCalled();
    expect(state.chats().find((candidate) => candidate.id === "chat-a")?.defaultKnowledgePlan)
      .toEqual({ baseIds: ["base-policies"] });
  });

  it("transfers an inactive blank session without stealing the selected chat", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const sourceKey = composerSessionKey(null);
    state.actions.activateBlankWorkspace();
    state.setComposerState("Background first send", []);
    await state.actions.activateChat(state.chatB, { resumeRuns: false });
    const created = chat({ id: "chat-background", title: "Background chat" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ chat: apiChatSummary(created) }))
    );

    await state.actions.createChat(null, sourceKey);

    expect(useWorkspaceStore.getState().activeChatId).toBe("chat-b");
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(
      composerSessionKey("chat-b")
    );
    expect(useComposerSessionStore.getState().sessionsByKey[sourceKey]).toBeUndefined();
    expect(state.session(composerSessionKey("chat-background")).draft).toBe(
      "Background first send"
    );
  });

  it("owns active-chat detail failures inline without duplicating a shell notice", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await state.actions.activateChat({
      ...state.chatA,
      messageCount: 1
    });

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeChatDetailError: "Chat detail load failed with HTTP 503 (chat_detail_failed_503)",
      activeChatDetailLoading: false,
      activeChatId: "chat-a"
    });
    expect(state.setNotice).not.toHaveBeenCalled();
  });

  it("rejects a detail response whose chat id does not match the requested chat", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    const requested = {
      ...state.chatA,
      messageCount: 1
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          chat: apiChatDetail(
            {
              ...state.chatB,
              activeLeafMessageId: "message-b",
              messageCount: 1
            },
            [message({ id: "message-b" })]
          )
        })
      )
    );

    await state.actions.activateChat(requested, { resumeRuns: false });

    expect(useThreadStore.getState().threadsByChatId).toEqual({});
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeChatDetailError: "Chat detail response was malformed (chat_detail_malformed)",
      activeChatDetailLoading: false,
      activeChatId: "chat-a"
    });
  });

  it("reuses a completed keyed thread after switching away without a second detail request", async () => {
    const state = useWorkspaceActionsForTest({
      activeChatId: "chat-b",
      attachments: [],
      draft: ""
    });
    const detailMessages = [
      message({ content: "Question", id: "user-a" }),
      message({
        content: "Answer",
        id: "assistant-a",
        parentMessageId: "user-a",
        role: "assistant"
      })
    ];
    const lazyChat = {
      ...state.chatA,
      activeLeafMessageId: "assistant-a",
      messageCount: detailMessages.length
    };
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        chat: apiChatDetail(lazyChat, detailMessages)
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.activateChat(lazyChat, { resumeRuns: false });
    state.actions.activateBlankWorkspace();
    const cachedSummary = state.chats().find((candidate) => candidate.id === lazyChat.id);
    expect(cachedSummary).toBeDefined();
    await state.actions.activateChat(cachedSummary!, { resumeRuns: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a");
    expect(useThreadStore.getState().threadsByChatId["chat-a"]).toMatchObject({
      activeLeafId: "assistant-a",
      messages: [
        expect.objectContaining({ id: "user-a" }),
        expect.objectContaining({ id: "assistant-a" })
      ]
    });
  });

  it("refetches same-count cache entries when the server summary revision advances", async () => {
    const state = useWorkspaceActionsForTest({
      activeChatId: "chat-b",
      attachments: [],
      draft: ""
    });
    const summary = {
      ...state.chatA,
      activeLeafMessageId: "message-a",
      messageCount: 1,
      updatedAt: "2026-06-10T00:05:00.000Z"
    };
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "message-a",
      messages: [message({ content: "stale", id: "message-a" })],
      sourceUpdatedAt: "2026-06-10T00:00:00.000Z",
      usageStats: null
    });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        chat: apiChatDetail(summary, [message({ content: "server current", id: "message-a" })])
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.activateChat(summary, { resumeRuns: false });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useThreadStore.getState().threadsByChatId["chat-a"]).toMatchObject({
      sourceUpdatedAt: summary.updatedAt
    });
    expect(useThreadStore.getState().threadsByChatId["chat-a"]?.messages[0]?.content).toBe(
      "server current"
    );
  });

  it("refetches an optimistic thread marked incomplete after terminal refresh failure", async () => {
    const state = useWorkspaceActionsForTest({
      activeChatId: "chat-b",
      attachments: [],
      draft: ""
    });
    const summary = {
      ...state.chatA,
      activeLeafMessageId: "assistant-optimistic",
      messageCount: 1
    };
    useThreadStore.getState().replaceThread(summary.id, {
      activeLeafId: "assistant-optimistic",
      messages: [
        message({ content: "Question", id: "user-1" }),
        message({
          content: "Optimistic answer",
          id: "assistant-optimistic",
          parentMessageId: "user-1",
          role: "assistant"
        })
      ],
      sourceUpdatedAt: null,
      usageStats: null
    });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        chat: apiChatDetail(summary, [
          message({ content: "Question", id: "user-1" }),
          message({
            content: "Canonical answer",
            id: "assistant-canonical",
            parentMessageId: "user-1",
            role: "assistant"
          })
        ])
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.activateChat(summary, { resumeRuns: false });

    expect(fetchMock).toHaveBeenCalledWith(`/api/chats/${summary.id}`);
    expect(useThreadStore.getState().threadsByChatId[summary.id]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Canonical answer", id: "assistant-canonical" })
      ])
    );
  });

  it("keeps concurrent token content and the current leaf when stale detail resolves", async () => {
    const state = useWorkspaceActionsForTest({
      activeChatId: "chat-b",
      attachments: [],
      draft: ""
    });
    const initialMessages = [
      message({ content: "Question", id: "user-a" }),
      message({
        content: "Partial",
        id: "assistant-a",
        parentMessageId: "user-a",
        role: "assistant",
        status: "streaming"
      })
    ];
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "assistant-a",
      messages: initialMessages,
      usageStats: null
    });
    const lazyChat = {
      ...state.chatA,
      activeLeafMessageId: "assistant-server",
      messageCount: 3
    };
    const serverMessages = [
      message({ content: "Question from server", id: "user-a" }),
      message({
        content: "Stale partial",
        id: "assistant-a",
        parentMessageId: "user-a",
        role: "assistant",
        status: "streaming"
      }),
      message({
        content: "Server sibling",
        id: "assistant-server",
        parentMessageId: "user-a",
        role: "assistant"
      })
    ];
    let resolveDetail!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveDetail = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const activation = state.actions.activateChat(lazyChat, { resumeRuns: false });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a"));
    useThreadStore.getState().updateMessages("chat-a", (current) =>
      current.map((candidate) =>
        candidate.id === "assistant-a" ? { ...candidate, content: "Partial plus live token" } : candidate
      )
    );
    useThreadStore.getState().mergeMessages(
      "chat-a",
      [
        message({
          content: "Optimistic current answer",
          id: "assistant-live",
          parentMessageId: "user-a",
          role: "assistant",
          status: "streaming"
        })
      ],
      { activeLeafId: "assistant-live" }
    );
    useWorkspaceStore.getState().updateChats((current) =>
      current.map((candidate) =>
        candidate.id === "chat-a"
          ? {
              ...candidate,
              activeLeafMessageId: "assistant-live",
              messageCount: 4,
              title: "Live terminal title",
              updatedAt: "2026-06-10T00:03:00.000Z"
            }
          : candidate
      )
    );
    resolveDetail(
      Response.json({
        chat: apiChatDetail(lazyChat, serverMessages)
      })
    );
    await activation;

    const cached = useThreadStore.getState().threadsByChatId["chat-a"];
    expect(cached.activeLeafId).toBe("assistant-live");
    expect(cached.messages.find((candidate) => candidate.id === "assistant-a")?.content).toBe(
      "Partial plus live token"
    );
    expect(cached.messages.map((candidate) => candidate.id)).toEqual([
      "user-a",
      "assistant-a",
      "assistant-server",
      "assistant-live"
    ]);
    expect(state.chats().find((candidate) => candidate.id === "chat-a")).toMatchObject({
      activeLeafMessageId: "assistant-live",
      messageCount: 4,
      title: "Live terminal title"
    });
  });

  it("exports the active branch from keyed detail without fetching", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    const summary = {
      ...state.chatA,
      activeLeafMessageId: "assistant-b",
      messageCount: 3
    };
    useWorkspaceStore.getState().updateChats((current) =>
      current.map((candidate) => (candidate.id === summary.id ? summary : candidate))
    );
    useThreadStore.getState().replaceThread(summary.id, {
      activeLeafId: "assistant-b",
      messages: [
        message({ content: "Question", id: "user-1" }),
        message({ content: "Branch A", id: "assistant-a", parentMessageId: "user-1", role: "assistant" }),
        message({ content: "Branch B", id: "assistant-b", parentMessageId: "user-1", role: "assistant" })
      ],
      sourceUpdatedAt: summary.updatedAt,
      usageStats: null
    });
    const fetchMock = vi.fn();
    let exportedText = "";
    class CapturedBlob {
      constructor(parts: BlobPart[]) {
        exportedText = parts.map((part) => (typeof part === "string" ? part : "")).join("");
      }
    }
    vi.stubGlobal("Blob", CapturedBlob);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.exportChat(summary);

    expect(fetchMock).not.toHaveBeenCalled();
    const payload = JSON.parse(exportedText) as {
      messages: { content: unknown }[];
      title: string;
    };
    expect(payload.title).toBe("Chat A");
    expect(payload.messages.map((candidate) => candidate.content)).toEqual([
      "Question",
      "Branch B"
    ]);
  });

  it("refreshes a same-count stale thread before exporting it", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    const summary = {
      ...state.chatA,
      activeLeafMessageId: "message-a",
      messageCount: 1,
      updatedAt: "2026-06-10T00:05:00.000Z"
    };
    useWorkspaceStore.getState().updateChats((current) =>
      current.map((candidate) => (candidate.id === summary.id ? summary : candidate))
    );
    useThreadStore.getState().replaceThread(summary.id, {
      activeLeafId: "message-a",
      messages: [message({ content: "stale export", id: "message-a" })],
      sourceUpdatedAt: "2026-06-10T00:00:00.000Z",
      usageStats: null
    });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        chat: apiChatDetail(summary, [message({ content: "current export", id: "message-a" })])
      })
    );
    let exportedText = "";
    class CapturedBlob {
      constructor(parts: BlobPart[]) {
        exportedText = parts.map((part) => (typeof part === "string" ? part : "")).join("");
      }
    }
    vi.stubGlobal("Blob", CapturedBlob);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.exportChat(summary);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(exportedText)).toMatchObject({
      messages: [{ content: "current export" }]
    });
    expect(useThreadStore.getState().threadsByChatId[summary.id]?.sourceUpdatedAt).toBe(
      summary.updatedAt
    );
  });

  it("hydrates an incomplete thread once before export and reuses it", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    const messages = [
      message({ content: "Question", id: "user-1" }),
      message({ content: "Answer", id: "assistant-1", parentMessageId: "user-1", role: "assistant" })
    ];
    const summary = {
      ...state.chatA,
      activeLeafMessageId: "assistant-1",
      messageCount: messages.length
    };
    useWorkspaceStore.getState().updateChats((current) =>
      current.map((candidate) => (candidate.id === summary.id ? summary : candidate))
    );
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        chat: apiChatDetail(summary, messages)
      })
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.exportChat(summary);
    await state.actions.exportChat(summary);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a");
    expect(useThreadStore.getState().threadsByChatId["chat-a"]?.messages).toHaveLength(2);
  });

  it("favorites chats and keeps favorite rows sorted ahead of newer rows", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          chat: {
            ...state.chatA,
            pinned: true,
            updatedAt: "2026-06-09T00:00:00.000Z"
          }
        }),
        {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.toggleChatFavorite(state.chatA);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/chat-a",
      expect.objectContaining({
        body: JSON.stringify({ pinned: true }),
        method: "PATCH"
      })
    );
    expect(state.chats().map((candidate) => candidate.id)).toEqual(["chat-a", "chat-b"]);
    expect(state.chats()[0]?.pinned).toBe(true);
  });

  it("keeps an initial workspace failure inline without also raising a shell notice", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await state.actions.refreshWorkspace();

    expect(useWorkspaceStore.getState()).toMatchObject({
      workspaceError: "Workspace load failed with HTTP 503 (workspace_failed_503)",
      workspaceLoading: false,
      workspaceReady: false
    });
    expect(state.setNotice).not.toHaveBeenCalled();
  });

  it("preserves a hydrated workspace and reports later refresh failures as notices", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    useWorkspaceStore.getState().setWorkspaceReady(true);
    const previousChats = state.chats();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 502 })));

    await state.actions.refreshWorkspace();

    expect(useWorkspaceStore.getState()).toMatchObject({
      chats: previousChats,
      workspaceError: null,
      workspaceLoading: false,
      workspaceReady: true
    });
    expect(state.setNotice).toHaveBeenCalledOnce();
    expect(state.setNotice).toHaveBeenCalledWith({
      kind: "error",
      text: "Workspace load failed with HTTP 502 (workspace_failed_502)"
    });
  });

  it("hydrates a workspace containing a chat without a default model", async () => {
    const state = useWorkspaceActionsForTest({
      activeChatId: null,
      attachments: [],
      draft: ""
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          chats: [
            {
              ...apiChatSummary(state.chatA),
              defaultModelId: null,
              defaultProvider: null
            }
          ],
          contentMatches: [],
          folders: []
        })
      )
    );

    await state.actions.refreshWorkspace(null);

    expect(useWorkspaceStore.getState()).toMatchObject({
      chats: [
        expect.objectContaining({
          defaultModelId: "",
          defaultProvider: "",
          id: state.chatA.id
        })
      ],
      workspaceError: null,
      workspaceLoading: false,
      workspaceReady: true
    });
    expect(state.setNotice).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent workspace retries and marks the first successful load ready", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    let resolveWorkspace: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveWorkspace = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = state.actions.refreshWorkspace();
    const second = state.actions.refreshWorkspace();

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledOnce();
    resolveWorkspace?.(
      new Response(JSON.stringify({ chats: [], contentMatches: [], folders: [] }), {
        headers: { "content-type": "application/json" },
        status: 200
      })
    );
    await Promise.all([first, second]);

    expect(useWorkspaceStore.getState()).toMatchObject({
      chats: [],
      folders: [],
      workspaceError: null,
      workspaceLoading: false,
      workspaceReady: true
    });
    expect(state.setNotice).not.toHaveBeenCalled();
  });

  it("prunes remotely removed threads and clears a missing active selection", async () => {
    const state = useWorkspaceActionsForTest({
      activeStreamChatIds: ["chat-c"],
      attachments: [],
      draft: "",
      includeConcurrentChat: true
    });
    useComposerSessionStore.getState().setDraft("Removed chat draft");
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-b"));
    useComposerSessionStore.getState().setDraft("Retained chat draft");
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-c"));
    useComposerSessionStore.getState().setDraft("Streaming chat draft");
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-a"));
    for (const summary of [state.chatA, state.chatB, state.chatC]) {
      useThreadStore.getState().replaceThread(summary.id, {
        activeLeafId: null,
        messages: [],
        sourceUpdatedAt: summary.updatedAt,
        usageStats: null
      });
      useRunSurfaceStore.getState().appendEvent(summary.id, {
        data: { chatId: summary.id },
        type: "run_start"
      });
    }
    state.actions.activateBlankWorkspace("remote-folder");
    useComposerSessionStore.getState().setDraft("Remote folder draft");
    const removedFolderUpload = useComposerSessionStore
      .getState()
      .beginUpload(composerSessionKey(null, "remote-folder"))!;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        Response.json({
          chats: [apiChatSummary(state.chatB)],
          contentMatches: [],
          folders: []
        })
      )
    );

    await state.actions.refreshWorkspace();

    expect(state.chats().map((candidate) => candidate.id)).toEqual(["chat-b"]);
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
    expect(useWorkspaceStore.getState().pendingChatFolderId).toBeNull();
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(composerSessionKey(null));
    expect(useThreadStore.getState().threadsByChatId["chat-a"]).toBeUndefined();
    expect(useThreadStore.getState().threadsByChatId["chat-b"]).toBeDefined();
    expect(useThreadStore.getState().threadsByChatId["chat-c"]).toBeDefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-a"]).toBeUndefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-b"]).toBeDefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-c"]).toBeDefined();
    expect(useComposerSessionStore.getState().sessionsByKey[composerSessionKey("chat-a")]).toBeUndefined();
    expect(state.session(composerSessionKey("chat-b")).draft).toBe("Retained chat draft");
    expect(state.session(composerSessionKey("chat-c")).draft).toBe("Streaming chat draft");
    expect(
      useComposerSessionStore.getState().sessionsByKey[
        composerSessionKey(null, "remote-folder")
      ]
    ).toBeUndefined();
    expect(
      useComposerSessionStore.getState().appendUploadedAttachment(
        composerSessionKey(null, "remote-folder"),
        removedFolderUpload,
        { fileName: "late.pdf", id: "late-folder", kind: "pdf" }
      )
    ).toBe(false);

    state.chatHasActiveStream.mockReturnValue(false);
    await state.actions.refreshWorkspace();

    expect(useThreadStore.getState().threadsByChatId["chat-c"]).toBeUndefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-c"]).toBeUndefined();
    expect(
      useComposerSessionStore.getState().sessionsByKey[composerSessionKey("chat-c")]
    ).toBeUndefined();
  });

  it("does not replace a live keyed thread with embedded workspace rows", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "assistant-live",
      messages: [
        message({
          content: "live token",
          id: "assistant-live",
          role: "assistant",
          status: "streaming"
        })
      ],
      usageStats: null
    });
    const liveThread = useThreadStore.getState().threadsByChatId["chat-a"];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          chats: [
            {
              ...apiChatSummary(state.chatA),
              messages: []
            },
            {
              ...apiChatSummary({ ...state.chatB, messageCount: 1 }),
              messages: [
                {
                  artifactSummary: null,
                  content: "embedded history",
                  createdAt: "2026-06-10T00:00:00.000Z",
                  errorMessage: null,
                  id: "embedded-message",
                  modelId: null,
                  modelRunId: null,
                  parentMessageId: null,
                  provider: null,
                  role: "user",
                  status: "complete"
                }
              ]
            }
          ],
          contentMatches: [],
          folders: []
        })
      )
    );

    await state.actions.refreshWorkspace("missing-chat");

    expect(useThreadStore.getState().threadsByChatId["chat-a"]).toBe(liveThread);
    expect(liveThread.messages[0]?.content).toBe("live token");
    expect(useThreadStore.getState().threadsByChatId["chat-b"]).toBeUndefined();
  });
});
