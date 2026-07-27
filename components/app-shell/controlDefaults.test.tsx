import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef, useState } from "react";
import { ShellLeftPane, type ShellLeftPaneProps } from "./ShellLeftPane";
import { useRunControlsActions } from "./runControlsActions";
import type { SettingsMutationCoordinator } from "./settingsMutationCoordinator";
import { useEventCallback } from "./useEventCallback";
import { resetComposerControlStoreForTest, useComposerControlStore } from "./composerControlStore";
import type { Catalog, CatalogModel, ChatSummary } from "./types";
import { resolveModelSearchStrategy, type SavedControlDraft } from "./powerAppShellData";

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
  defaultParams: {
    background: true,
    maxOutputTokens: 128000,
    reasoning: {
      effort: "medium"
    },
    temperature: 1
  },
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
  searchStrategyIds: ["search-disabled", "openai-native-web-search"]
};

const fakeModel: CatalogModel = {
  ...model,
  capabilities: {
    ...model.capabilities,
    nativeWebSearch: false,
    openRouterPerplexitySearch: false
  },
  defaultParams: {
    maxOutputTokens: 8192,
    responseStyle: "inspectable",
    stream: true,
    temperature: 1
  },
  displayName: "Fake QSA",
  modelId: "fake-qsa",
  parameterControls: {
    ...model.parameterControls,
    maxOutputTokens: {
      defaultValue: 8192,
      maxValue: 8192
    },
    stream: {
      defaultValue: true,
      supported: true
    }
  },
  provider: "fake",
  searchStrategyIds: ["search-disabled"]
};

const gpt56Model: CatalogModel = {
  ...model,
  defaultParams: {
    ...model.defaultParams,
    reasoning: {
      effort: "medium",
      mode: "standard"
    }
  },
  displayName: "GPT-5.6 Sol",
  modelId: "gpt-5.6-sol",
  parameterControls: {
    ...model.parameterControls,
    reasoningEffort: {
      defaultValue: "medium",
      options: ["none", "low", "medium", "high", "xhigh", "max"],
      supported: true
    },
    reasoningMode: {
      defaultValue: "standard",
      options: ["standard", "pro"],
      supported: true
    }
  }
};

const gpt56TerraModel: CatalogModel = {
  ...gpt56Model,
  displayName: "GPT-5.6 Terra",
  modelId: "gpt-5.6-terra"
};

const gpt56LunaModel: CatalogModel = {
  ...gpt56Model,
  displayName: "GPT-5.6 Luna",
  modelId: "gpt-5.6-luna"
};

const chat: ChatSummary = {
  activeLeafMessageId: null,
  createdAt: "2026-06-10T00:00:00.000Z",
  defaultModelId: "gpt-5.5",
  defaultPromptPresetId: null,
  defaultProvider: "openai",
  folderId: null,
  id: "chat-1",
  messageCount: 0,
  title: "Control chat",
  updatedAt: "2026-06-10T00:00:00.000Z"
};

function catalog(
  controlValues: Record<string, unknown> = {},
  models: CatalogModel[] = [model, fakeModel]
): Catalog {
  const profileInput = [
    { description: "Simple, well-defined questions", id: "fast" as const, label: "Fast", model: gpt56LunaModel, reasoningEffort: "medium", reasoningMode: "standard" },
    { description: "Most everyday questions", id: "balanced" as const, label: "Balanced", model: gpt56TerraModel, reasoningEffort: "medium", reasoningMode: "standard" },
    { description: "Difficult or open-ended questions", id: "deep" as const, label: "Deep", model: gpt56Model, reasoningEffort: "max", reasoningMode: "pro" }
  ];
  return {
    defaults: {
      controlValues,
      modelId: model.modelId,
      promptPresetId: null,
      provider: model.provider,
      searchStrategyId: "openai-native-web-search",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
    },
    models,
    promptPresets: [],
    providers: [
      {
        id: "fake",
        models: ["fake-qsa"],
        name: "Fake"
      },
      {
        id: "openai",
        models: models.filter((candidate) => candidate.provider === "openai").map((candidate) => candidate.modelId),
        name: "OpenAI"
      }
    ],
    runProfiles: profileInput.map((profile) => {
      const available = models.some(
        (candidate) => candidate.provider === profile.model.provider && candidate.modelId === profile.model.modelId
      );
      if (!available) {
        return {
          available: false as const,
          description: profile.description,
          id: profile.id,
          label: profile.label,
          unavailableReason: "model_unavailable" as const
        };
      }
      return {
        available: true as const,
        configurationLabel: `${profile.model.displayName} · ${profile.reasoningMode === "pro" ? "Pro" : "Standard"} · ${profile.reasoningEffort === "max" ? "Maximum" : "Medium"}`,
        description: profile.description,
        id: profile.id,
        label: profile.label,
        modelId: profile.model.modelId,
        provider: profile.model.provider,
        reasoningEffort: profile.reasoningEffort,
        reasoningMode: profile.reasoningMode
      };
    }),
    searchStrategies: [
      {
        displayName: "No Search",
        kind: "none",
        strategyId: "search-disabled"
      },
      {
        displayName: "OpenAI native web search",
        kind: "openai_native_web_search",
        strategyId: "openai-native-web-search"
      }
    ]
  };
}

