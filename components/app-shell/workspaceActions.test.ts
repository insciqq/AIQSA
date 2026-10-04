import { act, renderHook } from "@testing-library/react";
import { useWorkspaceOutputReconciliation } from "./useWorkspaceOutputReconciliation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetChatAssistantProjectionStoreForTest,
  resetComposerSessionStoreForTest,
  resetComposerControlStoreForTest,
  resetRunSurfaceStoreForTest,
  resetThreadStoreForTest,
  resetWorkspaceStoreForTest,
  resetKnowledgeLibraryStoreForTest
} from "@/tests/support/appShellStores";
import {
  composerSessionKey,
  projectComposerSessionKey,
  selectActiveComposerSession,
  selectComposerSession,
  useComposerSessionStore,
  type ComposerSessionKey
} from "./composerSessionStore";
import { useComposerControlStore } from "./composerControlStore";
import { useChatAssistantProjectionStore } from "./chatAssistantProjectionStore";
import {
  assistantAvatarFixture,
  boundComposerAssistantFixture
} from "@/tests/support/composerAssistantFixtures";
import type { ChatAssistantProjection } from "@/lib/contracts/chats";
import { useKnowledgeLibraryStore } from "./knowledgeLibraryStore";
import { useRunSurfaceStore } from "./runSurfaceStore";
import { chatExportMarkdown } from "@/lib/domain/chatExport";
import { useWorkspaceActions, type BlankDefaultAssistant } from "./workspaceActions";
import {
  useThreadStore,
  type ThreadHistoryState
} from "./threadStore";
import {
  useWorkspaceStore,
  workspaceNavigationChats
} from "./workspaceStore";
import type { ComposerAttachment } from "@/components/app-shell/attachmentContracts";
import type { Catalog, ChatDetail, WorkspaceChatSummary, ThreadMessage } from "./types";
import { replaceComposerDraftEpoch } from "./composerDraftStorage";
import { rememberSessionExpiredDraft, storedSessionExpiredDraft } from "./shellStorage";

function continuationDetail(): ChatDetail {
  const summary = chat({ id: "continuation", title: "Continued: source", activeLeafMessageId: "summary",
    messageCount: 1, hasContinuationSource: true, memoryMode: "TEMPORARY", temporaryRetentionDeadline: "2026-09-06T12:00:00.000Z" });
  return { ...summary, contextStats: { approximateActiveBranchInputTokens: 20 }, usageStats: null,
    messages: [message({ id: "summary", role: "assistant", content: "Conversation summary" })],
    pageInfo: { activeLeafMessageId: "summary", beforeCursor: null, hasOlder: false, snapshotUpdatedAt: summary.updatedAt } };
}

describe("opening a continuation", () => {
  afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); resetComposerControlStoreForTest(); window.history.replaceState(null, "", "/"); });

  it("opens the summary, preserves controls and moves current text and attachments with their handoff", async () => {
    window.history.replaceState(null, "", "/c/chat-a?message=source-message&artifactEdit=edit&artifactId=artifact&versionId=version&library=mcp");
    const attachments: ComposerAttachment[] = [{ id: "one", fileName: "one.pdf", kind: "pdf" }, { id: "two", fileName: "two.pdf", kind: "pdf" }];
    const setup = useWorkspaceActionsForTest({ attachments, draft: "Unsent source draft" });
    const source = composerSessionKey("chat-a");
    rememberSessionExpiredDraft({ accountId: "account-a", epoch: replaceComposerDraftEpoch("account-a")!, draft: "Unsent source draft", sessionKey: source, savedAt: Date.now() });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    useComposerControlStore.setState({ selectedProvider: "other", selectedModelId: "chosen", temperature: "0.4",
      maxOutputTokens: "1700", reasoningEffort: "high", reasoningMode: "extended", streamMode: false, backgroundMode: true,
      showCitations: false, showReasoningBlocks: true, searchPlanMode: "model_choice", selectedSearchOptionIds: ["search"],
      knowledgePlanSource: "explicit", knowledgeSelection: { version: 1, mode: "explicit", baseIds: ["base"], sourceIds: ["source"] },
      selectedKnowledgeBaseIds: ["base"], mcpSelection: { mode: "load_all" },
      selectedSkills: [{ id: "skill", name: "Skill", description: "", promptCharacterCount: 10 }],
      assistant: boundComposerAssistantFixture({ id: "assistant", name: "Assistant" })
    });
    const controls = useComposerControlStore.getState();
    const opening = setup.actions.openContinuedChat(continuationDetail(), source);
    useComposerSessionStore.getState().updateSession(source, { draft: "Updated before the transition finished" });
    await expect(opening).resolves.toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().activeChatId).toBe("continuation");
    // The new chat's address drops the source chat's one-shot parameters.
    expect(`${window.location.pathname}${window.location.search}`).toBe("/c/continuation?library=mcp");
    expect(useWorkspaceStore.getState().chats.find((chat) => chat.id === "continuation")).toMatchObject({ memoryMode: "TEMPORARY", hasContinuationSource: true });
    expect(useWorkspaceStore.getState().navigationChats.some((chat) => chat.id === "continuation")).toBe(false);
    expect(setup.session(source)).toMatchObject({ draft: "", attachments: [] });
    expect(setup.activeComposer()).toMatchObject({ draft: "Updated before the transition finished", attachments });
    expect(storedSessionExpiredDraft()).toBeNull();
    expect(useComposerControlStore.getState()).toBe(controls);
    for (const setter of [setup.applyModelControlDefaults, setup.setSelectedModelId, setup.setSelectedProvider,
      setup.setSelectedSearchPlan, setup.setSelectedKnowledgePlan]) expect(setter).not.toHaveBeenCalled();
    expect(useThreadStore.getState().threadsByChatId.continuation?.messages[0]?.content).toBe("Conversation summary");
  });

  it.each(["non-empty destination", "upload started"])("opens without moving input during %s", async (condition) => {
    const setup = useWorkspaceActionsForTest({ attachments: [], draft: "Keep source" });
    const source = composerSessionKey("chat-a");
    const target = composerSessionKey("continuation");
    rememberSessionExpiredDraft({ accountId: "account-a", epoch: replaceComposerDraftEpoch("account-a")!, draft: "Keep source", sessionKey: source, savedAt: Date.now() });
    useComposerSessionStore.getState().activateSession(target);
    useComposerSessionStore.getState().setDraft(condition === "non-empty destination" ? "Keep destination" : "");
    useComposerSessionStore.getState().activateSession(source);
    const opening = setup.actions.openContinuedChat(continuationDetail(), source);
    if (condition === "upload started") useComposerSessionStore.getState().beginUpload(source);
    await expect(opening).resolves.toBe(true);
    expect(setup.session(source).draft).toBe("Keep source");
    expect(setup.session(target).draft).toBe(condition === "non-empty destination" ? "Keep destination" : "");
    expect(storedSessionExpiredDraft()?.sessionKey).toBe(source);
  });

  it.each(["before", "during"])("ignores navigation %s opening a continuation", async (when) => {
    const setup = useWorkspaceActionsForTest({ attachments: [], draft: "Keep source" });
    const source = composerSessionKey("chat-a");
    let opening: Promise<boolean>;
    if (when === "before") {
      setup.actions.activateBlankWorkspace();
      opening = setup.actions.openContinuedChat(continuationDetail(), source);
    } else {
      opening = setup.actions.openContinuedChat(continuationDetail(), source);
      setup.actions.activateBlankWorkspace();
    }
    await expect(opening).resolves.toBe(false);
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
    expect(setup.session(source).draft).toBe("Keep source");
    expect(setup.session(composerSessionKey("continuation")).draft).toBe("");
  });
});

