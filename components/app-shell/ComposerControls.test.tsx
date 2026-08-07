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
    provider: "fake",
    searchStrategyId: "search-disabled",
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true
  },
  models: [fastModel, balancedModel, deepModel],
  providers: [{ id: "fake", models: [fastModel.modelId, balancedModel.modelId, deepModel.modelId], name: "Fake" }],
  searchStrategies: [
    { displayName: "No Search", kind: "none", strategyId: "search-disabled" },
    { displayName: "Web Search", kind: "openai_native_web_search", strategyId: "web-search" }
  ]
};

type ComposerAssistantView = ComposerControlsProps["assistant"];

function createAssistantView(
  overrides: Partial<ComposerAssistantView> = {}
): ComposerAssistantView {
  return {
    clearRemovedNotice: vi.fn(),
    openLibrary: vi.fn(),
    openPicker: false,
    pickerItems: [],
    pickerLoading: false,
    recentIds: [],
    remove: vi.fn(),
    removedNotice: false,
    selectById: vi.fn(),
    selected: null,
    sendStarter: vi.fn(),
    setPickerOpen: vi.fn(),
    startFromCurrentSetup: vi.fn(),
    ...overrides
  };
}

const selectedAssistant = {
  avatar: {
    accents: [0],
    backgroundShape: "circle" as const,
    foregroundShape: "diamond" as const,
    kind: "generated" as const,
    paletteId: "ocean" as const,
    recipeVersion: 1 as const,
    rotations: [0, 1] as [0, 1]
  },
  description: "Careful researcher",
  id: "assistant-research",
  name: "Research Helper",
  promptCharacterCount: 240,
  starterPrompts: ["Summarize the latest findings"]
};

