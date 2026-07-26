import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerControls } from "./ComposerControls";
import type { Catalog, CatalogModel, ModelParameterControls } from "./types";

type ComposerControlsProps = Parameters<typeof ComposerControls>[0];

const parameterControls: ModelParameterControls = {
  background: { defaultValue: false, supported: true },
  maxOutputTokens: { defaultValue: 2048, maxValue: 8192 },
  reasoningEffort: {
    defaultValue: "medium",
    options: ["none", "low", "medium", "high", "max"],
    supported: true
  },
  reasoningMode: {
    defaultValue: "standard",
    options: ["standard", "pro"],
    supported: true
  },
  stream: { defaultValue: true, supported: true },
  temperature: { defaultValue: 0.7, maxValue: 2, minValue: 0, supported: true }
};

function catalogModel(modelId: string, displayName: string): CatalogModel {
  return {
    capabilities: {
      background: true,
      documentInputMode: "native_pdf",
      imageInput: true,
      nativeWebSearch: true,
      openRouterPerplexitySearch: false,
      reasoning: true,
      streaming: true
    },
    contextWindow: 128_000,
    defaultParams: {},
    displayName,
    modelId,
    parameterControls,
    provider: "fake",
    providerFamily: "openai",
    searchStrategyIds: ["search-disabled", "web-search"],
    upstreamModelId: modelId
  };
}

const fastModel = catalogModel("fast-model", "Fast Research");
const balancedModel = catalogModel("balanced-model", "Balanced Research");
const deepModel = catalogModel("deep-model", "Deep Research");

const catalog: Catalog = {
  defaults: {
    controlValues: {},
    modelId: balancedModel.modelId,
    promptPresetId: "prompt-default",
    provider: "fake",
    searchStrategyId: "search-disabled",
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true
  },
  models: [fastModel, balancedModel, deepModel],
  promptPresets: [
    {
      developerPrompt: null,
      id: "prompt-default",
      isDefault: true,
      name: "Helpful Assistant",
      systemPrompt: "Be helpful."
    },
    {
      developerPrompt: null,
      id: "prompt-research",
      isDefault: false,
      name: "Research Assistant",
      systemPrompt: "Investigate carefully."
    }
  ],
  providers: [{ id: "fake", models: [fastModel.modelId, balancedModel.modelId, deepModel.modelId], name: "Fake" }],
  runProfiles: [
    {
      available: true,
      configurationLabel: "Fast Research · Standard · Low",
      description: "Simple, well-defined questions",
      id: "fast",
      label: "Fast",
      modelId: fastModel.modelId,
      provider: "fake",
      reasoningEffort: "low",
      reasoningMode: "standard"
    },
    {
      available: true,
      configurationLabel: "Balanced Research · Standard · Medium",
      description: "Most everyday questions",
      id: "balanced",
      label: "Balanced",
      modelId: balancedModel.modelId,
      provider: "fake",
      reasoningEffort: "medium",
      reasoningMode: "standard"
    },
    {
      available: true,
      configurationLabel: "Deep Research · Pro · Maximum",
      description: "Difficult or open-ended questions",
      id: "deep",
      label: "Deep",
      modelId: deepModel.modelId,
      provider: "fake",
      reasoningEffort: "max",
      reasoningMode: "pro"
    }
  ],
  searchStrategies: [
    { displayName: "No Search", kind: "none", strategyId: "search-disabled" },
    { displayName: "Web Search", kind: "openai_native_web_search", strategyId: "web-search" }
  ]
};

