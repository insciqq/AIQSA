import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef, useState } from "react";
import { ShellLeftPane, type ShellLeftPaneProps } from "./ShellLeftPane";
import { useRunControlsActions } from "./runControlsActions";
import type { SettingsMutationCoordinator } from "./settingsMutationCoordinator";
import { useEventCallback } from "./useEventCallback";
import { resetComposerControlStoreForTest, useComposerControlStore } from "./composerControlStore";
import type {
  AssistantAvatarRecipe,
  AssistantRevisionContent
} from "@/lib/contracts/assistants";
import type { Catalog, CatalogModel, ChatSummary } from "./types";
import {
  resolveModelSearchPlan,
  resolveModelSearchStrategy,
  type SavedControlDraft
} from "./powerAppShellData";
import { useWorkspaceStore } from "./workspaceStore";

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
  defaultProvider: "openai",
  folderId: null,
  id: "chat-1",
  messageCount: 0,
  title: "Control chat",
  updatedAt: "2026-06-10T00:00:00.000Z"
};

const assistantAvatar: AssistantAvatarRecipe = {
  accents: [0],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 1]
};

function assistantSelectionFixture() {
  return {
    avatar: assistantAvatar,
    description: "Difficult or open-ended questions",
    id: "assistant-1",
    name: "Deep helper",
    promptCharacterCount: 120,
    starterPrompts: []
  };
}

function assistantRevisionFixture(
  overrides: Partial<AssistantRevisionContent> = {}
): AssistantRevisionContent {
  return {
    authorDisplayName: "Operator",
    avatar: assistantAvatar,
    category: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    description: "Difficult or open-ended questions",
    developerPrompt: null,
    knowledgeBaseIds: [],
    mcpServerIds: [],
    name: "Deep helper",
    providerModelId: "gpt-5.6-sol",
    revisionNumber: 1,
    runControls: {},
    searchPlan: { mode: "all_selected", optionIds: ["openai-native-web-search"] },
    starterPrompts: [],
    systemPrompt: "Answer with care.",
    ...overrides
  };
}