function createControlsProps(overrides: Partial<ComposerControlsProps> = {}): ComposerControlsProps {
  const renderedCatalog = "catalog" in overrides ? (overrides.catalog ?? null) : catalog;
  const currentModel = "currentModel" in overrides ? overrides.currentModel : balancedModel;

  return {
    assistant: createAssistantView(),
    backgroundMode: false,
    catalog: renderedCatalog,
    contextLine: "Approx. input: ~21k / 115k safe input · 128k total context",
    currentModel,
    currentParameterControls: overrides.currentParameterControls ?? currentModel?.parameterControls ?? parameterControls,
    maxOutputTokens: "2048",
    notificationSoundEnabled: false,
    reasoningEffort: "medium",
    reasoningMode: "standard",
    searchOptions: renderedCatalog?.searchStrategies ?? [],
    selectedModelId: balancedModel.modelId,
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
    onReasoningEffortChange: vi.fn(),
    onReasoningModeChange: vi.fn(),
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps model and search directly reachable beside an explicit More control", () => {
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
    expect(screen.queryByTestId("run-profile-summary")).not.toBeInTheDocument();
    expect(screen.getByTestId("run-reasoning-summary")).toHaveTextContent("Reasoning: Standard · Medium");
    expect(screen.getByTestId("run-search-summary")).toHaveTextContent("Search: Off");
    expect(summary).toHaveAccessibleName(
      "Open more run settings. Model Balanced Research. Reasoning Standard mode, Medium effort. Search Off."
    );
    const model = within(controls).getByRole("button", { name: "Select model" });
    expect(model).toBeVisible();
    expect(within(model).queryByText("Model", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-assistant-chip-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-assistant-removed-notice")).not.toBeInTheDocument();
    const search = within(controls).getByRole("button", { name: "Search strategy" });
    expect(search).toBeVisible();
    expect(within(search).getByText("Search")).toHaveClass("max-[429px]:sr-only");
    expect(search.querySelector(".lucide-search")).toHaveClass("max-[429px]:block");
    expect(within(search).getAllByText("Off")[0]).toHaveClass("min-[430px]:hidden");
    expect(within(controls).queryByRole("button", { name: "Reasoning effort" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run settings" })).not.toBeInTheDocument();
    expect(summary.querySelector(".lucide-chevron-right")).not.toBeInTheDocument();
    expect(screen.getByTestId("run-model-summary").closest("div.relative")).toHaveClass(
      "max-w-full",
      "min-w-[min(14rem,100%)]",
      "flex-[1_1_16rem]"
    );
    expect(screen.getByTestId("composer-secondary-controls")).toHaveClass(
      "max-w-full",
      "flex-[1_1_20rem]",
      "flex-nowrap",
      "min-w-[min(20rem,100%)]"
    );
    expect(screen.getByTestId("composer-secondary-controls")).not.toHaveClass("flex-wrap");
    expect(screen.getByTestId("composer-secondary-controls")).toHaveAttribute(
      "data-has-direct-reasoning",
      "true"
    );
    expect(controls.querySelector('[data-composer-direct-reasoning="true"]')).toHaveClass(
      "hidden",
      "min-w-0",
      "max-w-[11rem]",
      "flex-[1_1_8rem]",
      "[@media(max-height:42rem)]:!hidden"
    );
  });

  it("routes the direct model and search controls through the existing actions", () => {
    const { props } = renderControls();

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

  it("shows the selected assistant chip and the strict-identity removal notice", () => {
    const assistant = createAssistantView({ removedNotice: true, selected: selectedAssistant });
    renderControls({ assistant });

    const chipRow = screen.getByTestId("composer-assistant-chip-row");
    const chip = within(chipRow).getByTestId("composer-assistant-chip");
    expect(chip).toHaveTextContent("Research Helper");
    fireEvent.click(chip);
    expect(assistant.setPickerOpen).toHaveBeenCalledWith(true);

    const notice = screen.getByTestId("composer-assistant-removed-notice");
    expect(notice).toHaveTextContent("Assistant removed. Your manual settings now apply.");
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss" }));
    expect(assistant.clearRemovedNotice).toHaveBeenCalledOnce();

    expect(screen.getByTestId("composer-run-summary")).toHaveAccessibleName(
      "Open more run settings. Assistant Research Helper. Model Balanced Research. Reasoning Standard mode, Medium effort. Search Off."
    );
  });

  it("mounts the assistant picker only while the view marks it open", () => {
    const view = renderControls();
    expect(screen.queryByTestId("assistant-picker")).not.toBeInTheDocument();

    view.rerender(
      <ComposerControls {...view.props} assistant={createAssistantView({ openPicker: true })} />
    );
    expect(screen.getByTestId("assistant-picker")).toBeVisible();
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

  it("prints exact non-default mode, effort, and search names", () => {
    renderControls({
      currentModel: deepModel,
      currentParameterControls: deepModel.parameterControls,
      reasoningEffort: "max",
      reasoningMode: "pro",
      selectedModelId: deepModel.modelId,
      selectedSearchStrategy: "web-search"
    });

    expect(screen.getByTestId("run-model-summary")).toHaveTextContent("Deep Research");
    expect(screen.getByTestId("run-reasoning-summary")).toHaveTextContent("Reasoning: Pro · Maximum");
    expect(screen.getByTestId("run-search-summary")).toHaveTextContent("Search: Web Search");
    const search = screen.getByRole("button", { name: "Search strategy" });
    const searchLabels = within(search).getAllByText("Web Search");
    expect(searchLabels).toHaveLength(2);
    expect(searchLabels[0]).toHaveClass("min-[430px]:hidden");
    expect(searchLabels[1]).toHaveClass("hidden", "min-[430px]:inline");
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

  it("marks client Search unavailable with attachments while retaining the selection", () => {
    const perplexity = {
      adapterKind: "provider_model_client" as const,
      displayName: "Perplexity tool",
      kind: "perplexity_tool_search" as const,
      privacy: "query_only" as const,
      strategyId: "perplexity-tool-search"
    };
    renderControls({
      compatibleSearchOptionIds: [perplexity.strategyId],
      hasAttachments: true,
      searchOptions: [perplexity],
      selectedSearchOptionIds: [perplexity.strategyId],
      selectedSearchStrategy: perplexity.strategyId
    });

    const trigger = screen.getByRole("button", { name: "Search strategy" });
    expect(trigger).toHaveAttribute("title", "0 active · 1 unavailable");
    fireEvent.click(trigger);
    expect(screen.getByText(
      "This Search source is unavailable while this message has attachments · preference retained"
    )).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close Search picker" }));
    expect(openRunSetup()).toHaveTextContent(
      "Unavailable with attachments for this model"
    );
  });

  it("keeps provider-hosted Search compatible with attachments", () => {
    const hosted = {
      adapterKind: "answer_provider_hosted" as const,
      displayName: "OpenAI Web Search",
      kind: "openai_native_web_search" as const,
      privacy: "answer_provider" as const,
      strategyId: "web-search"
    };
    renderControls({
      compatibleSearchOptionIds: [hosted.strategyId],
      hasAttachments: true,
      searchOptions: [hosted],
      selectedSearchOptionIds: [hosted.strategyId],
      selectedSearchStrategy: hosted.strategyId
    });

    expect(screen.getByRole("button", { name: "Search strategy" })).toHaveAttribute(
      "title",
      "OpenAI Web Search"
    );
  });

  it("projects mixed attachment capabilities without dropping the retained client choice", () => {
    const clientId = "client-search";
    const hostedId = "hosted-search";
    const searchOptions = [
      {
        displayName: "Hosted Search",
        kind: "web_search" as const,
        strategyId: hostedId
      },
      {
        displayName: "Client Search",
        kind: "web_search" as const,
        strategyId: clientId
      }
    ];
    const currentModel = {
      ...balancedModel,
      searchOptionCompatibility: {
        [clientId]: {
          attachments: false,
          clientToolCompatible: true,
          executionModes: ["all_selected", "model_choice"] as Array<
            "all_selected" | "model_choice"
          >
        },
        [hostedId]: {
          attachments: true,
          clientToolCompatible: false,
          executionModes: ["model_choice"] as Array<"model_choice">
        }
      },
      searchStrategyIds: ["search-disabled", hostedId, clientId]
    };
    renderControls({
      currentModel,
      hasAttachments: true,
      searchOptions,
      selectedSearchOptionIds: [hostedId, clientId],
      selectedSearchStrategy: hostedId
    });

    const trigger = screen.getByRole("button", { name: "Search strategy" });
    expect(trigger).toHaveAttribute("title", "1 active · 1 unavailable");
    fireEvent.click(trigger);
    expect(screen.getByText(
      "This Search source is unavailable while this message has attachments · preference retained"
    )).toBeVisible();
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
    expect(within(dialog).getByRole("heading", { name: "Answer setup" })).toBeVisible();
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
    expect(within(dialog).getByRole("heading", { name: "Assistant" })).toBeVisible();
    expect(within(dialog).getByTestId("run-setup-use-assistant")).toHaveTextContent("Use an assistant…");
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

  it("hands off from Run setup to the assistant picker without a second owner", () => {
    vi.useFakeTimers();
    const assistant = createAssistantView();
    const { props } = renderControls({ assistant });
    const dialog = openRunSetup();

    fireEvent.click(within(dialog).getByTestId("run-setup-use-assistant"));
    expect(screen.queryByRole("dialog", { name: "Run setup" })).not.toBeInTheDocument();
    expect(props.onTemperatureCommit).toHaveBeenCalledOnce();
    expect(props.onMaxOutputTokensCommit).toHaveBeenCalledOnce();
    expect(assistant.setPickerOpen).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    expect(assistant.setPickerOpen).toHaveBeenCalledWith(true);
    vi.useRealTimers();
  });

  it("labels the Run setup assistant action for the current selection", () => {
    renderControls({ assistant: createAssistantView({ selected: selectedAssistant }) });
    const dialog = openRunSetup();

    expect(dialog).toHaveTextContent(
      "Using Research Helper. Changing any governed control removes it."
    );
    expect(within(dialog).getByTestId("run-setup-use-assistant")).toHaveTextContent(
      "Change assistant…"
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

  it("routes reasoning, search, generation, and response controls through existing actions", () => {
    const { props } = renderControls();
    const dialog = openRunSetup();

    fireEvent.click(within(dialog).getByRole("button", { name: "Reasoning effort" }));
    fireEvent.click(screen.getByRole("button", { name: /High model reasoning effort/i }));
    expect(props.onReasoningEffortChange).toHaveBeenCalledWith("high");

    fireEvent.click(within(dialog).getByRole("button", { name: "Search strategy" }));
    fireEvent.click(screen.getByRole("button", { name: /Web Search/i }));
    expect(props.onSearchStrategyChange).toHaveBeenCalledWith("web-search");

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

  it("keeps global command shortcuts from escaping an open Run setup", () => {
    renderControls();
    const dialog = openRunSetup();
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "k" });
    dialog.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
