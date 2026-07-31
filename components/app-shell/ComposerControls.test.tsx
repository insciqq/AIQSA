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
      streaming: true,
      toolCalling: true
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
    onOpenPromptLibrary: vi.fn(),
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
    expect(summary).toHaveAttribute("title", "More run settings");
    expect(within(summary).getByText("More")).toHaveClass("hidden", "min-[430px]:inline");
    expect(summary).toHaveClass(
      "[@media(hover:none)]:!min-h-touch",
      "[@media(pointer:coarse)]:!min-h-touch"
    );
    expect(screen.getByTestId("run-model-summary")).toHaveTextContent("Balanced Research");
    expect(screen.getByTestId("run-model-summary-provider")).toHaveTextContent("Fake");
    expect(screen.getByTestId("run-profile-summary")).toHaveTextContent("Profile: Balanced");
    expect(screen.getByTestId("run-reasoning-summary")).toHaveTextContent("Reasoning: Standard · Medium");
    expect(screen.getByTestId("run-search-summary")).toHaveTextContent("Search: Off");
    expect(summary).toHaveAccessibleName(
      "Open more run settings. Profile Balanced. Model Balanced Research. Reasoning Standard mode, Medium effort. Search Off."
    );
    const model = within(controls).getByRole("button", { name: "Select model" });
    expect(model).toBeVisible();
    expect(within(model).queryByText("Model", { exact: true })).not.toBeInTheDocument();
    const profile = within(controls).getByRole("button", { name: "Run profile" });
    expect(profile).toBeVisible();
    expect(profile).toHaveTextContent("Balanced");
    expect(within(profile).getByText("Profile", { exact: true })).toHaveClass("sr-only");
    expect(within(controls).queryByRole("button", { name: "Use Fast run profile" })).not.toBeInTheDocument();
    expect(within(controls).queryByRole("button", { name: "Use Balanced run profile" })).not.toBeInTheDocument();
    expect(within(controls).queryByRole("button", { name: "Use Deep run profile" })).not.toBeInTheDocument();
    const search = within(controls).getByRole("button", { name: "Search strategy" });
    expect(search).toBeVisible();
    expect(within(search).getByText("Search")).toHaveClass("max-[429px]:sr-only");
    expect(search.querySelector(".lucide-search")).toHaveClass("max-[429px]:block");
    expect(within(search).getAllByText("Off")[0]).toHaveClass("min-[430px]:hidden");
    expect(within(controls).queryByRole("button", { name: "Reasoning effort" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run settings" })).not.toBeInTheDocument();
    expect(summary.querySelector(".lucide-chevron-right")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-secondary-controls")).toContainElement(profile);
    expect(profile).toHaveClass("bg-control-surface", "h-touch");
    expect(screen.getByTestId("run-model-summary").closest("div.relative")).toHaveClass(
      "max-w-full",
      "flex-[1_1_100%]",
      "sm:flex-[0_0_20rem]"
    );
  });

  it("routes the direct profile, model, and search controls through the existing actions", () => {
    const { props } = renderControls();

    fireEvent.click(screen.getByRole("button", { name: "Run profile" }));
    expect(screen.getByRole("dialog", { name: "Choose profile" })).toBeVisible();
    fireEvent.click(
      screen
        .getByTestId("composer-inline-profile-options")
        .querySelector('[data-option-value="deep"]')!
    );
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

  it("edits the exact Reasoning mode and effort from one wide direct control", () => {
    const { props } = renderControls({ reasoningEffort: "max", reasoningMode: "pro" });
    fireEvent.click(screen.getByRole("button", { name: "Reasoning Pro · Maximum" }));
    const dialog = screen.getByRole("dialog", { name: "Reasoning settings" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Standard" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "High" }));

    expect(props.onReasoningModeChange).toHaveBeenCalledWith("standard");
    expect(props.onReasoningEffortChange).toHaveBeenCalledWith("high");
    expect(dialog).toHaveTextContent("Saved for this exact model");
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
    expect(screen.getByRole("button", { name: "Run profile" })).toHaveTextContent("Deep");
    const search = screen.getByRole("button", { name: "Search strategy" });
    expect(within(search).getByText("OAI")).toHaveClass("min-[430px]:hidden");
    expect(within(search).getByText("Web Search")).toHaveClass("hidden", "min-[430px]:inline");
    expect(search).toHaveAttribute("title", "Web Search");
  });

  it("retains an incompatible selected Search engine as unavailable", () => {
    const perplexity = {
      displayName: "Perplexity tool",
      kind: "perplexity_tool_search" as const,
      strategyId: "perplexity-tool-search"
    };
    renderControls({
      searchOptions: [perplexity],
      selectedSearchStrategy: perplexity.strategyId
    });

    const search = screen.getByRole("button", { name: "Search strategy" });
    expect(within(search).getByText("0 active · 1 unavailable")).toBeVisible();
    expect(search).toHaveAttribute("title", "0 active · 1 unavailable");
  });

  it("keeps the full model identity available while containing a long direct-control label", () => {
    const longName = "OpenRouter research model with a deliberately long exact display name";
    renderControls({ currentModel: { ...balancedModel, displayName: longName } });

    const model = screen.getByTestId("run-model-summary");
    expect(model).toHaveTextContent(longName);
    expect(model).toHaveClass("truncate");
    expect(screen.getByTestId("run-model-summary-provider")).toHaveTextContent("Fake");
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
      "sm:max-h-[calc(100dvh_-_2rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))]",
      "sm:-translate-y-1/2",
      "[@media(max-height:32rem)]:!max-h-[calc(100dvh_-_1rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))]",
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
    const answerSetup = within(dialog).getByTestId("run-answer-setup-controls");
    expect(answerSetup).toHaveClass("sm:grid-cols-2");
    expect(answerSetup).not.toHaveClass("sm:grid-cols-3");
    expect(within(dialog).getByRole("button", { name: "Select model" }).parentElement).toHaveClass(
      "sm:col-span-2"
    );
    expect(dialog.querySelector("#composer-model-current-value")).toHaveTextContent("Balanced Research");
    expect(dialog.querySelector("#composer-reasoning-effort-current-value")).toHaveTextContent(
      "Standard · Medium"
    );
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

    const availabilityFacts = dialog.querySelectorAll(
      '[data-run-profile-availability="available"]'
    );
    expect(availabilityFacts).toHaveLength(3);
    for (const fact of availabilityFacts) {
      expect(fact).toBeVisible();
      expect(fact.tagName).toBe("SPAN");
      expect(fact).not.toHaveAttribute("disabled");
    }
    expect(within(dialog).getByText("Selected", { exact: true })).toBeVisible();

    fireEvent.click(within(dialog).getByRole("button", { name: "Use Deep run profile" }));
    expect(props.onRunProfileChange).toHaveBeenCalledWith("deep");
  });

  it("omits the Profile section only when the server omits every configured slot", () => {
    renderControls({ catalog: { ...catalog, runProfiles: [] } });
    expect(screen.queryByRole("button", { name: "Run profile" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("run-profile-summary")).not.toBeInTheDocument();
    const dialog = openRunSetup();

    expect(within(dialog).queryByRole("heading", { name: "Profile" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Answer setup" })).toBeVisible();
  });

  it("omits unusable profile shortcuts while retaining their diagnostics in Run setup", () => {
    const unavailableCatalog: Catalog = {
      ...catalog,
      runProfiles: (catalog.runProfiles ?? []).map((profile) => ({
        available: false,
        description: profile.description,
        id: profile.id,
        label: profile.label,
        unavailableReason: "model_unavailable"
      }))
    };
    renderControls({ catalog: unavailableCatalog });
    expect(screen.queryByRole("button", { name: "Run profile" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("run-profile-summary")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-run-summary")).not.toHaveAccessibleName(/Profile/i);

    const dialog = openRunSetup();

    expect(within(dialog).getByRole("heading", { name: "Profile" })).toBeVisible();
    const profiles = within(dialog).getByRole("group", { name: "Run profile" });
    for (const label of ["Fast", "Balanced", "Deep"]) {
      const action = within(profiles).getByRole("button", { name: `Use ${label} run profile` });
      expect(action).toBeDisabled();
      expect(action).toHaveAttribute("title", expect.stringContaining(`${label} is not available`));
    }
    const unavailableFacts = within(dialog).getAllByText(/Unavailable profiles cannot be used/, {
      selector: '[data-run-profile-availability="unavailable"]'
    });
    expect(unavailableFacts).toHaveLength(1);
    expect(unavailableFacts[0]).toBeVisible();
    expect(unavailableFacts[0].tagName).toBe("P");
    expect(unavailableFacts[0]).not.toHaveClass("rounded-pill", "border");
    expect(within(profiles).getAllByText("Unavailable", { exact: true })).toHaveLength(3);
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

    fireEvent.click(within(dialog).getByRole("button", { name: "Open library" }));
    expect(screen.queryByRole("dialog", { name: "Run setup" })).not.toBeInTheDocument();
    expect(props.onTemperatureCommit).toHaveBeenCalledOnce();
    expect(props.onMaxOutputTokensCommit).toHaveBeenCalledOnce();
    await waitFor(() => expect(props.onOpenPromptLibrary).toHaveBeenCalledOnce());
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

  it("derives Custom only for applicable profiles and omits a true-empty profile summary", () => {
    const view = renderControls({ reasoningEffort: "high" });
    expect(screen.getByTestId("run-profile-summary")).toHaveTextContent("Profile: Custom");
    const profile = screen.getByRole("button", { name: "Run profile" });
    expect(profile).toBeVisible();
    expect(profile).toHaveTextContent("Custom");
    expect(profile).toHaveAttribute("title", "Current run profile: Custom");

    view.rerender(<ComposerControls {...view.props} catalog={{ ...catalog, runProfiles: [] }} reasoningEffort="high" />);
    expect(screen.queryByTestId("run-profile-summary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run profile" })).not.toBeInTheDocument();
  });

  it("keeps global command shortcuts from escaping an open Run setup", () => {
    renderControls();
    const dialog = openRunSetup();
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "k" });
    dialog.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