function chat(input: Partial<WorkspaceChatSummary> & { id: string; title: string }): WorkspaceChatSummary {
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

function apiChatSummary(summary: WorkspaceChatSummary) {
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

function apiChatMemoryState(
  summary: WorkspaceChatSummary,
  mode: "NORMAL" | "EXCLUDED" | "TEMPORARY" = "NORMAL"
) {
  return {
    allowedActions: mode === "NORMAL" ? ["EXCLUDE"] : mode === "EXCLUDED" ? ["RESUME"] : [],
    archived: false,
    mode,
    temporaryRetentionDeadline: mode === "TEMPORARY" ? "2026-06-11T00:00:00.000Z" : null
  };
}

function apiChatSource(summary: WorkspaceChatSummary, sourceRevision = 0) {
  return {
    source: {
      chatId: summary.id,
      location: "ACTIVE_CHAT",
      memoryMode: summary.memoryMode ?? "NORMAL",
      sourceRevision,
      updatedAt: summary.updatedAt
    }
  };
}

function apiArchivedChat(summary: WorkspaceChatSummary, sourceRevision = 1) {
  return {
    chat: {
      archived: true,
      id: summary.id,
      memoryMode: "NORMAL",
      sourceRevision,
      updatedAt: summary.updatedAt
    }
  };
}

function apiMessage(candidate: ThreadMessage) {
  return {
    artifactSummary: candidate.artifactSummary ?? null,
    citationMessageId: candidate.citationMessageId ?? null,
    content: candidate.content,
    createdAt: "2026-06-10T00:00:00.000Z",
    errorMessage: null,
    id: candidate.id,
    modelId: candidate.modelId ?? null,
    modelRunId: candidate.runId ?? null,
    parentMessageId: candidate.parentMessageId,
    provider: candidate.provider ?? null,
    role: candidate.role,
    status: candidate.status,
    workspaceActivity: candidate.workspaceActivity ?? null
  };
}

function apiChatDetail(
  summary: WorkspaceChatSummary,
  messages: ThreadMessage[],
  options: {
    activeLeafMessageId?: string | null;
    beforeCursor?: string | null;
    contextTokens?: number;
    messageCount?: number;
    usageStats?: ChatDetail["usageStats"];
  } = {}
) {
  const activeLeafMessageId =
    options.activeLeafMessageId ?? messages.at(-1)?.id ?? null;
  const beforeCursor = options.beforeCursor === undefined
    ? messages[0]?.parentMessageId
      ? "cursor-before-page"
      : null
    : options.beforeCursor;
  const detailSummary = {
    ...summary,
    activeLeafMessageId,
    messageCount: options.messageCount ?? Math.max(summary.messageCount, messages.length)
  };

  return {
    ...apiChatSummary(detailSummary),
    contextStats: {
      approximateActiveBranchInputTokens: options.contextTokens ?? 96
    },
    messages: messages.map(apiMessage),
    pageInfo: {
      activeLeafMessageId,
      beforeCursor,
      hasOlder: beforeCursor !== null,
      snapshotUpdatedAt: detailSummary.updatedAt
    },
    usageStats: options.usageStats ?? null
  };
}

function apiMessagesPage(
  messages: ThreadMessage[],
  input: {
    activeLeafMessageId: string | null;
    beforeCursor: string | null;
    snapshotUpdatedAt: string;
  }
) {
  return {
    messages: messages.map(apiMessage),
    pageInfo: {
      ...input,
      hasOlder: input.beforeCursor !== null
    }
  };
}

function threadHistory(
  summary: WorkspaceChatSummary,
  overrides: Partial<ThreadHistoryState> = {}
): ThreadHistoryState {
  return {
    beforeCursor: null,
    error: null,
    hasOlder: false,
    loading: false,
    requestGeneration: 0,
    snapshotActiveLeafId: summary.activeLeafMessageId,
    snapshotUpdatedAt: summary.updatedAt,
    ...overrides
  };
}

function useWorkspaceActionsForTest(input: {
  activeChatId?: string | null;
  attachments: ComposerAttachment[];
  chooseDefaultAssistant?(assistantId: string, isCurrent: () => boolean): Promise<boolean>;
  draft: string;
  editingTitle?: string;
  includeConcurrentChat?: boolean;
  activeStreamChatIds?: string[];
  pendingThreadMutationChatIds?: string[];
}) {
  const catalog = {
    defaults: {
      controlValues: {},
      hasPersonalModelDefault: true,
      modelId: "gpt-5.5",
      modelPreferenceSource: "personal",
      organizationModelDefault: null,
      organizationSearchPlan: { mode: "all_selected", optionIds: [] },
      personalModelDefault: { modelId: "gpt-5.5", provider: "openai" },
      provider: "openai",
      searchPlan: { mode: "all_selected", optionIds: [] },
      searchPreferenceSource: "personal",
      showCitations: true,
      showReasoningBlocks: false,
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
  resetChatAssistantProjectionStoreForTest();
  // The test chats were read before; none has an Assistant.
  for (const known of initialChats) useChatAssistantProjectionStore.getState().setProjection(known.id, null);
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
  const applyModelControlDefaults = vi.fn();
  const resumeChatRun = vi.fn();
  const setSelectedModelId = vi.fn();
  const setSelectedKnowledgePlan = vi.fn();
  const setSelectedProvider = vi.fn();
  const setSelectedSearchPlan = vi.fn();
  const setNotice = vi.fn();
  const chatMutation = {
    editingTitle: input.editingTitle ?? "",
    finishEditing: vi.fn()
  };
  const activeStreamChatIds = new Set(input.activeStreamChatIds ?? []);
  const pendingThreadMutationChatIds = new Set(input.pendingThreadMutationChatIds ?? []);
  const chatHasActiveStream = vi.fn((chatId: string) => activeStreamChatIds.has(chatId));
  const chatHasPendingThreadMutation = vi.fn((chatId: string) =>
    pendingThreadMutationChatIds.has(chatId)
  );
  const chatDetailRequestsRef = { current: new Map<string, Promise<ChatDetail | null>>() };
  const workspaceRefreshPromiseRef = { current: null } as {
    current: Promise<ChatDetail | null> | null;
  };
  const blankDefaultAssistantRef = { current: null as BlankDefaultAssistant | null };
  const actions = useWorkspaceActions({
    activeChatIdRef,
    applyModelControlDefaults,
    ...(input.chooseDefaultAssistant
      ? { blankDefaultAssistantRef, chooseDefaultAssistant: input.chooseDefaultAssistant }
      : {}),
    chatDetailRequestsRef,
    chatHasActiveStream,
    chatHasPendingThreadMutation,
    chatMutation,
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
    activeStreamChatIds,
    attachments: () => selectActiveComposerSession(useComposerSessionStore.getState()).attachments,
    chatA,
    chatB,
    chatC,
    chatMutation,
    chatHasActiveStream,
    chatDetailRequestsRef,
    chats: () => useWorkspaceStore.getState().chats,
    draft: () => selectActiveComposerSession(useComposerSessionStore.getState()).draft,
    pendingThreadMutationChatIds,
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
      if (editingMessageId) {
        useComposerSessionStore.getState().startEdit(editingMessageId, nextDraft);
      }
    }
  };
}

function boundProjection(): ChatAssistantProjection {
  const row = <T,>(assistantValue: T, value: unknown, provenance: "assistant" | "chat" | "default" = "assistant") => ({
    assistantValue, deviation: null, policy: "adjustable" as const, provenance, value
  });
  return {
    availability: { ok: true },
    avatar: assistantAvatarFixture,
    id: "assistant-1",
    name: "Reviewer",
    owned: true,
    ownerDisplayName: "Owner",
    rows: {
      controls: row({}, {}, "default"),
      knowledge: row({ mode: "none" }, { mode: "none" }),
      model: row({ mode: "model", modelId: "assistant-model" }, { mode: "model", modelId: "assistant-model" }),
      search: row({ mode: "off" }, { mode: "all_selected", optionIds: ["web"] }, "chat"),
      skills: row({ links: [], mode: "off" }, { links: [], mode: "off" }),
      tools: row({ mode: "exact", serverIds: ["server-1"] }, { mode: "exact", serverIds: ["server-1"] })
    },
    state: "bound"
  } as ChatAssistantProjection;
}

describe("restoring a chat's Assistant", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetComposerControlStoreForTest();
    resetChatAssistantProjectionStoreForTest();
  });

  it("restores the Assistant, rows and origins the server projects on a cold open, and none for an unbound chat", async () => {
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "" });
    resetChatAssistantProjectionStoreForTest();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/chats/chat-a"
      ? Response.json({ chat: { ...apiChatDetail(state.chatA, []), assistant: boundProjection() } })
      : Response.json({ chat: { ...apiChatDetail(state.chatB, []), assistant: null } }));
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.activateChat(state.chatA, { resumeRuns: false });

    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const restored = useComposerControlStore.getState();
    expect(restored).toMatchObject({
      assistant: {
        id: "assistant-1",
        rows: {
          controls: { origin: "default" },
          model: { origin: "assistant" },
          search: { origin: "chat" },
          tools: { origin: "assistant" }
        },
        state: "bound"
      },
      mcpSelection: { mode: "exact", serverIds: ["server-1"] },
      searchPlanMode: "all_selected",
      selectedModelId: "assistant-model",
      selectedSearchOptionIds: ["web"],
      skillsMode: "off"
    });

    await state.actions.activateChat(state.chatB, { resumeRuns: false });
    expect(useComposerControlStore.getState()).toMatchObject({
      assistant: null,
      mcpSelection: { mode: "auto" },
      skillsMode: "auto"
    });

    // Reopening the bound chat restores it from the projection it read.
    await state.actions.activateChat(state.chatA, { resumeRuns: false });
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads an unknown projection for a caller that keeps its controls but asks for the Assistant", async () => {
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "" });
    resetChatAssistantProjectionStoreForTest();
    const cached = {
      activeLeafId: null,
      history: threadHistory(state.chatA),
      messages: [],
      sourceUpdatedAt: state.chatA.updatedAt,
      usageStats: null
    };
    useThreadStore.getState().replaceThread(state.chatA.id, cached);
    const fetchMock = vi.fn(async () => Response.json({ chat: { ...apiChatDetail(state.chatA, []), assistant: boundProjection() } }));
    vi.stubGlobal("fetch", fetchMock);

    // Preserved controls alone trust the composer and read nothing.
    await state.actions.activateChat(state.chatA, { preserveControls: true, resumeRuns: false });
    expect(fetchMock).not.toHaveBeenCalled();

    await state.actions.activateChat(state.chatA, { preserveControls: true, readAssistant: true, resumeRuns: false });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/chats/chat-a", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-1", state: "bound" });

    // Once read, the projection is known and nothing is read again.
    await state.actions.activateChat(state.chatA, { preserveControls: true, readAssistant: true, resumeRuns: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a deleted binding visible instead of substituting anything", async () => {
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "" });
    useChatAssistantProjectionStore.getState().setProjection(state.chatA.id, { state: "deleted" });
    useThreadStore.getState().replaceThread(state.chatA.id, {
      activeLeafId: null,
      history: threadHistory(state.chatA),
      messages: [],
      sourceUpdatedAt: state.chatA.updatedAt,
      usageStats: null
    });

    await state.actions.activateChat(state.chatA, { resumeRuns: false });

    expect(useComposerControlStore.getState().assistant).toEqual({ state: "deleted" });
  });

  it("keeps the archived reason a consumer's chat reads for its Assistant", async () => {
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "" });
    resetChatAssistantProjectionStoreForTest();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      chat: { ...apiChatDetail(state.chatA, []), assistant: { reason: "archived", state: "unavailable" } }
    })));

    await state.actions.activateChat(state.chatA, { resumeRuns: false });

    expect(useComposerControlStore.getState().assistant).toEqual({ reason: "archived", state: "unavailable" });
  });

  it("leaves a chat's Assistant with the chat and keeps one chosen for the blank chat", () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    useComposerControlStore.setState({ assistant: boundComposerAssistantFixture(), mcpSelection: { mode: "exact", serverIds: ["s"] } });

    state.actions.activateBlankWorkspace();
    expect(useComposerControlStore.getState()).toMatchObject({ assistant: null, mcpSelection: { mode: "auto" } });

    useComposerControlStore.setState({ assistant: boundComposerAssistantFixture({ id: "blank-choice" }) });
    state.actions.activateBlankWorkspace();
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "blank-choice" });
  });

  it("re-reads a chat after an Assistant change and applies it only while the chat is open", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      chat: { ...apiChatDetail(state.chatA, []), assistant: boundProjection() }
    })));

    await expect(state.actions.refreshChatAssistant("chat-a", () => false)).resolves.toBe(true);
    expect(useComposerControlStore.getState().assistant).toBeNull();

    await expect(state.actions.refreshChatAssistant("chat-a")).resolves.toBe(true);
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-1" });
  });
});

