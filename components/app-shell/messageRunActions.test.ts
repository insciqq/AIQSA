import { afterEach, describe, expect, it, vi } from "vitest";
import { resetComposerControlStoreForTest, useComposerControlStore } from "./composerControlStore";
import {
  composerSessionKey,
  resetComposerSessionStoreForTest,
  selectComposerSession,
  useComposerSessionStore,
  type ComposerSessionKey
} from "./composerSessionStore";
import type { ConsumeMessageRunStream } from "./messageRunLifecycle";
import { useMessageRunActions } from "./messageRunActions";
import { resetRunLifecycleStoreForTest, useRunLifecycleStore } from "./runLifecycleStore";
import {
  resetRunSurfaceStoreForTest,
  selectRunSurface,
  useRunSurfaceStore
} from "./runSurfaceStore";
import { resetThreadStoreForTest, selectThreadSnapshot, useThreadStore } from "./threadStore";
import { resetWorkspaceStoreForTest, useWorkspaceStore } from "./workspaceStore";
import type { ComposerAttachment } from "@/components/chat/Composer";
import type { CatalogModel, ChatDetail, ChatSummary } from "./types";

const model: CatalogModel = {
  capabilities: {
    background: true,
    documentInputMode: "pdf_text_extraction",
    imageInput: true,
    nativeWebSearch: true,
    openRouterPerplexitySearch: true,
    reasoning: true,
    streaming: true,
    toolCalling: true
  },
  contextWindow: 400000,
  defaultParams: {},
  displayName: "GPT-5.5",
  modelId: "gpt-5.5",
  parameterControls: {
    background: {
      defaultValue: true,
      supported: true
    },
    maxOutputTokens: {
      defaultValue: 128000,
      maxValue: 128000
    },
    reasoningEffort: {
      defaultValue: "medium",
      options: ["none", "low", "medium", "high", "xhigh"],
      supported: true
    },
    stream: {
      defaultValue: false,
      supported: true
    },
    temperature: {
      defaultValue: 1,
      maxValue: 2,
      minValue: 0,
      supported: true
    }
  },
  provider: "openai",
  searchStrategyIds: ["search-disabled"]
};

function chat(): ChatSummary {
  return {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: null,
    defaultProvider: "openai",
    folderId: null,
    id: "chat-a",
    messageCount: 0,
    title: "Chat A",
    updatedAt: "2026-06-10T00:00:00.000Z"
  };
}

function editResponse(text: string, chatId = "chat-a", role: "assistant" | "user" = "user") {
  return Response.json({
    message: {
      chatId,
      content: {
        blocks: [{ text, type: "text" }]
      },
      id: "message-edited",
      modelId: "gpt-5.5",
      parentMessageId: null,
      provider: "openai",
      role,
      status: "complete"
    }
  });
}

function prepareRegenerationThread() {
  useThreadStore.getState().replaceThread("chat-a", {
    activeLeafId: "assistant-original",
    messages: [
      {
        content: "Original question",
        id: "user-original",
        parentMessageId: null,
        role: "user",
        status: "complete"
      },
      {
        content: "Original answer",
        id: "assistant-original",
        parentMessageId: "user-original",
        role: "assistant",
        runId: "run-original",
        status: "complete"
      }
    ],
    usageStats: null
  });
}

