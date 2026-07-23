import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetComposerControlStoreForTest, useComposerControlStore } from "./composerControlStore";
import { usePromptSettingsActions } from "./promptSettingsActions";
import { resetPromptSettingsStoreForTest, usePromptSettingsStore } from "./promptSettingsStore";
import type { Catalog, Notice, PromptPreset } from "./types";

const promptDefault: PromptPreset = {
  developerPrompt: null,
  id: "prompt-default",
  isDefault: true,
  name: "Helpful Assistant",
  systemPrompt: "Be helpful."
};

const promptCustom: PromptPreset = {
  developerPrompt: "Check assumptions.",
  id: "prompt-custom",
  isDefault: false,
  name: "Research Prompt",
  systemPrompt: "Research carefully."
};

function okJson(body: unknown) {
  return {
    json: async () => body,
    ok: true
  } as Response;
}

function errorJson(error: string, status = 409) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ error })
  } as Response;
}

function createCatalog(): Catalog {
  return {
    defaults: {
      controlValues: {},
      modelId: "gpt-5.5",
      promptPresetId: "prompt-default",
      provider: "openai",
      searchStrategyId: "search-disabled",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
    },
    models: [],
    promptPresets: [promptDefault, promptCustom],
    providers: [],
    searchStrategies: []
  };
}

function renderPromptSettingsActions(
  catalogRef: { current: Catalog | null },
  options: {
    afterPersist?(catalogRef: { current: Catalog | null }): void;
    persistResult?: boolean;
  } = {}
) {
  const notices: Notice[] = [];
  const persistUserDefaults = vi.fn(async (update: Partial<Catalog["defaults"]>) => {
    if ("promptPresetId" in update) {
      catalogRef.current = catalogRef.current
        ? {
            ...catalogRef.current,
            defaults: {
              ...catalogRef.current.defaults,
              promptPresetId: update.promptPresetId ?? null
            },
            promptPresets: catalogRef.current.promptPresets
              .map((prompt) => ({
                ...prompt,
                isDefault: prompt.id === update.promptPresetId
              }))
              .sort(
                (left, right) =>
                  Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name)
              )
          }
        : null;
    }

    options.afterPersist?.(catalogRef);
    return options.persistResult ?? true;
  });
  const setCatalog = (update: (current: Catalog | null) => Catalog | null) => {
    catalogRef.current = update(catalogRef.current);
  };

  const hook = renderHook(() =>
    usePromptSettingsActions({
      catalog: catalogRef.current,
      currentPrompt: promptDefault,
      getCatalog: () => catalogRef.current,
      persistUserDefaults,
      setCatalog,
      setNotice: (notice) => notices.push(notice)
    })
  );

  return {
    ...hook,
    notices,
    persistUserDefaults
  };
}