function createControlsProps(overrides: Partial<ComposerControlsProps> = {}): ComposerControlsProps {
  const renderedCatalog = "catalog" in overrides ? (overrides.catalog ?? null) : catalog;
  const currentModel = "currentModel" in overrides ? overrides.currentModel : balancedModel;

  return {
    backgroundMode: false,
    catalog: renderedCatalog,
    contextLine: "Approx. input: ~21k / 115k safe input · 128k total context",
    currentModel,
    currentParameterControls: overrides.currentParameterControls ?? currentModel?.parameterControls ?? parameterControls,
    currentPrompt: renderedCatalog?.promptPresets[0] ?? null,
    maxOutputTokens: "2048",
    notificationSoundEnabled: false,
    reasoningEffort: "medium",
    reasoningMode: "standard",
    searchOptions: renderedCatalog?.searchStrategies ?? [],
    selectedModelId: balancedModel.modelId,
    selectedPromptId: "prompt-default",
    selectedProvider: "fake",
    selectedProviderName: "Fake",
    selectedSearchStrategy: "search-disabled",
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true,
    streamMode: true,
    streaming: false,
    temperature: "0.7",
    usageStats: {
      activeBranchMessageCount: 6,
      cachedInputTokens: 1200,
      cacheWriteInputTokens: 20,
      totalTokens: 4242
    },
    onBackgroundModeChange: vi.fn(),
    onMaxOutputTokensChange: vi.fn(),
    onMaxOutputTokensCommit: vi.fn(),
    onOpenPromptSettings: vi.fn(),
    onPromptChange: vi.fn(),
    onReasoningEffortChange: vi.fn(),
    onReasoningModeChange: vi.fn(),
    onRunProfileChange: vi.fn(),
    onSearchStrategyChange: vi.fn(),
    onSelectModel: vi.fn(),
    onStreamModeChange: vi.fn(),
    onTemperatureChange: vi.fn(),
    onTemperatureCommit: vi.fn(),
    onToggleCitations: vi.fn(),
    onToggleNotificationSound: vi.fn(),
    onToggleReasoningBlocks: vi.fn(),
    onToggleToolActivity: vi.fn(),
    ...overrides
  };
}

function renderControls(overrides: Partial<ComposerControlsProps> = {}) {
  const props = createControlsProps(overrides);
  return { props, ...render(<ComposerControls {...props} />) };
}

function openRunSetup() {
  fireEvent.click(screen.getByTestId("composer-run-summary"));
  return screen.getByRole("dialog", { name: "Run setup" });
}