function useMessageRunActionsForTest(input: {
  activeChat?: ChatSummary | null;
  activeChatId?: string | null;
  activeChatStreaming?: boolean;
  attachments: ComposerAttachment[];
  consumeRunStream?: ConsumeMessageRunStream;
  createChat?: (
    folderId?: string | null,
    sourceSessionKey?: ComposerSessionKey
  ) => Promise<ChatSummary | null>;
  draft?: string;
  editingMessageId?: string | null;
  model?: CatalogModel;
  pendingChatFolderId?: string | null;
  persistActiveLeaf?: (chatId: string, messageId: string | null) => Promise<unknown>;
  refreshActiveChat?: (
    chatId: string | null,
    options?: { forceDetail?: boolean; preserveControls?: boolean; resumeRuns?: boolean }
  ) => Promise<ChatDetail | null>;
}) {
  resetRunLifecycleStoreForTest();
  resetRunSurfaceStoreForTest();
  resetComposerControlStoreForTest();
  resetComposerSessionStoreForTest();
  resetThreadStoreForTest();
  resetWorkspaceStoreForTest();
  const activeChat = input.activeChat === undefined ? chat() : input.activeChat;
  const activeChatId = input.activeChatId === undefined ? activeChat?.id ?? null : input.activeChatId;
  const activeChatIdRef = { current: activeChatId };
  if (activeChatId) {
    useThreadStore.getState().replaceThread(activeChatId, {
      activeLeafId: activeChat?.activeLeafMessageId ?? null,
      messages: [],
      usageStats: null
    });
  }
  useWorkspaceStore.setState({
    activeChatId,
    chats: [activeChat ?? chat()]
  });
  const sourceSessionKey = composerSessionKey(activeChatId, input.pendingChatFolderId ?? null);
  useComposerSessionStore.getState().activateSession(sourceSessionKey);
  useComposerSessionStore.getState().updateSession(sourceSessionKey, {
    attachments: input.attachments,
    draft: input.draft ?? "Question with attachment",
    editingMessageId: input.editingMessageId ?? null
  });
  useComposerControlStore.setState({
    developerPrompt: "",
    selectedModelId: "gpt-5.5",
    selectedPromptId: null,
    selectedProvider: "openai",
    selectedSearchOptionIds: [],
    searchPlanMode: "all_selected",
    selectedSearchStrategy: "search-disabled",
    systemPrompt: ""
  });

  const activeStreamAbortRef = { current: new Map<string, AbortController>() };
  const fetchRun = vi.fn(async () => null);
  const notifyAnswerReady = vi.fn(async () => undefined);
  const primeAnswerSound = vi.fn(async () => undefined);
  const refreshActiveChat = vi.fn(input.refreshActiveChat ?? (async () => null));
  const resetThreadToLatest = vi.fn();
  const setNotice = vi.fn();

  const actions = useMessageRunActions({
    activeChat,
    activeChatDetailLoading: false,
    activeChatId,
    activeChatIdRef,
    activeStreamAbortRef,
    buildControlDraft: () => ({
      backgroundMode: true,
      maxOutputTokens: "128000",
      reasoningEffort: "medium",
      searchStrategyId: "search-disabled",
      streamMode: false,
      temperature: "1"
    }),
    buildParams: () => ({}),
    consumeRunStream:
      input.consumeRunStream ??
      (async () => {
        activeChatIdRef.current = "chat-b";
        return {
          failed: false,
          receivedChatUpdate: true,
          runId: "run-1"
        };
      }),
    createChat: async (folderId, sourceKey) => {
      const created = await (input.createChat ?? (async () => null))(folderId, sourceKey);
      if (created && sourceKey) {
        useComposerSessionStore
          .getState()
          .transferSession(sourceKey, composerSessionKey(created.id));
      }
      return created;
    },
    createStreamTokenBuffer: () => ({
      flush: vi.fn(),
      push: vi.fn()
    }),
    currentModel: input.model ?? model,
    fetchRun,
    notifyAnswerReady,
    persistActiveLeaf: input.persistActiveLeaf ?? vi.fn(async () => null),
    primeAnswerSound,
    refreshActiveChat,
    resetThreadToLatest,
    setNotice,
    activeChatStreaming: input.activeChatStreaming ?? false
  });

  return Object.assign(actions, {
    activeChatIdRef,
    activeStreamAbortRef,
    fetchRun,
    notifyAnswerReady,
    primeAnswerSound,
    refreshActiveChat,
    resetThreadToLatest,
    session: (key: ComposerSessionKey) =>
      selectComposerSession(useComposerSessionStore.getState(), key),
    sourceSessionKey,
    surface: (chatId: string) => selectRunSurface(useRunSurfaceStore.getState(), chatId),
    setNotice
  });
}

