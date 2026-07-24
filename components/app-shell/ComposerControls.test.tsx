import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerControls } from "./ComposerControls";
import type { Catalog, CatalogModel, ModelParameterControls } from "./types";

type ComposerControlsProps = Parameters<typeof ComposerControls>[0];

const model: CatalogModel = {
  capabilities: {
    background: false,
    documentInputMode: "none",
    imageInput: false,
    nativeWebSearch: false,
    openRouterPerplexitySearch: false,
    reasoning: false,
    streaming: true
  },
  contextWindow: 4096,
  defaultParams: {},
  displayName: "Fake QSA",
  modelId: "fake-qsa",
  parameterControls: {
    background: { defaultValue: false, supported: false },
    maxOutputTokens: { defaultValue: 1024, maxValue: 4096 },
    reasoningEffort: { defaultValue: "none", options: ["none"], supported: false },
    stream: { defaultValue: true, supported: false },
    temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
  },
  provider: "fake",
  searchStrategyIds: ["search-disabled", "web-search"]
};

const catalog: Catalog = {
  defaults: {
    controlValues: {},
    modelId: "fake-qsa",
    promptPresetId: "prompt-default",
    provider: "fake",
    searchStrategyId: "search-disabled",
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true,
  },
  models: [model],
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
  providers: [{ id: "fake", models: ["fake-qsa"], name: "Fake" }],
  searchStrategies: [
    { displayName: "No Search", kind: "none", strategyId: "search-disabled" },
    { displayName: "Web Search", kind: "openai_native_web_search", strategyId: "web-search" }
  ]
};

const capableParameterControls: ModelParameterControls = {
  ...model.parameterControls,
  background: { defaultValue: false, supported: true },
  reasoningEffort: {
    defaultValue: "medium",
    options: ["none", "medium", "high"],
    supported: true
  },
  reasoningMode: {
    defaultValue: "standard",
    options: ["standard", "pro"],
    supported: true
  },
  stream: { defaultValue: false, supported: true }
};

const visionModel: CatalogModel = {
  ...model,
  capabilities: {
    ...model.capabilities,
    documentInputMode: "native_pdf",
    imageInput: true,
    nativeWebSearch: true,
    reasoning: true
  },
  displayName: "Vision Research Model With A Deliberately Long Name",
  modelId: "vendor/vision-research-model-with-a-deliberately-long-id",
  provider: "openrouter"
};

const gatewayTextModel: CatalogModel = {
  ...model,
  displayName: "Gateway Text Model",
  modelId: "gateway-text-model",
  provider: "openrouter"
};

const profileParameterControls: ModelParameterControls = {
  ...capableParameterControls,
  reasoningEffort: {
    defaultValue: "medium",
    options: ["none", "low", "medium", "high", "xhigh", "max"],
    supported: true
  }
};

function profileModel(modelId: string, upstreamModelId: string, displayName: string): CatalogModel {
  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      nativeWebSearch: true,
      reasoning: true
    },
    displayName,
    modelId,
    parameterControls: profileParameterControls,
    provider: "connection-openai",
    providerFamily: "openai",
    searchStrategyIds: ["search-disabled", "web-search"],
    upstreamModelId
  };
}

const lunaModel = profileModel("deployment-luna", "gpt-5.6-luna", "GPT-5.6 Luna");
const terraModel = profileModel("deployment-terra", "gpt-5.6-terra", "GPT-5.6 Terra");
const solModel = profileModel("deployment-sol", "gpt-5.6-sol", "GPT-5.6 Sol");

function projectedProfile(
  id: "fast" | "balanced" | "deep",
  profileModel: CatalogModel,
  models: CatalogModel[],
  reasoningEffort: string,
  reasoningMode: string
): NonNullable<Catalog["runProfiles"]>[number] {
  const labels = { balanced: "Balanced", deep: "Deep", fast: "Fast" } as const;
  const descriptions = {
    balanced: "Most everyday questions",
    deep: "Difficult or open-ended questions",
    fast: "Simple, well-defined questions"
  } as const;
  if (!models.some(
    (candidate) => candidate.provider === profileModel.provider && candidate.modelId === profileModel.modelId
  )) {
    return {
      available: false,
      description: descriptions[id],
      id,
      label: labels[id],
      unavailableReason: "model_unavailable"
    };
  }
  const readable = (value: string) => value === "max"
    ? "Maximum"
    : value.replace(/^./, (letter) => letter.toUpperCase());
  return {
    available: true,
    configurationLabel: [profileModel.displayName, readable(reasoningMode), readable(reasoningEffort)].join(" · "),
    description: descriptions[id],
    id,
    label: labels[id],
    modelId: profileModel.modelId,
    provider: profileModel.provider,
    reasoningEffort,
    reasoningMode
  };
}

function profileCatalog(models: CatalogModel[] = [model, lunaModel, terraModel, solModel]): Catalog {
  return {
    ...catalog,
    models,
    providers: [
      { id: "fake", models: [model.modelId], name: "Fake" },
      {
        id: "connection-openai",
        models: models.filter((candidate) => candidate.provider === "connection-openai").map((candidate) => candidate.modelId),
        name: "OpenAI"
      }
    ],
    runProfiles: [
      projectedProfile("fast", lunaModel, models, "medium", "standard"),
      projectedProfile("balanced", terraModel, models, "medium", "standard"),
      projectedProfile("deep", solModel, models, "max", "pro")
    ]
  };
}