describe("prompt settings actions", () => {
  afterEach(() => {
    resetComposerControlStoreForTest();
    resetPromptSettingsStoreForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("moves the server-backed default prompt through catalog defaults and badges", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const { notices, persistUserDefaults, result } = renderPromptSettingsActions(catalogRef);

    useComposerControlStore.getState().applyPrompt(promptDefault);

    await act(async () => {
      await result.current.setDefaultPromptPreset("prompt-custom");
    });

    expect(persistUserDefaults).toHaveBeenCalledWith(
      {
        promptPresetId: "prompt-custom"
      },
      {
        noticeScope: "settings"
      }
    );
    expect(catalogRef.current?.defaults.promptPresetId).toBe("prompt-custom");
    expect(catalogRef.current?.promptPresets).toMatchObject([
      {
        id: "prompt-custom",
        isDefault: true
      },
      {
        id: "prompt-default",
        isDefault: false
      }
    ]);
    expect(notices).toContainEqual({
      kind: "success",
      scope: "settings",
      text: "Default prompt: Research Prompt"
    });
    expect(useComposerControlStore.getState()).toMatchObject({
      selectedPromptId: "prompt-default",
      systemPrompt: "Be helpful."
    });
    expect(usePromptSettingsStore.getState().promptSaving).toBe(false);
  });

  it("does not announce an older default after a newer prompt intent wins", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const { notices, result } = renderPromptSettingsActions(catalogRef, {
      afterPersist(currentCatalog) {
        if (!currentCatalog.current) {
          return;
        }

        currentCatalog.current = {
          ...currentCatalog.current,
          defaults: {
            ...currentCatalog.current.defaults,
            promptPresetId: "prompt-default"
          }
        };
      }
    });

    await act(async () => {
      await result.current.setDefaultPromptPreset("prompt-custom");
    });

    expect(catalogRef.current?.defaults.promptPresetId).toBe("prompt-default");
    expect(notices).toEqual([]);
  });

  it("keeps a failed default intent visible for the settings coordinator to retry", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const { notices, persistUserDefaults, result } = renderPromptSettingsActions(catalogRef, {
      persistResult: false
    });
    useComposerControlStore.getState().applyPrompt(promptDefault);

    await act(async () => {
      await result.current.setDefaultPromptPreset("prompt-custom");
    });

    expect(catalogRef.current?.defaults.promptPresetId).toBe("prompt-custom");
    expect(catalogRef.current?.promptPresets).toMatchObject([
      {
        id: "prompt-custom",
        isDefault: true
      },
      {
        id: "prompt-default",
        isDefault: false
      }
    ]);
    expect(useComposerControlStore.getState().selectedPromptId).toBe("prompt-default");
    expect(persistUserDefaults).toHaveBeenCalledWith(
      {
        promptPresetId: "prompt-custom"
      },
      {
        noticeScope: "settings"
      }
    );
    expect(notices).toEqual([]);
    expect(usePromptSettingsStore.getState().promptSaving).toBe(false);
  });

  it("protects the default prompt from deletion before confirmation or fetch", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderPromptSettingsActions(catalogRef);

    await act(async () => {
      await result.current.deleteSettingsPrompt(promptDefault);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(usePromptSettingsStore.getState().deletePromptConfirmation).toBeNull();
    expect(catalogRef.current?.promptPresets.map((prompt) => prompt.id)).toEqual([
      "prompt-default",
      "prompt-custom"
    ]);
  });

  it("uses a prompt for the next run without persisting it as the default", () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const { notices, persistUserDefaults, result } = renderPromptSettingsActions(catalogRef);

    act(() => {
      result.current.usePromptForNextRun("prompt-custom");
    });

    expect(useComposerControlStore.getState()).toMatchObject({
      developerPrompt: "Check assumptions.",
      selectedPromptId: "prompt-custom",
      systemPrompt: "Research carefully."
    });
    expect(persistUserDefaults).not.toHaveBeenCalled();
    expect(notices).toContainEqual({
      kind: "success",
      scope: "settings",
      text: "Prompt selected: Research Prompt"
    });
  });

  it("selects known next-run prompts without persisting and ignores missing prompt ids", () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const { notices, persistUserDefaults, result } = renderPromptSettingsActions(catalogRef);
    useComposerControlStore.getState().applyPrompt(promptDefault);
    let selected: PromptPreset | null = null;
    let missing: PromptPreset | null = promptDefault;

    act(() => {
      selected = result.current.selectPrompt("prompt-custom");
      missing = result.current.selectPrompt("prompt-missing");
    });

    expect(selected).toEqual(promptCustom);
    expect(missing).toBeNull();
    expect(useComposerControlStore.getState()).toMatchObject({
      developerPrompt: "Check assumptions.",
      selectedPromptId: "prompt-custom",
      systemPrompt: "Research carefully."
    });
    expect(persistUserDefaults).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("creates a prompt, inserts the server record, and makes the saved draft pristine", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const createdPrompt: PromptPreset = {
      developerPrompt: "Cite sources.",
      id: "prompt-created",
      isDefault: false,
      name: "Analysis Prompt",
      systemPrompt: "Analyze carefully."
    };
    const fetchMock = vi.fn(async () => okJson({ prompt: createdPrompt }));
    vi.stubGlobal("fetch", fetchMock);
    const { notices, result } = renderPromptSettingsActions(catalogRef);
    usePromptSettingsStore.getState().setSettingsPromptEditor({
      developerPrompt: "Cite sources.",
      id: null,
      name: "  Analysis Prompt  ",
      systemPrompt: "Analyze carefully."
    });

    await act(async () => {
      await result.current.createSettingsPrompt();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/prompts", {
      body: JSON.stringify({
        developerPrompt: "Cite sources.",
        name: "Analysis Prompt",
        systemPrompt: "Analyze carefully."
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });
    expect(catalogRef.current?.promptPresets.map((prompt) => prompt.id)).toEqual([
      "prompt-default",
      "prompt-created",
      "prompt-custom"
    ]);
    expect(usePromptSettingsStore.getState()).toMatchObject({
      promptSaving: false,
      settingsPromptEditor: {
        developerPrompt: "Cite sources.",
        id: "prompt-created",
        name: "Analysis Prompt",
        systemPrompt: "Analyze carefully."
      }
    });
    expect(notices).toEqual([
      {
        kind: "success",
        scope: "settings",
        text: "Prompt saved: Analysis Prompt"
      }
    ]);
  });

  it("preserves a new dirty draft and catalog when prompt creation fails", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const originalCatalog = structuredClone(catalogRef.current);
    const editor = {
      developerPrompt: "Cite sources.",
      id: null,
      name: "Analysis Prompt",
      systemPrompt: "Analyze carefully."
    };
    const fetchMock = vi.fn(async () => errorJson("prompt_create_conflict"));
    vi.stubGlobal("fetch", fetchMock);
    const { notices, result } = renderPromptSettingsActions(catalogRef);
    usePromptSettingsStore.getState().setSettingsPromptEditor(editor);

    await act(async () => {
      await result.current.createSettingsPrompt();
    });

    expect(catalogRef.current).toEqual(originalCatalog);
    expect(usePromptSettingsStore.getState()).toMatchObject({
      promptSaving: false,
      settingsPromptEditor: editor
    });
    expect(notices).toEqual([
      {
        kind: "error",
        scope: "settings",
        text: "prompt create conflict (prompt_create_conflict)"
      }
    ]);
  });

  it("updates the catalog, editor, and currently selected composer prompt from the server record", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const updatedPrompt: PromptPreset = {
      ...promptCustom,
      developerPrompt: "Verify assumptions.",
      name: "Research Prompt v2",
      systemPrompt: "Research and verify carefully."
    };
    const fetchMock = vi.fn(async () => okJson({ prompt: updatedPrompt }));
    vi.stubGlobal("fetch", fetchMock);
    const { notices, result } = renderPromptSettingsActions(catalogRef);
    useComposerControlStore.getState().applyPrompt(promptCustom);
    usePromptSettingsStore.getState().setSettingsPromptEditor({
      ...updatedPrompt,
      developerPrompt: updatedPrompt.developerPrompt ?? ""
    });

    await act(async () => {
      await result.current.updateSettingsPrompt();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/prompts/prompt-custom", {
      body: JSON.stringify({
        developerPrompt: "Verify assumptions.",
        name: "Research Prompt v2",
        systemPrompt: "Research and verify carefully."
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "PATCH"
    });
    expect(catalogRef.current?.promptPresets.find((prompt) => prompt.id === "prompt-custom")).toEqual(updatedPrompt);
    expect(usePromptSettingsStore.getState().settingsPromptEditor).toEqual({
      developerPrompt: "Verify assumptions.",
      id: "prompt-custom",
      name: "Research Prompt v2",
      systemPrompt: "Research and verify carefully."
    });
    expect(useComposerControlStore.getState()).toMatchObject({
      developerPrompt: "Verify assumptions.",
      selectedPromptId: "prompt-custom",
      systemPrompt: "Research and verify carefully."
    });
    expect(notices).toContainEqual({
      kind: "success",
      scope: "settings",
      text: "Prompt updated: Research Prompt v2"
    });
  });

  it("keeps the dirty editor, catalog, and current prompt unchanged when update fails", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const originalCatalog = structuredClone(catalogRef.current);
    const editor = {
      developerPrompt: "Verify assumptions.",
      id: "prompt-custom",
      name: "Research Prompt v2",
      systemPrompt: "Research and verify carefully."
    };
    const fetchMock = vi.fn(async () => errorJson("prompt_update_conflict"));
    vi.stubGlobal("fetch", fetchMock);
    const { notices, result } = renderPromptSettingsActions(catalogRef);
    useComposerControlStore.getState().applyPrompt(promptCustom);
    usePromptSettingsStore.getState().setSettingsPromptEditor(editor);

    await act(async () => {
      await result.current.updateSettingsPrompt();
    });

    expect(catalogRef.current).toEqual(originalCatalog);
    expect(usePromptSettingsStore.getState()).toMatchObject({
      promptSaving: false,
      settingsPromptEditor: editor
    });
    expect(useComposerControlStore.getState()).toMatchObject({
      developerPrompt: "Check assumptions.",
      selectedPromptId: "prompt-custom",
      systemPrompt: "Research carefully."
    });
    expect(notices).toEqual([
      {
        kind: "error",
        scope: "settings",
        text: "prompt update conflict (prompt_update_conflict)"
      }
    ]);
  });

  it("duplicates a server prompt without changing the current or default prompt", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const duplicatePrompt: PromptPreset = {
      ...promptCustom,
      id: "prompt-copy",
      name: "Research Prompt copy"
    };
    const fetchMock = vi.fn(async () => okJson({ prompt: duplicatePrompt }));
    vi.stubGlobal("fetch", fetchMock);
    const { notices, persistUserDefaults, result } = renderPromptSettingsActions(catalogRef);
    useComposerControlStore.getState().applyPrompt(promptDefault);

    await act(async () => {
      await result.current.duplicateSettingsPrompt(promptCustom);
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/prompts", {
      body: JSON.stringify({
        developerPrompt: "Check assumptions.",
        name: "Research Prompt copy",
        systemPrompt: "Research carefully."
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });
    expect(catalogRef.current?.defaults.promptPresetId).toBe("prompt-default");
    expect(catalogRef.current?.promptPresets.some((prompt) => prompt.id === "prompt-copy")).toBe(true);
    expect(usePromptSettingsStore.getState().settingsPromptEditor.id).toBe("prompt-copy");
    expect(useComposerControlStore.getState().selectedPromptId).toBe("prompt-default");
    expect(persistUserDefaults).not.toHaveBeenCalled();
    expect(notices).toContainEqual({
      kind: "success",
      scope: "settings",
      text: "Prompt duplicated: Research Prompt copy"
    });
  });

  it("preserves state when prompt duplication fails", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const originalCatalog = structuredClone(catalogRef.current);
    const fetchMock = vi.fn(async () => errorJson("prompt_duplicate_conflict"));
    vi.stubGlobal("fetch", fetchMock);
    const { notices, result } = renderPromptSettingsActions(catalogRef);
    usePromptSettingsStore.getState().setSettingsPromptFromPreset(promptDefault);

    await act(async () => {
      await result.current.duplicateSettingsPrompt(promptCustom);
    });

    expect(catalogRef.current).toEqual(originalCatalog);
    expect(usePromptSettingsStore.getState()).toMatchObject({
      promptSaving: false,
      settingsPromptEditor: {
        id: "prompt-default"
      }
    });
    expect(notices).toEqual([
      {
        kind: "error",
        scope: "settings",
        text: "prompt duplicate conflict (prompt_duplicate_conflict)"
      }
    ]);
  });

  it("deletes a confirmed non-default prompt and falls current/editor state back to the default", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const fetchMock = vi.fn(async () => okJson({ deleted: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { notices, result } = renderPromptSettingsActions(catalogRef);
    useComposerControlStore.getState().applyPrompt(promptCustom);
    usePromptSettingsStore.getState().setSettingsPromptFromPreset(promptCustom);
    let deletion!: Promise<void>;

    act(() => {
      deletion = result.current.deleteSettingsPrompt(promptCustom);
    });
    expect(usePromptSettingsStore.getState().deletePromptConfirmation).toEqual(promptCustom);
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      result.current.confirmDeletePrompt();
    });
    await act(async () => {
      await deletion;
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/prompts/prompt-custom", { method: "DELETE" });
    expect(catalogRef.current?.promptPresets).toEqual([promptDefault]);
    expect(catalogRef.current?.defaults.promptPresetId).toBe("prompt-default");
    expect(useComposerControlStore.getState()).toMatchObject({
      developerPrompt: "",
      selectedPromptId: "prompt-default",
      systemPrompt: "Be helpful."
    });
    expect(usePromptSettingsStore.getState()).toMatchObject({
      deletePromptConfirmation: null,
      promptSaving: false,
      settingsPromptEditor: {
        id: "prompt-default"
      }
    });
    expect(notices).toContainEqual({
      kind: "success",
      scope: "settings",
      text: "Prompt deleted"
    });
  });

  it("preserves the prompt and dirty editor when confirmed deletion fails", async () => {
    const catalogRef = { current: createCatalog() as Catalog | null };
    const originalCatalog = structuredClone(catalogRef.current);
    const dirtyEditor = {
      developerPrompt: "Verify assumptions.",
      id: "prompt-custom",
      name: "Research Prompt edited",
      systemPrompt: "Research carefully."
    };
    const fetchMock = vi.fn(async () => errorJson("prompt_delete_conflict"));
    vi.stubGlobal("fetch", fetchMock);
    const { notices, result } = renderPromptSettingsActions(catalogRef);
    useComposerControlStore.getState().applyPrompt(promptCustom);
    usePromptSettingsStore.getState().setSettingsPromptEditor(dirtyEditor);
    let deletion!: Promise<void>;

    act(() => {
      deletion = result.current.deleteSettingsPrompt(promptCustom);
    });
    act(() => {
      result.current.confirmDeletePrompt();
    });
    await act(async () => {
      await deletion;
    });

    expect(catalogRef.current).toEqual(originalCatalog);
    expect(useComposerControlStore.getState().selectedPromptId).toBe("prompt-custom");
    expect(usePromptSettingsStore.getState()).toMatchObject({
      deletePromptConfirmation: null,
      promptSaving: false,
      settingsPromptEditor: dirtyEditor
    });
    expect(notices).toEqual([
      {
        kind: "error",
        scope: "settings",
        text: "prompt delete conflict (prompt_delete_conflict)"
      }
    ]);
  });
});
