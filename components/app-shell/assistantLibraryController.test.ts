import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAssistantLibraryStoreForTest,
  resetComposerControlStoreForTest
} from "@/tests/support/appShellStores";
import {
  assistantControllerInput,
  assistantDetail,
  assistantList,
  assistantSummary,
  deferred,
  installAssistantEditor
} from "@/tests/support/assistantLibraryFixtures";
import {
  initialAssistantLibrarySnapshot,
  useAssistantLibraryStore
} from "./assistantLibraryStore";
import {
  buildAssistantLibraryView,
  createAssistantLibraryActions
} from "./assistantLibraryController";

const mocks = vi.hoisted(() => ({
  fetchAssistantDetail: vi.fn(),
  fetchAssistantList: vi.fn(),
  loadUserMcpServers: vi.fn(),
  updateAssistant: vi.fn()
}));

vi.mock("@/components/assistants/assistantsApi", () => ({
  fetchAssistantDetail: mocks.fetchAssistantDetail,
  fetchAssistantList: mocks.fetchAssistantList,
  updateAssistant: mocks.updateAssistant
}));

vi.mock("@/components/app-shell/mcpSettingsApi", () => ({
  loadUserMcpServers: mocks.loadUserMcpServers
}));

const store = () => useAssistantLibraryStore.getState();

beforeEach(() => {
  vi.resetAllMocks();
  resetAssistantLibraryStoreForTest();
  resetComposerControlStoreForTest();
  mocks.fetchAssistantList.mockResolvedValue({ data: assistantList(), ok: true });
  mocks.loadUserMcpServers.mockResolvedValue([]);
});

