import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRoute } from "@/components/app-shell/chatRoute";
import { composerSessionKey, selectComposerSession, useComposerSessionStore } from "@/components/app-shell/composerSessionStore";
import { rememberSessionExpiredDraft, storedSessionExpiredDraft } from "@/components/app-shell/shellStorage";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import {
  resetComposerControlStoreForTest,
  resetComposerSessionStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import type { Catalog } from "@/lib/contracts/catalog";
import { useWorkspaceBootstrapController } from "./useWorkspaceBootstrapController";

function catalog(enabled = true): Catalog {
  return { defaults: {
    answerSoundEnabled: enabled, answerSoundId: "bell", controlValues: {},
    hasPersonalModelDefault: false, modelId: "", modelPreferenceSource: "none",
    organizationModelDefault: null, personalModelDefault: null, organizationSearchPlan: { mode: "all_selected", optionIds: [] },
    provider: "", searchPlan: { mode: "all_selected", optionIds: [] }, searchPreferenceSource: "organization",
    showCitations: true, showReasoningBlocks: false
  }, models: [], providers: [], searchStrategies: [] };
}

function renderBootstrap(settled: ChatRoute | null = { chatId: null, projectId: null }) {
  const controls = useComposerControlStore.getState();
  const workspace = useWorkspaceStore.getState();
  const refreshWorkspace = vi.fn(async () => null);
  const resolveInitialRoute = vi.fn(async (catalogLoad: Catalog | null | Promise<Catalog | null>) => {
    await catalogLoad;
    useWorkspaceStore.getState().setWorkspaceReady(settled !== null);
    return settled;
  });
  const activateBlankWorkspace = vi.fn();
  const reapplyActiveChatDefaults = vi.fn();
  const hook = renderHook(({ accountId }) => useWorkspaceBootstrapController({
    accountEmail: "fixture@example.test", accountId, activateBlankWorkspace,
    applyControlDefaults: controls.applyControlDefaults, reapplyActiveChatDefaults, refreshWorkspace, resolveInitialRoute,
    setCatalog: workspace.setCatalog, setCatalogError: workspace.setCatalogError,
    setSelectedModelId: controls.setSelectedModelId, setSelectedProvider: controls.setSelectedProvider,
    setSelectedSearchPlan: controls.setSelectedSearchPlan, setShowCitations: controls.setShowCitations,
    setShowReasoningBlocks: controls.setShowReasoningBlocks, workspaceRefreshPromiseRef: { current: null }
  }), { initialProps: { accountId: "account-a" } });
  return { ...hook, activateBlankWorkspace, refreshWorkspace, resolveInitialRoute };
}

afterEach(() => {
  resetComposerControlStoreForTest();
  resetComposerSessionStoreForTest();
  resetWorkspaceStoreForTest();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("account-owned catalog loading", () => {
  it("treats an unowned catalog as loading until the authenticated saved mute arrives", async () => {
    useWorkspaceStore.getState().setCatalog(catalog(true));
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((settle) => { resolve = settle; })));
    renderBootstrap();
    expect(useWorkspaceStore.getState()).toMatchObject({ catalog: null, catalogAccountId: "account-a" });
    await act(async () => { resolve(Response.json({ catalog: catalog(false) })); });
    await waitFor(() => expect(useWorkspaceStore.getState().catalog?.defaults.answerSoundEnabled).toBe(false));
  });

  it.each(["success", "failure"])("ignores a previous account's delayed catalog %s after switching accounts", async (outcome) => {
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((settle) => { resolve = settle; }))
      .mockResolvedValueOnce(Response.json({ catalog: catalog(false) }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender, resolveInitialRoute } = renderBootstrap();
    rerender({ accountId: "account-b" });
    await waitFor(() => expect(useWorkspaceStore.getState().catalog?.defaults.answerSoundEnabled).toBe(false));
    await act(async () => { resolve(outcome === "success" ? Response.json({ catalog: catalog(true) }) : new Response(null, { status: 500 })); });
    expect(useWorkspaceStore.getState()).toMatchObject({
      catalog: { defaults: { answerSoundEnabled: false } }, catalogAccountId: "account-b", catalogError: null
    });
    // Each account's bootstrap holds the address at once; the newer one supersedes the older.
    expect(resolveInitialRoute).toHaveBeenCalledTimes(2);
    await expect(resolveInitialRoute.mock.calls[1]![0]).resolves.toMatchObject({ defaults: { answerSoundEnabled: false } });
    await expect(resolveInitialRoute.mock.calls[0]![0]).resolves.toBeNull();
  });
});

describe("bootstrapping from the address", () => {
  it("holds the address from the start and resolves it with the loaded catalog, never a remembered chat", async () => {
    const loaded = catalog(false);
    useWorkspaceStore.setState({ activeChatId: "remembered-chat" });
    let respond!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((settle) => { respond = settle; })));
    const { refreshWorkspace, resolveInitialRoute } = renderBootstrap();
    // The resolution starts before the catalog arrives, so nothing rewrites the address meanwhile.
    await waitFor(() => expect(resolveInitialRoute).toHaveBeenCalledOnce());
    await act(async () => { respond(Response.json({ catalog: loaded })); });
    await expect(resolveInitialRoute.mock.calls[0]![0]).resolves.toMatchObject({ defaults: { answerSoundEnabled: false } });
    expect(refreshWorkspace).not.toHaveBeenCalled();
  });

  it("returns a session-expired chat draft to its own session without choosing the chat", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ catalog: catalog() })));
    useWorkspaceStore.setState({ chats: [{ activeLeafMessageId: null, createdAt: "", defaultModelId: "", defaultProvider: "",
      folderId: null, id: "chat-1", messageCount: 0, pinned: false, projectId: null, title: "Chat", updatedAt: "" }] });
    rememberSessionExpiredDraft({ accountEmail: "fixture@example.test", draft: "Unsent", savedAt: Date.now(), sessionKey: composerSessionKey("chat-1") });
    const shown = useComposerSessionStore.getState().activeSessionKey;
    const { activateBlankWorkspace } = renderBootstrap({ chatId: "chat-2", projectId: null });
    await waitFor(() => expect(storedSessionExpiredDraft()).toBeNull());
    expect(selectComposerSession(useComposerSessionStore.getState(), composerSessionKey("chat-1")).draft).toBe("Unsent");
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(shown);
    expect(activateBlankWorkspace).not.toHaveBeenCalled();
  });

  it("reopens a blank folder draft only while the address is the new chat", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ catalog: catalog() })));
    useWorkspaceStore.setState({ folders: [{ id: "folder-1", name: "Folder", parentId: null } as never] });
    const sessionKey = composerSessionKey(null, "folder-1");
    rememberSessionExpiredDraft({ accountEmail: "fixture@example.test", draft: "Folder draft", savedAt: Date.now(), sessionKey });
    const blank = renderBootstrap();
    await waitFor(() => expect(storedSessionExpiredDraft()).toBeNull());
    expect(blank.activateBlankWorkspace).toHaveBeenCalledWith("folder-1");
    expect(selectComposerSession(useComposerSessionStore.getState(), sessionKey).draft).toBe("Folder draft");
    blank.unmount();

    rememberSessionExpiredDraft({ accountEmail: "fixture@example.test", draft: "Folder draft", savedAt: Date.now(), sessionKey });
    useComposerSessionStore.getState().updateSession(sessionKey, { draft: "" });
    const chat = renderBootstrap({ chatId: "chat-2", projectId: null });
    await waitFor(() => expect(storedSessionExpiredDraft()).toBeNull());
    expect(chat.activateBlankWorkspace).not.toHaveBeenCalled();
    expect(selectComposerSession(useComposerSessionStore.getState(), sessionKey).draft).toBe("Folder draft");
  });

  it("retries an unresolved address after a failed load, then refreshes the shown chat", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ catalog: catalog() })));
    const { refreshWorkspace, resolveInitialRoute, result } = renderBootstrap(null);
    await waitFor(() => expect(resolveInitialRoute).toHaveBeenCalledOnce());
    await act(async () => { await result.current.retryWorkspace(); });
    expect(resolveInitialRoute).toHaveBeenCalledTimes(2);
    expect(refreshWorkspace).not.toHaveBeenCalled();
    useWorkspaceStore.setState({ activeChatId: "chat-1", workspaceReady: true });
    await act(async () => { await result.current.retryWorkspace(); });
    expect(refreshWorkspace).toHaveBeenCalledWith("chat-1", expect.anything());
  });
});