describe("message run actions", () => {
  afterEach(() => {
    resetRunLifecycleStoreForTest();
    resetRunSurfaceStoreForTest();
    resetComposerControlStoreForTest();
    resetComposerSessionStoreForTest();
    resetThreadStoreForTest();
    resetWorkspaceStoreForTest();
    vi.restoreAllMocks();
  });

  it("clears only the completed source session after switching to another composer", async () => {
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
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [attachmentA],
      consumeRunStream: async () => {
        expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
          attachments: [],
          draft: "",
          pendingSend: expect.objectContaining({ attachments: [attachmentA] })
        });
        useComposerSessionStore.getState().activateSession(composerSessionKey("chat-b"));
        useComposerSessionStore.getState().updateSession(composerSessionKey("chat-b"), {
          attachments: [attachmentB],
          draft: "Question B"
        });
        return {
          failed: false,
          receivedChatUpdate: true,
          runId: "run-a"
        };
      }
    });

    await actions.submitComposer();

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      attachments: [],
      draft: "",
      pendingSend: null
    });
    expect(actions.session(composerSessionKey("chat-b"))).toMatchObject({
      attachments: [attachmentB],
      draft: "Question B"
    });
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      content: {
        blocks: [
          {
            text: "Question with attachment",
            type: "text"
          },
          {
            attachmentId: "attachment-a",
            fileName: "a.pdf",
            type: "file"
          }
        ]
      },
      controlDefaults: {
        maxOutputTokens: "128000",
        reasoningEffort: "medium",
        searchStrategyId: "search-disabled",
        temperature: "1"
      },
      expectedActiveLeafId: null
    });
    expect(actions.resetThreadToLatest).toHaveBeenCalledOnce();
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
  });

  it("sends attachment-only messages without an empty text block and keeps optimistic attachments", async () => {
    const attachment = {
      fileName: "diagram.png",
      id: "attachment-image",
      kind: "image" as const
    };
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [attachment],
      draft: ""
    });

    await actions.submitComposer();

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const expectedContent = {
      blocks: [
        {
          alt: "diagram.png",
          attachmentId: "attachment-image",
          type: "image"
        }
      ]
    };
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      content: expectedContent
    });
    const optimisticUserMessage = selectThreadSnapshot(
      useThreadStore.getState(),
      "chat-a"
    ).messages.find((message) => message.role === "user");
    expect(optimisticUserMessage?.content).toEqual(expectedContent);
  });

  it("does not send when the composer has neither text nor attachments", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: ""
    });

    await actions.submitComposer();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(actions.resetThreadToLatest).not.toHaveBeenCalled();
  });

  it("suppresses persisted MCP tools for a model without tool calling", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "Question for Fake QSA",
      model: {
        ...model,
        capabilities: {
          ...model.capabilities,
          toolCalling: false
        }
      }
    });

    await actions.submitComposer();

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({ tools: "none" });
  });

  it("suppresses persisted MCP tools when regenerating with an unsupported model", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [],
      model: {
        ...model,
        capabilities: {
          ...model.capabilities,
          toolCalling: false
        }
      }
    });
    prepareRegenerationThread();

    await actions.regenerateMessage("assistant-original");

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({ tools: "none" });
  });

  it("restores the draft and skips run creation when pending checkout fails", async () => {
    const fetchMock = vi.fn();
    const persistActiveLeaf = vi.fn(async () => {
      throw new Error("active_leaf_changed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const activeChat = { ...chat(), activeLeafMessageId: "message-selected" };
    const actions = useMessageRunActionsForTest({
      activeChat,
      attachments: [],
      draft: "Question for selected branch",
      persistActiveLeaf
    });

    await actions.submitComposer();

    expect(persistActiveLeaf).toHaveBeenCalledWith("chat-a", "message-selected");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      draft: "Question for selected branch",
      operationError: "Send failed. Your draft was preserved."
    });
    expect(actions.setNotice).toHaveBeenCalledWith({
      kind: "error",
      text: expect.stringContaining("active_leaf_changed")
    });
    expect(actions.resetThreadToLatest).not.toHaveBeenCalled();
  });

  it("does not move a different active chat when branch settlement outlives navigation", async () => {
    let actions!: ReturnType<typeof useMessageRunActionsForTest>;
    const persistActiveLeaf = vi.fn(async () => {
      actions.activeChatIdRef.current = "chat-b";
    });
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const activeChat = { ...chat(), activeLeafMessageId: "message-selected" };
    actions = useMessageRunActionsForTest({
      activeChat,
      attachments: [],
      draft: "Question that becomes a background run",
      persistActiveLeaf
    });

    await actions.submitComposer();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(actions.resetThreadToLatest).not.toHaveBeenCalled();
  });

  it("keeps a blank-folder source recoverable when chat creation fails", async () => {
    const createChat = vi.fn(async () => null);
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      activeChat: null,
      activeChatId: null,
      attachments: [
        {
          fileName: "source.pdf",
          id: "attachment-source",
          kind: "pdf"
        }
      ],
      createChat,
      pendingChatFolderId: "folder-1"
    });

    await actions.submitComposer();

    expect(createChat).toHaveBeenCalledWith("folder-1", composerSessionKey(null, "folder-1"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(actions.session(composerSessionKey(null, "folder-1"))).toMatchObject({
      attachments: [expect.objectContaining({ id: "attachment-source" })],
      draft: "Question with attachment"
    });
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(
      composerSessionKey(null, "folder-1")
    );
  });

  it("settles a blank send after creation transferred it but activation failed", async () => {
    const targetKey = composerSessionKey("chat-created");
    const createChat = vi.fn(async (_folderId?: string | null, sourceKey?: ComposerSessionKey) => {
      useComposerSessionStore.getState().transferSession(sourceKey!, targetKey);
      return null;
    });
    vi.stubGlobal("fetch", vi.fn());
    const actions = useMessageRunActionsForTest({
      activeChat: null,
      activeChatId: null,
      attachments: [],
      createChat,
      pendingChatFolderId: "folder-1"
    });

    await actions.submitComposer();

    expect(actions.session(composerSessionKey(null, "folder-1"))).toMatchObject({
      draft: "",
      pendingSend: null
    });
    expect(actions.session(targetKey)).toMatchObject({
      draft: "Question with attachment",
      operationError: "Send failed. Your draft was preserved.",
      pendingSend: null
    });
  });

  it("ignores repeated blank workspace submits while chat creation is pending", async () => {
    const createdChat = {
      ...chat(),
      id: "chat-new",
      title: "New Chat"
    };
    let resolveCreateChat!: (chat: ChatSummary) => void;
    const createChat = vi.fn(
      () =>
        new Promise<ChatSummary>((resolve) => {
          resolveCreateChat = resolve;
        })
    );
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      activeChat: null,
      activeChatId: null,
      attachments: [],
      createChat
    });

    const firstSubmit = actions.submitComposer();
    expect(actions.session(composerSessionKey(null))).toMatchObject({
      attachments: [],
      draft: "",
      pendingSend: expect.any(Object)
    });
    const secondSubmit = actions.submitComposer();
    expect(createChat).toHaveBeenCalledOnce();
    useComposerControlStore.setState({
      selectedModelId: "later-model",
      selectedProvider: "later-provider",
      selectedSearchOptionIds: ["later-search"],
      selectedSearchStrategy: "later-search"
    });

    resolveCreateChat(createdChat);
    await Promise.all([firstSubmit, secondSubmit]);

    expect(createChat).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chats/chat-new/messages");
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      modelId: "gpt-5.5",
      provider: "openai",
      searchStrategy: "search-disabled"
    });
  });

  it("creates and sends from a blank workspace while another chat streams", async () => {
    const createdChat = {
      ...chat(),
      id: "chat-new",
      title: "New Chat"
    };
    const createChat = vi.fn(async () => createdChat);
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      activeChat: null,
      activeChatId: null,
      attachments: [],
      createChat
    });
    useRunLifecycleStore.getState().streamStarted({
      assistantMessageId: "assistant-b",
      chatId: "chat-b",
      runId: "run-b"
    });

    await actions.submitComposer();

    expect(createChat).toHaveBeenCalledWith(null, composerSessionKey(null));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/chat-new/messages",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(useRunLifecycleStore.getState().activeStreams["chat-b"]).toMatchObject({
      runId: "run-b"
    });
  });

  it("clears sent attachments immediately and preserves only newer composer work", async () => {
    const sentAttachment = {
      fileName: "sent.pdf",
      id: "attachment-sent",
      kind: "pdf" as const
    };
    const nextAttachment = {
      fileName: "next.pdf",
      id: "attachment-next",
      kind: "pdf" as const
    };
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [sentAttachment],
      consumeRunStream: async () => {
        expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
          attachments: [],
          draft: ""
        });
        useComposerSessionStore.getState().setDraft("Next question");
        useComposerSessionStore.getState().setAttachments([nextAttachment]);
        return {
          failed: false,
          receivedChatUpdate: true,
          runId: "run-a"
        };
      }
    });

    await actions.submitComposer();

    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      attachments: [nextAttachment],
      draft: "Next question",
      editingMessageId: null,
      pendingSend: null
    });
  });

  it("keeps a deferred edit owned by A after switching to B", async () => {
    let resolveEdit!: (response: Response) => void;
    const fetchMock = vi
      .fn(async (..._args: unknown[]) => new Response("", { status: 200 }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveEdit = resolve;
          })
      );
    vi.stubGlobal("fetch", fetchMock);
    const refreshActiveChat = vi.fn(async (chatId: string | null) => {
      useThreadStore.getState().replaceThread(chatId!, {
        activeLeafId: "message-edited",
        messages: [
          {
            content: "Edited answer",
            id: "message-edited",
            parentMessageId: null,
            role: "user",
            status: "complete"
          }
        ],
        usageStats: null
      });
      return null;
    });
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "Edited answer",
      editingMessageId: "message-1",
      refreshActiveChat
    });
    const edit = actions.submitComposer();
    expect(actions.session(composerSessionKey("chat-a")).pendingEdit).toEqual(
      expect.objectContaining({ messageId: "message-1" })
    );
    actions.activeChatIdRef.current = "chat-b";
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-b"));
    useComposerSessionStore.getState().updateSession(composerSessionKey("chat-b"), {
      draft: "Draft B"
    });
    resolveEdit(editResponse("Edited answer"));

    await edit;

    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      draft: "",
      editingMessageId: null,
      pendingEdit: null
    });
    expect(actions.session(composerSessionKey("chat-b"))).toMatchObject({
      draft: "Draft B",
      editingMessageId: null
    });
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a").messages).toEqual([
      expect.objectContaining({ content: "Edited answer", id: "message-edited" }),
      expect.objectContaining({
        parentMessageId: "message-edited",
        role: "assistant",
        status: "complete"
      })
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/messages/message-edited/regenerate",
      expect.objectContaining({ method: "POST" })
    );
    expect(actions.resetThreadToLatest).not.toHaveBeenCalled();
    expect(actions.refreshActiveChat).toHaveBeenCalledWith("chat-a", {
      preserveControls: true
    });
  });

  it("keeps the source edit recoverable when the response is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: { id: "bad" } })));
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "Edited answer",
      editingMessageId: "message-1"
    });

    await actions.submitComposer();

    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      draft: "Edited answer",
      editingMessageId: "message-1",
      operationError: "Message edit response was malformed (edit_malformed)",
      pendingEdit: null
    });
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a").messages).toEqual([]);
    expect(actions.refreshActiveChat).not.toHaveBeenCalled();
  });

  it("uses the committed edit response when canonical detail refresh is unavailable", async () => {
    const fetchMock = vi
      .fn(async (..._args: unknown[]) => new Response("", { status: 200 }))
      .mockImplementationOnce(async () => editResponse("Committed edit"));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "Committed edit",
      editingMessageId: "message-1"
    });

    await actions.submitComposer();

    expect(actions.refreshActiveChat).toHaveBeenCalledWith("chat-a", {
      preserveControls: true
    });
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a")).toMatchObject({
      messages: [
        expect.objectContaining({ content: "Committed edit", id: "message-edited" }),
        expect.objectContaining({
          parentMessageId: "message-edited",
          role: "assistant",
          status: "complete"
        })
      ]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/messages/message-edited/regenerate",
      expect.objectContaining({ method: "POST" })
    );
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      draft: "",
      editingMessageId: null,
      operationError: null,
      pendingEdit: null
    });
  });

  it("allows only one same-source edit request until canonical refresh settles", async () => {
    let resolveEdit!: (response: Response) => void;
    const fetchMock = vi
      .fn(async (..._args: unknown[]) => new Response("", { status: 200 }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveEdit = resolve;
          })
      );
    vi.stubGlobal("fetch", fetchMock);
    const refreshActiveChat = vi.fn(async (chatId: string | null) => {
      useThreadStore.getState().replaceThread(chatId!, {
        activeLeafId: "message-edited",
        messages: [
          {
            content: "First edit",
            id: "message-edited",
            parentMessageId: null,
            role: "user",
            status: "complete"
          }
        ],
        usageStats: null
      });
      return null;
    });
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "First edit",
      editingMessageId: "message-1",
      refreshActiveChat
    });

    const first = actions.submitComposer();
    const duplicate = actions.submitComposer();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(actions.session(composerSessionKey("chat-a")).pendingEdit).toEqual(
      expect.objectContaining({ messageId: "message-1" })
    );

    resolveEdit(editResponse("First edit"));
    await Promise.all([first, duplicate]);

    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a").messages).toEqual([
      expect.objectContaining({ content: "First edit", id: "message-edited" }),
      expect.objectContaining({
        parentMessageId: "message-edited",
        role: "assistant"
      })
    ]);
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      draft: "",
      editingMessageId: null,
      operationError: null,
      pendingEdit: null
    });
    expect(actions.refreshActiveChat).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/regenerate"))
    ).toHaveLength(1);
  });

  it("clears failed ownership for a retry and retires the edit after canonical success", async () => {
    const fetchMock = vi
      .fn(async (..._args: unknown[]) => new Response("", { status: 200 }))
      .mockResolvedValueOnce(Response.json({ error: "edit_conflict" }, { status: 409 }))
      .mockResolvedValueOnce(editResponse("Retry edit"))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const refreshActiveChat = vi.fn(async (chatId: string | null) => {
      useThreadStore.getState().replaceThread(chatId!, {
        activeLeafId: "message-edited",
        messages: [
          {
            content: "Retry edit",
            id: "message-edited",
            parentMessageId: null,
            role: "user",
            status: "complete"
          }
        ],
        usageStats: null
      });
      return null;
    });
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "Retry edit",
      editingMessageId: "message-1",
      refreshActiveChat
    });

    await actions.submitComposer();
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      draft: "Retry edit",
      editingMessageId: "message-1",
      operationError: expect.stringContaining("edit_conflict"),
      pendingEdit: null
    });

    await actions.submitComposer();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/messages/message-edited/regenerate");
    expect(actions.refreshActiveChat).toHaveBeenCalledOnce();
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      draft: "",
      editingMessageId: null,
      operationError: null,
      pendingEdit: null
    });
  });

  it("starts a streamed answer run on the committed branch after editing a user message", async () => {
    vi.spyOn(Date, "now").mockReturnValue(555);
    const fetchMock = vi
      .fn(async (..._args: unknown[]) => new Response("", { status: 200 }))
      .mockImplementationOnce(async () => editResponse("Edited question"));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [],
      consumeRunStream: async ({ onMessageIds, onRunId }) => {
        onRunId("run-edit");
        onMessageIds({ assistantMessageId: "assistant-edit-persisted" }, "run-edit");
        return {
          failed: false,
          receivedChatUpdate: true,
          runId: "run-edit"
        };
      },
      draft: "Edited question",
      editingMessageId: "message-1"
    });

    await actions.submitComposer();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/messages/message-edited/regenerate",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal)
      })
    );
    const [, regenerateInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(regenerateInit.body))).toMatchObject({
      modelId: "gpt-5.5",
      provider: "openai",
      searchStrategy: "search-disabled"
    });
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a")).toMatchObject({
      activeLeafId: "assistant-edit-persisted",
      messages: [
        expect.objectContaining({ content: "Edited question", id: "message-edited" }),
        expect.objectContaining({
          id: "assistant-edit-persisted",
          parentMessageId: "message-edited",
          runId: "run-edit",
          status: "complete"
        })
      ]
    });
    expect(actions.fetchRun).toHaveBeenCalledWith("run-edit", "chat-a");
    expect(actions.notifyAnswerReady).toHaveBeenCalledOnce();
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
  });

  it("keeps a readable run-error tail on the edited branch when the follow-up run fails to start", async () => {
    vi.spyOn(Date, "now").mockReturnValue(556);
    const fetchMock = vi
      .fn(async (..._args: unknown[]) =>
        Response.json({ error: "edit_run_failed_500" }, { status: 500 })
      )
      .mockImplementationOnce(async () => editResponse("Edited question"));
    vi.stubGlobal("fetch", fetchMock);
    const consumeRunStream = vi.fn<ConsumeMessageRunStream>();
    const actions = useMessageRunActionsForTest({
      attachments: [],
      consumeRunStream,
      draft: "Edited question",
      editingMessageId: "message-1"
    });

    await actions.submitComposer();

    expect(consumeRunStream).not.toHaveBeenCalled();
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a")).toMatchObject({
      activeLeafId: "assistant-556",
      messages: [
        expect.objectContaining({ content: "Edited question", id: "message-edited" }),
        expect.objectContaining({
          id: "assistant-556",
          parentMessageId: "message-edited",
          status: "error"
        })
      ]
    });
    expect(actions.surface("chat-a").events).toEqual([
      {
        data: {
          message: expect.stringContaining("edit_run_failed_500")
        },
        type: "error"
      }
    ]);
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
  });

  it("does not start a run after editing an assistant message", async () => {
    const fetchMock = vi
      .fn(async (..._args: unknown[]) => new Response("", { status: 200 }))
      .mockImplementationOnce(async () => editResponse("Edited answer text", "chat-a", "assistant"));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "Edited answer text",
      editingMessageId: "assistant-1"
    });

    await actions.submitComposer();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
  });

  it("does not edit while the active chat streams", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      activeChatStreaming: true,
      attachments: [],
      draft: "Edited answer",
      editingMessageId: "message-1"
    });

    await actions.submitComposer();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rolls back a rejected send and retries from the prior canonical leaf", async () => {
    vi.spyOn(Date, "now").mockReturnValue(300);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "provider_unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const activeChat = {
      ...chat(),
      activeLeafMessageId: "assistant-parent",
      messageCount: 2
    };
    const actions = useMessageRunActionsForTest({
      activeChat,
      attachments: [],
      draft: "Retry this question"
    });

    await actions.submitComposer();

    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a")).toMatchObject({
      activeLeafId: "assistant-parent",
      messages: []
    });
    expect(useWorkspaceStore.getState().chats[0]?.activeLeafMessageId).toBe(
      "assistant-parent"
    );
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      draft: "Retry this question",
      operationError: "Send failed. Your draft was preserved."
    });

    await actions.submitComposer();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(retryInit.body))).toMatchObject({
      expectedActiveLeafId: "assistant-parent"
    });
  });

  it("reconciles a stranded optimistic leaf before retrying a network failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(301);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network disconnected"))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let refreshAttempt = 0;
    const canonicalMessages = [
      {
        content: "Persisted question",
        id: "user-canonical",
        parentMessageId: null,
        role: "user" as const,
        status: "complete" as const
      },
      {
        content: "Persisted failed answer",
        id: "assistant-canonical",
        parentMessageId: "user-canonical",
        role: "assistant" as const,
        runId: "run-canonical",
        status: "error" as const
      }
    ];
    const refreshActiveChat = vi.fn(async () => {
      refreshAttempt += 1;
      if (refreshAttempt === 1) {
        return null;
      }

      useThreadStore.getState().replaceThread("chat-a", {
        activeLeafId: "assistant-canonical",
        messages: canonicalMessages,
        usageStats: null
      });
      useWorkspaceStore.getState().updateChats((current) =>
        current.map((candidate) =>
          candidate.id === "chat-a"
            ? {
                ...candidate,
                activeLeafMessageId: "assistant-canonical",
                messageCount: 2
              }
            : candidate
        )
      );
      return {
        ...chat(),
        activeLeafMessageId: "assistant-canonical",
        messageCount: 2,
        messages: canonicalMessages,
        usageStats: null
      };
    });
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "Retry after reconnect",
      refreshActiveChat
    });

    await actions.submitComposer();

    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a")).toMatchObject({
      activeLeafId: "assistant-301",
      messages: [
        expect.objectContaining({ id: "user-301" }),
        expect.objectContaining({ id: "assistant-301", status: "error" })
      ]
    });
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      draft: "Retry after reconnect"
    });

    await actions.submitComposer();

    expect(actions.refreshActiveChat).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(retryInit.body))).toMatchObject({
      expectedActiveLeafId: "assistant-canonical"
    });
  });

  it("reconciles an ambiguous send only in its source chat while another chat streams", async () => {
    const refreshActiveChat = vi.fn(async (chatId: string | null) => {
      expect(chatId).toBe("chat-a");
      useThreadStore.getState().replaceThread("chat-a", {
        activeLeafId: "assistant-server-a",
        messages: [
          {
            content: "Persisted question",
            id: "user-server-a",
            parentMessageId: null,
            role: "user",
            status: "complete"
          },
          {
            content: "Provider result unavailable",
            id: "assistant-server-a",
            parentMessageId: "user-server-a",
            role: "assistant",
            runId: "run-server-a",
            status: "error"
          }
        ],
        usageStats: null
      });
      useWorkspaceStore.getState().updateChats((current) =>
        current.map((candidate) =>
          candidate.id === "chat-a"
            ? { ...candidate, activeLeafMessageId: "assistant-server-a" }
            : candidate
        )
      );
      return null;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network disconnected");
      })
    );
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "Question A",
      refreshActiveChat
    });
    const chatB = { ...chat(), activeLeafMessageId: "assistant-b", id: "chat-b", title: "Chat B" };
    useWorkspaceStore.setState({
      chats: [chat(), chatB]
    });
    useThreadStore.getState().replaceThread("chat-b", {
      activeLeafId: "assistant-b",
      messages: [
        {
          content: "Answer B",
          id: "assistant-b",
          parentMessageId: null,
          role: "assistant",
          runId: "run-b",
          status: "streaming"
        }
      ],
      usageStats: null
    });
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-b"));
    useComposerSessionStore.getState().updateSession(composerSessionKey("chat-b"), {
      draft: "Draft B"
    });
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-a"));
    useRunLifecycleStore.getState().streamStarted({
      assistantMessageId: "assistant-b",
      chatId: "chat-b",
      runId: "run-b"
    });

    await actions.submitComposer();

    expect(actions.refreshActiveChat).toHaveBeenCalledWith("chat-a", {
      forceDetail: true,
      preserveControls: true,
      resumeRuns: false
    });
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a")).toMatchObject({
      activeLeafId: "assistant-server-a",
      messages: [
        expect.objectContaining({ id: "user-server-a" }),
        expect.objectContaining({ id: "assistant-server-a", runId: "run-server-a" })
      ]
    });
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-b")).toMatchObject({
      activeLeafId: "assistant-b",
      messages: [expect.objectContaining({ content: "Answer B", id: "assistant-b" })]
    });
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({
      "chat-b": {
        optimisticAssistantMessageId: "assistant-b",
        resuming: false,
        runId: "run-b"
      }
    });
    expect(actions.session(composerSessionKey("chat-b"))).toMatchObject({
      draft: "Draft B"
    });
  });

  it("remaps send message_start ids, parents, active leaf, and run id", async () => {
    vi.spyOn(Date, "now").mockReturnValue(321);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    const actions = useMessageRunActionsForTest({
      attachments: [],
      consumeRunStream: async ({ onMessageIds, onRunId }) => {
        onRunId("run-send");
        onMessageIds(
          {
            assistantMessageId: "assistant-send-persisted",
            userMessageId: "user-send-persisted"
          },
          "run-send"
        );
        return {
          failed: false,
          receivedChatUpdate: true,
          runId: "run-send"
        };
      }
    });

    await actions.submitComposer();

    const thread = selectThreadSnapshot(useThreadStore.getState(), "chat-a");
    expect(thread.activeLeafId).toBe("assistant-send-persisted");
    expect(thread.messages).toEqual([
      expect.objectContaining({
        id: "user-send-persisted",
        parentMessageId: null,
        role: "user"
      }),
      expect.objectContaining({
        id: "assistant-send-persisted",
        parentMessageId: "user-send-persisted",
        role: "assistant",
        runId: "run-send",
        status: "complete"
      })
    ]);
    expect(thread.messages.some((message) => message.id === "user-321" || message.id === "assistant-321")).toBe(false);
    expect(useWorkspaceStore.getState().chats[0]?.activeLeafMessageId).toBe("assistant-send-persisted");
    expect(actions.fetchRun).toHaveBeenCalledWith("run-send", "chat-a");
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      attachments: [],
      draft: ""
    });
    expect(actions.refreshActiveChat).not.toHaveBeenCalled();
  });

  it("keeps a failed first-send draft under only the created chat key", async () => {
    const attachment = {
      fileName: "evidence.pdf",
      id: "attachment-evidence",
      kind: "pdf" as const
    };
    const createdChat = {
      ...chat(),
      id: "chat-new",
      title: "New Chat"
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    const actions = useMessageRunActionsForTest({
      activeChat: null,
      activeChatId: null,
      attachments: [attachment],
      createChat: vi.fn(async () => createdChat),
      pendingChatFolderId: "folder-1",
      consumeRunStream: async () => {
        throw new Error("stream disconnected");
      }
    });

    await actions.submitComposer();

    expect(actions.session(composerSessionKey(null, "folder-1"))).toMatchObject({
      attachments: [],
      draft: ""
    });
    expect(actions.session(composerSessionKey("chat-new"))).toMatchObject({
      attachments: [attachment],
      draft: "Question with attachment",
      operationError: "Send failed. Your draft was preserved.",
      pendingSend: null
    });
    expect(
      Object.entries(useComposerSessionStore.getState().sessionsByKey)
        .filter(([, session]) => session?.draft === "Question with attachment")
        .map(([key]) => key)
    ).toEqual([composerSessionKey("chat-new")]);
    expect(
      selectThreadSnapshot(useThreadStore.getState(), "chat-new").messages.find(
        (message) => message.role === "user"
      )?.content
    ).toEqual({
      blocks: [
        {
          text: "Question with attachment",
          type: "text"
        },
        {
          attachmentId: "attachment-evidence",
          fileName: "evidence.pdf",
          type: "file"
        }
      ]
    });
    expect(actions.surface("chat-new").events).toEqual([
      {
        data: { message: "stream disconnected" },
        type: "error"
      }
    ]);
  });

  it("settles a rejected first send as one saved-empty chat with restored feedback", async () => {
    const createdChat = {
      ...chat(),
      id: "chat-rejected",
      title: "New Chat"
    };
    const consumeRunStream = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "mcp_tool_calling_not_supported" }, { status: 400 })
      )
    );
    let actions!: ReturnType<typeof useMessageRunActionsForTest>;
    const createChat = vi.fn(async () => {
      useWorkspaceStore.getState().upsertChat(createdChat);
      useWorkspaceStore.getState().setActiveChatId(createdChat.id);
      actions.activeChatIdRef.current = createdChat.id;
      return createdChat;
    });
    actions = useMessageRunActionsForTest({
      activeChat: null,
      activeChatId: null,
      attachments: [],
      consumeRunStream,
      createChat,
      draft: "Question that should survive"
    });

    await actions.submitComposer();

    expect(createChat).toHaveBeenCalledOnce();
    expect(consumeRunStream).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeChatId: createdChat.id,
      chats: expect.arrayContaining([expect.objectContaining({ id: createdChat.id })])
    });
    expect(selectThreadSnapshot(useThreadStore.getState(), createdChat.id)).toMatchObject({
      activeLeafId: null,
      messages: []
    });
    expect(actions.surface(createdChat.id)).toEqual({ events: [], lastRun: null });
    expect(actions.session(composerSessionKey(createdChat.id))).toMatchObject({
      draft: "Question that should survive",
      operationError: "Send failed. Your draft was preserved.",
      pendingSend: null
    });
  });

  it("regenerates as a sibling under the original parent and remaps the optimistic assistant id", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [],
      consumeRunStream: async ({ onMessageIds, onRunId }) => {
        onRunId("run-regenerated");
        onMessageIds({ assistantMessageId: "assistant-persisted" }, "run-regenerated");
        return {
          failed: false,
          receivedChatUpdate: true,
          runId: "run-regenerated"
        };
      }
    });
    prepareRegenerationThread();

    await actions.regenerateMessage("assistant-original");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/messages/assistant-original/regenerate",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal)
      })
    );
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toEqual({
      controlDefaults: {
        backgroundMode: true,
        maxOutputTokens: "128000",
        reasoningEffort: "medium",
        searchStrategyId: "search-disabled",
        streamMode: false,
        temperature: "1"
      },
      modelId: "gpt-5.5",
      params: {},
      prompt: {
        developer: "",
        presetId: null,
        system: ""
      },
      provider: "openai",
      searchPlan: {
        mode: "all_selected",
        optionIds: []
      },
      searchStrategy: "search-disabled"
    });
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a")).toMatchObject({
      activeLeafId: "assistant-persisted",
      messages: [
        expect.objectContaining({ id: "user-original" }),
        expect.objectContaining({ id: "assistant-original", status: "complete" }),
        expect.objectContaining({
          id: "assistant-persisted",
          parentMessageId: "user-original",
          runId: "run-regenerated",
          status: "complete"
        })
      ]
    });
    expect(useWorkspaceStore.getState().chats[0]?.activeLeafMessageId).toBe("assistant-persisted");
    expect(actions.fetchRun).toHaveBeenCalledWith("run-regenerated", "chat-a");
    expect(actions.notifyAnswerReady).toHaveBeenCalledOnce();
    expect(actions.resetThreadToLatest).toHaveBeenCalledOnce();
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
  });

  it("regenerates from a user message into the same assistant-sibling branch shape", async () => {
    vi.spyOn(Date, "now").mockReturnValue(124);
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [],
      consumeRunStream: async ({ onMessageIds, onRunId }) => {
        onRunId("run-from-user");
        onMessageIds({ assistantMessageId: "assistant-from-user" }, "run-from-user");
        return {
          failed: false,
          receivedChatUpdate: true,
          runId: "run-from-user"
        };
      }
    });
    prepareRegenerationThread();

    await actions.regenerateMessage("user-original");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/messages/user-original/regenerate",
      expect.objectContaining({ method: "POST" })
    );
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a")).toMatchObject({
      activeLeafId: "assistant-from-user",
      messages: [
        expect.objectContaining({ id: "user-original" }),
        expect.objectContaining({ id: "assistant-original", status: "complete" }),
        expect.objectContaining({
          id: "assistant-from-user",
          parentMessageId: "user-original",
          runId: "run-from-user",
          status: "complete"
        })
      ]
    });
  });

  it("rolls back a rejected regenerate to the prior assistant", async () => {
    vi.spyOn(Date, "now").mockReturnValue(456);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "regenerate_failed_500" }, { status: 500 }))
    );
    const consumeRunStream = vi.fn<ConsumeMessageRunStream>();
    const actions = useMessageRunActionsForTest({
      attachments: [],
      consumeRunStream
    });
    prepareRegenerationThread();

    await actions.regenerateMessage("assistant-original");

    expect(consumeRunStream).not.toHaveBeenCalled();
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a")).toMatchObject({
      activeLeafId: "assistant-original",
      messages: [
        expect.objectContaining({ id: "user-original" }),
        expect.objectContaining({ id: "assistant-original", status: "complete" })
      ]
    });
    expect(useWorkspaceStore.getState().chats[0]?.activeLeafMessageId).toBe(
      "assistant-original"
    );
    expect(actions.surface("chat-a").events).toEqual([
      {
        data: {
          message: "Regeneration failed with HTTP 500 (regenerate_failed_500)"
        },
        type: "error"
      }
    ]);
    expect(actions.notifyAnswerReady).not.toHaveBeenCalled();
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
  });

  it("records regenerate cancellation as a done event without an error notice", async () => {
    vi.spyOn(Date, "now").mockReturnValue(789);
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: []
    });
    prepareRegenerationThread();

    const regeneration = actions.regenerateMessage("assistant-original");
    actions.activeStreamAbortRef.current.get("chat-a")?.abort();
    await regeneration;

    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a").messages.at(-1)).toMatchObject({
      content: "Stopped.",
      id: "assistant-regen-789",
      status: "cancelled"
    });
    expect(actions.surface("chat-a").events).toEqual([
      {
        data: {
          runId: null,
          status: "cancelled"
        },
        type: "done"
      }
    ]);
    expect(actions.setNotice).not.toHaveBeenCalled();
    expect(actions.notifyAnswerReady).not.toHaveBeenCalled();
    expect(actions.activeStreamAbortRef.current.has("chat-a")).toBe(false);
    expect(useRunLifecycleStore.getState().activeStreams).toEqual({});
  });

  it("completes an inactive-chat regenerate with source-keyed fetch and canonical refresh", async () => {
    vi.spyOn(Date, "now").mockReturnValue(999);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    let actions!: ReturnType<typeof useMessageRunActionsForTest>;
    actions = useMessageRunActionsForTest({
      attachments: [],
      consumeRunStream: async ({ onMessageIds, onRunId }) => {
        onRunId("run-background");
        onMessageIds({ assistantMessageId: "assistant-background" }, "run-background");
        actions.activeChatIdRef.current = "chat-b";
        return {
          failed: false,
          receivedChatUpdate: false,
          runId: "run-background"
        };
      }
    });
    useRunSurfaceStore.getState().appendEvent("chat-a", {
      data: { runId: "stale-a" },
      type: "start"
    });
    useRunSurfaceStore.getState().appendEvent("chat-b", {
      data: { runId: "run-b" },
      type: "start"
    });
    prepareRegenerationThread();

    await actions.regenerateMessage("assistant-original");

    expect(actions.fetchRun).toHaveBeenCalledWith("run-background", "chat-a");
    expect(actions.refreshActiveChat).toHaveBeenCalledWith("chat-a", {
      forceDetail: true,
      preserveControls: true
    });
    expect(actions.notifyAnswerReady).toHaveBeenCalledOnce();
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a").messages.at(-1)).toMatchObject({
      id: "assistant-background",
      runId: "run-background",
      status: "complete"
    });
    expect(actions.surface("chat-a").events).toEqual([]);
    expect(actions.surface("chat-b").events).toEqual([
      { data: { runId: "run-b" }, type: "start" }
    ]);
  });
});
