import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { resetComposerControlStoreForTest, resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";
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

function renderBootstrap() {
  const controls = useComposerControlStore.getState();
  const workspace = useWorkspaceStore.getState();
  const refreshWorkspace = vi.fn(async () => null);
  const reapplyActiveChatDefaults = vi.fn();
  const hook = renderHook(({ accountId }) => useWorkspaceBootstrapController({
    accountEmail: "fixture@example.test", accountId, activateBlankWorkspace: vi.fn(),
    applyControlDefaults: controls.applyControlDefaults, reapplyActiveChatDefaults, refreshWorkspace,
    setCatalog: workspace.setCatalog, setCatalogError: workspace.setCatalogError,
    setSelectedModelId: controls.setSelectedModelId, setSelectedProvider: controls.setSelectedProvider,
    setSelectedSearchPlan: controls.setSelectedSearchPlan, setShowCitations: controls.setShowCitations,
    setShowReasoningBlocks: controls.setShowReasoningBlocks, workspaceRefreshPromiseRef: { current: null }
  }), { initialProps: { accountId: "account-a" } });
  return { ...hook, refreshWorkspace };
}

afterEach(() => {
  resetComposerControlStoreForTest();
  resetWorkspaceStoreForTest();
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
    const { rerender, refreshWorkspace } = renderBootstrap();
    rerender({ accountId: "account-b" });
    await waitFor(() => expect(useWorkspaceStore.getState().catalog?.defaults.answerSoundEnabled).toBe(false));
    await act(async () => { resolve(outcome === "success" ? Response.json({ catalog: catalog(true) }) : new Response(null, { status: 500 })); });
    expect(useWorkspaceStore.getState()).toMatchObject({
      catalog: { defaults: { answerSoundEnabled: false } }, catalogAccountId: "account-b", catalogError: null
    });
    expect(refreshWorkspace).toHaveBeenCalledOnce();
  });
});