describe("starting a new personal chat with the default Assistant", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetComposerControlStoreForTest();
  });

  /** Chooses like the composer's Assistant actions: only while the blank chat is current. */
  function defaultChooser() {
    const pending: Array<() => void> = [];
    const choose = vi.fn((assistantId: string, isCurrent: () => boolean) => new Promise<boolean>((resolve) => {
      pending.push(() => {
        if (!isCurrent()) return resolve(false);
        useComposerControlStore.setState({ assistant: boundComposerAssistantFixture({ id: assistantId, name: "Daily co-pilot" }) });
        resolve(true);
      });
    }));
    const settle = async () => {
      for (const next of pending.splice(0)) next();
      await Promise.resolve();
      await Promise.resolve();
    };
    return { choose, settle };
  }

  function withDefaultAssistant(assistantId: string | null, assistantUnavailable = false) {
    useWorkspaceStore.getState().setCatalog((current) => current
      ? { ...current, defaults: { ...current.defaults, assistantId, assistantUnavailable } }
      : current);
  }

  it("starts a new personal chat with it, keeps a removal for that blank chat, and starts the next one with it again", async () => {
    const chooser = defaultChooser();
    const state = useWorkspaceActionsForTest({ attachments: [], chooseDefaultAssistant: chooser.choose, draft: "" });
    withDefaultAssistant("assistant-1");

    state.actions.activateBlankWorkspace();
    expect(chooser.choose).toHaveBeenCalledWith("assistant-1", expect.any(Function));
    await chooser.settle();
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-1", state: "bound" });

    // "Remove for this chat" returns the blank chat to its defaults without an Assistant.
    state.actions.applyPersonalBlankDefaults();
    expect(useComposerControlStore.getState().assistant).toBeNull();
    state.actions.activateBlankWorkspace();
    await chooser.settle();
    expect(chooser.choose).toHaveBeenCalledOnce();
    expect(useComposerControlStore.getState().assistant).toBeNull();
    expect(useWorkspaceStore.getState().catalog?.defaults.assistantId).toBe("assistant-1");

    await state.actions.activateChat(state.chatB, { resumeRuns: false });
    state.actions.activateBlankWorkspace();
    await chooser.settle();
    expect(chooser.choose).toHaveBeenCalledTimes(2);
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-1" });

    // New chat follows a changed setting even from the blank chat.
    withDefaultAssistant(null);
    state.actions.activateBlankWorkspace();
    expect(useComposerControlStore.getState().assistant).toBeNull();
    withDefaultAssistant("assistant-2");
    state.actions.activateBlankWorkspace();
    await chooser.settle();
    expect(chooser.choose).toHaveBeenLastCalledWith("assistant-2", expect.any(Function));
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-2" });
  });

  it("never starts Temporary or Project chats with it and drops it when the blank chat turns Temporary", async () => {
    const chooser = defaultChooser();
    const state = useWorkspaceActionsForTest({ attachments: [], chooseDefaultAssistant: chooser.choose, draft: "" });
    withDefaultAssistant("assistant-1");

    state.actions.activateBlankWorkspace(null, "TEMPORARY");
    state.actions.activateBlankWorkspace(null, "NORMAL", "project-1");
    expect(chooser.choose).not.toHaveBeenCalled();

    state.actions.activateBlankWorkspace();
    await chooser.settle();
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-1" });
    // The composer's Temporary switch changes only the blank chat's session.
    useComposerSessionStore.getState().activateSession(composerSessionKey(null, null, "TEMPORARY"));
    state.actions.reconcileBlankDefaultAssistant();
    expect(useComposerControlStore.getState().assistant).toBeNull();
    useComposerSessionStore.getState().activateSession(composerSessionKey(null, null, "NORMAL"));
    state.actions.reconcileBlankDefaultAssistant();
    await chooser.settle();
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-1" });

    // One the user chose for the blank chat stays theirs.
    useComposerControlStore.setState({ assistant: boundComposerAssistantFixture({ id: "chosen" }) });
    state.actions.activateBlankWorkspace(null, "TEMPORARY");
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "chosen" });
  });

  it("does not apply an unavailable default or a result that arrives after the user moved on", async () => {
    const chooser = defaultChooser();
    const state = useWorkspaceActionsForTest({ attachments: [], chooseDefaultAssistant: chooser.choose, draft: "" });
    withDefaultAssistant(null, true);
    state.actions.activateBlankWorkspace();
    expect(chooser.choose).not.toHaveBeenCalled();

    withDefaultAssistant("assistant-1");
    await state.actions.activateChat(state.chatA, { resumeRuns: false });
    state.actions.activateBlankWorkspace();
    await state.actions.activateChat(state.chatB, { resumeRuns: false });
    await chooser.settle();
    expect(useComposerControlStore.getState().assistant).toBeNull();
  });

  it("lets an Assistant entry link decide the blank chat instead of the default, until the next new chat", async () => {
    const chooser = defaultChooser();
    const state = useWorkspaceActionsForTest({ attachments: [], chooseDefaultAssistant: chooser.choose, draft: "" });
    withDefaultAssistant("assistant-1");

    // The default was still loading when the link took over the blank chat.
    await state.actions.activateChat(state.chatA, { resumeRuns: false });
    state.actions.activateBlankWorkspace();
    expect(chooser.choose).toHaveBeenCalledOnce();
    state.actions.skipBlankDefaultAssistant();
    await chooser.settle();
    expect(useComposerControlStore.getState().assistant).toBeNull();

    // The blank chat stays without the default, whether or not the link resolved.
    useComposerControlStore.setState({ assistant: boundComposerAssistantFixture({ id: "linked" }) });
    state.actions.reconcileBlankDefaultAssistant();
    useComposerSessionStore.getState().activateSession(composerSessionKey(null, null, "TEMPORARY"));
    state.actions.reconcileBlankDefaultAssistant();
    useComposerSessionStore.getState().activateSession(composerSessionKey(null, null, "NORMAL"));
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "linked" });
    state.actions.applyPersonalBlankDefaults();
    state.actions.reconcileBlankDefaultAssistant();
    expect(chooser.choose).toHaveBeenCalledOnce();

    await state.actions.activateChat(state.chatB, { resumeRuns: false });
    state.actions.activateBlankWorkspace();
    await chooser.settle();
    expect(chooser.choose).toHaveBeenCalledTimes(2);
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-1" });
  });

  it("shows the Assistant of a first message in the chat list before the server's next page", async () => {
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "" });
    useWorkspaceStore.getState().applyNavigationPage({ chats: [], folders: [], nextCursor: null }, false);
    const sourceKey = composerSessionKey(null);
    state.actions.activateBlankWorkspace();
    useComposerControlStore.setState({ assistant: boundComposerAssistantFixture({ id: "assistant-1", name: "Daily co-pilot" }) });
    useComposerSessionStore.getState().updateSession(sourceKey, { draft: "Hello" });
    vi.stubGlobal("fetch", vi.fn());

    const created = await state.actions.createPersonalChatForSend(null, sourceKey);

    expect(useWorkspaceStore.getState().navigationChats).toEqual([expect.objectContaining({
      assistant: { avatar: assistantAvatarFixture, name: "Daily co-pilot" },
      id: created?.id
    })]);
  });
});