function jsonBodies(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

function requestInits(fetchMock: ReturnType<typeof vi.fn>): RequestInit[] {
  return fetchMock.mock.calls.map(([, init]) => init as RequestInit);
}

function settingsFetchMock() {
  const saved = {
    defaultControlValues: {} as Record<string, unknown>,
    defaultModelId: model.modelId,
    defaultPromptPresetId: null as string | null,
    defaultProvider: model.provider,
    defaultSearchStrategyId: "openai-native-web-search",
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true,
  };

  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (typeof body.defaultModelId === "string") {
      saved.defaultModelId = body.defaultModelId;
    }
    if (body.defaultPromptPresetId === null || typeof body.defaultPromptPresetId === "string") {
      saved.defaultPromptPresetId = body.defaultPromptPresetId;
    }
    if (typeof body.defaultProvider === "string") {
      saved.defaultProvider = body.defaultProvider;
    }
    if (typeof body.defaultSearchStrategyId === "string") {
      saved.defaultSearchStrategyId = body.defaultSearchStrategyId;
    }
    if (typeof body.showCitations === "boolean") {
      saved.showCitations = body.showCitations;
    }
    if (typeof body.showReasoningBlocks === "boolean") {
      saved.showReasoningBlocks = body.showReasoningBlocks;
    }
    if (body.defaultControlValues && typeof body.defaultControlValues === "object") {
      saved.defaultControlValues = {
        ...saved.defaultControlValues,
        ...(body.defaultControlValues as Record<string, unknown>)
      };
    }

    return Response.json({ settings: saved });
  });
}

function createRunControlsHarness(
  currentModel: CatalogModel = model,
  initialCatalog: Catalog = catalog()
) {
  resetComposerControlStoreForTest();
  let currentCatalog = initialCatalog;
  const pendingControlDefaultsRef = { current: null as { draft: SavedControlDraft; model: CatalogModel } | null };
  const pendingControlDefaultsTimerRef = { current: null as number | null };
  const settingsMutationCoordinatorRef = { current: null as SettingsMutationCoordinator | null };

  function useRunControlsActionsForTest() {
    return useRunControlsActions({
      catalog: currentCatalog,
      currentModel,
      pendingControlDefaultsRef,
      pendingControlDefaultsTimerRef,
      settingsMutationCoordinatorRef,
      setCatalog(update) {
        currentCatalog = update(currentCatalog) ?? currentCatalog;
      },
      setNotice: vi.fn(),
      setSettingsNotice: vi.fn()
    });
  }

  return {
    actions: useRunControlsActionsForTest,
    catalog: () => currentCatalog,
    searchStrategy: () => useComposerControlStore.getState().selectedSearchStrategy
  };
}

function ControlFlushHarness() {
  const [currentCatalog, setCurrentCatalog] = useState(() => catalog());
  const pendingControlDefaultsRef = useRef<{ draft: SavedControlDraft; model: CatalogModel } | null>(null);
  const pendingControlDefaultsTimerRef = useRef<number | null>(null);
  const settingsMutationCoordinatorRef = useRef<SettingsMutationCoordinator | null>(null);
  const actions = useRunControlsActions({
    catalog: currentCatalog,
    currentModel: model,
    pendingControlDefaultsRef,
    pendingControlDefaultsTimerRef,
    settingsMutationCoordinatorRef,
    setCatalog(update) {
      setCurrentCatalog((current) => update(current) ?? current);
    },
    setNotice: vi.fn(),
    setSettingsNotice: vi.fn()
  });
  const flushPendingModelControlDefaults = useEventCallback(actions.flushPendingModelControlDefaults);

  useEffect(
    () => () => {
      flushPendingModelControlDefaults();
    },
    [flushPendingModelControlDefaults]
  );

  return (
    <button type="button" onClick={() => actions.changeTemperature("0.4")}>
      Change temperature
    </button>
  );
}

