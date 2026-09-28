import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetChatAssistantProjectionStoreForTest,
  resetComposerControlStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import {
  assistantAvatarFixture,
  boundComposerAssistantFixture
} from "@/tests/support/composerAssistantFixtures";
import { createChatAssistantActions, type ChatAssistantChooseScope } from "./chatAssistantActions";
import { useChatAssistantProjectionStore } from "./chatAssistantProjectionStore";
import { useComposerControlStore } from "./composerControlStore";
import { useWorkspaceStore } from "./workspaceStore";
import type { CatalogModel, WorkspaceChatSummary } from "./types";
import type { AssistantDetail } from "@/lib/contracts/assistants";
import { EMPTY_KNOWLEDGE_SELECTION } from "@/lib/contracts/knowledge";

const model = {
  capabilities: { toolCalling: true },
  defaultParams: {},
  displayName: "Assistant model",
  modelId: "assistant-model",
  parameterControls: {
    background: { defaultValue: false, supported: false },
    maxOutputTokens: { defaultValue: 4096, maxValue: 8192 },
    reasoningEffort: { defaultValue: "medium", options: ["low", "medium"], supported: true },
    stream: { defaultValue: true, supported: true },
    temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
  },
  provider: "assistant-provider",
  searchStrategyIds: []
} as unknown as CatalogModel;

function chat(overrides: Partial<WorkspaceChatSummary> = {}): WorkspaceChatSummary {
  return {
    activeLeafMessageId: null,
    createdAt: "2026-09-28T00:00:00.000Z",
    defaultModelId: "assistant-model",
    defaultProvider: "assistant-provider",
    folderId: null,
    id: "chat-a",
    messageCount: 2,
    title: "Chat A",
    updatedAt: "2026-09-28T00:00:00.000Z",
    ...overrides
  };
}

function detail(overrides: Partial<AssistantDetail> = {}): AssistantDetail {
  return {
    archived: false,
    audience: overrides.owned === false ? null : { everyone: false, groupNames: [] },
    availability: { ok: true },
    content: {
      answerRules: null,
      avatar: assistantAvatarFixture,
      category: null,
      description: "Reviews code",
      knowledgeSelection: EMPTY_KNOWLEDGE_SELECTION,
      mcpServerIds: [],
      name: "Reviewer",
      providerModelId: "assistant-model",
      rows: {
        controls: { policy: "adjustable", value: {} },
        knowledge: { policy: "adjustable", value: { mode: "none" } },
        model: { policy: "adjustable", value: { mode: "model", modelId: "assistant-model" } },
        search: { policy: "fixed", value: { mode: "off" } },
        skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
        tools: { policy: "adjustable", value: { mode: "inherit" } }
      },
      runControls: {},
      searchPlan: { mode: "all_selected", optionIds: [] },
      skillIds: [],
      starterPrompts: ["Review this"],
      systemPrompt: "Review carefully."
    },
    featured: false,
    id: "assistant-1",
    owned: true,
    ownerDisplayName: "Owner",
    pinned: false,
    rowAvailability: {},
    scope: { kind: "owner" },
    updatedAt: "2026-09-28T00:00:00.000Z",
    version: 7,
    ...overrides
  };
}

function scope(): ChatAssistantChooseScope {
  return {
    context: {
      controlDefaults: () => ({
        backgroundMode: false,
        maxOutputTokens: "4096",
        reasoningEffort: "medium",
        reasoningMode: "standard",
        streamMode: true,
        temperature: "1"
      }),
      models: [model],
      skill: () => null
    },
    defaults: {
      knowledge: { selection: EMPTY_KNOWLEDGE_SELECTION, source: "off" },
      model: { modelId: "assistant-model", provider: "assistant-provider" },
      search: { mode: "all_selected", optionIds: [] },
      skillsMode: "auto",
      tools: { mode: "load_all" }
    },
    restoreDefaults: vi.fn()
  };
}

const subscriptions: (() => void)[] = [];