describe("workspace actions", () => {
  beforeEach(() => {
    // Exercise these actions with the Crypto API exposed on non-loopback HTTP.
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  });

  it("starts personal chats with the remembered Workspace choice and preserves saved chat flags", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const catalog = useWorkspaceStore.getState().catalog!;
    useWorkspaceStore.setState({ catalog: { ...catalog, defaults: { ...catalog.defaults, workspaceEnabled: true } } });
    state.actions.activateBlankWorkspace();
    expect(state.activeComposer().workspaceEnabled).toBe(true);
    state.actions.activateBlankWorkspace("folder-1", "TEMPORARY");
    expect(state.activeComposer().workspaceEnabled).toBe(true);
    await state.actions.activateChat({ ...state.chatA, workspace: {
      enabled: false, internetEnabled: null, sessionState: null, available: true
    } }, { resumeRuns: false });
    expect(state.activeComposer().workspaceEnabled).toBe(false);
    useWorkspaceStore.setState({ catalog: { ...catalog, defaults: { ...catalog.defaults, workspaceEnabled: false } } });
    state.actions.activateBlankWorkspace();
    expect(state.activeComposer().workspaceEnabled).toBe(false);
  });

  it.each([null, "folder-1"])("restores current Search defaults for a new chat in %s", async (folderId) => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const catalog = useWorkspaceStore.getState().catalog!;
    const selected = { mode: "model_choice" as const, optionIds: ["search-a", "search-b"] };
    const off = { mode: "all_selected" as const, optionIds: [] };
    useWorkspaceStore.setState({ catalog: {
      ...catalog,
      defaults: { ...catalog.defaults, searchPlan: selected },
      searchStrategies: selected.optionIds.map(strategyId => ({ strategyId, kind: "web_search", displayName: strategyId }))
    } });
    await state.actions.activateChat({ ...state.chatA, defaultSearchPlan: off }, { resumeRuns: false });
    expect(state.setSelectedSearchPlan).toHaveBeenLastCalledWith([], "all_selected", "system");

    state.actions.activateBlankWorkspace(folderId);
    expect(state.setSelectedSearchPlan).toHaveBeenLastCalledWith(selected.optionIds, "model_choice", "system");

    await state.actions.activateChat({ ...state.chatB, defaultSearchPlan: selected }, { resumeRuns: false });
    useWorkspaceStore.getState().setCatalog(current => current
      ? { ...current, defaults: { ...current.defaults, searchPlan: off } } : current);
    state.actions.activateBlankWorkspace(folderId);
    expect(state.setSelectedSearchPlan).toHaveBeenLastCalledWith([], "all_selected", "system");
  });

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
    useComposerSessionStore.getState().startEdit("message-a", "Editing A");
    const chatAKey = composerSessionKey("chat-a");
    const chatBKey = composerSessionKey("chat-b");
    const blankRootKey = composerSessionKey(null);
    const blankFolderKey = composerSessionKey(null, "folder-1");

    await state.actions.activateChat(state.chatB, { resumeRuns: false });
    expect(state.session(chatAKey)).toMatchObject({
      attachments: [attachmentA],
      draft: "Draft A",
      editingDraft: "Editing A",
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
      editingDraft: "Editing A",
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
      editingDraft: "Draft B",
      editingMessageId: "message-b"
    });
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(chatBKey);
    expect(state.session(blankRootKey).draft).toBe("Root draft");
    expect(state.session(blankFolderKey).draft).toBe("Folder draft");
  });

  it("finishes a successful inline rename without a redundant notice", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: "",
      editingTitle: "  Renamed chat  "
    });
    const updated = {
      ...state.chatA,
      title: "Renamed chat",
      updatedAt: "2026-06-10T00:01:00.000Z"
    };
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ chat: apiChatSummary(updated) })
    );
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.renameChat(state.chatA);

    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a", expect.objectContaining({
      body: JSON.stringify({ title: "Renamed chat" }),
      method: "PATCH"
    }));
    expect(state.chats().find((candidate) => candidate.id === state.chatA.id)?.title)
      .toBe("Renamed chat");
    expect(state.chatMutation.finishEditing).toHaveBeenCalledOnce();
    expect(state.setNotice).toHaveBeenCalledOnce();
    expect(state.setNotice).toHaveBeenLastCalledWith(null);
  });

  it("keeps inline rename open after failure and clears that error after retry succeeds", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: "",
      editingTitle: "Renamed chat"
    });
    const updated = {
      ...state.chatA,
      title: "Renamed chat",
      updatedAt: "2026-06-10T00:01:00.000Z"
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ chat: apiChatSummary(updated) })));

    await state.actions.renameChat(state.chatA);

    expect(state.chatMutation.finishEditing).not.toHaveBeenCalled();
    expect(state.chats().find((candidate) => candidate.id === state.chatA.id)?.title)
      .toBe("Chat A");
    expect(state.setNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));

    await state.actions.renameChat(state.chatA);

    expect(state.chatMutation.finishEditing).toHaveBeenCalledOnce();
    expect(state.chats().find((candidate) => candidate.id === state.chatA.id)?.title)
      .toBe("Renamed chat");
    expect(state.setNotice).toHaveBeenLastCalledWith(null);
  });

  it("returns a too-long title rejection as a field error instead of a save or notice", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: "",
      editingTitle: "Rejected title"
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ error: "chat_title_too_long" }, { status: 400 })
    ));

    await expect(state.actions.renameChat(state.chatA)).resolves.toEqual({
      fieldError: "Use at most 120 characters for the chat title (chat_title_too_long)",
      ok: false
    });
    expect(state.chatMutation.finishEditing).not.toHaveBeenCalled();
    expect(state.setNotice).not.toHaveBeenCalled();
    expect(state.chats().find((candidate) => candidate.id === state.chatA.id)?.title).toBe("Chat A");
  });

  it("archives chats with a functional list update so concurrent rows survive", async () => {
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
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/memory-mode")) return Response.json(apiChatMemoryState(state.chatA));
      if (path.endsWith("/source")) return Response.json(apiChatSource(state.chatA));
      return Response.json(apiArchivedChat(state.chatA));
    }));

    await state.actions.deleteChat(state.chatA);

    expect(state.setNotice).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({ label: "Undo" }),
      kind: "success",
      text: "Chat moved to archive"
    }));
    expect(state.chats().map((candidate) => candidate.id)).toEqual(["chat-b", "chat-c"]);
    expect(useThreadStore.getState().threadsByChatId["chat-a"]).toBeUndefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-a"]).toBeUndefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-b"]?.events).toHaveLength(1);
    expect(useComposerSessionStore.getState().sessionsByKey[composerSessionKey("chat-a")]).toBeUndefined();
  });

  it("blocks archiving an inactive chat while that chat owns a stream", async () => {
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
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.chats().map((candidate) => candidate.id)).toEqual(["chat-a", "chat-b"]);
    expect(state.setNotice).toHaveBeenCalledWith({
      kind: "error",
      text: "Stop the running response before archiving this chat."
    });
  });

  it("does not let an older detail response resurrect an archived chat", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    let resolveDetail!: (response: Response) => void;
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith("/memory-mode")) {
        return Promise.resolve(Response.json(apiChatMemoryState(state.chatA)));
      }
      if (String(url).endsWith("/source")) {
        return Promise.resolve(Response.json(apiChatSource(state.chatA)));
      }
      if (String(url) === "/api/chats/chat-a/archive") {
        return Promise.resolve(Response.json(apiArchivedChat(state.chatA)));
      }

      return new Promise<Response>((resolve) => {
        resolveDetail = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pendingDetail = state.actions.fetchChatDetail("chat-a");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a", expect.objectContaining({ signal: expect.any(AbortSignal) })));
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

  it("reconciles terminal Workspace files through the ordinary detail owner without losing draft, controls or ready downloads", async () => {
    vi.useFakeTimers();
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "Unsent follow-up" });
    const file = { attachmentId: "first", byteSize: 6, fileName: "first.txt", mimeType: "text/plain", relativePath: "first.txt" };
    const original = message({ id: "answer", role: "assistant", content: "Completed answer", artifactSummary: { citations: [], sources: [], reasoningText: [], generatedFiles: [file] },
      workspaceActivity: { entries: [], outputStatus: { state: "retrying" } } });
    useThreadStore.getState().mergeMessages("chat-a", [original], { activeLeafId: "answer" });
    const result = { ...original, artifactSummary: { citations: [], sources: [], reasoningText: [], generatedFiles: [file, { ...file, attachmentId: "second", fileName: "second.txt", relativePath: "second.txt" }] },
      workspaceActivity: { entries: [], outputStatus: { state: "complete" as const } } };
    const fetchMock = vi.fn(async () => Response.json({ chat: apiChatDetail(state.chatA, [result]) }));
    vi.stubGlobal("fetch", fetchMock);
    const hook = renderHook(() => {
      const messages = useThreadStore((store) => store.threadsByChatId["chat-a"]!.messages);
      useWorkspaceOutputReconciliation({ accountId: "account-a", chatId: "chat-a", messages, streaming: false, refreshActiveChat: state.actions.refreshActiveChat });
    });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      const current = useThreadStore.getState().threadsByChatId["chat-a"]!.messages[0]!;
      expect(current).toMatchObject({ content: "Completed answer", status: "complete", workspaceActivity: { outputStatus: { state: "complete" } } });
      expect(current.artifactSummary?.generatedFiles).toEqual(result.artifactSummary.generatedFiles);
      expect(state.draft()).toBe("Unsent follow-up");
      expect(state.setSelectedModelId).not.toHaveBeenCalled();
      expect(state.applyModelControlDefaults).not.toHaveBeenCalled();
      expect(state.resumeChatRun).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { hook.unmount(); vi.useRealTimers(); }
  });

  it("ignores an aborted output refresh even when the transport returns a late response", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "Keep draft" });
    useThreadStore.getState().mergeMessages("chat-a", [message({ id: "existing" })]);
    const before = useThreadStore.getState().threadsByChatId["chat-a"];
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const controller = new AbortController();
    const refresh = state.actions.refreshActiveChat("chat-a", { forceDetail: true, preserveControls: true, resumeRuns: false, signal: controller.signal });
    controller.abort();
    resolve(Response.json({ chat: apiChatDetail(state.chatA, [message({ id: "late" })]) }));
    await expect(refresh).resolves.toBeNull();
    expect(useThreadStore.getState().threadsByChatId["chat-a"]).toBe(before);
    expect(state.draft()).toBe("Keep draft");
    expect(state.setSelectedModelId).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 503])("classifies output-refresh HTTP %s for its source owner", async (status) => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "Keep draft" });
    const unavailable = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status })));
    await expect(state.actions.refreshActiveChat("chat-a", { forceDetail: true, preserveControls: true, resumeRuns: false, signal: new AbortController().signal, onUnavailable: unavailable })).resolves.toBeNull();
    expect(unavailable).toHaveBeenCalledTimes(status === 503 ? 0 : 1);
    expect(state.draft()).toBe("Keep draft");
  });

  it("does not start an aborted output refresh queued behind another detail request", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "Keep draft" });
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    const first = state.actions.fetchChatDetail("chat-a");
    const controller = new AbortController();
    const queued = state.actions.refreshActiveChat("chat-a", { forceDetail: true, preserveControls: true, resumeRuns: false, signal: controller.signal });
    controller.abort();
    resolve(Response.json({ chat: apiChatDetail(state.chatA, [message({ id: "first" })]) }));
    await first;
    await expect(queued).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(state.setSelectedModelId).not.toHaveBeenCalled();
    expect(state.draft()).toBe("Keep draft");
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
            hasCompletedAnswer: true,
            incompleteRecordCount: 0,
            recordCount: 1,
            knownCostRecordCount: 0,
            estimatedCostMicros: null,
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
            hasCompletedAnswer: true,
            incompleteRecordCount: 0,
            recordCount: 1,
            knownCostRecordCount: 0,
            estimatedCostMicros: null,
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

  it("refreshes past a suspended detail request and ignores its late stale response", async () => {
    vi.useFakeTimers();
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "Unsent follow-up" });
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(Response.json({ chat: apiChatDetail(state.chatA, [message({ id: "answer", content: "Finished" })]) })));
    const stale = state.actions.fetchChatDetail("chat-a");
    const refresh = state.actions.refreshActiveChat("chat-a", { forceDetail: true, preserveControls: true });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(stale).resolves.toBeNull();
    await expect(refresh).resolves.toMatchObject({ messages: [{ content: "Finished" }] });
    finish(Response.json({ chat: apiChatDetail(state.chatA, [message({ id: "answer", content: "Stale" })]) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(useThreadStore.getState().threadsByChatId["chat-a"]?.messages[0]?.content).toBe("Finished");
    expect(state.draft()).toBe("Unsent follow-up");
    vi.useRealTimers();
  });

  it("restores an immediately archived chat through the undo toast", async () => {
    const state = useWorkspaceActionsForTest({
      activeChatId: "chat-b",
      attachments: [],
      draft: ""
    });
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/memory-mode")) return Response.json(apiChatMemoryState(state.chatA));
      if (path.endsWith("/source")) return Response.json(apiChatSource(state.chatA));
      if (path.endsWith("/archive")) return Response.json(apiArchivedChat(state.chatA));
      if (path.endsWith("/restore")) {
        return Response.json({
          chat: { ...apiArchivedChat(state.chatA, 2).chat, archived: false }
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.deleteChat(state.chatA);
    expect(state.chats().map((candidate) => candidate.id)).toEqual(["chat-b"]);
    const notice = state.setNotice.mock.calls.at(-1)?.[0];
    expect(notice).toMatchObject({
      action: { label: "Undo" },
      text: "Chat moved to archive"
    });
    notice?.action?.onClick();
    await vi.waitFor(() => {
      expect(state.chats().map((candidate) => candidate.id)).toEqual(["chat-a", "chat-b"]);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/chat-a/restore",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("keeps the live navigation list fresh across archive and its undo", async () => {
    const state = useWorkspaceActionsForTest({
      activeChatId: "chat-b",
      attachments: [],
      draft: ""
    });
    useWorkspaceStore.getState().applyNavigationPage({
      chats: [
        {
          activeRun: false,
          assistant: null,
          folderId: null,
          id: "chat-a",
          title: "Chat A",
          updatedAt: state.chatA.updatedAt
        },
        {
          activeRun: false,
          assistant: null,
          folderId: null,
          id: "chat-b",
          title: "Chat B",
          updatedAt: state.chatB.updatedAt
        }
      ],
      folders: [],
      nextCursor: null
    }, false);
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/memory-mode")) return Response.json(apiChatMemoryState(state.chatA));
      if (path.endsWith("/source")) return Response.json(apiChatSource(state.chatA));
      if (path.endsWith("/archive")) return Response.json(apiArchivedChat(state.chatA));
      if (path.endsWith("/restore")) {
        return Response.json({
          chat: { ...apiArchivedChat(state.chatA, 2).chat, archived: false }
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.deleteChat(state.chatA);

    expect(useWorkspaceStore.getState().navigationChats.map((chat) => chat.id))
      .toEqual(["chat-b"]);
    const notice = state.setNotice.mock.calls.at(-1)?.[0];
    expect(notice).toMatchObject({
      action: { label: "Undo" },
      kind: "success",
      text: "Chat moved to archive"
    });

    notice?.action?.onClick();
    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().navigationChats.map((chat) => chat.id).sort())
        .toEqual(["chat-a", "chat-b"]);
    });
  });

  it("addresses what it activates by replacing the URL, never through browser storage", async () => {
    window.history.replaceState(null, "", "/");
    const historyLength = window.history.length;
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ chat: apiChatDetail(state.chatB, []) })));
    await state.actions.activateChat(state.chatB);
    expect(window.location.pathname).toBe("/c/chat-b");
    state.actions.activateBlankWorkspace("folder-1");
    expect(window.location.pathname).toBe("/");
    state.actions.activateBlankWorkspace(null, "NORMAL", "project-1");
    expect(window.location.pathname).toBe("/p/project-1");
    await state.actions.activateChat(chat({ id: "project-chat", projectId: "project-1", title: "Project chat" }));
    expect(window.location.pathname).toBe("/p/project-1/c/project-chat");
    expect(window.history.length).toBe(historyLength);
    expect(window.localStorage.length).toBe(0);
    window.history.replaceState(null, "", "/");
  });

  it("addresses a first-send chat while it is sent and keeps an unsent draft on the new chat", async () => {
    window.history.replaceState(null, "", "/");
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "" });
    const sourceKey = composerSessionKey(null);
    state.actions.activateBlankWorkspace();
    useComposerControlStore.setState({ selectedModelId: "gpt-5.5", selectedProvider: "openai" });
    useComposerSessionStore.getState().updateSession(sourceKey, { draft: "First question" });
    expect(useComposerSessionStore.getState().beginSend(sourceKey)).not.toBeNull();
    const created = await state.actions.createPersonalChatForSend(null, sourceKey);
    expect(window.location.pathname).toBe(`/c/${created!.id}`);

    const draftKey = composerSessionKey(null, null, "EXCLUDED");
    state.actions.activateBlankWorkspace(null, "EXCLUDED");
    useComposerSessionStore.getState().updateSession(draftKey, { draft: "Not sent yet" });
    const unsent = await state.actions.createPersonalChatForSend(null, draftKey);
    expect(useWorkspaceStore.getState().activeChatId).toBe(unsent!.id);
    expect(window.location.pathname).toBe("/");
  });

  it("reports an unlisted refresh target and drops a superseded refresh", async () => {
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/chats"
      ? Response.json({ chats: [apiChatSummary(state.chatA)], folders: [] })
      : Response.json({ error: "not_found" }, { status: 404 })));
    const onTargetUnavailable = vi.fn();
    await state.actions.refreshWorkspace("missing-chat", { onTargetUnavailable });
    expect(onTargetUnavailable).toHaveBeenCalledExactlyOnceWith(null);
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();

    await state.actions.refreshWorkspace(state.chatA.id, { isCurrent: () => false, onTargetUnavailable });
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
    expect(onTargetUnavailable).toHaveBeenCalledOnce();
    await state.actions.refreshWorkspace(state.chatA.id, { onTargetUnavailable });
    expect(useWorkspaceStore.getState().activeChatId).toBe(state.chatA.id);
  });

  it("reports a readable Project chat's Project from one detail read, without admitting it", async () => {
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "" });
    const workspace = {
      agentAvailable: false,
      available: false,
      enabled: false,
      internetEnabled: true,
      sessionState: null,
      unavailableReason: "model_tools_required"
    };
    const requests: string[] = [];
    // The shapes the server answers a Project member with: the personal list
    // never carries Project chats, the personal memory state does not exist
    // for them, and the chat detail names the Project.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path === "/api/chats") {
        return Response.json({
          chats: [{ ...apiChatSummary(state.chatA), projectId: null, workspace }],
          folders: []
        });
      }
      if (path === "/api/chats/project-chat") {
        return Response.json({
          chat: {
            activeLeafMessageId: null,
            contextStats: { approximateActiveBranchInputTokens: 0 },
            createdAt: "2026-09-26T21:52:47.737Z",
            defaultKnowledgePlan: null,
            defaultModelId: "00000000-0000-4000-8000-000000001201",
            defaultProvider: "00000000-0000-4000-8000-000000001101",
            folderId: null,
            id: "project-chat",
            messageCount: 0,
            messages: [],
            pageInfo: {
              activeLeafMessageId: null,
              beforeCursor: null,
              hasOlder: false,
              snapshotUpdatedAt: "2026-09-26T21:52:47.737Z"
            },
            pinned: false,
            projectId: "project-1",
            title: "Routing Project chat",
            updatedAt: "2026-09-26T21:52:47.737Z",
            usageStats: null,
            workspace
          }
        });
      }
      if (path.endsWith("/memory-mode")) {
        return Response.json({ error: "memory_not_found" }, { status: 404 });
      }
      return Response.json({ error: "chat_not_found" }, { status: 404 });
    }));
    const onTargetUnavailable = vi.fn();

    await state.actions.refreshWorkspace("project-chat", { onTargetUnavailable });
    expect(onTargetUnavailable).toHaveBeenCalledExactlyOnceWith("project-1");
    expect(requests).toEqual(["/api/chats", "/api/chats/project-chat"]);
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
    expect(state.chats().map((candidate) => candidate.id)).not.toContain("project-chat");

    requests.length = 0;
    onTargetUnavailable.mockClear();
    await state.actions.refreshWorkspace("foreign-chat", { onTargetUnavailable });
    expect(onTargetUnavailable).toHaveBeenCalledExactlyOnceWith(null);
    expect(requests).toEqual(["/api/chats", "/api/chats/foreign-chat"]);
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

  it("re-prunes temporary cache exceptions after their owners settle", () => {
    const state = useWorkspaceActionsForTest({
      activeStreamChatIds: ["chat-b"],
      attachments: [],
      draft: "",
      pendingThreadMutationChatIds: ["chat-c"]
    });
    const chatIds = ["chat-a", "chat-b", "chat-c", "chat-d", "chat-e", "chat-f"];
    for (const chatId of chatIds) {
      useThreadStore.getState().replaceThread(chatId, {
        activeLeafId: `${chatId}-message`,
        messages: [message({ id: `${chatId}-message` })],
        usageStats: null
      });
      useThreadStore.getState().touchThread(chatId);
      useRunSurfaceStore.getState().resetSurface(chatId);
    }
    const pendingSessionKey = composerSessionKey("chat-d");
    useComposerSessionStore.getState().activateSession(pendingSessionKey);
    useComposerSessionStore.getState().setDraft("Pending send");
    const sendToken = useComposerSessionStore.getState().beginSend(pendingSessionKey);
    expect(sendToken).not.toBeNull();
    state.chatDetailRequestsRef.current.set("chat-e", Promise.resolve(null));

    expect(state.actions.pruneThreadCache()).toEqual([]);
    expect(Object.keys(useThreadStore.getState().threadsByChatId)).toHaveLength(6);

    state.activeStreamChatIds.delete("chat-b");
    state.chatDetailRequestsRef.current.delete("chat-e");
    useComposerSessionStore.getState().finishSend(sendToken!, "failed");
    expect(state.actions.pruneThreadCache().sort()).toEqual(["chat-b", "chat-d"]);
    expect(Object.keys(useThreadStore.getState().threadsByChatId).sort()).toEqual([
      "chat-a",
      "chat-c",
      "chat-e",
      "chat-f"
    ]);
    expect(useThreadStore.getState().threadsByChatId["chat-a"]).toBeDefined();
    expect(useThreadStore.getState().threadsByChatId["chat-c"]).toBeDefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-b"]).toBeUndefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-d"]).toBeUndefined();

    state.pendingThreadMutationChatIds.delete("chat-c");
    expect(state.actions.pruneThreadCache()).toEqual(["chat-c"]);
    expect(Object.keys(useThreadStore.getState().threadsByChatId).sort()).toEqual([
      "chat-a",
      "chat-e",
      "chat-f"
    ]);
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-c"]).toBeUndefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-e"]).toBeDefined();
    expect(useRunSurfaceStore.getState().surfacesByChatId["chat-f"]).toBeDefined();
  });

  it("keeps only two inactive snapshots after opening a blank New Chat", () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    for (const chatId of ["chat-a", "chat-b", "chat-c", "chat-d"]) {
      useThreadStore.getState().replaceThread(chatId, {
        activeLeafId: `${chatId}-message`,
        messages: [message({ id: `${chatId}-message` })],
        usageStats: null
      });
      useThreadStore.getState().touchThread(chatId);
      useRunSurfaceStore.getState().resetSurface(chatId);
    }

    state.actions.activateBlankWorkspace();

    expect(Object.keys(useThreadStore.getState().threadsByChatId).sort()).toEqual([
      "chat-c",
      "chat-d"
    ]);
    expect(Object.keys(useRunSurfaceStore.getState().surfacesByChatId).sort()).toEqual([
      "chat-c",
      "chat-d"
    ]);
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
        organizationSearchPlan: { mode: "all_selected", optionIds: [] },
        personalModelDefault: { modelId: "catalog-startup", provider: "openai" },
        provider: "openai",
        searchPlan: { mode: "all_selected", optionIds: [] },
        searchPreferenceSource: "personal",
        showCitations: true,
        showReasoningBlocks: false,
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

  it("reserves a personal chat locally for atomic first-send admission", async () => {
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "" });
    const sourceKey = composerSessionKey(null, "folder-1");
    state.actions.activateBlankWorkspace("folder-1");
    useComposerControlStore.setState({
      selectedModelId: "gpt-5.5",
      selectedProvider: "openai"
    });
    useComposerSessionStore.getState().updateSession(sourceKey, {
      draft: "Atomic first send",
      workspaceEnabled: true
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const created = await state.actions.createPersonalChatForSend("folder-1", sourceKey);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(created).toMatchObject({
      defaultModelId: "gpt-5.5",
      defaultProvider: "openai",
      folderId: "folder-1",
      memoryMode: "NORMAL",
      pendingPersonalDraft: { folderId: "folder-1", memoryMode: "NORMAL" },
      projectId: null
    });
    expect(created?.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(useWorkspaceStore.getState().activeChatId).toBe(created?.id);
    expect(state.session(composerSessionKey(created!.id))).toMatchObject({
      draft: "Atomic first send",
      workspaceEnabled: true
    });
  });

  it("marks a chat created from a Temporary draft pending and keeps it out of navigation", async () => {
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "" });
    useWorkspaceStore.getState().applyNavigationPage({
      chats: [],
      folders: [],
      nextCursor: null
    }, false);
    const sourceKey = composerSessionKey(null, "folder-1", "TEMPORARY");
    useComposerSessionStore.getState().activateSession(sourceKey);
    useComposerSessionStore.getState().setDraft("Temporary first send");
    const created = chat({ folderId: "folder-1", id: "chat-temporary", title: "Temporary" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ chat: apiChatSummary(created) })));

    await expect(state.actions.createChat("folder-1", sourceKey)).resolves.toMatchObject({
      id: "chat-temporary",
      pendingInitialMemoryMode: "TEMPORARY"
    });

    const stored = useWorkspaceStore.getState().chats.find((candidate) => candidate.id === created.id);
    expect(stored).toMatchObject({ pendingInitialMemoryMode: "TEMPORARY" });
    expect(workspaceNavigationChats(useWorkspaceStore.getState().chats))
      .not.toContainEqual(expect.objectContaining({ id: created.id }));
    expect(useWorkspaceStore.getState().navigationChats)
      .not.toContainEqual(expect.objectContaining({ id: created.id }));
    expect(state.session(composerSessionKey(created.id)).draft).toBe("Temporary first send");
  });

  it("activates Memory-off and Temporary blank workspaces without sharing the Normal draft", () => {
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "Normal" });
    state.actions.activateBlankWorkspace("folder-1", "EXCLUDED");
    useComposerSessionStore.getState().setDraft("Memory off");
    state.actions.activateBlankWorkspace("folder-1", "TEMPORARY");
    useComposerSessionStore.getState().setDraft("Temporary");

    expect(state.session(composerSessionKey(null, "folder-1", "EXCLUDED")).draft)
      .toBe("Memory off");
    expect(state.session(composerSessionKey(null, "folder-1", "TEMPORARY")).draft)
      .toBe("Temporary");
    expect(state.session(composerSessionKey(null, "folder-1")).draft).toBe("");
  });

  it("creates a Memory-off draft as an excluded retained chat without merging sessions", async () => {
    const state = useWorkspaceActionsForTest({ activeChatId: null, attachments: [], draft: "" });
    const sourceKey = composerSessionKey(null, "folder-1", "EXCLUDED");
    useComposerSessionStore.getState().activateSession(sourceKey);
    useComposerSessionStore.getState().setDraft("Memory-off first send");
    const created = chat({ folderId: "folder-1", id: "chat-excluded", title: "Memory off" });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ chat: apiChatSummary(created) }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(state.actions.createChat("folder-1", sourceKey)).resolves.toMatchObject({
      id: "chat-excluded",
      memoryMode: "EXCLUDED",
      memorySourceRevision: 0
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      folderId: "folder-1",
      memoryMode: "EXCLUDED",
      workspaceEnabled: false
    });
    expect(state.session(composerSessionKey(created.id)).draft).toBe("Memory-off first send");
    expect(state.session(composerSessionKey(null, "folder-1")).draft).toBe("");
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

  it("opens a personal chat in the saved MCP mode instead of the previous chat's", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const catalog = useWorkspaceStore.getState().catalog!;
    useWorkspaceStore.setState({ catalog: { ...catalog, defaults: { ...catalog.defaults, mcpMode: "load_all" } } });
    useComposerControlStore.setState({ mcpSelection: { mode: "off" } });

    await state.actions.activateChat(state.chatB, { resumeRuns: false });

    expect(useComposerControlStore.getState().mcpSelection).toEqual({ mode: "load_all" });
  });

  it("resolves Knowledge defaults as chat, then project, then Off", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    useWorkspaceStore.setState({
      folders: [{
        defaultKnowledgePlan: {
          baseIds: ["project-base"], mode: "explicit", sourceIds: [], version: 1
        },
        id: "folder-1",
        name: "Research",
        parentId: null,
        projectMemory: "",
        sortOrder: 0
      }]
    });

    await state.actions.activateChat({
      ...state.chatB,
      defaultKnowledgePlan: {
        baseIds: ["chat-base"], mode: "explicit", sourceIds: [], version: 1
      },
      folderId: "folder-1"
    }, { resumeRuns: false });
    expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith(
      { baseIds: ["chat-base"], mode: "explicit", sourceIds: [], version: 1 },
      "chat",
      "system"
    );

    await state.actions.activateChat({
      ...state.chatA,
      defaultKnowledgePlan: null,
      folderId: "folder-1"
    }, { resumeRuns: false });
    expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith(
      { baseIds: ["project-base"], mode: "explicit", sourceIds: [], version: 1 },
      "project",
      "system"
    );

    state.actions.activateBlankWorkspace();
    expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith(
      { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      "off",
      "system"
    );
    state.actions.activateBlankWorkspace("folder-1");
    expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith(
      { baseIds: ["project-base"], mode: "explicit", sourceIds: [], version: 1 },
      "project",
      "system"
    );
  });

  it("persists a chat Knowledge default and reapplies its effective source", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const updated: WorkspaceChatSummary = {
      ...state.chatA,
      defaultKnowledgePlan: {
        baseIds: ["base-policies"], mode: "explicit", sourceIds: [], version: 1
      },
      updatedAt: "2026-06-10T00:01:00.000Z"
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ chat: apiChatSummary(updated) }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(state.actions.setChatKnowledgeDefault({
      baseIds: ["base-policies"], mode: "explicit", sourceIds: [], version: 1
    })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a", expect.objectContaining({
      body: JSON.stringify({
        defaultKnowledgePlan: {
          baseIds: ["base-policies"], mode: "explicit", sourceIds: [], version: 1
        }
      }),
      method: "PATCH"
    }));
    expect(state.chats().find((chat) => chat.id === "chat-a")?.defaultKnowledgePlan).toEqual({
      baseIds: ["base-policies"], mode: "explicit", sourceIds: [], version: 1
    });
    expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith(
      { baseIds: ["base-policies"], mode: "explicit", sourceIds: [], version: 1 },
      "chat",
      "system"
    );
  });

  it("does not let a late chat Knowledge save replace a newer workspace plan", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    let resolveSave!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveSave = resolve;
    })));

    const pendingSave = state.actions.setChatKnowledgeDefault({
      baseIds: ["base-policies"], mode: "explicit", sourceIds: [], version: 1
    });
    await vi.waitFor(() => expect(resolveSave).toBeTypeOf("function"));
    state.actions.activateBlankWorkspace();
    state.setSelectedKnowledgePlan.mockClear();
    resolveSave(Response.json({
      chat: apiChatSummary({
        ...state.chatA,
        defaultKnowledgePlan: {
          baseIds: ["base-policies"], mode: "explicit", sourceIds: [], version: 1
        }
      })
    }));

    await expect(pendingSave).resolves.toBe(true);
    expect(state.setSelectedKnowledgePlan).not.toHaveBeenCalled();
    expect(state.chats().find((candidate) => candidate.id === "chat-a")?.defaultKnowledgePlan)
      .toEqual({
        baseIds: ["base-policies"], mode: "explicit", sourceIds: [], version: 1
      });
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

  it("authoritatively loads an unlisted Personal deep-link chat and rejects Project detail", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const personal = chat({
      activeLeafMessageId: "linked-message",
      id: "linked-personal-chat",
      messageCount: 1,
      title: "Linked personal chat"
    });
    const project = chat({
      activeLeafMessageId: "project-message",
      id: "linked-project-chat",
      messageCount: 1,
      projectId: "project-1",
      title: "Linked Project chat"
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/chats/linked-personal-chat") {
        return Response.json({
          chat: apiChatDetail(personal, [message({ id: "linked-message" })])
        });
      }
      if (path === "/api/chats/linked-project-chat") {
        return Response.json({
          chat: {
            ...apiChatDetail(project, [message({ id: "project-message" })]),
            projectId: "project-1"
          }
        });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(state.actions.activatePersonalChatById(personal.id)).resolves.toMatchObject({
      id: personal.id
    });
    expect(useWorkspaceStore.getState().activeChatId).toBe(personal.id);
    expect(state.chats()).toContainEqual(expect.objectContaining({ id: personal.id }));
    expect(useThreadStore.getState().threadsByChatId[personal.id]?.messages)
      .toContainEqual(expect.objectContaining({ id: "linked-message" }));

    state.actions.activateBlankWorkspace();
    await expect(state.actions.activatePersonalChatById(project.id)).resolves.toBeNull();
    expect(state.chats()).not.toContainEqual(expect.objectContaining({ id: project.id }));
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
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
        chat: apiChatDetail(lazyChat, detailMessages, { contextTokens: 12_345 })
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.activateChat(lazyChat, { resumeRuns: false });
    state.actions.activateBlankWorkspace();
    const cachedSummary = state.chats().find((candidate) => candidate.id === lazyChat.id);
    expect(cachedSummary).toBeDefined();
    await state.actions.activateChat(cachedSummary!, { resumeRuns: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(useThreadStore.getState().threadsByChatId["chat-a"]).toMatchObject({
      activeLeafId: "assistant-a",
      contextStats: {
        approximateActiveBranchInputTokens: 12_345
      },
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

    expect(fetchMock).toHaveBeenCalledWith(`/api/chats/${summary.id}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(useThreadStore.getState().threadsByChatId[summary.id]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Canonical answer", id: "assistant-canonical" })
      ])
    );
  });

  it.each([false, true])("keeps concurrent token content and the current leaf when stale detail resolves (stale activity: %s)", async (staleActivity) => {
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
        runId: "run-activity",
        parentMessageId: "user-a",
        role: "assistant",
        status: "streaming",
        workspaceActivity: { entries: [{ command: { preview: "pytest", ...(staleActivity ? { exitCode: 0, stdoutPreview: "passed" } : {}) }, id: "command", kind: "command", phase: staleActivity ? "succeeded" : "running", sequence: staleActivity ? 2 : 1 }] }
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
        runId: "run-activity",
        parentMessageId: "user-a",
        role: "assistant",
        status: "streaming",
        workspaceActivity: { entries: [{ command: { preview: "…", ...(!staleActivity ? { exitCode: 0, stdoutPreview: "passed" } : {}) }, id: "command", kind: "command", phase: staleActivity ? "running" : "succeeded", sequence: staleActivity ? 1 : 2 }] }
      }),
      message({
        content: "Server sibling",
        id: "assistant-server",
        parentMessageId: "assistant-a",
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
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a", expect.objectContaining({ signal: expect.any(AbortSignal) })));
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
    expect(cached.messages.find((candidate) => candidate.id === "assistant-a")?.workspaceActivity?.entries).toMatchObject([
      { command: { exitCode: 0, preview: "pytest", stdoutPreview: "passed" }, phase: "succeeded", sequence: 2 }
    ]);
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

  it("prepends a snapshot-matched older page without replacing thread facts", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const summary = {
      ...state.chatA,
      activeLeafMessageId: "message-4",
      messageCount: 4
    };
    const tail = [
      message({ content: "Third", id: "message-3", parentMessageId: "message-2" }),
      message({
        content: "Fourth",
        id: "message-4",
        parentMessageId: "message-3",
        role: "assistant"
      })
    ];
    useWorkspaceStore.getState().updateChats((current) =>
      current.map((candidate) => (candidate.id === summary.id ? summary : candidate))
    );
    useThreadStore.getState().replaceThread(summary.id, {
      activeLeafId: summary.activeLeafMessageId,
      contextStats: { approximateActiveBranchInputTokens: 4_200 },
      history: threadHistory(summary, {
        beforeCursor: "cursor-tail",
        hasOlder: true
      }),
      messages: tail,
      sourceUpdatedAt: summary.updatedAt,
      usageStats: {
        hasCompletedAnswer: true,
        incompleteRecordCount: 0,
        recordCount: 4,
        knownCostRecordCount: 0,
        estimatedCostMicros: null,
        totalTokens: 88
      }
    });
    const older = [
      message({ content: "First", id: "message-1" }),
      message({ content: "Second", id: "message-2", parentMessageId: "message-1" })
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        apiMessagesPage(older, {
          activeLeafMessageId: summary.activeLeafMessageId,
          beforeCursor: null,
          snapshotUpdatedAt: summary.updatedAt
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(state.actions.loadEarlierMessages(summary.id)).resolves.toBe("prepended");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/chat-a/messages?before=cursor-tail"
    );
    expect(useThreadStore.getState().threadsByChatId[summary.id]).toMatchObject({
      activeLeafId: "message-4",
      contextStats: { approximateActiveBranchInputTokens: 4_200 },
      history: {
        beforeCursor: null,
        error: null,
        hasOlder: false,
        loading: false
      },
      usageStats: {
        hasCompletedAnswer: true,
        incompleteRecordCount: 0,
        recordCount: 4,
        knownCostRecordCount: 0,
        estimatedCostMicros: null,
        totalTokens: 88
      }
    });
    expect(
      useThreadStore.getState().threadsByChatId[summary.id]?.messages.map(
        (candidate) => candidate.id
      )
    ).toEqual(["message-1", "message-2", "message-3", "message-4"]);
  });

  it("rejects an older page from a different snapshot without corrupting the tail", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const summary = {
      ...state.chatA,
      activeLeafMessageId: "message-4",
      messageCount: 4
    };
    const tail = [
      message({ id: "message-3", parentMessageId: "message-2" }),
      message({ id: "message-4", parentMessageId: "message-3", role: "assistant" })
    ];
    useWorkspaceStore.getState().updateChats((current) =>
      current.map((candidate) => (candidate.id === summary.id ? summary : candidate))
    );
    useThreadStore.getState().replaceThread(summary.id, {
      activeLeafId: summary.activeLeafMessageId,
      history: threadHistory(summary, {
        beforeCursor: "cursor-tail",
        hasOlder: true
      }),
      messages: tail,
      sourceUpdatedAt: summary.updatedAt,
      usageStats: null
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          apiMessagesPage(
            [
              message({ id: "message-1" }),
              message({ id: "message-2", parentMessageId: "message-1" })
            ],
            {
              activeLeafMessageId: summary.activeLeafMessageId,
              beforeCursor: null,
              snapshotUpdatedAt: "2026-06-10T00:01:00.000Z"
            }
          )
        )
      )
    );

    await expect(state.actions.loadEarlierMessages(summary.id)).resolves.toBe("failed");

    expect(useThreadStore.getState().threadsByChatId[summary.id]).toMatchObject({
      history: {
        error: expect.stringContaining("chat_page_malformed"),
        loading: false
      },
      messages: tail
    });
  });

  it("downloads the server-built export under the server file name, Markdown by default", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const summary = { ...state.chatA, title: "Release checklist · 032" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(
      String(input).includes("format=json") ? "{\"format\":\"aiqsa.chat\"}" : "# Release checklist · 032\n",
      { headers: { "content-disposition": String(input).includes("format=json")
        ? "attachment; filename=\"chat-2026-09-01.json\"; filename*=UTF-8''%D1%80%D0%B5%D0%BB%D0%B8%D0%B7-2026-09-01.json"
        : "attachment; filename=\"release-checklist-032-2026-09-01.md\"; filename*=UTF-8''release-checklist-032-2026-09-01.md" } }
    ));
    const blobs: Blob[] = [];
    const downloads: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:export";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      downloads.push(this.download);
    });
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.exportChat(summary);
    await state.actions.exportChat(summary, "json");

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/chats/chat-a/export?format=markdown",
      "/api/chats/chat-a/export?format=json"
    ]);
    expect(downloads).toEqual(["release-checklist-032-2026-09-01.md", "релиз-2026-09-01.json"]);
    expect(await blobs[0]?.text()).toBe("# Release checklist · 032\n");
    expect(state.setNotice).toHaveBeenLastCalledWith({ kind: "success", text: "Chat exported" });
    expect(useThreadStore.getState().threadsByChatId[summary.id]).toBeUndefined();
  });

  it("reports a refused export without downloading anything", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "chat_not_found" }, { status: 404 })));

    await state.actions.exportChat(state.chatA, "json");

    expect(click).not.toHaveBeenCalled();
    expect(state.setNotice).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "error",
      text: expect.stringContaining("The complete chat could not be exported")
    }));
  });

  it("loads older pages of the complete branch through operation-local memory without growing the thread cache", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const summary = {
      ...state.chatA,
      activeLeafMessageId: "message-4",
      messageCount: 4
    };
    const tail = [
      message({ content: "Third", id: "message-3", parentMessageId: "message-2" }),
      message({
        content: "Fourth",
        id: "message-4",
        parentMessageId: "message-3",
        role: "assistant"
      })
    ];
    useWorkspaceStore.getState().updateChats((current) =>
      current.map((candidate) => (candidate.id === summary.id ? summary : candidate))
    );
    useThreadStore.getState().replaceThread(summary.id, {
      activeLeafId: summary.activeLeafMessageId,
      history: threadHistory(summary, {
        beforeCursor: "cursor-tail",
        hasOlder: true
      }),
      messages: tail,
      sourceUpdatedAt: summary.updatedAt,
      usageStats: null
    });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        apiMessagesPage(
          [
            message({ content: "First", id: "message-1" }),
            message({ content: "Second", id: "message-2", parentMessageId: "message-1" })
          ],
          {
            activeLeafMessageId: summary.activeLeafMessageId,
            beforeCursor: null,
            snapshotUpdatedAt: summary.updatedAt
          }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const branch = await state.actions.loadCompleteActiveBranch(summary.id);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/chat-a/messages?before=cursor-tail"
    );
    expect(branch.map((candidate) => candidate.content)).toEqual(["First", "Second", "Third", "Fourth"]);
    expect(
      useThreadStore.getState().threadsByChatId[summary.id]?.messages.map(
        (candidate) => candidate.id
      )
    ).toEqual(["message-3", "message-4"]);
  });

  it("refreshes a same-count stale thread before loading the complete branch", async () => {
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
      history: threadHistory(summary, {
        snapshotUpdatedAt: "2026-06-10T00:00:00.000Z"
      }),
      messages: [message({ content: "stale export", id: "message-a" })],
      sourceUpdatedAt: "2026-06-10T00:00:00.000Z",
      usageStats: null
    });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        chat: apiChatDetail(summary, [message({ content: "current export", id: "message-a" })])
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const branch = await state.actions.loadCompleteActiveBranch(summary.id);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(branch.map((candidate) => candidate.content)).toEqual(["current export"]);
    expect(useThreadStore.getState().threadsByChatId[summary.id]?.sourceUpdatedAt).toBe(
      summary.updatedAt
    );
  });

  it("hydrates an incomplete thread once for the complete branch and reuses it", async () => {
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
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.loadCompleteActiveBranch(summary.id);
    await state.actions.loadCompleteActiveBranch(summary.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(useThreadStore.getState().threadsByChatId["chat-a"]?.messages).toHaveLength(2);
  });

  it("favorites chats and keeps favorite rows sorted ahead of newer rows", async () => {
    const state = useWorkspaceActionsForTest({
      attachments: [],
      draft: ""
    });
    useWorkspaceStore.getState().applyNavigationPage({
      chats: [{
        activeRun: true,
        assistant: null,
        folderId: state.chatA.folderId,
        id: state.chatA.id,
        title: state.chatA.title,
        updatedAt: state.chatA.updatedAt
      }],
      folders: [],
      nextCursor: null
    }, false);
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
    expect(useWorkspaceStore.getState().navigationChats).toEqual([expect.objectContaining({
      activeRun: true,
      id: "chat-a",
      updatedAt: "2026-06-09T00:00:00.000Z"
    })]);
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
      (url: string | URL | Request) => String(url) !== "/api/chats"
        ? Promise.resolve(Response.json({ error: "memory_not_found" }, { status: 404 }))
        :
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
      new Response(JSON.stringify({ chats: [], folders: [] }), {
        headers: { "content-type": "application/json" },
        status: 200
      })
    );
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(useWorkspaceStore.getState()).toMatchObject({
      chats: [],
      folders: [],
      workspaceError: null,
      workspaceLoading: false,
      workspaceReady: true
    });
    expect(state.setNotice).not.toHaveBeenCalled();
  });

  it("does not replace a newer chat selection when an older workspace refresh finishes", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "Draft in A" });
    let settle!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { settle = resolve; })));

    const refresh = state.actions.refreshWorkspace();
    await state.actions.activateChat(state.chatB);
    useComposerSessionStore.getState().setDraft("Draft in B");
    settle(Response.json({ chats: [apiChatSummary(state.chatA), apiChatSummary(state.chatB)], folders: [] }));
    await refresh;

    expect(useWorkspaceStore.getState().activeChatId).toBe(state.chatB.id);
    expect(selectActiveComposerSession(useComposerSessionStore.getState()).draft).toBe("Draft in B");
  });

  it("preserves a chat created during an older list refresh and its unsent draft", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const created = chat({ id: "new-chat", title: "New chat" });
    let settle!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => init?.method === "POST"
      ? Response.json({ chat: apiChatSummary(created) })
      : new Promise<Response>((resolve) => { settle = resolve; })));

    const refresh = state.actions.refreshWorkspace();
    await state.actions.createChat();
    useComposerSessionStore.getState().setDraft("New unsent work");
    settle(Response.json({ chats: [apiChatSummary(state.chatA), apiChatSummary(state.chatB)], folders: [] }));
    await refresh;

    expect(useWorkspaceStore.getState().activeChatId).toBe(created.id);
    expect(state.chats()).toContainEqual(expect.objectContaining({ id: created.id }));
    expect(selectComposerSession(useComposerSessionStore.getState(), composerSessionKey(created.id)).draft)
      .toBe("New unsent work");
  });

  it("preserves committed renames and removals against an older workspace response", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "Keep this draft" });
    let settle!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { settle = resolve; })));
    const refresh = state.actions.refreshWorkspace();
    useWorkspaceStore.getState().updateChats((chats) => chats
      .filter((chat) => chat.id !== state.chatB.id)
      .map((chat) => chat.id === state.chatA.id ? { ...chat, title: "Saved new title" } : chat));
    settle(Response.json({ chats: [apiChatSummary(state.chatA), apiChatSummary(state.chatB)], folders: [] }));
    await refresh;

    expect(state.chats()).toEqual([expect.objectContaining({ id: state.chatA.id, title: "Saved new title" })]);
    expect(state.draft()).toBe("Keep this draft");
  });

  it("still removes a chat absent from a fresh authoritative list", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    vi.stubGlobal("fetch", vi.fn(async (input) => String(input) === "/api/chats"
      ? Response.json({ chats: [], folders: [] })
      : Response.json({ error: "not_found" }, { status: 404 })));
    await state.actions.refreshWorkspace();

    expect(state.chats()).toEqual([]);
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
  });

  it("recovers the exact remembered Temporary chat without exposing it or pruning its draft", async () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "Temporary draft" });
    const temporary = {
      ...state.chatA,
      memoryMode: "TEMPORARY" as const,
      memorySourceRevision: 2,
      temporaryRetentionDeadline: "2026-06-11T00:00:00.000Z"
    };
    useWorkspaceStore.setState({ activeChatId: temporary.id, chats: [temporary, state.chatB] });
    useComposerSessionStore.getState().activateSession(composerSessionKey(temporary.id));
    useComposerSessionStore.getState().setDraft("Temporary draft");
    useThreadStore.getState().replaceThread(temporary.id, {
      activeLeafId: null,
      messages: [],
      sourceUpdatedAt: temporary.updatedAt,
      usageStats: null
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/chats") {
        return Response.json({
          chats: [apiChatSummary(state.chatB)],
          folders: []
        });
      }
      if (path === `/api/me/chats/${temporary.id}/memory-mode`) {
        return Response.json(apiChatMemoryState(temporary, "TEMPORARY"));
      }
      if (path === `/api/chats/${temporary.id}`) {
        return Response.json({ chat: apiChatDetail(temporary, []) });
      }
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await state.actions.refreshWorkspace(temporary.id, { resumeRuns: false });

    expect(useWorkspaceStore.getState().activeChatId).toBe(temporary.id);
    expect(state.session(composerSessionKey(temporary.id)).draft).toBe("Temporary draft");
    expect(useThreadStore.getState().threadsByChatId[temporary.id]).toBeDefined();
    expect(workspaceNavigationChats(useWorkspaceStore.getState().chats).map((chat) => chat.id))
      .toEqual([state.chatB.id]);
    expect(useWorkspaceStore.getState().chats.find((chat) => chat.id === temporary.id))
      .toMatchObject({
        memoryMode: "TEMPORARY",
        temporaryRetentionDeadline: "2026-06-11T00:00:00.000Z"
      });
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

describe("chat scope across personal and Project workspaces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  const attachmentFor = (id: string): ComposerAttachment => ({ fileName: `${id}.pdf`, id, kind: "pdf" });

  /**
   * A personal workspace after a Project visit: a blank Project reservation
   * and a saved Project chat share the store with personal chats, newest first.
   */
  function useMixedScopeForTest(activeChatId: string | null) {
    const state = useWorkspaceActionsForTest({ activeChatId, attachments: [], draft: "" });
    const reservation = chat({
      id: "project-reservation",
      pendingProjectDraft: { folderId: null, projectId: "project-1" },
      projectId: "project-1",
      title: "Project reservation",
      updatedAt: "2026-06-12T00:00:00.000Z"
    });
    const saved = chat({
      defaultModelId: "project-model",
      defaultProvider: "project-provider",
      id: "project-saved",
      projectId: "project-1",
      title: "Saved Project chat",
      updatedAt: "2026-06-11T00:00:00.000Z"
    });
    useWorkspaceStore.setState({ chats: [reservation, saved, state.chatA, state.chatB] });
    const projectSessions = [
      [composerSessionKey(saved.id), "Saved Project draft"],
      [composerSessionKey(reservation.id), "Reserved Project draft"],
      [projectComposerSessionKey("project-1"), "Project blank draft"],
      [projectComposerSessionKey("project-1", "project-folder"), "Project folder draft"]
    ] as const;
    for (const [key, draft] of projectSessions) {
      useComposerSessionStore.getState().activateSession(key);
      useComposerSessionStore.getState().setDraft(draft);
      useComposerSessionStore.getState().setAttachments([attachmentFor(`${draft.split(" ")[0]}-file`)]);
    }
    useComposerSessionStore.getState().activateSession(composerSessionKey(activeChatId));
    useThreadStore.getState().replaceThread(reservation.id, {
      activeLeafId: null,
      messages: [],
      sourceUpdatedAt: reservation.updatedAt,
      usageStats: null
    });
    const expectProjectDraftsKept = () => {
      for (const [key, draft] of projectSessions) {
        expect(state.session(key)).toMatchObject({
          attachments: [attachmentFor(`${draft.split(" ")[0]}-file`)],
          draft
        });
      }
      expect(state.chats().map((candidate) => candidate.id)).toEqual(
        expect.arrayContaining([reservation.id, saved.id])
      );
    };
    return { ...state, expectProjectDraftsKept, reservation, saved };
  }

  function stubArchiveRequests() {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const chatId = decodeURIComponent(path.split("/")[3] ?? "");
      const summary = chat({ id: chatId, title: chatId });
      if (path.endsWith("/memory-mode")) return Response.json(apiChatMemoryState(summary));
      if (path.endsWith("/source")) return Response.json(apiChatSource(summary));
      if (path.endsWith("/archive")) return Response.json(apiArchivedChat(summary));
      return Response.json({ error: "unexpected" }, { status: 500 });
    }));
  }

  it("archives the active personal chat into another personal chat, then the personal blank chat, without history entries", async () => {
    window.history.replaceState(null, "", "/c/chat-a");
    const historyLength = window.history.length;
    const state = useMixedScopeForTest("chat-a");
    stubArchiveRequests();

    await state.actions.deleteChat(state.chatA);
    expect(state.setNotice).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Chat moved to archive" }));
    expect(useWorkspaceStore.getState().activeChatId).toBe("chat-b");
    expect(window.location.pathname).toBe("/c/chat-b");
    expect(state.setSelectedModelId).toHaveBeenLastCalledWith("gpt-5.5", "system");

    await state.actions.deleteChat(state.chatB);
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(composerSessionKey(null));
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(historyLength);
    expect(state.setSelectedModelId).not.toHaveBeenCalledWith("project-model", expect.anything());
    state.expectProjectDraftsKept();
  });

  it("hands a removed Project chat to its scope's fallback, and without one opens the personal blank chat", async () => {
    window.history.replaceState(null, "", "/p/project-1/c/project-saved");
    const state = useMixedScopeForTest("project-saved");
    stubArchiveRequests();
    const activateFallback = vi.fn();

    await state.actions.deleteChat(state.saved, activateFallback);
    expect(activateFallback).toHaveBeenCalledExactlyOnceWith("project-1", state.reservation);

    const next = useMixedScopeForTest("project-saved");
    stubArchiveRequests();
    await next.actions.deleteChat(next.saved);
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
    expect(window.location.pathname).toBe("/");
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(composerSessionKey(null));
  });

  it("keeps saved and reserved Project chats with their drafts and controls through a personal refresh", async () => {
    window.history.replaceState(null, "", "/p/project-1/c/project-saved");
    const historyLength = window.history.length;
    const state = useMixedScopeForTest("project-saved");
    useComposerSessionStore.getState().activateSession(composerSessionKey("chat-b"));
    useComposerSessionStore.getState().setDraft("Removed personal draft");
    useComposerSessionStore.getState().activateSession(composerSessionKey("project-saved"));
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({ chats: [apiChatSummary(state.chatA)], folders: [] });
    }));

    // A retry keeps the open saved Project chat and the controls its Project applied.
    await state.actions.refreshWorkspace("project-saved");
    expect(requests).toEqual(["/api/chats"]);
    expect(useWorkspaceStore.getState().activeChatId).toBe("project-saved");
    expect(window.location.pathname).toBe("/p/project-1/c/project-saved");
    for (const setter of [state.applyModelControlDefaults, state.setSelectedModelId, state.setSelectedProvider,
      state.setSelectedSearchPlan, state.setSelectedKnowledgePlan]) expect(setter).not.toHaveBeenCalled();
    expect(state.actions.reapplyActiveChatDefaults(useWorkspaceStore.getState().catalog!)).toBe(false);
    expect(state.setSelectedModelId).not.toHaveBeenCalled();
    state.expectProjectDraftsKept();
    expect(useThreadStore.getState().threadsByChatId["project-reservation"]).toBeDefined();
    expect(useComposerSessionStore.getState().sessionsByKey[composerSessionKey("chat-b")]).toBeUndefined();

    // Restoring a personal chat opens it by replacing the address and leaves every Project draft.
    await state.actions.refreshWorkspace("chat-a", { preserveControls: true });
    expect(useWorkspaceStore.getState().activeChatId).toBe("chat-a");
    expect(window.location.pathname).toBe("/c/chat-a");
    expect(window.history.length).toBe(historyLength);
    state.expectProjectDraftsKept();
  });

  it("leaves an open Project's blank chat to its owner when a personal refresh has no target", async () => {
    window.history.replaceState(null, "", "/p/project-1");
    const state = useMixedScopeForTest(null);
    useComposerSessionStore.getState().activateSession(projectComposerSessionKey("project-1"));
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ chats: [apiChatSummary(state.chatA)], folders: [] })));

    await state.actions.refreshWorkspace(null);
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(projectComposerSessionKey("project-1"));
    expect(window.location.pathname).toBe("/p/project-1");
    expect(state.setSelectedModelId).not.toHaveBeenCalled();
    state.expectProjectDraftsKept();
  });

  it("keeps a session whose send is pending through a refresh that drops its chat, then returns the refused text", async () => {
    const state = useWorkspaceActionsForTest({ activeChatId: "chat-a", attachments: [attachmentFor("sent")], draft: "Pending question" });
    const key = composerSessionKey("chat-a");
    const send = useComposerSessionStore.getState().beginSend(key)!;
    useComposerSessionStore.getState().setDraft("Typed while waiting");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/chats"
      ? Response.json({ chats: [apiChatSummary(state.chatB)], folders: [] })
      : Response.json({ error: "chat_not_found" }, { status: 404 })));

    await state.actions.refreshWorkspace("chat-b");
    expect(state.session(key).pendingSend?.generation).toBe(send.generation);

    expect(useComposerSessionStore.getState().finishSend(send, "failed", "Send refused")).toBe(true);
    expect(state.session(key)).toMatchObject({
      attachments: [attachmentFor("sent")],
      draft: "Pending question\n\nTyped while waiting",
      operationError: "Send refused",
      operationErrorRetryable: false,
      pendingSend: null
    });

    await state.actions.refreshWorkspace("chat-b");
    expect(useComposerSessionStore.getState().sessionsByKey[key]).toBeUndefined();
  });
});

describe("chat export markdown", () => {
  it("renders the visible branch as a readable deterministic document", () => {
    const markdown = chatExportMarkdown("Release checklist · 032", [
      message({ content: "Составь план релиза  ", id: "q1" }),
      message({
        content: {
          blocks: [{ text: "1. Проверить миграции\n2. Прогнать smoke", type: "text" }]
        },
        id: "a1",
        parentMessageId: "q1",
        role: "assistant"
      })
    ]);

    expect(markdown).toBe(
      "# Release checklist · 032\n\n" +
      "## User\n\nСоставь план релиза\n\n" +
      "## Assistant\n\n1. Проверить миграции\n2. Прогнать smoke\n"
    );
    // No provider internals, ids, or token counts leak into the document.
    expect(markdown).not.toMatch(/token|provider|runId|uuid/iu);
  });
});

describe("blank workspace chat defaults", () => {
  it("starts a new chat with the personal MCP and Knowledge defaults and names a dropped base", () => {
    const state = useWorkspaceActionsForTest({ attachments: [], draft: "" });
    const catalog = useWorkspaceStore.getState().catalog;
    if (!catalog) throw new Error("catalog fixture missing");
    useWorkspaceStore.setState({
      catalog: {
        ...catalog,
        defaults: {
          ...catalog.defaults,
          knowledgePlan: { baseIds: ["kb-1", "kb-gone"], mode: "explicit", sourceIds: [], version: 1 },
          mcpMode: "load_all"
        }
      }
    });
    useKnowledgeLibraryStore.setState({
      data: {
        knowledgeBases: [{
          archived: false,
          deletionPending: false,
          description: "",
          id: "kb-1",
          name: "Handbook",
          owned: true,
          ownerDisplayName: "Operator",
          purgeScheduledAt: null,
          readiness: { indexedSourceCount: 0, state: "ready", totalSourceCount: 0 } as never,
          scope: "personal" as never,
          sourceCount: 0,
          trashed: false,
          trashedAt: null,
          updatedAt: "2026-09-01T00:00:00.000Z",
          version: 1
        }],
        publishableGroups: [],
        viewer: { canCreate: true, canPublishInstallation: false, maxUploadBytes: 1 }
      }
    });
    try {
      state.actions.activateBlankWorkspace();
      expect(useComposerControlStore.getState().mcpSelection).toEqual({ mode: "load_all" });
      expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith(
        expect.objectContaining({ baseIds: ["kb-1"], mode: "explicit" }),
        "explicit",
        "system"
      );
      expect(state.setNotice).toHaveBeenCalledWith(expect.objectContaining({
        kind: "error",
        text: expect.stringContaining("no longer available")
      }));

      useKnowledgeLibraryStore.setState({ data: null });
      state.setNotice.mockClear();
      state.actions.activateBlankWorkspace();
      expect(state.setSelectedKnowledgePlan).toHaveBeenLastCalledWith(
        expect.objectContaining({ baseIds: ["kb-1", "kb-gone"] }),
        "explicit",
        "system"
      );
      expect(state.setNotice).not.toHaveBeenCalled();
    } finally {
      useComposerControlStore.getState().setMcpSelection({ mode: "auto" });
      resetKnowledgeLibraryStoreForTest();
    }
  });
});