function shellLeftPaneProps(
  activateChat: ShellLeftPaneProps["pane"]["actions"]["activateChat"]
): ShellLeftPaneProps {
  return {
    activeChatId: null,
    availableChatModelKeys: new Set<string>(),
    chatModelLabels: new Map(),
    pane: {
      actions: {
        activateChat,
        cancelChatEdit: vi.fn(),
        cancelFolderEdit: vi.fn(),
        cancelSubfolder: vi.fn(),
        changeChatQuery: vi.fn(),
        changeEditingChatTitle: vi.fn(),
        changeEditingFolderName: vi.fn(),
        changeNewFolderName: vi.fn(),
        changeSubfolderName: vi.fn(),
        closeMenus: vi.fn(),
        createChat: vi.fn(),
        createFolder: vi.fn(),
        deleteChat: vi.fn(),
        deleteFolder: vi.fn(),
        exportChat: vi.fn(),
        moveChat: vi.fn(),
        moveFolder: vi.fn(),
        openProjectSettings: vi.fn(),
        retry: vi.fn(),
        saveChatTitle: vi.fn(),
        saveFolder: vi.fn(),
        shareChat: vi.fn(),
        startChatEdit: vi.fn(),
        startFolderEdit: vi.fn(),
        startSubfolder: vi.fn(),
        toggleChatActions: vi.fn(),
        toggleChatFavorite: vi.fn(),
        toggleFolderCollapsed: vi.fn(),
        toggleFolderMenu: vi.fn()
      },
      state: {
        activeRunChatIds: new Set<string>(),
        chatActionId: null,
        chatContentMatchIds: new Set(),
        chatContentSearchError: null,
        chatContentSearchLoading: false,
        chatGroups: [
          {
            chats: [chat],
            depth: 0,
            folder: null,
            name: "Chats"
          }
        ],
        chatQuery: "",
        collapsedFolderIds: new Set(),
        creatingChat: false,
        creatingFolder: false,
        editingChatId: null,
        editingChatTitle: "",
        editingFolderId: null,
        editingFolderName: "",
        folderActionId: null,
        folderMenuId: null,
        folders: [],
        newFolderName: "",
        subfolderName: "",
        subfolderParentId: null,
        workspaceError: null,
        workspaceLoading: false,
        workspaceReady: true
      }
    },
    sharing: false,
  };
}