describe("assistantLibraryController", () => {
  it("retains MCP readiness metadata from the latest refresh", async () => {
    mocks.loadUserMcpServers.mockResolvedValue([{
      enabled: false,
      id: "mcp-disabled",
      name: "Disabled tools",
      readiness: "disabled"
    }]);
    const actions = createAssistantLibraryActions(assistantControllerInput());
    actions.openLibrary();
    await vi.waitFor(() => expect(store().mcpOptions).toEqual([{
      enabled: false,
      id: "mcp-disabled",
      name: "Disabled tools",
      readiness: "disabled"
    }]));
  });

  it("keeps only the latest MCP refresh and clears stale choices while revalidating", async () => {
    const stale = deferred<Awaited<ReturnType<typeof mocks.loadUserMcpServers>>>();
    const latest = deferred<Awaited<ReturnType<typeof mocks.loadUserMcpServers>>>();
    mocks.loadUserMcpServers
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise);
    const actions = createAssistantLibraryActions(assistantControllerInput());

    actions.openLibrary();
    actions.openLibrary();
    expect(store().mcpOptions).toEqual([]);

    latest.resolve([{ enabled: false, id: "mcp-1", name: "GitHub", readiness: "disabled" }]);
    await vi.waitFor(() => expect(store().mcpOptions)
      .toEqual([expect.objectContaining({ enabled: false, id: "mcp-1" })]));

    stale.resolve([{ enabled: true, id: "mcp-1", name: "GitHub", readiness: "ready" }]);
    await stale.promise;
    expect(store().mcpOptions).toEqual([
      expect.objectContaining({ enabled: false, id: "mcp-1", readiness: "disabled" })
    ]);
  });

  it("ignores an MCP refresh that resolves after its Library session closes", async () => {
    const pending = deferred<Awaited<ReturnType<typeof mocks.loadUserMcpServers>>>();
    mocks.loadUserMcpServers.mockReturnValue(pending.promise);
    const actions = createAssistantLibraryActions(assistantControllerInput());

    actions.openLibrary();
    actions.closeLibrary();
    pending.resolve([{ enabled: true, id: "mcp-1", name: "GitHub", readiness: "ready" }]);
    await pending.promise;

    expect(store()).toMatchObject({ mcpOptions: [], open: false });
  });

  it("does not retain a previously runnable MCP option after refresh failure", async () => {
    useAssistantLibraryStore.setState({
      mcpOptions: [{ enabled: true, id: "mcp-1", name: "GitHub", readiness: "ready" }]
    });
    mocks.loadUserMcpServers.mockRejectedValue(new Error("offline"));
    const actions = createAssistantLibraryActions(assistantControllerInput());

    actions.openLibrary();

    expect(store().mcpOptions).toEqual([]);
    await vi.waitFor(() => expect(mocks.loadUserMcpServers).toHaveBeenCalledOnce());
    expect(store().mcpOptions).toEqual([]);
  });

  it("opens Studio on the gallery with every sheet closed", () => {
    useAssistantLibraryStore.setState({
      detail: { assistantId: "a", detail: null, error: null, requestId: 1, state: "loading" },
      newAssistantOpen: true
    });
    const actions = createAssistantLibraryActions(assistantControllerInput());

    actions.openLibrary();

    expect(store()).toMatchObject({
      deletion: null,
      detail: null,
      editor: null,
      newAssistantOpen: false,
      open: true,
      sharing: null,
      task: "list"
    });
  });

  it("reports an unavailable Start chat failure inside the open Library", async () => {
    mocks.fetchAssistantDetail.mockResolvedValue({
      data: { ...assistantDetail(), availability: { ok: false, reason: "tools_access" } },
      ok: true
    });
    store().patch({ open: true });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);

    await expect(actions.startChat("assistant-1")).resolves.toBe(false);

    expect(store().notice).toEqual({
      kind: "error",
      text: "This assistant needs access you do not currently have."
    });
    expect(input.setShellNotice).not.toHaveBeenCalled();
  });

  it("hands the authorized detail to the composer", async () => {
    const authorized = {
      ...assistantDetail(),
      skills: [{ id: "skill-incident", name: "Incident brief", instructionApproxTokens: 201 }]
    };
    mocks.fetchAssistantDetail.mockResolvedValue({ data: authorized, ok: true });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);

    await expect(actions.useAssistant("assistant-1", { navigate: false })).resolves.toBe(true);

    expect(input.chooseAssistant).toHaveBeenCalledExactlyOnceWith(authorized);
    expect(input.activateBlankWorkspace).not.toHaveBeenCalled();
  });

  it("starts a chat from the gallery, leaves Studio and closes its sheets", async () => {
    mocks.fetchAssistantDetail.mockResolvedValue({ data: assistantDetail(), ok: true });
    useAssistantLibraryStore.setState({
      detail: { assistantId: "assistant-1", detail: assistantDetail(), error: null, requestId: 1, state: "ready" },
      open: true
    });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);

    await expect(buildAssistantLibraryView(input, actions, store())!.gallery.onStartChat("assistant-1"))
      .resolves.toBe(true);

    expect(input.activateBlankWorkspace).toHaveBeenCalledOnce();
    expect(store()).toMatchObject({ detail: null, open: false });
  });

  it("reports a refused choice and keeps the library state", async () => {
    mocks.fetchAssistantDetail.mockResolvedValue({ data: assistantDetail(), ok: true });
    const input = assistantControllerInput();
    vi.mocked(input.chooseAssistant).mockResolvedValue("This Assistant isn't available to you.");
    const actions = createAssistantLibraryActions(input);

    await expect(actions.useAssistant("assistant-1", { navigate: true })).resolves.toBe(false);

    expect(input.activateBlankWorkspace).toHaveBeenCalledOnce();
    expect(input.setShellNotice).toHaveBeenCalledWith({ kind: "error", text: "This Assistant isn't available to you." });
    expect(store().busy).toBe(false);
  });

  it("refuses save and close mutations while another library operation is busy", async () => {
    installAssistantEditor({ busy: true });
    const actions = createAssistantLibraryActions(assistantControllerInput());

    await actions.saveEditor();
    actions.closeEditor();
    actions.closeLibrary();

    expect(mocks.updateAssistant).not.toHaveBeenCalled();
    expect(store().editor).not.toBeNull();
    expect(store().task).toBe("editor");
    expect(store().open).toBe(true);
  });

  it("guards a stale retry callback after a library mutation starts", () => {
    useAssistantLibraryStore.setState({ ...initialAssistantLibrarySnapshot, open: true });
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    const view = buildAssistantLibraryView(input, actions, store());
    store().patch({ busy: true });

    view!.onRetryCatalog();

    expect(input.retryCatalog).not.toHaveBeenCalled();
  });

  it("keeps the newest Assistant list when overlapping refreshes settle out of order", async () => {
    const older = deferred<{ data: ReturnType<typeof assistantList>; ok: true }>();
    const newer = deferred<{ data: ReturnType<typeof assistantList>; ok: true }>();
    mocks.fetchAssistantList.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const actions = createAssistantLibraryActions(assistantControllerInput());

    const olderRefresh = actions.refreshList();
    const newerRefresh = actions.refreshList();
    newer.resolve({ data: assistantList({ assistants: [assistantSummary({ id: "newer" })] }), ok: true });
    await newerRefresh;
    older.resolve({ data: assistantList({ assistants: [assistantSummary({ id: "older" })] }), ok: true });
    await olderRefresh;

    expect(store().data?.assistants.map((assistant) => assistant.id)).toEqual(["newer"]);
  });

  it("shares the first list load, loads again after a failure and keeps a loaded list", async () => {
    const first = deferred<{ message: string; ok: false } | { data: ReturnType<typeof assistantList>; ok: true }>();
    mocks.fetchAssistantList.mockReturnValueOnce(first.promise);
    const actions = createAssistantLibraryActions(assistantControllerInput());

    actions.ensureList();
    actions.ensureList();
    expect(mocks.fetchAssistantList).toHaveBeenCalledOnce();

    first.resolve({ message: "Assistants didn't load.", ok: false });
    await vi.waitFor(() => expect(store().dataState).toBe("error"));
    actions.ensureList();
    await vi.waitFor(() => expect(store().dataState).toBe("ready"));
    expect(mocks.fetchAssistantList).toHaveBeenCalledTimes(2);

    actions.ensureList();
    expect(mocks.fetchAssistantList).toHaveBeenCalledTimes(2);
  });

  it("reports unsaved editor or Sharing changes and discards both on request", () => {
    installAssistantEditor();
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    const view = () => buildAssistantLibraryView(input, actions, store())!;
    expect(view().dirty).toBe(false);

    view().editor!.onChange({ description: "Changed" });
    expect(view().dirty).toBe(true);
    view().onDiscardDrafts();
    expect(store()).toMatchObject({ editor: null, task: "list" });
    expect(view().dirty).toBe(false);

    const draft = { audience: "owner" as const, featured: false, featuredOrder: 0, groupIds: [] };
    store().patch({
      sharing: {
        assistantId: "assistant-1",
        baseline: JSON.stringify(draft),
        detail: assistantDetail(),
        draft: { ...draft, audience: "everyone" },
        error: null,
        failures: [],
        requestId: 1,
        saving: false,
        state: "ready",
        withdrawing: false
      }
    });
    expect(view().dirty).toBe(true);
    view().onDiscardDrafts();
    expect(store().sharing).toBeNull();
  });

  it("refuses to leave for a chat while a draft is unsaved", async () => {
    installAssistantEditor();
    const input = assistantControllerInput();
    const actions = createAssistantLibraryActions(input);
    buildAssistantLibraryView(input, actions, store())!.editor!.onChange({ name: "Unsaved" });

    await expect(actions.startChat("assistant-1")).resolves.toBe(false);

    expect(mocks.fetchAssistantDetail).not.toHaveBeenCalled();
  });
});