function createControlsProps(overrides: Partial<ComposerControlsProps> = {}): ComposerControlsProps {
  const renderedCatalog = "catalog" in overrides ? (overrides.catalog ?? null) : catalog;
  const currentModel = "currentModel" in overrides ? overrides.currentModel : model;

  return {
    backgroundMode: false,
    catalog: renderedCatalog,
    currentModel,
    currentParameterControls:
      overrides.currentParameterControls ?? currentModel?.parameterControls ?? model.parameterControls,
    currentPrompt: renderedCatalog?.promptPresets[0] ?? null,
    maxOutputTokens: "1024",
    notificationSoundEnabled: false,
    reasoningEffort: "none",
    reasoningMode: "standard",
    searchOptions: renderedCatalog?.searchStrategies ?? [],
    selectedModelId: "fake-qsa",
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

function openRunSettings() {
  const trigger = screen.getByRole("button", { name: "Run settings" });
  fireEvent.click(trigger);
  return screen.getByRole("dialog", { name: "Run settings" });
}

function openRunSetup() {
  const trigger = screen.getByTestId("composer-run-summary");
  fireEvent.click(trigger);
  return screen.getByRole("dialog", { name: "Run setup" });
}

describe("ComposerControls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps Model, Reasoning, Search, and Run settings visible while advanced controls stay disclosed", () => {
    const { props } = renderControls();
    const controls = screen.getByTestId("composer-control-bar");
    const modelButton = within(controls).getByRole("button", { name: "Select model" });
    const searchButton = within(controls).getByRole("button", { name: "Search strategy" });
    const reasoningButton = within(controls).getByRole("button", { name: "Reasoning effort" });
    const settingsButton = within(controls).getByRole("button", { name: "Run settings" });

    expect(controls).toHaveAttribute("data-layout", "focused");
    expect(within(modelButton).getByText("Fake QSA")).toBeVisible();
    expect(modelButton).not.toHaveTextContent("Fake / Fake QSA");
    expect(modelButton).toHaveAttribute("title", "Fake / Fake QSA");
    expect(modelButton).toHaveAccessibleDescription("Fake / Fake QSA");
    expect(within(searchButton).getByText("Off")).toBeVisible();
    expect(searchButton).toHaveAccessibleDescription("No Search");
    expect(reasoningButton).toHaveTextContent("Not supported");
    expect(reasoningButton).toBeDisabled();
    expect(settingsButton).toHaveAttribute("aria-expanded", "false");
    expect(settingsButton).toHaveAttribute("aria-controls", "run-settings-panel");
    expect(screen.queryByRole("button", { name: "Provider" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Prompt preset" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Temperature")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Max output tokens")).not.toBeInTheDocument();

    fireEvent.click(searchButton);
    fireEvent.click(screen.getByTestId("search-select-options").querySelector('[data-option-value="web-search"]')!);
    expect(props.onSearchStrategyChange).toHaveBeenCalledWith("web-search");
  });

  it("keeps compact run summaries while exposing full values and full picker options", () => {
    const proParameterControls: ModelParameterControls = {
      ...capableParameterControls,
      reasoningEffort: {
        defaultValue: "medium",
        options: ["medium", "high", "max"],
        supported: true
      }
    };
    renderControls({
      currentParameterControls: proParameterControls,
      reasoningEffort: "max",
      reasoningMode: "pro",
      selectedSearchStrategy: "web-search"
    });

    const modelButton = screen.getByRole("button", { name: "Select model" });
    const reasoningButton = screen.getByRole("button", { name: "Reasoning effort" });
    const searchButton = screen.getByRole("button", { name: "Search strategy" });

    expect(within(modelButton).getByText("Fake QSA")).toBeVisible();
    expect(modelButton).toHaveAccessibleDescription("Fake / Fake QSA");
    expect(within(reasoningButton).getByText("Pro · Max")).toBeVisible();
    expect(reasoningButton).toHaveAttribute("title", "Pro mode, Maximum effort");
    expect(reasoningButton).toHaveAccessibleDescription("Pro mode, Maximum effort");
    expect(within(searchButton).getByText("OpenAI")).toBeVisible();
    expect(searchButton).toHaveAttribute("title", "Web Search");
    expect(searchButton).toHaveAccessibleDescription("Web Search");

    fireEvent.click(reasoningButton);
    expect(within(screen.getByTestId("composer-reasoning-effort-options")).getByText("Maximum")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close reasoning effort picker" }));

    fireEvent.click(searchButton);
    expect(within(screen.getByTestId("search-select-options")).getByText("Web Search")).toBeVisible();
  });

  it("keeps profile, reasoning, model, and search state explicit in the narrow Run summary", () => {
    renderControls({
      catalog: profileCatalog(),
      currentModel: solModel,
      currentParameterControls: solModel.parameterControls,
      reasoningEffort: "max",
      reasoningMode: "pro",
      selectedModelId: solModel.modelId,
      selectedProvider: solModel.provider,
      selectedProviderName: "OpenAI",
      selectedSearchStrategy: "web-search"
    });

    const summary = screen.getByTestId("composer-run-summary");
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(summary).toHaveAccessibleName(
      "Open run setup. Profile Deep. Model GPT-5.6 Sol. Reasoning Pro mode, Maximum effort. Search OpenAI."
    );
    expect(screen.getByTestId("run-profile-summary")).toHaveTextContent("Deep");
    expect(screen.getByTestId("run-profile-summary")).toHaveAttribute("data-level", "3");
    expect(screen.getByTestId("run-reasoning-summary")).toHaveTextContent("Pro · Max");
    expect(screen.getByTestId("run-reasoning-summary")).toHaveAttribute("data-level", "5");
    expect(screen.getByTestId("run-model-summary")).toHaveTextContent("GPT-5.6 Sol");
    expect(screen.getByTestId("run-search-summary")).toHaveTextContent("Search: OpenAI");
  });

  it("uses explicit Custom, unsupported Reasoning, and Search Off summary states", () => {
    const unsupported = renderControls();

    expect(screen.getByTestId("run-profile-summary")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("run-reasoning-summary")).toHaveTextContent("Not supported");
    expect(screen.getByTestId("run-reasoning-summary")).toHaveAttribute("data-level", "0");
    expect(screen.getByTestId("run-search-summary")).toHaveTextContent("Search: Off");
    unsupported.unmount();

    const customCatalog = profileCatalog();
    renderControls({
      catalog: customCatalog,
      currentModel: terraModel,
      currentParameterControls: terraModel.parameterControls,
      reasoningEffort: "high",
      reasoningMode: "standard",
      selectedModelId: terraModel.modelId,
      selectedProvider: terraModel.provider,
      selectedProviderName: "OpenAI"
    });
    expect(screen.getByTestId("run-profile-summary")).toHaveTextContent("Custom");
  });

  it("opens one Run setup sheet with the full direct and advanced inventory", async () => {
    const props = createControlsProps({
      catalog: profileCatalog(),
      currentModel: solModel,
      currentParameterControls: solModel.parameterControls,
      reasoningEffort: "max",
      reasoningMode: "pro",
      selectedModelId: solModel.modelId,
      selectedProvider: solModel.provider,
      selectedProviderName: "OpenAI",
      selectedSearchStrategy: "web-search"
    });
    render(<ComposerControls {...props} />);

    const trigger = screen.getByTestId("composer-run-summary");
    trigger.focus();
    const sheet = openRunSetup();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("run-setup-content")).toHaveClass("max-sm:overflow-y-auto");
    expect(within(sheet).getByTestId("composer-run-profiles")).toBeVisible();
    expect(within(sheet).getByRole("button", { name: "Select model" })).toBeVisible();
    expect(within(sheet).getByRole("button", { name: "Reasoning effort" })).toBeVisible();
    expect(within(sheet).getByRole("button", { name: "Search strategy" })).toBeVisible();
    expect(within(sheet).getByText("Advanced settings")).toBeVisible();
    expect(within(sheet).getByLabelText("Temperature")).toBeVisible();
    expect(within(sheet).getByLabelText("Max output tokens")).toBeVisible();
    expect(within(sheet).getByLabelText("Reasoning mode")).toHaveValue("pro");
    expect(within(sheet).getByRole("button", { name: "Show reasoning blocks" })).toBeVisible();

    fireEvent.click(within(sheet).getByRole("button", { name: "Select model" }));
    expect(screen.getByTestId("model-picker")).toHaveClass(
      "z-[90]",
      "border-separator-strong"
    );
    expect(screen.getByTestId("model-picker-backdrop")).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to Run setup" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Close model picker" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Run setup" })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Choose a model" })).toHaveAttribute(
      "aria-modal",
      "false"
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to Run setup" }));
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "Select model" })).toHaveFocus());

    fireEvent.click(within(sheet).getByRole("button", { name: "Close run setup" }));
    expect(screen.queryByRole("dialog", { name: "Run setup" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(props.onTemperatureCommit).toHaveBeenCalled();
    expect(props.onMaxOutputTokensCommit).toHaveBeenCalled();
  });

  it("keeps nested picker Escape local before closing Run setup", async () => {
    renderControls({
      currentModel: visionModel,
      currentParameterControls: capableParameterControls,
      reasoningEffort: "high"
    });
    const trigger = screen.getByTestId("composer-run-summary");
    const sheet = openRunSetup();
    const reasoning = within(sheet).getByRole("button", { name: "Reasoning effort" });
    fireEvent.click(reasoning);
    expect(screen.getByTestId("composer-reasoning-effort-options")).toBeVisible();

    fireEvent.keyDown(reasoning, { key: "Escape" });
    expect(screen.queryByTestId("composer-reasoning-effort-options")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Run setup" })).toBeVisible();
    await waitFor(() => expect(reasoning).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Run setup" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps nested model picker Escape and backdrop local to Run setup", async () => {
    renderControls({
      currentModel: visionModel,
      currentParameterControls: capableParameterControls
    });
    const sheet = openRunSetup();
    const modelTrigger = within(sheet).getByRole("button", { name: "Select model" });

    fireEvent.click(modelTrigger);
    const search = screen.getByLabelText("Search models");
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByTestId("model-picker")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Run setup" })).toBeVisible();
    await waitFor(() => expect(modelTrigger).toHaveFocus());

    fireEvent.click(modelTrigger);
    expect(screen.getByTestId("model-picker-backdrop")).toBeVisible();
    fireEvent.mouseDown(screen.getByTestId("model-picker-backdrop"));
    expect(screen.queryByTestId("model-picker")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Run setup" })).toBeVisible();
    await waitFor(() => expect(modelTrigger).toHaveFocus());
  });

  it("closes Run setup from its backdrop and restores the summary opener", async () => {
    renderControls();
    const trigger = screen.getByTestId("composer-run-summary");
    trigger.focus();
    openRunSetup();

    fireEvent.mouseDown(screen.getByTestId("run-setup-backdrop"));
    expect(screen.queryByRole("dialog", { name: "Run setup" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps the global command shortcut from opening another modal over Run setup", () => {
    renderControls();
    const sheet = openRunSetup();
    const globalKeyDown = vi.fn();
    window.addEventListener("keydown", globalKeyDown);

    fireEvent.keyDown(within(sheet).getByRole("button", { name: "Close run setup" }), {
      ctrlKey: true,
      key: "k"
    });
    expect(globalKeyDown).not.toHaveBeenCalled();
    window.removeEventListener("keydown", globalKeyDown);
    expect(screen.getByRole("dialog", { name: "Run setup" })).toBeVisible();
  });

  it("exposes built-in run profiles directly in the composer", async () => {
    const props = createControlsProps({ catalog: profileCatalog() });
    render(<ComposerControls {...props} />);
    const profiles = screen.getByTestId("composer-run-profiles");
    const modelButton = screen.getByRole("button", { name: "Select model" });
    const fastProfile = within(profiles).getByRole("button", { name: "Use Fast run profile" });
    const balancedProfile = within(profiles).getByRole("button", { name: "Use Balanced run profile" });
    const deepProfile = within(profiles).getByRole("button", { name: "Use Deep run profile" });

    expect(within(profiles).getByText("Custom")).toBeVisible();
    expect(fastProfile).toHaveAccessibleDescription(/GPT-5.6 Luna · Standard · Medium/);
    expect(balancedProfile).toHaveAccessibleDescription(/GPT-5.6 Terra · Standard · Medium/);
    expect(deepProfile).toHaveAccessibleDescription(/GPT-5.6 Sol · Pro · Max/);
    fireEvent.click(fastProfile);

    expect(props.onRunProfileChange).toHaveBeenCalledOnce();
    expect(props.onRunProfileChange).toHaveBeenCalledWith("fast");

    fireEvent.click(modelButton);
    await waitFor(() => expect(screen.getByLabelText("Search models")).toHaveFocus());
    expect(screen.queryByText("Run profiles")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select model OpenAI GPT-5.6 Terra" })).toBeVisible();
  });

  it("marks the exact active profile and disables unavailable siblings without hiding models", () => {
    renderControls({
      catalog: profileCatalog([model, terraModel, solModel]),
      currentModel: solModel,
      currentParameterControls: solModel.parameterControls,
      reasoningEffort: "max",
      reasoningMode: "pro",
      selectedModelId: solModel.modelId,
      selectedProvider: solModel.provider,
      selectedProviderName: "OpenAI"
    });

    const profiles = screen.getByTestId("composer-run-profiles");
    expect(within(profiles).getByRole("button", { name: "Use Deep run profile" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    const fastProfile = screen.getByRole("button", { name: "Use Fast run profile" });
    expect(fastProfile).toBeDisabled();
    expect(fastProfile).toHaveAccessibleDescription(/Fast is not available with your model access/);
    expect(fastProfile).not.toHaveAccessibleDescription(/GPT-5.6 Luna/);

    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    expect(screen.getByRole("button", { name: "Select model OpenAI GPT-5.6 Terra" })).toBeVisible();
  });

  it("does not display stale saved model ids when the user has no entitled models", () => {
    renderControls({
      catalog: {
        ...catalog,
        models: [],
        providers: []
      },
      currentModel: undefined,
      selectedModelId: "",
      selectedProvider: "",
      selectedProviderName: ""
    });

    const modelButton = screen.getByRole("button", { name: "Select model" });
    expect(modelButton).toHaveTextContent("No models available");
    expect(modelButton).toHaveAccessibleDescription("No models available");
    expect(modelButton).toBeDisabled();
    expect(modelButton).not.toHaveTextContent("Fake QSA");
    expect(modelButton).not.toHaveTextContent("gpt-5.5");
    expect(screen.getByRole("button", { name: "Search strategy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reasoning effort" })).toBeDisabled();
  });

  it("distinguishes a failed catalog from catalog loading", () => {
    renderControls({
      catalog: null,
      catalogUnavailable: true,
      currentModel: undefined
    });

    const modelButton = screen.getByRole("button", { name: "Select model" });
    expect(modelButton).toHaveTextContent("Models unavailable");
    expect(modelButton).toHaveAccessibleDescription("Models unavailable");
    expect(modelButton).not.toHaveTextContent("Loading models");
  });

  it("closes open next-run pickers when bootstrap readiness disables the control bar", async () => {
    const searchView = renderControls();
    fireEvent.click(screen.getByRole("button", { name: "Search strategy" }));
    expect(screen.getByTestId("search-select-options")).toBeVisible();

    searchView.rerender(<ComposerControls {...searchView.props} disabled />);
    await waitFor(() => expect(screen.queryByTestId("search-select-options")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Select model" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search strategy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reasoning effort" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run settings" })).toBeDisabled();
    expect(searchView.props.onSearchStrategyChange).not.toHaveBeenCalled();
    searchView.unmount();

    const promptView = renderControls({ currentParameterControls: capableParameterControls });
    const runSettings = openRunSettings();
    fireEvent.click(within(runSettings).getByRole("button", { name: "Prompt preset" }));
    expect(screen.getByTestId("prompt-picker-options")).toBeVisible();

    promptView.rerender(<ComposerControls {...promptView.props} disabled />);
    await waitFor(() => expect(screen.queryByTestId("prompt-picker-options")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run settings" })).not.toBeInTheDocument());
    expect(promptView.props.onPromptChange).not.toHaveBeenCalled();
    promptView.unmount();

    const setupView = renderControls({ currentParameterControls: capableParameterControls });
    openRunSetup();
    setupView.rerender(<ComposerControls {...setupView.props} disabled />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run setup" })).not.toBeInTheDocument());
    expect(screen.getByTestId("composer-run-summary")).toBeDisabled();
    expect(setupView.props.onTemperatureCommit).toHaveBeenCalled();
    expect(setupView.props.onMaxOutputTokensCommit).toHaveBeenCalled();
  });

  it("shows the complete advanced inventory with its current state and emits changes", () => {
    const { props } = renderControls({
      backgroundMode: true,
      currentParameterControls: capableParameterControls,
      notificationSoundEnabled: true,
      reasoningEffort: "medium",
      showReasoningBlocks: true,
      showToolActivity: true,
      streamMode: false
    });
    const dialog = openRunSettings();

    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(within(dialog).getByRole("heading", { name: "Prompt" })).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: "Generation" })).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: "Response behavior" })).toBeVisible();
    const promptTrigger = within(dialog).getByRole("button", { name: "Prompt preset" });
    const reasoningTrigger = within(screen.getByTestId("composer-control-bar")).getByRole("button", {
      name: "Reasoning effort"
    });
    expect(promptTrigger).toHaveTextContent("Helpful Assistant");
    expect(promptTrigger).toHaveAccessibleDescription("Helpful Assistant");
    expect(reasoningTrigger).toHaveTextContent("Medium");
    expect(reasoningTrigger).toHaveAccessibleDescription("Standard mode, Medium effort");
    expect(within(dialog).queryByRole("button", { name: "Reasoning effort" })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Temperature")).toHaveValue(0.7);
    expect(within(dialog).getByLabelText("Max output tokens")).toHaveValue(1024);
    expect(within(dialog).getByLabelText("Reasoning mode")).toHaveValue("standard");
    expect(within(dialog).getByText(/Pro can spend more time and tokens/)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Search strategy" })).not.toBeInTheDocument();

    const background = within(dialog).getByRole("button", { name: "Background mode" });
    const stream = within(dialog).getByRole("button", { name: "Stream response" });
    const citations = within(dialog).getByRole("button", { name: "Hide citations" });
    const reasoningBlocks = within(dialog).getByRole("button", { name: "Hide reasoning blocks" });
    const toolActivity = within(dialog).getByRole("button", { name: "Hide tool activity" });
    const sound = within(dialog).getByRole("button", { name: "Mute answer sound" });
    expect(background).toHaveAttribute("aria-pressed", "true");
    expect(stream).toHaveAttribute("aria-pressed", "false");
    expect(citations).toHaveAttribute("aria-pressed", "true");
    expect(reasoningBlocks).toHaveAttribute("aria-pressed", "true");
    expect(toolActivity).toHaveAttribute("aria-pressed", "true");
    expect(sound).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(background);
    fireEvent.click(stream);
    fireEvent.click(citations);
    fireEvent.click(reasoningBlocks);
    fireEvent.click(toolActivity);
    fireEvent.click(sound);
    expect(props.onBackgroundModeChange).toHaveBeenCalledWith(false);
    expect(props.onStreamModeChange).toHaveBeenCalledWith(true);
    expect(props.onToggleCitations).toHaveBeenCalledOnce();
    expect(props.onToggleReasoningBlocks).toHaveBeenCalledOnce();
    expect(props.onToggleToolActivity).toHaveBeenCalledOnce();
    expect(props.onToggleNotificationSound).toHaveBeenCalledOnce();

    fireEvent.change(within(dialog).getByLabelText("Reasoning mode"), { target: { value: "pro" } });
    expect(props.onReasoningModeChange).toHaveBeenCalledWith("pro");

    fireEvent.click(within(dialog).getByRole("button", { name: "Prompt preset" }));
    expect(screen.getByRole("button", { name: "Close prompt picker" })).toHaveClass("size-11", "lg:size-8");
    fireEvent.click(screen.getByTestId("prompt-picker-options").querySelector('[data-option-value="prompt-research"]')!);
    expect(props.onPromptChange).toHaveBeenCalledWith("prompt-research");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close run settings" }));
    fireEvent.click(reasoningTrigger);
    expect(screen.getByRole("button", { name: "Close reasoning effort picker" })).toHaveClass(
      "size-11",
      "lg:size-8"
    );
    fireEvent.click(
      screen.getByTestId("composer-reasoning-effort-options").querySelector('[data-option-value="high"]')!
    );
    expect(props.onReasoningEffortChange).toHaveBeenCalledWith("high");
  });

  it("promotes advanced pickers for short viewports and keeps the right-column picker contained", () => {
    renderControls({ currentParameterControls: capableParameterControls, reasoningEffort: "medium" });

    const dialog = openRunSettings();
    expect(dialog).toHaveClass(
      "[@media(max-height:32rem)]:fixed",
      "[@media(max-height:32rem)]:!w-auto",
      "overscroll-contain"
    );
    expect(within(dialog).getByRole("button", { name: "Close run settings" })).toHaveClass(
      "[@media(hover:none)]:!size-11"
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Close run settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
    const picker = screen.getByTestId("composer-reasoning-effort-options");
    expect(picker).toHaveClass(
      "right-0",
      "[@media(max-height:32rem)]:fixed",
      "[@media(max-height:32rem)]:!right-[max(.5rem,env(safe-area-inset-right))]"
    );
  });

  it("hides unsupported capability controls and disables unsupported reasoning and temperature", () => {
    renderControls({
      currentParameterControls: {
        ...model.parameterControls,
        temperature: {
          ...model.parameterControls.temperature,
          supported: false
        }
      }
    });
    const dialog = openRunSettings();

    expect(within(dialog).queryByRole("button", { name: "Background mode" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Stream response" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reasoning effort" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reasoning effort" })).toHaveTextContent("Not supported");
    expect(within(dialog).queryByRole("button", { name: "Reasoning effort" })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Reasoning mode")).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Temperature")).toBeDisabled();
    expect(within(dialog).getByLabelText("Max output tokens")).toBeEnabled();
  });

  it("disables next-run controls while streaming but leaves immediate preferences available", () => {
    renderControls({
      currentParameterControls: capableParameterControls,
      streaming: true
    });

    expect(screen.getByRole("button", { name: "Select model" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search strategy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reasoning effort" })).toBeDisabled();
    const dialog = openRunSettings();
    expect(within(dialog).getByRole("button", { name: "Prompt preset" })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Reasoning effort" })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Temperature")).toBeDisabled();
    expect(within(dialog).getByLabelText("Max output tokens")).toBeDisabled();
    expect(within(dialog).getByLabelText("Reasoning mode")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Background mode" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Stream response" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Hide citations" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Show reasoning blocks" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Hide tool activity" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Enable answer sound" })).toBeEnabled();
  });

  it("keeps nested picker Escape local and restores focus to each trigger", async () => {
    renderControls({ currentParameterControls: capableParameterControls });

    const search = screen.getByRole("button", { name: "Search strategy" });
    fireEvent.click(search);
    expect(screen.getByTestId("search-select-options")).toBeVisible();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByTestId("search-select-options")).not.toBeInTheDocument();
    await waitFor(() => expect(search).toHaveFocus());

    const dialog = openRunSettings();
    const prompt = within(dialog).getByRole("button", { name: "Prompt preset" });
    fireEvent.click(prompt);
    expect(screen.getByTestId("prompt-picker-options")).toBeVisible();
    fireEvent.keyDown(prompt, { key: "Escape" });
    expect(screen.queryByTestId("prompt-picker-options")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeVisible();
    await waitFor(() => expect(prompt).toHaveFocus());
  });

  it("searches models by readable context without exposing internal ids", async () => {
    const extendedCatalog: Catalog = {
      ...catalog,
      models: [model, visionModel, gatewayTextModel],
      providers: [
        ...catalog.providers,
        {
          id: "openrouter",
          models: [visionModel.modelId, gatewayTextModel.modelId],
          name: "OpenRouter Gateway"
        }
      ]
    };
    const onSelectModel = vi.fn();
    const props = createControlsProps({
      catalog: extendedCatalog,
      onSelectModel
    });

    render(<ComposerControls {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    const search = screen.getByLabelText("Search models");
    await waitFor(() => expect(search).toHaveFocus());
    const currentModelRow = screen.getByRole("button", { name: "Select model Fake Fake QSA" });
    const providerHeading = screen.getByRole("heading", { name: "Fake" });
    const providerHeader = providerHeading.closest("header");
    expect(providerHeading).toBeVisible();
    expect(providerHeader).not.toBeNull();
    expect(providerHeader).toHaveClass("rounded-control", "bg-surface-raised");
    expect(within(providerHeader!).getByText("Provider")).toBeVisible();
    expect(within(providerHeader!).getByText("1 model")).toBeVisible();
    expect(within(providerHeader!).getByText("Current group")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Provider Fake" })).not.toBeInTheDocument();
    expect(within(currentModelRow).getByText("Current")).toBeVisible();
    expect(within(currentModelRow).getByText("Default")).toBeVisible();
    expect(currentModelRow).toHaveAccessibleDescription(
      "Streaming Current Default"
    );

    fireEvent.change(search, { target: { value: "Gateway" } });
    const visionRow = screen.getByRole("button", { name: /Select model OpenRouter Gateway Vision Research Model/ });
    expect(visionRow).not.toHaveTextContent("openrouter:vendor/vision-research-model-with-a-deliberately-long-id");
    expect(visionRow).toHaveTextContent("Reasoning · Images · PDF and documents · Web search · Streaming");
    expect(visionRow).toHaveAccessibleDescription(
      "Reasoning · Images · PDF and documents · Web search · Streaming"
    );
    expect(
      within(visionRow).getByText("Reasoning · Images · PDF and documents · Web search")
    ).toHaveClass("font-medium", "text-content-secondary");
    expect(within(visionRow).getByText("Streaming")).toHaveClass("text-content-muted");
    expect(screen.queryByRole("button", { name: /Select model Fake Fake QSA/ })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "pdf" } });
    const capabilityFilteredRow = screen.getByRole("button", {
      name: /Select model OpenRouter Gateway Vision Research Model/
    });
    expect(
      within(capabilityFilteredRow).getByText(
        "Reasoning · Images · PDF and documents · Web search"
      )
    ).toHaveClass("font-medium", "text-content-secondary");
    expect(
      screen.queryByRole("button", {
        name: /Select model OpenRouter Gateway Gateway Text Model/
      })
    ).not.toBeInTheDocument();

    fireEvent.keyDown(search, { key: "End" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelectModel).toHaveBeenCalledWith(visionModel);
    expect(screen.queryByTestId("model-picker")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Select model" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    const reopenedSearch = screen.getByLabelText("Search models");
    expect(reopenedSearch).toHaveValue("");
    fireEvent.change(reopenedSearch, { target: { value: "does-not-exist" } });
    expect(screen.getByRole("status")).toHaveTextContent("No models match");
    fireEvent.keyDown(reopenedSearch, { key: "Escape" });
    expect(screen.queryByTestId("model-picker")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Select model" })).toHaveFocus());
  });

  it("closes and resets the model picker when another workflow changes the selected model", async () => {
    const extendedCatalog: Catalog = {
      ...catalog,
      models: [model, visionModel],
      providers: [
        ...catalog.providers,
        { id: "openrouter", models: [visionModel.modelId], name: "OpenRouter Gateway" }
      ]
    };
    const props = createControlsProps({ catalog: extendedCatalog });
    const view = render(<ComposerControls {...props} />);
    const trigger = screen.getByRole("button", { name: "Select model" });

    fireEvent.click(trigger);
    const search = screen.getByLabelText("Search models");
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "Gateway" } });
    expect(screen.getByRole("button", { name: /Select model OpenRouter Gateway Vision Research Model/ })).toBeVisible();

    view.rerender(
      <ComposerControls
        {...props}
        currentModel={visionModel}
        currentParameterControls={visionModel.parameterControls}
        selectedModelId={visionModel.modelId}
        selectedProvider="openrouter"
        selectedProviderName="OpenRouter Gateway"
      />
    );

    await waitFor(() => expect(screen.queryByTestId("model-picker")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveTextContent("Vision Research Model With A Deliberately Long Name");
    expect(trigger).not.toHaveTextContent("OpenRouter Gateway /");
    expect(trigger).toHaveAttribute(
      "title",
      "OpenRouter Gateway / Vision Research Model With A Deliberately Long Name"
    );
    expect(trigger).toHaveAccessibleDescription(
      "OpenRouter Gateway / Vision Research Model With A Deliberately Long Name"
    );
    expect(props.onSelectModel).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    expect(screen.getByLabelText("Search models")).toHaveValue("");
  });

  it("supports roving keyboard selection and outside-close for search and prompt pickers", async () => {
    const { props } = renderControls({ currentParameterControls: capableParameterControls });
    const searchTrigger = screen.getByRole("button", { name: "Search strategy" });
    fireEvent.click(searchTrigger);
    const searchOptions = screen.getByTestId("search-select-options");
    const currentSearch = within(searchOptions).getByRole("button", { name: /No Search/ });
    await waitFor(() => expect(currentSearch).toHaveFocus());
    expect(currentSearch).toHaveTextContent("Current");
    expect(currentSearch).toHaveTextContent("Default");
    fireEvent.keyDown(currentSearch, { key: "End" });
    const webSearch = within(searchOptions).getByRole("button", { name: /Web Search/ });
    expect(webSearch).toHaveFocus();
    fireEvent.keyDown(webSearch, { key: "Enter" });
    expect(props.onSearchStrategyChange).toHaveBeenCalledWith("web-search");
    await waitFor(() => expect(searchTrigger).toHaveFocus());

    const dialog = openRunSettings();
    const promptTrigger = within(dialog).getByRole("button", { name: "Prompt preset" });
    fireEvent.click(promptTrigger);
    const promptSearch = screen.getByLabelText("Search prompt presets");
    await waitFor(() => expect(promptSearch).toHaveFocus());
    fireEvent.change(promptSearch, { target: { value: "carefully" } });
    fireEvent.keyDown(promptSearch, { key: "End" });
    fireEvent.keyDown(promptSearch, { key: "Enter" });
    expect(props.onPromptChange).toHaveBeenCalledWith("prompt-research");
    await waitFor(() => expect(promptTrigger).toHaveFocus());

    fireEvent.click(promptTrigger);
    expect(screen.getByLabelText("Search prompt presets")).toHaveValue("");
    fireEvent.pointerDown(within(dialog).getByRole("heading", { name: "Run settings" }));
    expect(screen.queryByTestId("prompt-picker-options")).not.toBeInTheDocument();
    await waitFor(() => expect(promptTrigger).toHaveFocus());
  });

  it("does not move option focus when pointer hover changes the active picker row", async () => {
    renderControls();
    fireEvent.click(screen.getByRole("button", { name: "Search strategy" }));

    const searchOptions = screen.getByTestId("search-select-options");
    const currentSearch = within(searchOptions).getByRole("button", { name: /No Search/ });
    const webSearch = within(searchOptions).getByRole("button", { name: /Web Search/ });
    await waitFor(() => expect(currentSearch).toHaveFocus());

    fireEvent.mouseMove(webSearch);

    expect(currentSearch).toHaveFocus();
    expect(webSearch).toHaveAttribute("tabindex", "0");
    expect(currentSearch).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(currentSearch, { key: "ArrowDown" });
    expect(webSearch).toHaveFocus();
  });

  it("flushes numeric drafts on blur, Enter, and explicit close", () => {
    const { props } = renderControls({ currentParameterControls: capableParameterControls });
    const dialog = openRunSettings();
    const temperature = within(dialog).getByLabelText("Temperature");
    const maxOutputTokens = within(dialog).getByLabelText("Max output tokens");

    temperature.focus();
    fireEvent.change(temperature, { target: { value: "0.9" } });
    temperature.blur();
    expect(props.onTemperatureChange).toHaveBeenCalledWith("0.9");
    expect(props.onTemperatureCommit).toHaveBeenCalledOnce();

    maxOutputTokens.focus();
    fireEvent.change(maxOutputTokens, { target: { value: "2048" } });
    fireEvent.keyDown(maxOutputTokens, { key: "Enter" });
    expect(props.onMaxOutputTokensChange).toHaveBeenCalledWith("2048");
    expect(props.onMaxOutputTokensCommit).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeVisible();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close run settings" }));
    expect(screen.queryByRole("dialog", { name: "Run settings" })).not.toBeInTheDocument();
    expect(props.onTemperatureCommit).toHaveBeenCalledTimes(2);
    expect(props.onMaxOutputTokensCommit).toHaveBeenCalledTimes(2);
  });

  it("opens prompt management only after closing and flushing Run settings", async () => {
    const { props } = renderControls({ currentParameterControls: capableParameterControls });
    const dialog = openRunSettings();

    fireEvent.click(within(dialog).getByRole("button", { name: "Manage prompts" }));

    expect(screen.queryByRole("dialog", { name: "Run settings" })).not.toBeInTheDocument();
    expect(props.onTemperatureCommit).toHaveBeenCalledOnce();
    expect(props.onMaxOutputTokensCommit).toHaveBeenCalledOnce();
    await waitFor(() => expect(props.onOpenPromptSettings).toHaveBeenCalledOnce());
  });

  it("closes on Escape and outside pointer input, flushes, and restores opener focus", async () => {
    const { props } = renderControls({ currentParameterControls: capableParameterControls });
    const trigger = screen.getByRole("button", { name: "Run settings" });
    trigger.focus();
    let dialog = openRunSettings();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Manage prompts" })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Run settings" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(props.onTemperatureCommit).toHaveBeenCalledOnce();
    expect(props.onMaxOutputTokensCommit).toHaveBeenCalledOnce();

    dialog = openRunSettings();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Manage prompts" })).toHaveFocus());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Run settings" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(props.onTemperatureCommit).toHaveBeenCalledTimes(2);
    expect(props.onMaxOutputTokensCommit).toHaveBeenCalledTimes(2);
  });

  it("keeps the model picker and Run settings mutually exclusive", async () => {
    const { props } = renderControls({ currentParameterControls: capableParameterControls });
    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    expect(screen.getByTestId("model-picker")).toBeVisible();
    expect(screen.getByRole("button", { name: "Close model picker" })).toHaveClass("size-11", "lg:size-8");
    expect(screen.queryByRole("button", { name: "Back to Run setup" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("model-picker-backdrop")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Search models")).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Run settings" }));
    expect(screen.queryByTestId("model-picker")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    expect(screen.queryByRole("dialog", { name: "Run settings" })).not.toBeInTheDocument();
    expect(screen.getByTestId("model-picker")).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText("Search models")).toHaveFocus());
    expect(props.onTemperatureCommit).toHaveBeenCalledOnce();
    expect(props.onMaxOutputTokensCommit).toHaveBeenCalledOnce();
  });
});