describe("ComposerControls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps model, profile, and search directly reachable beside an explicit More control", () => {
    renderControls();

    const controls = screen.getByTestId("composer-control-bar");
    const summary = screen.getByTestId("composer-run-summary");
    expect(controls).toHaveAttribute("data-layout", "direct");
    expect(summary).toHaveTextContent("More");
    expect(summary).not.toHaveClass("w-full");
    expect(screen.getByTestId("run-model-summary")).toHaveTextContent("Balanced Research");
    expect(screen.getByTestId("run-profile-summary")).toHaveTextContent("Profile: Balanced");
    expect(screen.getByTestId("run-reasoning-summary")).toHaveTextContent("Reasoning: Standard · Medium");
    expect(screen.getByTestId("run-search-summary")).toHaveTextContent("Search: Off");
    expect(summary).toHaveAccessibleName(
      "Open more run settings. Profile Balanced. Model Balanced Research. Reasoning Standard mode, Medium effort. Search Off."
    );
    expect(within(controls).getByRole("button", { name: "Select model" })).toBeVisible();
    expect(within(controls).getByRole("button", { name: "Use Balanced run profile" })).toBeVisible();
    expect(within(controls).getByRole("button", { name: "Use Deep run profile" })).toBeVisible();
    expect(within(controls).getByRole("button", { name: "Search strategy" })).toBeVisible();
    expect(within(controls).queryByRole("button", { name: "Reasoning effort" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run settings" })).not.toBeInTheDocument();
    expect(summary.querySelector(".lucide-chevron-right")).not.toBeInTheDocument();
  });

  it("routes the direct profile, model, and search controls through the existing actions", () => {
    const { props } = renderControls();

    fireEvent.click(screen.getByRole("button", { name: "Use Deep run profile" }));
    expect(props.onRunProfileChange).toHaveBeenCalledWith("deep");

    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    const modelPicker = screen.getByTestId("composer-inline-model-picker");
    expect(within(modelPicker).queryByRole("button", { name: "Back to Run setup" })).not.toBeInTheDocument();
    fireEvent.click(within(modelPicker).getByRole("button", { name: "Select model Fake Deep Research" }));
    expect(props.onSelectModel).toHaveBeenCalledWith(deepModel);

    fireEvent.click(screen.getByRole("button", { name: "Search strategy" }));
    fireEvent.click(
      screen
        .getByTestId("composer-inline-search-options")
        .querySelector('[data-option-value="web-search"]')!
    );
    expect(props.onSearchStrategyChange).toHaveBeenCalledWith("web-search");
  });

  it("prints exact non-default profile, mode, effort, and search names", () => {
    renderControls({
      currentModel: deepModel,
      currentParameterControls: deepModel.parameterControls,
      reasoningEffort: "max",
      reasoningMode: "pro",
      selectedModelId: deepModel.modelId,
      selectedSearchStrategy: "web-search"
    });

    expect(screen.getByTestId("run-model-summary")).toHaveTextContent("Deep Research");
    expect(screen.getByTestId("run-profile-summary")).toHaveTextContent("Profile: Deep");
    expect(screen.getByTestId("run-reasoning-summary")).toHaveTextContent("Reasoning: Pro · Maximum");
    expect(screen.getByTestId("run-search-summary")).toHaveTextContent("Search: Web Search");
  });

  it("keeps the full model identity available while containing a long direct-control label", () => {
    const longName = "OpenRouter research model with a deliberately long exact display name";
    renderControls({ currentModel: { ...balancedModel, displayName: longName } });

    const model = screen.getByTestId("run-model-summary");
    expect(model).toHaveTextContent(longName);
    expect(model).toHaveClass("truncate");
    expect(model.closest("button")).toHaveAttribute("title", `Fake / ${longName}`);
  });

  it("opens one complete Run setup from that receipt", () => {
    renderControls();
    const dialog = openRunSetup();

    expect(dialog).toHaveClass(
      "bg-overlay-surface",
      "overflow-hidden",
      "sm:w-[min(44rem,calc(100vw-2rem))]",
      "sm:top-1/2",
      "sm:-translate-y-1/2",
      "[@media(max-height:32rem)]:!translate-y-0"
    );
    expect(screen.getByTestId("run-setup-backdrop")).toHaveClass("bg-scrim/55");
    expect(screen.getByTestId("run-setup-backdrop")).not.toHaveClass("backdrop-blur-sm");
    expect(screen.getByTestId("run-setup-content")).toHaveClass("overflow-y-auto", "overscroll-contain");
    expect(within(dialog).getByRole("heading", { name: "Profile" })).toBeVisible();
    expect(within(dialog).getByRole("group", { name: "Run profile" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Select model" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Reasoning effort" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Search strategy" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Prompt preset" })).toBeVisible();
    expect(within(dialog).getByRole("spinbutton", { name: "Temperature" })).toBeVisible();
    expect(within(dialog).getByRole("spinbutton", { name: "Max output tokens" })).toBeVisible();
    expect(within(dialog).getByRole("combobox", { name: "Reasoning mode" })).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: "Context and usage" })).toBeVisible();
    expect(dialog).toHaveTextContent("Approx. input: ~21k / 115k safe input · 128k total context");
    expect(dialog).toHaveTextContent("Provider-reported tokens4.2k");
    expect(dialog).toHaveTextContent("Cached input tokens1.2k");
    expect(within(dialog).getByRole("heading", { name: "Next run" })).toBeVisible();
    expect(within(dialog).getByText("Provider behavior applied when you send the next message.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Background mode" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Stream response" })).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: "Display preferences" })).toBeVisible();
    expect(within(dialog).getByText("Changes how existing and future answers are presented.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Hide citations" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Show reasoning blocks" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Hide tool activity" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Enable answer sound" })).toBeVisible();
  });

  it("applies quick profiles from inside Run setup without a second owner", () => {
    const { props } = renderControls();
    const dialog = openRunSetup();

    const availabilityFacts = within(dialog).getAllByText("Available", {
      selector: '[data-run-profile-availability="available"]'
    });
    expect(availabilityFacts).toHaveLength(3);
    for (const fact of availabilityFacts) {
      expect(fact).toBeVisible();
      expect(fact.tagName).toBe("SPAN");
      expect(fact).not.toHaveAttribute("disabled");
    }

    fireEvent.click(within(dialog).getByRole("button", { name: "Use Deep run profile" }));
    expect(props.onRunProfileChange).toHaveBeenCalledWith("deep");
  });

  it("omits the Profile section only when the server omits every configured slot", () => {
    renderControls({ catalog: { ...catalog, runProfiles: [] } });
    const dialog = openRunSetup();

    expect(within(dialog).queryByRole("heading", { name: "Profile" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Answer setup" })).toBeVisible();
  });

  it("separates an unavailable profile fact from its unavailable action", () => {
    const unavailableCatalog: Catalog = {
      ...catalog,
      runProfiles: [{
        available: false,
        description: "Simple, well-defined questions",
        id: "fast",
        label: "Fast",
        unavailableReason: "model_unavailable"
      }]
    };
    renderControls({ catalog: unavailableCatalog });
    const compactProfiles = screen.getByTestId("composer-inline-run-profiles");
    const compactFact = compactProfiles.querySelector('[data-run-profile-availability="unavailable"]');
    expect(compactFact).toBeVisible();
    expect(compactFact?.tagName).toBe("SPAN");
    expect(compactProfiles).toHaveTextContent("Unavailable");

    const dialog = openRunSetup();

    expect(within(dialog).getByRole("heading", { name: "Profile" })).toBeVisible();
    const action = within(dialog).getByRole("button", { name: "Use Fast run profile" });
    const fact = within(dialog).getByText("Unavailable", {
      selector: '[data-run-profile-availability="unavailable"]'
    });
    expect(action).toBeDisabled();
    expect(fact).toBeVisible();
    expect(fact.tagName).toBe("SPAN");
    expect(fact).not.toHaveAttribute("disabled");
    expect(dialog).not.toHaveTextContent("Disabled");
    expect(within(dialog).getByTestId("run-profile-unavailable-reason")).toHaveTextContent(
      "Unavailable profiles cannot be used with your current model access."
    );
  });

  it("keeps model search and selection nested in Run setup", () => {
    const { props } = renderControls();
    const dialog = openRunSetup();

    fireEvent.click(within(dialog).getByRole("button", { name: "Select model" }));
    const picker = screen.getByRole("dialog", { name: "Choose a model" });
    expect(screen.getByTestId("model-picker-backdrop")).toHaveClass("bg-scrim/55");
    expect(screen.getByRole("button", { name: "Back to Run setup" })).toBeVisible();
    fireEvent.change(within(picker).getByRole("searchbox", { name: "Search models" }), {
      target: { value: "Deep Research" }
    });
    const modelOption = within(picker).getByText("Deep Research").closest("button");
    expect(modelOption).not.toBeNull();
    fireEvent.click(modelOption!);
    expect(props.onSelectModel).toHaveBeenCalledWith(deepModel);
  });

  it("returns from the nested model picker without dismissing Run setup", () => {
    renderControls();
    const dialog = openRunSetup();
    const modelTrigger = within(dialog).getByRole("button", { name: "Select model" });

    fireEvent.click(modelTrigger);
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search models" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Run setup" })).toBeVisible();

    fireEvent.click(modelTrigger);
    fireEvent.mouseDown(screen.getByTestId("model-picker-backdrop"));
    expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Run setup" })).toBeVisible();
  });

  it("routes reasoning, search, prompt, generation, and response controls through existing actions", () => {
    const { props } = renderControls();
    const dialog = openRunSetup();

    fireEvent.click(within(dialog).getByRole("button", { name: "Reasoning effort" }));
    fireEvent.click(screen.getByRole("button", { name: /High model reasoning effort/i }));
    expect(props.onReasoningEffortChange).toHaveBeenCalledWith("high");

    fireEvent.click(within(dialog).getByRole("button", { name: "Search strategy" }));
    fireEvent.click(screen.getByRole("button", { name: /Web Search/i }));
    expect(props.onSearchStrategyChange).toHaveBeenCalledWith("web-search");

    fireEvent.click(within(dialog).getByRole("button", { name: "Prompt preset" }));
    fireEvent.click(screen.getByRole("button", { name: /Research Assistant/i }));
    expect(props.onPromptChange).toHaveBeenCalledWith("prompt-research");

    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Temperature" }), { target: { value: "1.1" } });
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Max output tokens" }), { target: { value: "4096" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Reasoning mode" }), { target: { value: "pro" } });
    expect(props.onTemperatureChange).toHaveBeenCalledWith("1.1");
    expect(props.onMaxOutputTokensChange).toHaveBeenCalledWith("4096");
    expect(props.onReasoningModeChange).toHaveBeenCalledWith("pro");

    fireEvent.click(within(dialog).getByRole("button", { name: "Background mode" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Stream response" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide citations" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Show reasoning blocks" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide tool activity" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Enable answer sound" }));
    expect(props.onBackgroundModeChange).toHaveBeenCalledWith(true);
    expect(props.onStreamModeChange).toHaveBeenCalledWith(false);
    expect(props.onToggleCitations).toHaveBeenCalledOnce();
    expect(props.onToggleReasoningBlocks).toHaveBeenCalledOnce();
    expect(props.onToggleToolActivity).toHaveBeenCalledOnce();
    expect(props.onToggleNotificationSound).toHaveBeenCalledOnce();
  });

  it("flushes numeric drafts and restores the one summary trigger when Run setup closes", async () => {
    const { props } = renderControls();
    const trigger = screen.getByTestId("composer-run-summary");
    openRunSetup();

    fireEvent.mouseDown(screen.getByTestId("run-setup-backdrop"));
    expect(screen.queryByRole("dialog", { name: "Run setup" })).not.toBeInTheDocument();
    expect(props.onTemperatureCommit).toHaveBeenCalledOnce();
    expect(props.onMaxOutputTokensCommit).toHaveBeenCalledOnce();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes and flushes before opening prompt management", async () => {
    const { props } = renderControls();
    const dialog = openRunSetup();

    fireEvent.click(within(dialog).getByRole("button", { name: "Manage prompts" }));
    expect(screen.queryByRole("dialog", { name: "Run setup" })).not.toBeInTheDocument();
    expect(props.onTemperatureCommit).toHaveBeenCalledOnce();
    expect(props.onMaxOutputTokensCommit).toHaveBeenCalledOnce();
    await waitFor(() => expect(props.onOpenPromptSettings).toHaveBeenCalledOnce());
  });

  it("closes an open setup when bootstrap readiness disables its owner", async () => {
    const view = renderControls();
    openRunSetup();

    view.rerender(<ComposerControls {...view.props} disabled />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run setup" })).not.toBeInTheDocument());
    expect(screen.getByTestId("composer-run-summary")).toBeDisabled();
  });

  it("reports unsupported and unavailable values explicitly in the resting receipt", () => {
    const unsupportedControls: ModelParameterControls = {
      ...parameterControls,
      reasoningEffort: { defaultValue: "none", options: ["none"], supported: false },
      reasoningMode: undefined
    };
    const unsupportedModel: CatalogModel = {
      ...balancedModel,
      parameterControls: unsupportedControls
    };
    renderControls({
      catalogUnavailable: true,
      currentModel: unsupportedModel,
      currentParameterControls: unsupportedControls,
      searchOptions: [],
      selectedSearchStrategy: "missing"
    });

    expect(screen.getByTestId("run-reasoning-summary")).toHaveTextContent("Reasoning: Not supported");
    expect(screen.getByTestId("run-search-summary")).toHaveTextContent("Search: Unavailable");
    const dialog = openRunSetup();
    expect(within(dialog).getByRole("button", { name: "Reasoning effort" })).toBeDisabled();
  });

  it("derives Custom and unavailable profile states instead of inventing a selection", () => {
    const view = renderControls({ reasoningEffort: "high" });
    expect(screen.getByTestId("run-profile-summary")).toHaveTextContent("Profile: Custom");

    view.rerender(<ComposerControls {...view.props} catalog={{ ...catalog, runProfiles: [] }} reasoningEffort="high" />);
    expect(screen.getByTestId("run-profile-summary")).toHaveTextContent("Profile: Unavailable");
  });

  it("keeps global command shortcuts from escaping an open Run setup", () => {
    renderControls();
    const dialog = openRunSetup();
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "k" });
    dialog.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