afterEach(() => {
  resetComposerControlStoreForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("control default freshness", () => {
  it("keeps memoized left-pane chat activation wired to the latest handler", () => {
    const firstActivate = vi.fn();
    const secondActivate = vi.fn();
    const props = shellLeftPaneProps(firstActivate);
    const { rerender } = render(<ShellLeftPane {...props} />);

    rerender(
      <ShellLeftPane
        {...props}
        pane={{
          ...props.pane,
          actions: {
            ...props.pane.actions,
            activateChat: secondActivate
          }
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Control chat" }));

    expect(firstActivate).not.toHaveBeenCalled();
    expect(secondActivate).toHaveBeenCalledWith(chat);
  });

  it("merges pending numeric drafts into immediate background and reasoning saves", async () => {
    vi.useFakeTimers();
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const harness = createRunControlsHarness();
    let actions = harness.actions();

    actions.changeTemperature("0.2");
    actions = harness.actions();
    actions.changeBackgroundMode(false);
    vi.advanceTimersByTime(600);

    actions = harness.actions();
    actions.changeMaxOutputTokens("96");
    actions = harness.actions();
    actions.changeReasoningEffort("high");
    vi.advanceTimersByTime(600);

    const draft = harness.catalog().defaults.controlValues["openai:gpt-5.5"];
    expect(draft).toMatchObject({
      backgroundMode: false,
      maxOutputTokens: "96",
      reasoningEffort: "high",
      searchStrategyId: "openai-native-web-search",
      streamMode: false,
      temperature: "0.2"
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(jsonBodies(fetchMock).at(-1)?.defaultControlValues).toEqual({
      "openai:gpt-5.5": {
        backgroundMode: false,
        maxOutputTokens: "96",
        reasoningEffort: "high",
        searchStrategyId: "openai-native-web-search",
        streamMode: false,
        temperature: "0.2"
      }
    });
  });

  it("persists stream mode as an immediate per-model draft", () => {
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const harness = createRunControlsHarness();
    const actions = harness.actions();

    actions.changeStreamMode(true);

    expect(harness.catalog().defaults.controlValues["openai:gpt-5.5"]).toMatchObject({
      streamMode: true
    });
    expect(jsonBodies(fetchMock)[0]?.defaultControlValues).toEqual({
      "openai:gpt-5.5": {
        backgroundMode: true,
        maxOutputTokens: "128000",
        reasoningEffort: "medium",
        searchStrategyId: "openai-native-web-search",
        streamMode: true,
        temperature: "1"
      }
    });
  });

  it("persists GPT-5.6 reasoning mode per model and builds exact pro/max params", () => {
    vi.stubGlobal("fetch", settingsFetchMock());
    const harness = createRunControlsHarness(
      gpt56Model,
      catalog({}, [model, fakeModel, gpt56Model])
    );
    useComposerControlStore.getState().setSelectedProvider("openai");
    useComposerControlStore.getState().setSelectedModelId("gpt-5.6-sol");
    harness.actions().applyModelControlDefaults(gpt56Model);

    harness.actions().changeReasoningEffort("max");
    harness.actions().changeReasoningMode("pro");

    expect(harness.actions().buildParams()).toMatchObject({
      reasoning: {
        effort: "max",
        mode: "pro"
      }
    });
    expect(harness.catalog().defaults.controlValues["openai:gpt-5.6-sol"]).toMatchObject({
      reasoningEffort: "max",
      reasoningMode: "pro"
    });
  });

  it("builds params from provider family when the catalog uses opaque connection ids", () => {
    const openRouterModel: CatalogModel = {
      ...model,
      defaultParams: {
        maxTokens: 4096,
        reasoning: { effort: "medium" },
        stream: true,
        temperature: 1
      },
      displayName: "Opaque OpenRouter model",
      modelId: "deployment-router",
      parameterControls: {
        ...model.parameterControls,
        background: { defaultValue: false, supported: false },
        maxOutputTokens: { defaultValue: 4096, maxValue: 4096 },
        stream: { defaultValue: true, supported: true }
      },
      provider: "connection-router-uuid",
      providerFamily: "openrouter"
    };
    const harness = createRunControlsHarness(
      openRouterModel,
      catalog({}, [model, openRouterModel])
    );
    useComposerControlStore.getState().setSelectedProvider(openRouterModel.provider);
    useComposerControlStore.getState().setSelectedModelId(openRouterModel.modelId);
    harness.actions().applyModelControlDefaults(openRouterModel);

    expect(harness.actions().buildParams()).toMatchObject({
      maxTokens: 4096,
      reasoning: { effort: "medium", enabled: true },
      stream: true,
      temperature: 1
    });
    expect(harness.actions().buildParams()).not.toHaveProperty("maxOutputTokens");

    const compatibleModel: CatalogModel = {
      ...openRouterModel,
      defaultParams: {
        maxOutputTokens: 2048,
        temperature: 0.5
      },
      modelId: "deployment-compatible",
      parameterControls: {
        ...openRouterModel.parameterControls,
        maxOutputTokens: { defaultValue: 2048, maxValue: 2048 },
        reasoningEffort: {
          defaultValue: "none",
          options: ["none"],
          supported: false
        },
        stream: { defaultValue: false, supported: false },
        temperature: { defaultValue: 0.5, maxValue: 2, minValue: 0, supported: true }
      },
      provider: "connection-compatible-uuid",
      providerFamily: "openai_compatible"
    };
    const compatibleHarness = createRunControlsHarness(
      compatibleModel,
      catalog({}, [model, compatibleModel])
    );
    useComposerControlStore.getState().setSelectedProvider(compatibleModel.provider);
    useComposerControlStore.getState().setSelectedModelId(compatibleModel.modelId);
    compatibleHarness.actions().applyModelControlDefaults(compatibleModel);

    expect(compatibleHarness.actions().buildParams()).toMatchObject({
      maxOutputTokens: 2048,
      reasoning: { effort: "none" },
      temperature: 0.5
    });
    expect(compatibleHarness.actions().buildParams()).not.toHaveProperty("background");
    expect(compatibleHarness.actions().buildParams()).not.toHaveProperty("stream");
  });

  it("translates Gemini and Claude controls into one valid provider dialect", () => {
    vi.stubGlobal("fetch", settingsFetchMock());
    const geminiModel: CatalogModel = {
      ...model,
      defaultParams: {
        maxOutputTokens: 65536,
        reasoning: { effort: "medium" },
        stream: true
      },
      displayName: "Gemini 3.6 Flash",
      modelId: "gemini-3.6-flash",
      parameterControls: {
        ...model.parameterControls,
        background: { defaultValue: false, supported: false },
        maxOutputTokens: { defaultValue: 65536, maxValue: 65536 },
        reasoningEffort: {
          defaultValue: "medium",
          options: ["minimal", "low", "medium", "high"],
          supported: true
        },
        stream: { defaultValue: true, supported: true },
        temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: false }
      },
      provider: "gemini-connection",
      providerFamily: "gemini",
      searchStrategyIds: ["search-disabled"]
    };
    const geminiHarness = createRunControlsHarness(
      geminiModel,
      catalog({}, [model, geminiModel])
    );
    useComposerControlStore.getState().setSelectedProvider(geminiModel.provider);
    useComposerControlStore.getState().setSelectedModelId(geminiModel.modelId);
    geminiHarness.actions().applyModelControlDefaults(geminiModel);
    geminiHarness.actions().changeMaxOutputTokens("2048");

    expect(geminiHarness.actions().buildParams()).toEqual({
      maxOutputTokens: 2048,
      reasoning: { effort: "medium" },
      stream: true
    });

    const claudeModel: CatalogModel = {
      ...geminiModel,
      defaultParams: {
        maxTokens: 128000,
        reasoning: { effort: "high" }
      },
      displayName: "Claude Opus 5",
      modelId: "claude-opus-5",
      parameterControls: {
        ...geminiModel.parameterControls,
        maxOutputTokens: { defaultValue: 128000, maxValue: 128000 },
        reasoningEffort: {
          defaultValue: "high",
          options: ["low", "medium", "high", "xhigh", "max"],
          supported: true
        },
        stream: { defaultValue: true, supported: false }
      },
      provider: "anthropic-connection",
      providerFamily: "anthropic"
    };
    const claudeHarness = createRunControlsHarness(
      claudeModel,
      catalog({}, [model, claudeModel])
    );
    useComposerControlStore.getState().setSelectedProvider(claudeModel.provider);
    useComposerControlStore.getState().setSelectedModelId(claudeModel.modelId);
    claudeHarness.actions().applyModelControlDefaults(claudeModel);

    expect(claudeHarness.actions().buildParams()).toMatchObject({
      maxTokens: 128000,
      outputConfig: { effort: "high" },
      thinking: { enabled: true, type: "adaptive" }
    });
    expect(claudeHarness.actions().buildParams()).not.toHaveProperty("reasoning");
  });

  it("applies a Deep profile atomically and persists one complete target-model draft", async () => {
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const initialCatalog = catalog(
      {
        "openai:gpt-5.6-sol": {
          backgroundMode: false,
          maxOutputTokens: "64000",
          reasoningEffort: "low",
          reasoningMode: "standard",
          searchStrategyId: "search-disabled",
          streamMode: true,
          temperature: "0.4"
        }
      },
      [model, fakeModel, gpt56Model, gpt56TerraModel, gpt56LunaModel]
    );
    const harness = createRunControlsHarness(model, initialCatalog);

    expect(harness.actions().selectRunProfile("deep")).toBe(true);

    expect(useComposerControlStore.getState()).toMatchObject({
      backgroundMode: false,
      maxOutputTokens: "64000",
      reasoningEffort: "max",
      reasoningMode: "pro",
      selectedModelId: "gpt-5.6-sol",
      selectedProvider: "openai",
      selectedSearchStrategy: "search-disabled",
      streamMode: true,
      temperature: "0.4"
    });
    expect(harness.actions().buildParams()).toMatchObject({
      reasoning: {
        effort: "max",
        mode: "pro"
      }
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(jsonBodies(fetchMock)[0]).toMatchObject({
      defaultControlValues: {
        "openai:gpt-5.6-sol": {
          backgroundMode: false,
          maxOutputTokens: "64000",
          reasoningEffort: "max",
          reasoningMode: "pro",
          searchStrategyId: "search-disabled",
          streamMode: true,
          temperature: "0.4"
        }
      },
      defaultModelId: "gpt-5.6-sol",
      defaultProvider: "openai",
      defaultSearchStrategyId: "search-disabled"
    });
    expect(Object.keys(jsonBodies(fetchMock)[0]?.defaultControlValues as Record<string, unknown>)).toEqual([
      "openai:gpt-5.6-sol"
    ]);
  });

  it("maps Fast to Luna Standard/Medium and ignores unavailable profiles", async () => {
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const harness = createRunControlsHarness(
      model,
      catalog({}, [model, fakeModel, gpt56Model, gpt56TerraModel, gpt56LunaModel])
    );

    expect(harness.actions().selectRunProfile("fast")).toBe(true);
    expect(useComposerControlStore.getState()).toMatchObject({
      reasoningEffort: "medium",
      reasoningMode: "standard",
      selectedModelId: "gpt-5.6-luna",
      selectedProvider: "openai"
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const unavailableHarness = createRunControlsHarness(model, catalog({}, [model, fakeModel]));
    fetchMock.mockClear();
    expect(unavailableHarness.actions().selectRunProfile("deep")).toBe(false);
    expect(useComposerControlStore.getState()).toMatchObject({
      selectedModelId: "gpt-5.5",
      selectedProvider: "openai"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds params from the currently selected model even before the hook prop catches up", () => {
    const harness = createRunControlsHarness();
    useComposerControlStore.getState().setSelectedProvider("fake");
    useComposerControlStore.getState().setSelectedModelId("fake-qsa");
    useComposerControlStore.getState().setMaxOutputTokens("128000");

    expect(harness.actions().buildParams()).toMatchObject({
      maxOutputTokens: 8192,
      responseStyle: "inspectable",
      stream: false
    });
  });

  it("flushes a pending control draft when the owner unmounts", () => {
    vi.useFakeTimers();
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ControlFlushHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Change temperature" }));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      view.unmount();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestInits(fetchMock)[0]).toMatchObject({
      keepalive: true,
      method: "PATCH"
    });
    expect(jsonBodies(fetchMock)[0]?.defaultControlValues).toEqual({
      "openai:gpt-5.5": {
        backgroundMode: true,
        maxOutputTokens: "128000",
        reasoningEffort: "medium",
        searchStrategyId: "openai-native-web-search",
        streamMode: false,
        temperature: "0.4"
      }
    });
  });

  it("persists search strategy as a per-model draft and keeps pending numeric edits", () => {
    vi.useFakeTimers();
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const harness = createRunControlsHarness();
    let actions = harness.actions();

    actions.changeTemperature("0.25");
    actions = harness.actions();
    actions.selectSearchStrategy("openai-native-web-search");
    vi.advanceTimersByTime(600);

    expect(harness.searchStrategy()).toBe("openai-native-web-search");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jsonBodies(fetchMock)[0]).toMatchObject({
      defaultControlValues: {
        "openai:gpt-5.5": {
          backgroundMode: true,
          maxOutputTokens: "128000",
          reasoningEffort: "medium",
          searchStrategyId: "openai-native-web-search",
          streamMode: false,
          temperature: "0.25"
        }
      }
    });
    expect(jsonBodies(fetchMock)[0]?.defaultSearchStrategyId).toBeUndefined();
  });

  it("restores saved model search drafts and clamps invalid drafts", () => {
    expect(
      resolveModelSearchStrategy(
        model,
        {
          "openai:gpt-5.5": {
            searchStrategyId: "openai-native-web-search"
          }
        },
        "search-disabled"
      )
    ).toBe("openai-native-web-search");

    expect(
      resolveModelSearchStrategy(
        model,
        {
          "openai:gpt-5.5": {
            searchStrategyId: "unsupported-search"
          }
        },
        "search-disabled"
      )
    ).toBe("search-disabled");
  });
});