function catalog(
  controlValues: Record<string, unknown> = {},
  models: CatalogModel[] = [model, fakeModel]
): Catalog {
  return {
    defaults: {
      controlValues,
      hasPersonalModelDefault: true,
      modelId: model.modelId,
      modelPreferenceSource: "personal",
      organizationModelDefault: { modelId: model.modelId, provider: model.provider },
      organizationSearchPlan: { mode: "all_selected", optionIds: [] },
      personalModelDefault: { modelId: model.modelId, provider: model.provider },
      provider: model.provider,
      searchStrategyId: "openai-native-web-search",
      searchPreferenceSource: "personal",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
    },
    models,
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
    hasPersonalModelDefault: true,
    defaultModelId: model.modelId,
    modelPreferenceSource: "personal" as "none" | "organization" | "personal",
    organizationModelDefault: { modelId: model.modelId, provider: model.provider },
    personalModelDefault: { modelId: model.modelId, provider: model.provider } as {
      modelId: string;
      provider: string;
    } | null,
    defaultSearchPlan: { mode: "all_selected", optionIds: ["openai-native-web-search"] },
    organizationSearchPlan: { mode: "all_selected", optionIds: [] },
    defaultProvider: model.provider,
    defaultSearchStrategyId: "openai-native-web-search",
    searchPreferenceSource: "personal" as const,
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true,
  };

  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (typeof body.defaultModelId === "string") {
      saved.defaultModelId = body.defaultModelId;
      saved.hasPersonalModelDefault = true;
      saved.modelPreferenceSource = "personal";
    }
    if (typeof body.defaultProvider === "string") {
      saved.defaultProvider = body.defaultProvider;
      saved.personalModelDefault = {
        modelId: saved.defaultModelId,
        provider: saved.defaultProvider
      };
    }
    if (body.defaultProviderModelId === null) {
      saved.defaultModelId = saved.organizationModelDefault.modelId;
      saved.defaultProvider = saved.organizationModelDefault.provider;
      saved.hasPersonalModelDefault = false;
      saved.modelPreferenceSource = "organization";
      saved.personalModelDefault = null;
    }
    if (typeof body.defaultSearchStrategyId === "string") {
      saved.defaultSearchStrategyId = body.defaultSearchStrategyId;
    }
    if (body.defaultSearchPlan === null) {
      saved.defaultSearchPlan = saved.organizationSearchPlan;
      saved.searchPreferenceSource = "organization";
    } else if (body.defaultSearchPlan && typeof body.defaultSearchPlan === "object") {
      saved.defaultSearchPlan = body.defaultSearchPlan as typeof saved.defaultSearchPlan;
      saved.searchPreferenceSource = "personal";
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
  useWorkspaceStore.getState().setCatalog(initialCatalog);
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
        useWorkspaceStore.getState().setCatalog(currentCatalog);
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
      streamMode: false,
      temperature: "0.2"
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(jsonBodies(fetchMock).at(-1)?.defaultControlValues).toEqual({
      "openai:gpt-5.5": {
        backgroundMode: false,
        maxOutputTokens: "96",
        reasoningEffort: "high",
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

  it("does not reuse a render-captured model for a different selected key", () => {
    const harness = createRunControlsHarness(model, catalog({}, [model]));
    useComposerControlStore.setState({
      selectedModelId: fakeModel.modelId,
      selectedProvider: fakeModel.provider
    });

    const params = harness.actions().buildParams();

    expect(params).not.toHaveProperty("background");
    expect(params).not.toHaveProperty("maxOutputTokens", 128000);
    expect(params).not.toHaveProperty("reasoning.effort", "medium");
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

  it("applies an assistant revision atomically without persisting any user default", () => {
    vi.useFakeTimers();
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const initialCatalog = catalog(
      {},
      [model, fakeModel, gpt56Model, gpt56TerraModel, gpt56LunaModel]
    );
    const harness = createRunControlsHarness(model, initialCatalog);

    expect(
      harness.actions().applyAssistantToComposer({
        assistant: assistantSelectionFixture(),
        revision: assistantRevisionFixture({
          providerModelId: "gpt-5.6-sol",
          runControls: {
            backgroundMode: false,
            maxOutputTokens: 64000,
            reasoningEffort: "max",
            reasoningMode: "pro",
            streamMode: true,
            temperature: 0.4
          }
        })
      })
    ).toBe(true);

    expect(useComposerControlStore.getState()).toMatchObject({
      backgroundMode: false,
      maxOutputTokens: "64000",
      reasoningEffort: "max",
      reasoningMode: "pro",
      selectedAssistant: { id: "assistant-1", name: "Deep helper" },
      selectedModelId: "gpt-5.6-sol",
      selectedProvider: "openai",
      selectedSearchStrategy: "openai-native-web-search",
      streamMode: true,
      temperature: "0.4"
    });
    expect(harness.actions().buildParams()).toMatchObject({
      reasoning: {
        effort: "max",
        mode: "pro"
      }
    });
    // The persistence path defers through window.setTimeout, so drain timers
    // before asserting that applying an assistant scheduled no settings write.
    vi.advanceTimersByTime(600);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("excludes assistant-derived values from the draft persisted after a manual change", async () => {
    vi.useFakeTimers();
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const initialCatalog = catalog(
      {
        "openai:gpt-5.6-sol": {
          maxOutputTokens: "64000",
          reasoningEffort: "low"
        }
      },
      [model, fakeModel, gpt56Model]
    );
    const harness = createRunControlsHarness(model, initialCatalog);
    harness.actions().applyAssistantToComposer({
      assistant: assistantSelectionFixture(),
      revision: assistantRevisionFixture({
        providerModelId: "gpt-5.6-sol",
        runControls: {
          reasoningEffort: "max",
          reasoningMode: "pro",
          temperature: 0.9
        }
      })
    });

    harness.actions().changeTemperature("0.5");
    vi.advanceTimersByTime(600);

    expect(useComposerControlStore.getState()).toMatchObject({
      assistantRemovedNotice: true,
      selectedAssistant: null,
      temperature: "0.5"
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(jsonBodies(fetchMock)[0]?.defaultControlValues).toEqual({
      "openai:gpt-5.6-sol": {
        maxOutputTokens: "64000",
        reasoningEffort: "low",
        temperature: "0.5"
      }
    });
  });

  it("restores each model's exact Reasoning tuple after A to B to A switching", () => {
    vi.stubGlobal("fetch", settingsFetchMock());
    const initialCatalog = catalog({
      "openai:gpt-5.6-sol": { reasoningEffort: "max", reasoningMode: "pro" },
      "openai:gpt-5.6-terra": { reasoningEffort: "low", reasoningMode: "standard" }
    }, [gpt56Model, gpt56TerraModel]);
    const harness = createRunControlsHarness(gpt56Model, initialCatalog);

    harness.actions().selectModel(gpt56Model);
    expect(useComposerControlStore.getState()).toMatchObject({
      reasoningEffort: "max",
      reasoningMode: "pro"
    });
    harness.actions().selectModel(gpt56TerraModel);
    expect(useComposerControlStore.getState()).toMatchObject({
      reasoningEffort: "low",
      reasoningMode: "standard"
    });
    harness.actions().changeReasoningEffort("high");
    harness.actions().selectModel(gpt56Model);
    expect(useComposerControlStore.getState()).toMatchObject({
      reasoningEffort: "max",
      reasoningMode: "pro"
    });
  });

  it("keeps ordinary model selection local and persists only explicit default actions", async () => {
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const harness = createRunControlsHarness(model, catalog({}, [model, fakeModel]));

    harness.actions().selectModel(fakeModel);
    expect(useComposerControlStore.getState()).toMatchObject({
      selectedModelId: "fake-qsa",
      selectedProvider: "fake"
    });
    expect(fetchMock).not.toHaveBeenCalled();

    harness.actions().makeCurrentModelDefault();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(jsonBodies(fetchMock)[0]).toEqual({
      defaultModelId: "fake-qsa",
      defaultProvider: "fake"
    });
    expect(harness.catalog().defaults).toMatchObject({
      modelId: "fake-qsa",
      modelPreferenceSource: "personal",
      personalModelDefault: { modelId: "fake-qsa", provider: "fake" },
      provider: "fake"
    });
  });

  it("clears a personal default without changing the current next-run model", async () => {
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const initialCatalog = catalog({}, [model, fakeModel]);
    const harness = createRunControlsHarness(fakeModel, initialCatalog);
    useComposerControlStore.getState().applyModelSelection({
      controlDefaults: {
        backgroundMode: false,
        maxOutputTokens: "8192",
        reasoningEffort: "medium",
        reasoningMode: "standard",
        streamMode: true,
        temperature: "1"
      },
      modelId: fakeModel.modelId,
      provider: fakeModel.provider
    });

    harness.actions().useOrganizationModelDefault();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(jsonBodies(fetchMock)[0]).toEqual({ defaultProviderModelId: null });
    expect(useComposerControlStore.getState()).toMatchObject({
      selectedModelId: "fake-qsa",
      selectedProvider: "fake"
    });
    expect(harness.catalog().defaults).toMatchObject({
      hasPersonalModelDefault: false,
      modelId: "gpt-5.5",
      modelPreferenceSource: "organization",
      personalModelDefault: null,
      provider: "openai"
    });
  });

  it("retains a global multi-engine Search preference across incompatible model switches", () => {
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const multiSearchModel = {
      ...model,
      searchStrategyIds: ["search-disabled", "openai-native-web-search", "perplexity-tool-search"]
    };
    const initialCatalog = {
      ...catalog({}, [multiSearchModel, fakeModel]),
      searchStrategies: [
        ...catalog().searchStrategies,
        {
          adapterKind: "provider_model_client" as const,
          displayName: "Perplexity tool",
          executionModes: ["all_selected" as const, "model_choice" as const],
          kind: "perplexity_tool_search" as const,
          protocol: "openrouter_perplexity_chat" as const,
          strategyId: "perplexity-tool-search"
        }
      ]
    };
    const harness = createRunControlsHarness(multiSearchModel, initialCatalog);
    harness.actions().selectSearchPlan(
      ["openai-native-web-search", "perplexity-tool-search"],
      "model_choice"
    );
    harness.actions().selectModel(fakeModel);
    expect(useComposerControlStore.getState().selectedSearchOptionIds).toEqual([
      "openai-native-web-search",
      "perplexity-tool-search"
    ]);
    expect(resolveModelSearchPlan(
      fakeModel,
      {
        mode: useComposerControlStore.getState().searchPlanMode,
        optionIds: useComposerControlStore.getState().selectedSearchOptionIds
      },
      undefined,
      initialCatalog.searchStrategies
    )).toEqual({ mode: "all_selected", optionIds: [] });

    harness.actions().selectModel(multiSearchModel);
    expect(useComposerControlStore.getState().selectedSearchOptionIds).toEqual([
      "openai-native-web-search",
      "perplexity-tool-search"
    ]);
    expect(jsonBodies(fetchMock).filter((body) => "defaultModelId" in body).every((body) =>
      !("defaultSearchPlan" in body))).toBe(true);
  });

  it("refuses an assistant revision whose model is not in the caller's catalog", () => {
    vi.useFakeTimers();
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const unavailableHarness = createRunControlsHarness(model, catalog({}, [model, fakeModel]));

    expect(
      unavailableHarness.actions().applyAssistantToComposer({
        assistant: assistantSelectionFixture(),
        revision: assistantRevisionFixture({
          providerModelId: "gpt-5.6-sol",
          runControls: { reasoningEffort: "max", reasoningMode: "pro" }
        })
      })
    ).toBe(false);
    expect(useComposerControlStore.getState()).toMatchObject({
      selectedAssistant: null,
      selectedModelId: "gpt-5.5",
      selectedProvider: "openai"
    });
    vi.advanceTimersByTime(600);
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
        streamMode: false,
        temperature: "0.4"
      }
    });
  });

  it("persists Search globally without writing it into the per-model draft", async () => {
    vi.useFakeTimers();
    const fetchMock = settingsFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const harness = createRunControlsHarness();
    let actions = harness.actions();

    actions.changeTemperature("0.25");
    actions = harness.actions();
    actions.selectSearchStrategy("openai-native-web-search");
    expect(harness.searchStrategy()).toBe("openai-native-web-search");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jsonBodies(fetchMock)[0]).toMatchObject({
      defaultSearchPlan: {
        mode: "all_selected",
        optionIds: ["openai-native-web-search"]
      }
    });
    expect(jsonBodies(fetchMock)[0]?.defaultControlValues).toBeUndefined();
    vi.advanceTimersByTime(600);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(jsonBodies(fetchMock)[1]?.defaultControlValues).toMatchObject({
      "openai:gpt-5.5": { temperature: "0.25" }
    });
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