function setup(active: WorkspaceChatSummary | null = chat()) {
  useWorkspaceStore.setState({ activeChatId: active?.id ?? null, chats: active ? [active] : [] });
  const chooseScope = scope();
  const refreshChatAssistant = vi.fn(async (_chatId: string, _isCurrent: () => boolean) => true);
  const setNotice = vi.fn();
  const clearNotice = vi.fn();
  const actions = createChatAssistantActions({
    chooseScope: () => chooseScope,
    clearNotice,
    refreshChatAssistant,
    setNotice,
    syncDelayMs: 10
  });
  const unsubscribe = useComposerControlStore.subscribe(() => actions.syncChangedRows());
  subscriptions.push(unsubscribe);
  return { actions, chooseScope, clearNotice, refreshChatAssistant, setNotice, unsubscribe };
}

function patchBodies(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("chat Assistant actions", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetComposerControlStoreForTest();
    resetWorkspaceStoreForTest();
    resetChatAssistantProjectionStoreForTest();
    fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ chat: {} }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("chooses an Assistant for a chat that does not exist yet in composer state only", async () => {
    const { actions } = setup(chat({ pendingPersonalDraft: { folderId: null, memoryMode: "NORMAL" } }));

    await expect(actions.chooseAssistant(detail())).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useComposerControlStore.getState()).toMatchObject({
      assistant: { id: "assistant-1", state: "bound", starterPrompts: ["Review this"] },
      mcpSelection: { mode: "load_all" },
      selectedModelId: "assistant-model"
    });
  });

  it("changes the Assistant of an existing chat with a chat update, then re-reads its projection", async () => {
    const { actions, refreshChatAssistant } = setup();

    await expect(actions.chooseAssistant(detail())).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat-a", expect.objectContaining({ method: "PATCH" }));
    expect(patchBodies(fetchMock)).toEqual([{ assistantId: "assistant-1" }]);
    expect(refreshChatAssistant).toHaveBeenCalledWith("chat-a", expect.any(Function));
    expect(useComposerControlStore.getState().assistant).toBeNull();
    expect(useChatAssistantProjectionStore.getState().pendingChatIds).toEqual({});
  });

  it("reports a refused change and still shows the server's state", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "assistant_not_available" }, { status: 404 }));
    const { actions, refreshChatAssistant } = setup();

    await expect(actions.chooseAssistant(detail())).resolves.toBe("This Assistant isn't available to you.");
    expect(refreshChatAssistant).toHaveBeenCalledOnce();
  });

  it("removes the Assistant for an existing chat, and for a blank chat returns to its defaults", async () => {
    useComposerControlStore.setState({ assistant: boundComposerAssistantFixture() });
    const existing = setup();
    await existing.actions.removeAssistant();
    expect(patchBodies(fetchMock)).toEqual([{ assistantId: null }]);
    existing.unsubscribe();

    const blank = setup(null);
    await blank.actions.continueWithoutAssistant();
    expect(blank.chooseScope.restoreDefaults).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    blank.unsubscribe();
  });

  it("updates the chat list row after a binding change or removal, and not after a refused change", async () => {
    const row = { activeRun: false, assistant: null, folderId: null, id: "chat-a", title: "Chat A", updatedAt: "2026-09-28T00:00:00.000Z" };
    useWorkspaceStore.getState().applyNavigationPage({ chats: [row], folders: [], nextCursor: null }, false);
    const { actions } = setup();
    const listed = () => useWorkspaceStore.getState().navigationChats[0]?.assistant;

    fetchMock.mockResolvedValueOnce(Response.json({ error: "assistant_not_available" }, { status: 404 }));
    await actions.chooseAssistant(detail());
    expect(listed()).toBeNull();

    await actions.chooseAssistant(detail());
    expect(listed()).toEqual({ avatar: assistantAvatarFixture, name: "Reviewer" });

    useComposerControlStore.setState({ assistant: boundComposerAssistantFixture({ id: "assistant-1" }) });
    await actions.removeAssistant();
    expect(listed()).toBeNull();
  });

  it("starts a blank chat with the default Assistant through the choose path and reports one it can't use", async () => {
    const { actions, setNotice } = setup(null);
    fetchMock.mockResolvedValueOnce(Response.json({ assistant: detail() }));
    await expect(actions.chooseDefaultAssistant("assistant-1", () => true)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/me/assistants/assistant-1", expect.objectContaining({ method: "GET" }));
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-1", state: "bound" });

    resetComposerControlStoreForTest();
    fetchMock.mockResolvedValueOnce(Response.json({ assistant: detail() }));
    await expect(actions.chooseDefaultAssistant("assistant-1", () => false)).resolves.toBe(false);
    expect(useComposerControlStore.getState().assistant).toBeNull();
    expect(setNotice).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(Response.json({
      assistant: detail({ availability: { ok: false, reason: "model_access" } })
    }));
    await expect(actions.chooseDefaultAssistant("assistant-1", () => true)).resolves.toBe(false);
    expect(useComposerControlStore.getState().assistant).toBeNull();
    expect(setNotice).toHaveBeenLastCalledWith({
      kind: "error",
      text: "Your default Assistant isn't available to you right now. This chat starts without it."
    });
  });

  it("starts a blank chat with a linked Assistant through the choose path", async () => {
    const { actions, setNotice } = setup(null);
    fetchMock.mockResolvedValueOnce(Response.json({ assistant: detail({ owned: false }) }));
    await expect(actions.chooseLinkedAssistant("assistant-1", () => true)).resolves.toBe("chosen");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/me/assistants/assistant-1", expect.objectContaining({ method: "GET" }));
    expect(useComposerControlStore.getState().assistant).toMatchObject({ id: "assistant-1", state: "bound" });
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("leaves a blank chat without an Assistant, silently, for every linked Assistant it can't use", async () => {
    const { actions, chooseScope, setNotice } = setup(null);
    const failures = [
      Response.json({ error: "assistant_not_available" }, { status: 404 }),
      Response.json({ assistant: detail({ archived: true }) }),
      Response.json({ assistant: detail({ availability: { ok: false, reason: "model_access" } }) }),
      Response.json({ assistant: detail({ content: { ...detail().content, providerModelId: "gone-model", rows: { ...detail().content.rows, model: { policy: "adjustable", value: { mode: "model", modelId: "gone-model" } } } } }) }),
      Response.json({ error: "internal_error" }, { status: 500 })
    ];
    for (const response of failures) {
      // A default Assistant applied before the link resolved gives way too.
      useComposerControlStore.setState({ assistant: boundComposerAssistantFixture({ id: "default-assistant" }) });
      vi.mocked(chooseScope.restoreDefaults).mockImplementationOnce(() => useComposerControlStore.getState().clearAssistant());
      fetchMock.mockResolvedValueOnce(response);
      await expect(actions.chooseLinkedAssistant("assistant-1", () => true)).resolves.toBe("unavailable");
      expect(useComposerControlStore.getState().assistant).toBeNull();
    }
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(actions.chooseLinkedAssistant("assistant-1", () => true)).resolves.toBe("unavailable");
    expect(chooseScope.restoreDefaults).toHaveBeenCalledTimes(failures.length);
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("reads nothing for a malformed link and ignores a linked Assistant that resolves too late", async () => {
    const { actions } = setup(null);
    await expect(actions.chooseLinkedAssistant(null, () => true)).resolves.toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(Response.json({ assistant: detail() }));
    await expect(actions.chooseLinkedAssistant("assistant-1", () => false)).resolves.toBe("superseded");
    expect(useComposerControlStore.getState().assistant).toBeNull();

    // The blank chat's first message made it a chat meanwhile: the link never binds it.
    useWorkspaceStore.setState({ activeChatId: "chat-a", chats: [chat()] });
    fetchMock.mockResolvedValueOnce(Response.json({ assistant: detail() }));
    await expect(actions.chooseLinkedAssistant("assistant-1", () => true)).resolves.toBe("superseded");
    expect(patchBodies(fetchMock)).toEqual([]);
    expect(useComposerControlStore.getState().assistant).toBeNull();
  });

  it("turns row changes in an existing chat into one coalesced chat update", async () => {
    vi.useFakeTimers();
    const { actions, refreshChatAssistant, unsubscribe } = setup();
    useComposerControlStore.getState().applyAssistantState({
      assistant: boundComposerAssistantFixture(),
      controls: { selectedModelId: "assistant-model", selectedProvider: "assistant-provider", selectedSearchOptionIds: ["web"] }
    });

    useComposerControlStore.getState().setSelectedSearchPlan([], "all_selected");
    useComposerControlStore.getState().setMcpSelection({ mode: "off" });
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);

    expect(patchBodies(fetchMock)).toEqual([{
      assistantOverrides: { search: { mode: "off" }, tools: { mode: "off" } }
    }]);
    expect(refreshChatAssistant).toHaveBeenCalledOnce();
    const assistant = useComposerControlStore.getState().assistant;
    expect(assistant?.state === "bound" && assistant.unsyncedRows).toEqual([]);
    expect(actions).toBeDefined();
    unsubscribe();
  });

  it("keeps row changes of a chat that does not exist yet in composer state", async () => {
    vi.useFakeTimers();
    const { unsubscribe } = setup(null);
    useComposerControlStore.getState().applyAssistantState({ assistant: boundComposerAssistantFixture(), controls: {} });

    useComposerControlStore.getState().setSkillsMode("off");
    await vi.advanceTimersByTimeAsync(20);

    expect(fetchMock).not.toHaveBeenCalled();
    const assistant = useComposerControlStore.getState().assistant;
    expect(assistant?.state === "bound" && assistant.rows.skills.origin).toBe("chat");
    unsubscribe();
  });

  it("sends a model change without the controls it replaces", async () => {
    vi.useFakeTimers();
    const { unsubscribe } = setup();
    useComposerControlStore.getState().applyAssistantState({
      assistant: boundComposerAssistantFixture(),
      controls: { selectedModelId: "assistant-model", selectedProvider: "assistant-provider" }
    });
    useComposerControlStore.getState().setTemperature("0.9");
    useComposerControlStore.getState().applyModelSelection({
      controlDefaults: {
        backgroundMode: false,
        maxOutputTokens: "2000",
        reasoningEffort: "low",
        reasoningMode: "standard",
        streamMode: false,
        temperature: "1"
      },
      modelId: "other-model",
      provider: "other-provider"
    });
    await vi.advanceTimersByTimeAsync(20);

    // The parameters changed for the Assistant's model stay behind with it;
    // the server drops the chat's controls when the model changes.
    expect(patchBodies(fetchMock)).toEqual([{
      assistantOverrides: { model: { mode: "model", modelId: "other-model" } }
    }]);
    unsubscribe();
  });

  it("resets a row with a chat update in an existing chat and locally in a blank chat", async () => {
    vi.useFakeTimers();
    const existing = setup();
    useComposerControlStore.getState().applyAssistantState({
      assistant: boundComposerAssistantFixture(),
      controls: { selectedSearchOptionIds: ["web"] }
    });
    useComposerControlStore.getState().setSelectedSearchPlan([], "all_selected");
    await existing.actions.resetRow("search");
    await vi.advanceTimersByTimeAsync(20);

    expect(patchBodies(fetchMock)).toEqual([{ assistantOverrides: { search: null } }]);
    existing.unsubscribe();

    const blank = setup(null);
    useComposerControlStore.getState().applyAssistantState({
      assistant: boundComposerAssistantFixture({
        resets: { skills: { controls: { skillsMode: "auto" }, origin: "assistant" } }
      }),
      controls: { skillsMode: "auto" }
    });
    useComposerControlStore.getState().setSkillsMode("off");
    await blank.actions.resetRow("skills");

    expect(useComposerControlStore.getState().skillsMode).toBe("auto");
    expect(fetchMock).toHaveBeenCalledOnce();
    blank.unsubscribe();
  });

  it("applies only the latest re-read when chat updates overlap", async () => {
    const { actions, refreshChatAssistant } = setup();
    useComposerControlStore.setState({ assistant: boundComposerAssistantFixture() });

    const first = actions.resetRow("search");
    const second = actions.resetRow("tools");
    await Promise.all([first, second]);

    const [firstCall, secondCall] = refreshChatAssistant.mock.calls;
    expect(firstCall?.[1]()).toBe(false);
    expect(secondCall?.[1]()).toBe(true);
  });

  it("saves the chat setup to the owner's Assistant and drops the chat's now equal values", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/me/assistants/assistant-a") return Response.json({ assistant: detail({ id: "assistant-a" }) });
      if (url.endsWith("/adopt-chat-setup")) {
        expect(JSON.parse(String(init?.body))).toEqual({ chatId: "chat-a", expectedVersion: 7 });
        return Response.json({ assistant: detail({ id: "assistant-a" }) });
      }
      return Response.json({ chat: {} });
    });
    const { actions, setNotice } = setup();
    const assistant = boundComposerAssistantFixture();
    assistant.rows.search = { ...assistant.rows.search, origin: "chat" };
    useComposerControlStore.setState({ assistant });

    await expect(actions.saveChatSetupToAssistant()).resolves.toBe(true);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/me/assistants/assistant-a",
      "/api/me/assistants/assistant-a/adopt-chat-setup",
      "/api/chats/chat-a"
    ]);
    expect(patchBodies(fetchMock)).toEqual([{ assistantOverrides: { search: null } }]);
    expect(setNotice).toHaveBeenLastCalledWith({ kind: "success", text: "Chat setup saved to Reviewer." });
  });

  describe("restoring an archived Assistant", () => {
    const failed = (text: string) => async () => ({ ok: false as const, reason: "failed" as const, text });

    it("reports a failed restore in the chat, re-reads the chat and ends its pending state", async () => {
      const { actions, refreshChatAssistant, setNotice } = setup();
      const chooseRestored = vi.fn();
      const text = "This assistant changed in another session. Reload Assistants and reapply your edit.";

      await expect(actions.restoreArchivedAssistant("chat-a", failed(text), chooseRestored)).resolves.toBe(false);

      expect(setNotice).toHaveBeenCalledExactlyOnceWith({ kind: "error", text });
      expect(refreshChatAssistant).toHaveBeenCalledExactlyOnceWith("chat-a", expect.any(Function));
      expect(chooseRestored).not.toHaveBeenCalled();
      expect(useChatAssistantProjectionStore.getState().pendingChatIds).toEqual({});
      expect(actions.hasPendingUpdate("chat-a")).toBe(false);
    });

    it("reports a restore the busy library refused, without re-reading the chat", async () => {
      const { actions, refreshChatAssistant, setNotice } = setup();

      await expect(actions.restoreArchivedAssistant(
        "chat-a",
        async () => ({ ok: false, reason: "busy" }),
        vi.fn()
      )).resolves.toBe(false);

      expect(setNotice).toHaveBeenCalledExactlyOnceWith({
        kind: "error",
        text: "Wait for the current Assistant change to finish, then try again."
      });
      expect(refreshChatAssistant).not.toHaveBeenCalled();
      expect(useChatAssistantProjectionStore.getState().pendingChatIds).toEqual({});
    });

    it("chooses the Assistant again in a blank chat only once it is restored", async () => {
      const { actions, refreshChatAssistant, setNotice } = setup(null);
      const chooseRestored = vi.fn();

      await expect(actions.restoreArchivedAssistant(
        null,
        failed("Only the owner can archive this assistant."),
        chooseRestored
      )).resolves.toBe(false);
      expect(chooseRestored).not.toHaveBeenCalled();
      expect(setNotice).toHaveBeenCalledExactlyOnceWith({ kind: "error", text: "Only the owner can archive this assistant." });

      await expect(actions.restoreArchivedAssistant(null, async () => ({ ok: true }), chooseRestored)).resolves.toBe(true);
      expect(chooseRestored).toHaveBeenCalledOnce();
      expect(setNotice).toHaveBeenCalledOnce();
      expect(refreshChatAssistant).not.toHaveBeenCalled();
    });

    it("clears the failure an earlier Restore wrote once a way out succeeds, and no other notice", async () => {
      const { actions, clearNotice, setNotice } = setup();
      const lastNotice = () => setNotice.mock.lastCall?.[0] as unknown;

      // A later successful Restore clears the failure the earlier one wrote.
      await actions.restoreArchivedAssistant("chat-a", failed("The assistant request could not be completed."), vi.fn());
      const restoreFailure = lastNotice();
      await expect(actions.restoreArchivedAssistant("chat-a", async () => ({ ok: true }), vi.fn())).resolves.toBe(true);
      expect(clearNotice).toHaveBeenCalledExactlyOnceWith(restoreFailure);

      // So does Continue without the Assistant, but not when the chat refuses it.
      await actions.restoreArchivedAssistant("chat-a", failed("Try again."), vi.fn());
      const secondFailure = lastNotice();
      useComposerControlStore.setState({ assistant: boundComposerAssistantFixture() });
      fetchMock.mockResolvedValueOnce(Response.json({ error: "assistant_not_available" }, { status: 404 }));
      await actions.continueWithoutAssistant();
      expect(clearNotice).toHaveBeenCalledOnce();
      await actions.continueWithoutAssistant();
      expect(clearNotice).toHaveBeenLastCalledWith(secondFailure);

      // And choosing another Assistant.
      await actions.restoreArchivedAssistant("chat-a", failed("Try again later."), vi.fn());
      const thirdFailure = lastNotice();
      await expect(actions.chooseAssistant(detail())).resolves.toBeNull();
      expect(clearNotice).toHaveBeenLastCalledWith(thirdFailure);
      expect(clearNotice).toHaveBeenCalledTimes(3);

      // Without a Restore failure there is nothing to clear.
      await actions.chooseAssistant(detail({ id: "assistant-2" }));
      expect(clearNotice).toHaveBeenCalledTimes(3);
    });

    it("ignores a repeated Restore while one is in flight", async () => {
      const { actions, setNotice } = setup();
      let release!: () => void;
      const restore = vi.fn(() => new Promise<{ ok: true }>((resolve) => { release = () => resolve({ ok: true }); }));

      const first = actions.restoreArchivedAssistant("chat-a", restore, vi.fn());
      await expect(actions.restoreArchivedAssistant("chat-a", restore, vi.fn())).resolves.toBe(false);
      release();

      await expect(first).resolves.toBe(true);
      expect(restore).toHaveBeenCalledOnce();
      expect(setNotice).not.toHaveBeenCalled();
    });
  });

  it("refuses to change a fixed row", async () => {
    const { actions } = setup();
    useComposerControlStore.getState().applyAssistantState({
      assistant: boundComposerAssistantFixture({
        rows: { ...boundComposerAssistantFixture().rows, search: { ...boundComposerAssistantFixture().rows.search, policy: "fixed" } }
      }),
      controls: {}
    });

    expect(actions.setRow("search", { mode: "off" })).toBe(false);
    expect(actions.setRow("skills", { mode: "off" })).toBe(true);
    expect(useComposerControlStore.getState().skillsMode).toBe("off");
    // The queued chat update is sent now rather than by a timer in a later test.
    await actions.settle("chat-a");
  });

  describe("settling before a run", () => {
    function deferredPatch() {
      let resolve!: (response: Response) => void;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((settle) => { resolve = settle; }));
      return (response: Response) => resolve(response);
    }

    it("waits for an in-flight binding change and its re-read", async () => {
      const { actions, refreshChatAssistant } = setup();
      const respond = deferredPatch();
      const change = actions.chooseAssistant(detail());
      expect(actions.hasPendingUpdate("chat-a")).toBe(true);

      let settled: boolean | null = null;
      const settling = actions.settle("chat-a").then((value) => { settled = value; });
      await Promise.resolve();
      expect(settled).toBeNull();

      respond(Response.json({ chat: {} }));
      await settling;
      expect(settled).toBe(true);
      expect(refreshChatAssistant).toHaveBeenCalledOnce();
      await expect(change).resolves.toBeNull();
      expect(actions.hasPendingUpdate("chat-a")).toBe(false);
    });

    it("reports a failed change as not settled; its own notice stays with the change", async () => {
      useComposerControlStore.setState({ assistant: boundComposerAssistantFixture() });
      const { actions, setNotice } = setup();
      const respond = deferredPatch();
      const removal = actions.removeAssistant();
      const settling = actions.settle("chat-a");

      respond(Response.json({ error: "assistant_not_available" }, { status: 404 }));
      await expect(settling).resolves.toBe(false);
      await removal;
      expect(setNotice).toHaveBeenCalledWith({ kind: "error", text: "This Assistant isn't available to you." });
    });

    it("flushes queued row changes at once instead of after the delay", async () => {
      vi.useFakeTimers();
      const { actions, unsubscribe } = setup();
      useComposerControlStore.getState().applyAssistantState({
        assistant: boundComposerAssistantFixture(),
        controls: { selectedModelId: "assistant-model", selectedProvider: "assistant-provider" }
      });
      useComposerControlStore.getState().setSkillsMode("off");
      expect(actions.hasPendingUpdate("chat-a")).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(actions.settle("chat-a")).resolves.toBe(true);
      expect(patchBodies(fetchMock)).toEqual([{ assistantOverrides: { skills: { mode: "off" } } }]);
      expect(actions.hasPendingUpdate("chat-a")).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(fetchMock).toHaveBeenCalledOnce();
      unsubscribe();
    });

    async function settledAfter(actions: ReturnType<typeof setup>["actions"], release: () => void) {
      let settled: boolean | null = null;
      const settling = actions.settle("chat-a").then((value) => { settled = value; });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const beforeRelease = settled;
      release();
      await settling;
      return { afterRelease: settled, beforeRelease };
    }

    it("keeps Save chat setup pending from its detail read to its final update and re-read", async () => {
      let releaseRead!: () => void;
      const read = new Promise<void>((resolve) => { releaseRead = resolve; });
      const calls: string[] = [];
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/me/assistants/assistant-a") {
          await read;
          return Response.json({ assistant: detail({ id: "assistant-a" }) });
        }
        if (url.endsWith("/adopt-chat-setup")) return Response.json({ assistant: detail({ id: "assistant-a" }) });
        return Response.json({ chat: {} });
      });
      const { actions, refreshChatAssistant } = setup();
      const assistant = boundComposerAssistantFixture();
      assistant.rows.search = { ...assistant.rows.search, origin: "chat" };
      useComposerControlStore.setState({ assistant });

      const saving = actions.saveChatSetupToAssistant();
      expect(actions.hasPendingUpdate("chat-a")).toBe(true);
      const { afterRelease, beforeRelease } = await settledAfter(actions, releaseRead);

      expect(beforeRelease).toBeNull();
      expect(afterRelease).toBe(true);
      expect(calls).toEqual([
        "GET /api/me/assistants/assistant-a",
        "POST /api/me/assistants/assistant-a/adopt-chat-setup",
        "PATCH /api/chats/chat-a"
      ]);
      expect(refreshChatAssistant).toHaveBeenCalledOnce();
      await expect(saving).resolves.toBe(true);
    });

    it("keeps a restore pending from the click to the chat's re-read", async () => {
      const { actions, refreshChatAssistant } = setup();
      let releaseRestore!: () => void;
      const restored = new Promise<void>((resolve) => { releaseRestore = resolve; });
      const steps: string[] = [];
      refreshChatAssistant.mockImplementationOnce(async () => {
        steps.push("re-read");
        return true;
      });
      const chooseRestored = vi.fn();

      const restoring = actions.restoreArchivedAssistant("chat-a", async () => {
        await restored;
        steps.push("restored");
        return { ok: true };
      }, chooseRestored);

      expect(actions.hasPendingUpdate("chat-a")).toBe(true);
      expect(useChatAssistantProjectionStore.getState().pendingChatIds).toEqual({ "chat-a": 1 });
      const { afterRelease, beforeRelease } = await settledAfter(actions, releaseRestore);
      expect(beforeRelease).toBeNull();
      expect(afterRelease).toBe(true);
      await expect(restoring).resolves.toBe(true);
      expect(steps).toEqual(["restored", "re-read"]);
      expect(chooseRestored).not.toHaveBeenCalled();
      expect(actions.hasPendingUpdate("chat-a")).toBe(false);
      expect(useChatAssistantProjectionStore.getState().pendingChatIds).toEqual({});
    });

    it("reports a tracked choice whose detail read failed as not settled", async () => {
      const { actions } = setup();
      let releaseRead!: () => void;
      const read = new Promise<void>((resolve) => { releaseRead = resolve; });
      void actions.trackOpenChat(async () => {
        await read;
        return false;
      }, (chosen) => chosen);

      const { afterRelease } = await settledAfter(actions, releaseRead);
      expect(afterRelease).toBe(false);
    });

    it("has nothing to wait for in a blank chat", async () => {
      const { actions } = setup(null);
      await actions.chooseAssistant(detail());
      expect(actions.hasPendingUpdate("chat-a")).toBe(false);
      await expect(actions.settle("chat-a")).resolves.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
