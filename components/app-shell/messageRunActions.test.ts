import { afterEach, describe, expect, it, vi } from "vitest";
import { resetComposerControlStoreForTest, resetComposerSessionStoreForTest, resetMemorySettingsStoreForTest, resetRunLifecycleStoreForTest, resetRunSurfaceStoreForTest, resetThreadStoreForTest, resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";
import { useComposerControlStore } from "./composerControlStore";
import {
  composerSessionKey,
  selectComposerSession,
  useComposerSessionStore,
  type ComposerSessionKey
} from "./composerSessionStore";
import type { ConsumeMessageRunStream } from "./messageRunLifecycle";
import { useMessageRunActions } from "./messageRunActions";
import { useRunLifecycleStore } from "./runLifecycleStore";
import {
  selectRunSurface,
  useRunSurfaceStore
} from "./runSurfaceStore";
import { selectThreadSnapshot, useThreadStore } from "./threadStore";
import { useWorkspaceStore } from "./workspaceStore";
import type { ComposerAttachment } from "@/components/app-shell/attachmentContracts";
import type { Catalog, CatalogModel, ChatDetail, WorkspaceChatSummary } from "./types";
import type { SavedControlDraft } from "./powerAppShellData";
import { memorySettingsFixture } from "@/tests/support/memoryFixtures";
import { useMemorySettingsStore } from "./memorySettingsStore";

const hostedSearchOptionId = "hosted-openai-search";
const clientSearchOptionId = "client-openai-search";
const searchAttachment = {
  fileName: "search-evidence.txt",
  id: "attachment-search-evidence",
  kind: "document" as const
};
const newerSearchAttachment = {
  fileName: "newer-search-evidence.txt",
  id: "attachment-newer-search-evidence",
  kind: "document" as const
};

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

const mixedSearchModel: CatalogModel = {
  ...model,
  searchOptionCompatibility: {
    [clientSearchOptionId]: {
      clientToolCompatible: true,
      executionModes: ["all_selected", "model_choice"]
    },
    [hostedSearchOptionId]: {
      clientToolCompatible: false,
      executionModes: ["model_choice"]
    }
  },
  searchStrategyIds: [
    "search-disabled",
    hostedSearchOptionId,
    clientSearchOptionId
  ]
};

function mixedSearchCatalog(
  searchPreferenceSource: "organization" | "personal"
): Catalog {
  const retainedPlan = {
    mode: "all_selected" as const,
    optionIds: [hostedSearchOptionId, clientSearchOptionId]
  };

  return {
    defaults: {
      controlValues: {},
      hasPersonalModelDefault: true,
      modelId: mixedSearchModel.modelId,
      modelPreferenceSource: "personal",
      organizationModelDefault: null,
      organizationSearchPlan: retainedPlan,
      personalModelDefault: {
        modelId: mixedSearchModel.modelId,
        provider: mixedSearchModel.provider
      },
      provider: mixedSearchModel.provider,
      searchPlan: retainedPlan,
      searchPreferenceSource,
      showCitations: true,
      showReasoningBlocks: false,
    },
    models: [mixedSearchModel],
    providers: [
      {
        id: mixedSearchModel.provider,
        models: [mixedSearchModel.modelId],
        name: "OpenAI"
      }
    ],
    searchStrategies: [
      {
        displayName: "No Search",
        kind: "none",
        strategyId: "search-disabled"
      },
      {
        displayName: "Hosted OpenAI Search",
        kind: "web_search",
        strategyId: hostedSearchOptionId
      },
      {
        displayName: "Client OpenAI Search",
        kind: "web_search",
        strategyId: clientSearchOptionId
      }
    ]
  };
}

function chat(): WorkspaceChatSummary {
  return {
    activeLeafMessageId: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
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

function prepareRegenerationThread(
  userContent: unknown = "Original question",
  assistantContent: unknown = "Original answer"
) {
  useThreadStore.getState().replaceThread("chat-a", {
    activeLeafId: "assistant-original",
    messages: [
      {
        content: userContent,
        id: "user-original",
        parentMessageId: null,
        role: "user",
        status: "complete"
      },
      {
        content: assistantContent,
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
  activeChat?: WorkspaceChatSummary | null;
  activeChatId?: string | null;
  activeChatStreaming?: boolean;
  attachments: ComposerAttachment[];
  buildControlDraft?: () => SavedControlDraft;
  buildParams?: () => Record<string, unknown>;
  consumeRunStream?: ConsumeMessageRunStream;
  createChat?: (
    folderId?: string | null,
    sourceSessionKey?: ComposerSessionKey
  ) => Promise<WorkspaceChatSummary | null>;
  draft?: string;
  editingMessageId?: string | null;
  fetchRun?: (runId: string, chatId: string) => Promise<unknown>;
  model?: CatalogModel;
  openMemorySettings?: () => void;
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
  resetMemorySettingsStoreForTest();
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
    selectedAssistant: null,
    selectedModelId: "gpt-5.5",
    selectedProvider: "openai",
    selectedSearchOptionIds: [],
    searchPlanMode: "all_selected",
  });

  const activeStreamAbortRef = { current: new Map<string, AbortController>() };
  const fetchRun = vi.fn(input.fetchRun ?? (async () => null));
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
    buildControlDraft:
      input.buildControlDraft ??
      (() => ({
        backgroundMode: true,
        maxOutputTokens: "128000",
        reasoningEffort: "medium",
        streamMode: false,
        temperature: "1"
      })),
    buildParams: input.buildParams ?? (() => ({})),
    consumeRunStream:
      input.consumeRunStream ??
      (async () => {
        activeChatIdRef.current = "chat-b";
        return {
          failed: false,
          receivedChatUpdate: true,
          runId: "run-1",
          terminalStatus: "complete"
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
    openMemorySettings: input.openMemorySettings ?? vi.fn(),
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
    resetMemorySettingsStoreForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes an ambiguous Memory target to Manage Memories without claiming a mutation", async () => {
    const openMemorySettings = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: "memory_intent_confirmation_required"
    }, { status: 409 })));
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "Forget the preference I mentioned.",
      openMemorySettings
    });
    useMemorySettingsStore.setState({
      data: memorySettingsFixture(),
      error: null,
      loadState: "ready"
    });

    await actions.submitComposer();

    expect(actions.setNotice).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({ label: "Manage Memories" }),
      kind: "error",
      persistent: true,
      text: "Choose the exact saved memory before AIQSA changes anything."
    }));
    const notice = actions.setNotice.mock.calls.at(-1)?.[0];
    expect(notice?.kind).toBe("error");
    notice?.action?.onClick();
    expect(openMemorySettings).toHaveBeenCalledOnce();
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      draft: "Forget the preference I mentioned.",
      pendingSend: null
    });
  });

  it.each([
    ["attachment_unavailable", "Remove report.docx before sending."],
    ["attachment_poll_timeout", "Remove or retry report.docx before sending."]
  ])("keeps programmatic send recovery truthful for %s", async (
    processingErrorCode,
    expectedNotice
  ) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [{
        fileName: "report.docx",
        id: "attachment-1",
        kind: "document",
        processingErrorCode,
        status: "failed"
      }]
    });

    await actions.submitComposer();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(actions.setNotice).toHaveBeenCalledWith({
      kind: "error",
      text: expectedNotice
    });
  });

  it("blocks a programmatic send over projected attachment limits without clearing work", async () => {
    const nativeModel: CatalogModel = {
      ...model,
      capabilities: {
        ...model.capabilities,
        documentInputMode: "native_pdf"
      }
    };
    const attachment = {
      byteSize: 101,
      fileName: "paper.pdf",
      id: "paper",
      kind: "pdf" as const
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [attachment],
      draft: "Review the paper",
      model: nativeModel
    });
    useWorkspaceStore.setState({
      catalog: {
        ...mixedSearchCatalog("personal"),
        attachmentLimits: {
          maxCount: 20,
          maxEncodedBytes: 200,
          maxMaterializedBytes: 100
        },
        models: [nativeModel]
      }
    });

    await actions.submitComposer();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(actions.setNotice).toHaveBeenCalledWith({
      kind: "error",
      text: "Selected attachments require about 101 bytes of the 100 bytes attachment-data limit. Remove files or choose a model that uses extracted text."
    });
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      attachments: [attachment],
      draft: "Review the paper",
      pendingSend: null
    });
  });

  it("preserves an allowlisted stale-catalog limit message with the restored draft", async () => {
    const message = "This run contains 24 attachments; the limit is 20.";
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: "attachment_count_limit_exceeded",
          message
        },
        { status: 413 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "Keep this draft"
    });

    await actions.submitComposer();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      attachments: [],
      draft: "Keep this draft",
      operationError: message,
      operationErrorLive: false,
      pendingSend: null
    });
  });

  it("rejects a stale programmatic send when a zero-text partial PDF needs extracted text", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const renderedNativeModel: CatalogModel = {
      ...model,
      capabilities: {
        ...model.capabilities,
        documentInputMode: "native_pdf"
      },
      modelId: "native-model"
    };
    const selectedExtractionModel: CatalogModel = {
      ...model,
      modelId: "extraction-model"
    };
    const zeroTextPartialPdf: ComposerAttachment = {
      extractedText: null,
      fileName: "astral.pdf",
      id: "attachment-astral",
      kind: "pdf",
      processing: {
        extractedCharacterCount: 0,
        pageCount: 8,
        pagesProcessed: 1,
        status: "partial",
        truncationReason: "text_limit"
      }
    };
    const actions = useMessageRunActionsForTest({
      attachments: [zeroTextPartialPdf],
      draft: "Read this scan",
      model: renderedNativeModel
    });
    const selectedCatalog = mixedSearchCatalog("personal");
    useWorkspaceStore.setState({
      catalog: {
        ...selectedCatalog,
        defaults: {
          ...selectedCatalog.defaults,
          modelId: selectedExtractionModel.modelId,
          provider: selectedExtractionModel.provider
        },
        models: [renderedNativeModel, selectedExtractionModel]
      }
    });
    useComposerControlStore.setState({
      selectedModelId: selectedExtractionModel.modelId,
      selectedProvider: selectedExtractionModel.provider
    });

    await actions.submitComposer();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(actions.session(actions.sourceSessionKey)).toMatchObject({
      attachments: [zeroTextPartialPdf],
      draft: "Read this scan",
      pendingSend: null
    });
    expect(actions.setNotice).toHaveBeenCalledWith({
      kind: "error",
      text: "No PDF text could be retained within the configured limit. Choose a model with native PDF support or remove this file."
    });
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
          runId: "run-a",
          terminalStatus: "complete"
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

  it("sends only the assistant identity with content when an assistant is selected", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [],
      draft: "Question for the assistant"
    });
    useComposerControlStore.setState({
      knowledgePlanSource: "assistant",
      selectedAssistant: {
        avatar: {
          accents: [0],
          backgroundShape: "circle",
          foregroundShape: "diamond",
          kind: "generated",
          paletteId: "ocean",
          recipeVersion: 1,
          rotations: [0, 1]
        },
        description: "Focused helper",
        id: "assistant-selected",
        name: "Researcher",
        promptCharacterCount: 42,
        starterPrompts: []
      },
      selectedKnowledgeBaseIds: ["assistant-base-private"]
    });

    await actions.submitComposer();

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toEqual({
      assistantId: "assistant-selected",
      content: {
        blocks: [{ text: "Question for the assistant", type: "text" }]
      },
      expectedActiveLeafId: null
    });
  });

  it("materializes an ordinary explicit Knowledge plan in the run request", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({ attachments: [], draft: "Use policies" });
    useComposerControlStore.setState({
      knowledgePlanSource: "explicit",
      selectedKnowledgeBaseIds: ["base-policies", "base-release"]
    });

    await actions.submitComposer();

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      knowledgePlan: { baseIds: ["base-policies", "base-release"] }
    });
  });

  it.each(["chat", "project", "off"] as const)(
    "leaves a %s Knowledge default for server-side admission",
    async (knowledgePlanSource) => {
      const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const actions = useMessageRunActionsForTest({ attachments: [], draft: "Use defaults" });
      useComposerControlStore.setState({
        knowledgePlanSource,
        selectedKnowledgeBaseIds: knowledgePlanSource === "off" ? [] : ["effective-base"]
      });

      await actions.submitComposer();

      const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(requestInit.body))).not.toHaveProperty("knowledgePlan");
    }
  );

  it("sends an explicit empty Knowledge plan instead of falling back to defaults", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({ attachments: [], draft: "No Knowledge" });
    useComposerControlStore.setState({
      knowledgePlanSource: "explicit",
      selectedKnowledgeBaseIds: []
    });

    await actions.submitComposer();

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({ knowledgePlan: { baseIds: [] } });
  });

  it.each(["personal", "organization"] as const)(
    "uses model-choice execution for a mixed hosted/client %s Search preference",
    async (searchPreferenceSource) => {
      const fetchMock = vi.fn(async (..._args: unknown[]) =>
        new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const actions = useMessageRunActionsForTest({
        attachments: [],
        model: mixedSearchModel
      });
      useWorkspaceStore.getState().setCatalog(
        mixedSearchCatalog(searchPreferenceSource)
      );
      useComposerControlStore.setState({
        selectedSearchOptionIds: [hostedSearchOptionId, clientSearchOptionId],
        searchPlanMode: "all_selected",
      });

      await actions.submitComposer();

      const [, requestInit] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit
      ];
      expect(JSON.parse(String(requestInit.body))).toMatchObject({
        searchPlan: {
          mode: "model_choice",
          optionIds: [hostedSearchOptionId, clientSearchOptionId]
        },
        searchPreferencePlan: {
          mode: "all_selected",
          optionIds: [hostedSearchOptionId, clientSearchOptionId]
        },
        searchPreferenceSource
      });
    }
  );

  it.each([
    {
      expectedMode: "all_selected" as const,
      expectedOptionIds: [clientSearchOptionId],
      label: "keeps a client-only plan",
      selectedOptionIds: [clientSearchOptionId]
    },
    {
      expectedMode: "all_selected" as const,
      expectedOptionIds: [hostedSearchOptionId],
      label: "keeps a hosted-only plan",
      selectedOptionIds: [hostedSearchOptionId]
    },
    {
      expectedMode: "model_choice" as const,
      expectedOptionIds: [hostedSearchOptionId, clientSearchOptionId],
      label: "keeps and reconciles a mixed plan",
      selectedOptionIds: [hostedSearchOptionId, clientSearchOptionId]
    }
  ])("$label for a send with attachments", async ({
    expectedMode,
    expectedOptionIds,
    selectedOptionIds
  }) => {
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [searchAttachment],
      model: mixedSearchModel
    });
    useWorkspaceStore.getState().setCatalog(mixedSearchCatalog("personal"));
    useComposerControlStore.setState({
      selectedSearchOptionIds: selectedOptionIds,
      searchPlanMode: "all_selected",
    });

    await actions.submitComposer();

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      searchPlan: {
        mode: expectedMode,
        optionIds: expectedOptionIds
      },
      searchPreferencePlan: {
        mode: "all_selected",
        optionIds: selectedOptionIds
      },
      searchPreferenceSource: "personal"
    });
  });

  it("keeps client Search active while sending captured attachments across deferred leaf persistence", async () => {
    let markPersistStarted!: () => void;
    let resolvePersist!: () => void;
    const persistStarted = new Promise<void>((resolve) => {
      markPersistStarted = resolve;
    });
    const persistActiveLeaf = vi.fn(() => {
      markPersistStarted();
      return new Promise<void>((resolve) => {
        resolvePersist = resolve;
      });
    });
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      activeChat: { ...chat(), activeLeafMessageId: "message-selected" },
      attachments: [searchAttachment],
      draft: "Question with sent attachment",
      model: mixedSearchModel,
      persistActiveLeaf
    });
    useWorkspaceStore.getState().setCatalog(mixedSearchCatalog("personal"));
    useComposerControlStore.setState({
      selectedSearchOptionIds: [clientSearchOptionId],
      searchPlanMode: "all_selected",
    });

    const submit = actions.submitComposer();
    await persistStarted;
    expect(actions.session(composerSessionKey("chat-a")).pendingSend).toMatchObject({
      attachments: [searchAttachment]
    });
    useComposerSessionStore.getState().setDraft("Newer question");
    useComposerSessionStore.getState().setAttachments([newerSearchAttachment]);
    resolvePersist();
    await submit;

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      content: {
        blocks: [
          { text: "Question with sent attachment", type: "text" },
          { attachmentId: searchAttachment.id, type: "file" }
        ]
      },
      searchPlan: {
        mode: "all_selected",
        optionIds: [clientSearchOptionId]
      },
      searchPreferencePlan: {
        mode: "all_selected",
        optionIds: [clientSearchOptionId]
      }
    });
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      attachments: [newerSearchAttachment],
      draft: "Newer question",
      pendingSend: null
    });
  });

  it("does not apply newer live attachments to a send token captured before deferred chat creation", async () => {
    let markCreateStarted!: () => void;
    let resolveCreate!: (chat: WorkspaceChatSummary) => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createdChat = {
      ...chat(),
      id: "chat-created-after-send-snapshot"
    };
    const createChat = vi.fn(() => {
      markCreateStarted();
      return new Promise<WorkspaceChatSummary>((resolve) => {
        resolveCreate = resolve;
      });
    });
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      activeChat: null,
      activeChatId: null,
      attachments: [],
      createChat,
      draft: "Question without sent attachments",
      model: mixedSearchModel
    });
    useWorkspaceStore.getState().setCatalog(mixedSearchCatalog("personal"));
    useComposerControlStore.setState({
      selectedSearchOptionIds: [clientSearchOptionId],
      searchPlanMode: "all_selected",
    });

    const submit = actions.submitComposer();
    await createStarted;
    expect(actions.session(composerSessionKey(null)).pendingSend).toMatchObject({
      attachments: []
    });
    useComposerSessionStore.getState().setDraft("Newer blank-chat question");
    useComposerSessionStore.getState().setAttachments([newerSearchAttachment]);
    resolveCreate(createdChat);
    await submit;

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      content: {
        blocks: [{ text: "Question without sent attachments", type: "text" }]
      },
      searchPlan: {
        mode: "all_selected",
        optionIds: [clientSearchOptionId]
      },
      searchPreferencePlan: {
        mode: "all_selected",
        optionIds: [clientSearchOptionId]
      }
    });
    expect(actions.session(composerSessionKey(createdChat.id))).toMatchObject({
      attachments: [newerSearchAttachment],
      draft: "Newer blank-chat question",
      pendingSend: null
    });
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

  it("sends the exact reviewed Temporary admission only from the keyed first-send draft", async () => {
    const createdChat = { ...chat(), id: "chat-temporary" };
    const createChat = vi.fn(async () => createdChat);
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).endsWith("/memory-mode")
        ? Response.json({
            chat: {
              archived: false,
              chatId: createdChat.id,
              mode: "TEMPORARY",
              sourceRevision: 1,
              temporaryRetentionDeadline: "2026-06-11T00:00:00.000Z",
              temporaryRetentionPolicyVersion: "temporary-24h-v1",
              updatedAt: "2026-06-10T00:00:00.000Z"
            }
          })
        : new Response("", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      activeChat: null,
      activeChatId: null,
      attachments: [],
      createChat,
      draft: "Normal draft must stay isolated"
    });
    const temporaryKey = composerSessionKey(null, null, "TEMPORARY");
    useComposerSessionStore.getState().activateSession(temporaryKey);
    useComposerSessionStore.getState().setDraft("Temporary question");

    await actions.submitComposer();

    expect(createChat).toHaveBeenCalledWith(null, temporaryKey);
    const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/messages"));
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      chatMode: "TEMPORARY",
      temporaryRetentionPolicyVersion: "temporary-24h-v1"
    });
    expect(actions.session(composerSessionKey(null)).draft).toBe("Normal draft must stay isolated");
  });

  it("preserves and repeats a reviewed Temporary intent after ambiguous admission failure", async () => {
    const pendingTemporary = {
      ...chat(),
      pendingInitialMemoryMode: "TEMPORARY" as const
    };
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).endsWith("/memory-mode")
        ? Response.json({ error: "memory_unavailable" }, { status: 503 })
        : Response.json({ error: "run_rejected" }, { status: 409 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      activeChat: pendingTemporary,
      attachments: [],
      draft: "Temporary retry"
    });

    await actions.submitComposer();
    expect(useWorkspaceStore.getState().chats[0]?.pendingInitialMemoryMode).toBe("TEMPORARY");
    expect(actions.session(composerSessionKey("chat-a")).draft).toBe("Temporary retry");
    await actions.submitComposer();

    const postBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/messages"))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(postBodies).toHaveLength(2);
    for (const body of postBodies) {
      expect(body).toMatchObject({
        chatMode: "TEMPORARY",
        temporaryRetentionPolicyVersion: "temporary-24h-v1"
      });
    }
  });

  it("omits first-send fields from subsequent Temporary runs", async () => {
    const existingTemporary = {
      ...chat(),
      memoryMode: "TEMPORARY" as const,
      memorySourceRevision: 2,
      messageCount: 2,
      temporaryRetentionDeadline: "2026-06-11T00:00:00.000Z"
    };
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).endsWith("/memory-mode")
        ? Response.json({
            chat: {
              archived: false,
              chatId: existingTemporary.id,
              mode: "TEMPORARY",
              sourceRevision: 2,
              temporaryRetentionDeadline: existingTemporary.temporaryRetentionDeadline,
              temporaryRetentionPolicyVersion: "temporary-24h-v1",
              updatedAt: existingTemporary.updatedAt
            }
          })
        : new Response("", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      activeChat: existingTemporary,
      attachments: [],
      draft: "Follow-up"
    });

    await actions.submitComposer();

    const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/messages"));
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body).not.toHaveProperty("chatMode");
    expect(body).not.toHaveProperty("temporaryRetentionPolicyVersion");
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
    const unsupportedModel = {
      ...model,
      capabilities: {
        ...model.capabilities,
        toolCalling: false
      },
      modelId: "selected-without-tools",
      provider: "selected-provider"
    };
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [],
      model
    });
    useWorkspaceStore.getState().setCatalog({
      ...mixedSearchCatalog("personal"),
      models: [model, unsupportedModel]
    });
    useComposerControlStore.setState({
      selectedModelId: unsupportedModel.modelId,
      selectedProvider: unsupportedModel.provider
    });
    prepareRegenerationThread();

    await actions.regenerateMessage("assistant-original");

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      modelId: unsupportedModel.modelId,
      provider: unsupportedModel.provider,
      tools: "none"
    });
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
      operationError: "Send failed. Your draft was preserved.",
      operationErrorLive: true
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
    let resolveCreateChat!: (chat: WorkspaceChatSummary) => void;
    const createChat = vi.fn(
      () =>
        new Promise<WorkspaceChatSummary>((resolve) => {
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
      searchPlan: { mode: "all_selected", optionIds: [] }
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

  it("keeps one selected-model snapshot across blank chat creation", async () => {
    const selectedModel = {
      ...model,
      defaultParams: { maxOutputTokens: 4096 },
      modelId: "selected-model-b",
      provider: "selected-provider-b"
    };
    const createdChat = {
      ...chat(),
      defaultModelId: model.modelId,
      defaultProvider: model.provider,
      id: "chat-created-with-old-defaults"
    };
    const createChat = vi.fn(async () => {
      useComposerControlStore.setState({
        maxOutputTokens: "128000",
        selectedModelId: model.modelId,
        selectedProvider: model.provider
      });
      return createdChat;
    });
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      activeChat: null,
      activeChatId: null,
      attachments: [],
      buildControlDraft: () => {
        const controls = useComposerControlStore.getState();
        return {
          maxOutputTokens: controls.maxOutputTokens,
          reasoningEffort: controls.reasoningEffort
        };
      },
      buildParams: () => {
        const controls = useComposerControlStore.getState();
        return {
          capturedModel: `${controls.selectedProvider}:${controls.selectedModelId}`,
          maxOutputTokens: Number(controls.maxOutputTokens)
        };
      },
      createChat,
      model: selectedModel
    });
    useWorkspaceStore.getState().setCatalog({
      ...mixedSearchCatalog("personal"),
      models: [model, selectedModel]
    });
    useComposerControlStore.setState({
      maxOutputTokens: "4096",
      selectedModelId: selectedModel.modelId,
      selectedProvider: selectedModel.provider
    });

    await actions.submitComposer();

    expect(createChat).toHaveBeenCalledWith(null, composerSessionKey(null));
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      controlDefaults: {
        maxOutputTokens: "4096"
      },
      modelId: selectedModel.modelId,
      params: {
        capturedModel: `${selectedModel.provider}:${selectedModel.modelId}`,
        maxOutputTokens: 4096
      },
      provider: selectedModel.provider
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
          runId: "run-a",
          terminalStatus: "complete"
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
      buildControlDraft: () => {
        const controls = useComposerControlStore.getState();
        return {
          backgroundMode: controls.backgroundMode,
          maxOutputTokens: controls.maxOutputTokens,
          reasoningEffort: controls.reasoningEffort,
          streamMode: controls.streamMode,
          temperature: controls.temperature
        };
      },
      buildParams: () => {
        const controls = useComposerControlStore.getState();
        return {
          capturedModel: `${controls.selectedProvider}:${controls.selectedModelId}`,
          maxOutputTokens: Number(controls.maxOutputTokens)
        };
      },
      draft: "Edited answer",
      editingMessageId: "message-1",
      model: {
        ...mixedSearchModel,
        capabilities: {
          ...mixedSearchModel.capabilities,
          toolCalling: false
        },
        modelId: "source-model",
        provider: "source-provider"
      },
      refreshActiveChat
    });
    const sourceModel = {
      ...mixedSearchModel,
      capabilities: {
        ...mixedSearchModel.capabilities,
        toolCalling: false
      },
      modelId: "source-model",
      provider: "source-provider"
    };
    const otherModel = {
      ...model,
      modelId: "other-model",
      provider: "other-provider"
    };
    useWorkspaceStore.getState().setCatalog({
      ...mixedSearchCatalog("personal"),
      defaults: {
        ...mixedSearchCatalog("personal").defaults,
        modelId: sourceModel.modelId,
        provider: sourceModel.provider
      },
      models: [sourceModel, otherModel]
    });
    useComposerControlStore.setState({
      backgroundMode: false,
      maxOutputTokens: "4096",
      reasoningEffort: "high",
      selectedModelId: sourceModel.modelId,
      selectedProvider: sourceModel.provider,
      selectedSearchOptionIds: [hostedSearchOptionId, clientSearchOptionId],
      searchPlanMode: "all_selected",
      streamMode: true,
      temperature: "0.25"
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
    useComposerControlStore.setState({
      backgroundMode: true,
      maxOutputTokens: "8192",
      reasoningEffort: "low",
      selectedModelId: otherModel.modelId,
      selectedProvider: otherModel.provider,
      selectedSearchOptionIds: [],
      searchPlanMode: "model_choice",
      streamMode: false,
      temperature: "1"
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
    const [, regenerateInit] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit
    ];
    expect(JSON.parse(String(regenerateInit.body))).toEqual({
      controlDefaults: {
        backgroundMode: false,
        maxOutputTokens: "4096",
        reasoningEffort: "high",
        streamMode: true,
        temperature: "0.25"
      },
      modelId: sourceModel.modelId,
      params: {
        capturedModel: `${sourceModel.provider}:${sourceModel.modelId}`,
        maxOutputTokens: 4096
      },
      provider: sourceModel.provider,
      searchPlan: {
        mode: "model_choice",
        optionIds: [hostedSearchOptionId, clientSearchOptionId]
      },
      searchPreferencePlan: {
        mode: "all_selected",
        optionIds: [hostedSearchOptionId, clientSearchOptionId]
      },
      searchPreferenceSource: "personal",
      timeZone: expect.any(String),
      tools: "none"
    });
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
          runId: "run-edit",
          terminalStatus: "complete"
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
      searchPlan: { mode: "all_selected", optionIds: [] }
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

  it("does not apply staged attachments to the text-only edited branch run", async () => {
    const fetchMock = vi
      .fn(async (..._args: unknown[]) => new Response("", { status: 200 }))
      .mockImplementationOnce(async () => editResponse("Edited question"));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [searchAttachment],
      draft: "Edited question",
      editingMessageId: "message-1",
      model: mixedSearchModel
    });
    useWorkspaceStore.getState().setCatalog(mixedSearchCatalog("personal"));
    useComposerControlStore.setState({
      selectedSearchOptionIds: [clientSearchOptionId],
      searchPlanMode: "all_selected",
    });

    await actions.submitComposer();

    const [, regenerateInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(regenerateInit.body))).toMatchObject({
      searchPlan: {
        mode: "all_selected",
        optionIds: [clientSearchOptionId]
      },
      searchPreferencePlan: {
        mode: "all_selected",
        optionIds: [clientSearchOptionId]
      }
    });
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
        contextStats: {
          approximateActiveBranchInputTokens: 48
        },
        messageCount: 2,
        messages: canonicalMessages,
        pageInfo: {
          activeLeafMessageId: "assistant-canonical",
          beforeCursor: null,
          hasOlder: false,
          snapshotUpdatedAt: chat().updatedAt
        },
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

    await expect(actions.refreshInterruptedRun("chat-a")).resolves.toBe(true);
    await actions.submitComposer();

    expect(actions.refreshActiveChat).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(retryInit.body))).toMatchObject({
      expectedActiveLeafId: "assistant-canonical"
    });
  });

  it("refreshes a known interrupted run outcome before reconciling its chat", async () => {
    const order: string[] = [];
    const actions = useMessageRunActionsForTest({
      attachments: [],
      fetchRun: async (runId, chatId) => {
        order.push(`outcome:${chatId}:${runId}`);
        return { id: runId, status: "complete" };
      },
      refreshActiveChat: async (chatId) => {
        order.push(`chat:${chatId}`);
        return {
          ...chat(),
          contextStats: { approximateActiveBranchInputTokens: 0 },
          messages: [],
          pageInfo: {
            activeLeafMessageId: null,
            beforeCursor: null,
            hasOlder: false,
            snapshotUpdatedAt: chat().updatedAt
          },
          usageStats: null
        };
      }
    });
    useRunLifecycleStore.getState().streamAmbiguous({
      assistantMessageId: "assistant-interrupted",
      chatId: "chat-a",
      runId: "run-interrupted"
    });

    await expect(actions.refreshInterruptedRun("chat-a")).resolves.toBe(true);

    expect(order).toEqual([
      "outcome:chat-a:run-interrupted",
      "chat:chat-a"
    ]);
    expect(actions.fetchRun).toHaveBeenCalledWith("run-interrupted", "chat-a");
    expect(useRunLifecycleStore.getState().ambiguousFailures).toEqual({});
  });

  it("refreshes an ambiguous send only on user request and only in its source chat", async () => {
    const canonicalMessages = [
      {
        content: "Persisted question",
        id: "user-server-a",
        parentMessageId: null,
        role: "user" as const,
        status: "complete" as const
      },
      {
        content: "Provider result unavailable",
        id: "assistant-server-a",
        parentMessageId: "user-server-a",
        role: "assistant" as const,
        runId: "run-server-a",
        status: "error" as const
      }
    ];
    const refreshActiveChat = vi.fn(async (chatId: string | null) => {
      expect(chatId).toBe("chat-a");
      useThreadStore.getState().replaceThread("chat-a", {
        activeLeafId: "assistant-server-a",
        messages: canonicalMessages,
        usageStats: null
      });
      useWorkspaceStore.getState().updateChats((current) =>
        current.map((candidate) =>
          candidate.id === "chat-a"
            ? { ...candidate, activeLeafMessageId: "assistant-server-a" }
            : candidate
        )
      );
      return {
        ...chat(),
        activeLeafMessageId: "assistant-server-a",
        contextStats: { approximateActiveBranchInputTokens: 48 },
        messageCount: 2,
        messages: canonicalMessages,
        pageInfo: {
          activeLeafMessageId: "assistant-server-a",
          beforeCursor: null,
          hasOlder: false,
          snapshotUpdatedAt: chat().updatedAt
        },
        usageStats: null
      };
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

    expect(actions.refreshActiveChat).not.toHaveBeenCalled();
    expect(useRunLifecycleStore.getState().ambiguousFailures).toMatchObject({
      "chat-a": { assistantMessageId: expect.any(String), runId: null }
    });
    await expect(actions.refreshInterruptedRun("chat-a")).resolves.toBe(true);
    expect(actions.refreshActiveChat).toHaveBeenCalledWith("chat-a", {
      forceDetail: true,
      preserveControls: true
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
    expect(useRunLifecycleStore.getState().ambiguousFailures).toEqual({});
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
          runId: "run-send",
          terminalStatus: "complete"
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
      operationErrorLive: false,
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
    expect(actions.surface("chat-new").events).toEqual([]);
    expect(useRunLifecycleStore.getState().ambiguousFailures["chat-new"]).toEqual({
      assistantMessageId: expect.any(String),
      runId: null
    });
  });

  it("keeps an ambiguous send visible until an explicit refresh succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    const actions = useMessageRunActionsForTest({
      attachments: [],
      consumeRunStream: async () => {
        throw new Error("stream disconnected");
      },
      draft: "Question that remains retryable",
      refreshActiveChat: async () => null
    });

    await actions.submitComposer();

    expect(selectThreadSnapshot(useThreadStore.getState(), "chat-a").messages).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ content: "", role: "assistant", status: "error" })
    ]);
    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      draft: "Question that remains retryable",
      operationError: "Send failed. Your draft was preserved.",
      operationErrorLive: false,
      pendingSend: null
    });
    expect(actions.surface("chat-a").events).toEqual([]);
    await expect(actions.refreshInterruptedRun("chat-a")).resolves.toBe(false);
    expect(useRunLifecycleStore.getState().ambiguousFailures).toHaveProperty("chat-a");
  });

  it("does not announce an ambiguous source-chat failure after focus moves away", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    let actions!: ReturnType<typeof useMessageRunActionsForTest>;
    actions = useMessageRunActionsForTest({
      attachments: [],
      consumeRunStream: async () => {
        actions.activeChatIdRef.current = "chat-b";
        useWorkspaceStore.getState().setActiveChatId("chat-b");
        throw new Error("stream disconnected");
      }
    });

    await actions.submitComposer();

    expect(actions.session(composerSessionKey("chat-a"))).toMatchObject({
      operationError: "Send failed. Your draft was preserved.",
      operationErrorLive: false
    });
    expect(actions.refreshActiveChat).not.toHaveBeenCalled();
    expect(useRunLifecycleStore.getState().ambiguousFailures).toHaveProperty("chat-a");
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
    expect(actions.surface(createdChat.id)).toEqual({
      events: []
    });
    expect(actions.session(composerSessionKey(createdChat.id))).toMatchObject({
      draft: "Question that should survive",
      operationError: "Send failed. Your draft was preserved.",
      operationErrorLive: true,
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
          runId: "run-regenerated",
          terminalStatus: "complete"
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
        streamMode: false,
        temperature: "1"
      },
      modelId: "gpt-5.5",
      params: {},
      provider: "openai",
      searchPlan: {
        mode: "all_selected",
        optionIds: []
      },
      searchPreferencePlan: {
        mode: "all_selected",
        optionIds: []
      },
      searchPreferenceSource: "personal",
      timeZone: expect.any(String)
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
          runId: "run-from-user",
          terminalStatus: "complete"
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

  it.each(["assistant-original", "user-original"])(
    "keeps client Search when regenerating %s from an attachment-bearing source user",
    async (messageId) => {
      const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const actions = useMessageRunActionsForTest({
        attachments: [],
        model: mixedSearchModel
      });
      useWorkspaceStore.getState().setCatalog(mixedSearchCatalog("personal"));
      useComposerControlStore.setState({
        selectedSearchOptionIds: [clientSearchOptionId],
        searchPlanMode: "model_choice",
      });
      prepareRegenerationThread({
        blocks: [
          { text: "Original question", type: "text" },
          {
            attachmentId: searchAttachment.id,
            fileName: searchAttachment.fileName,
            type: "file"
          }
        ]
      });

      await actions.regenerateMessage(messageId);

      const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(requestInit.body))).toMatchObject({
        searchPlan: {
          mode: "model_choice",
          optionIds: [clientSearchOptionId]
        },
        searchPreferencePlan: {
          mode: "model_choice",
          optionIds: [clientSearchOptionId]
        }
      });
    }
  );

  it("keeps client Search regardless of staged or historical assistant attachments", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions = useMessageRunActionsForTest({
      attachments: [searchAttachment],
      model: mixedSearchModel
    });
    useWorkspaceStore.getState().setCatalog(mixedSearchCatalog("personal"));
    useComposerControlStore.setState({
      selectedSearchOptionIds: [clientSearchOptionId],
      searchPlanMode: "all_selected",
    });
    prepareRegenerationThread("Original question", {
      blocks: [
        { text: "Original answer", type: "text" },
        {
          attachmentId: "assistant-only-attachment",
          type: "file"
        }
      ]
    });

    await actions.regenerateMessage("assistant-original");

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      searchPlan: {
        mode: "all_selected",
        optionIds: [clientSearchOptionId]
      }
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
          runId: "run-background",
          terminalStatus: "complete"
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
