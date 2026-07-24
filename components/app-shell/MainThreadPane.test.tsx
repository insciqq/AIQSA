import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatDeleteConfirmationDialog,
  DiscardChangesConfirmationDialog,
  FolderDeleteConfirmationDialog,
  MessageDeleteConfirmationDialog,
  PromptDeleteConfirmationDialog
} from "./ConfirmationDialog";
import { MainThreadPane } from "./MainThreadPane";
import { defaultParameterControls } from "./controlDefaults";
import { resetMcpSettingsStoreForTest, useMcpSettingsStore } from "./mcpSettingsStore";
import type { Catalog, CatalogModel, ChatSummary, FolderSummary, ThreadMessage } from "./types";

beforeEach(() => {
  resetMcpSettingsStoreForTest();
  useMcpSettingsStore.setState({ loadState: "ready" });
});

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
    stream: { defaultValue: true, supported: true },
    temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
  },
  provider: "fake",
  searchStrategyIds: ["search-disabled"]
};

const catalog: Catalog = {
  defaults: {
    controlValues: {},
    modelId: "fake-qsa",
    promptPresetId: null,
    provider: "fake",
    searchStrategyId: "search-disabled",
    showCitations: true,
    showReasoningBlocks: false,
    showToolActivity: true,
  },
  models: [model],
  promptPresets: [],
  providers: [{ id: "fake", models: ["fake-qsa"], name: "Fake" }],
  searchStrategies: [{ displayName: "No Search", kind: "none", strategyId: "search-disabled" }]
};

const deepProfileModel: CatalogModel = {
  ...model,
  capabilities: {
    ...model.capabilities,
    reasoning: true
  },
  displayName: "GPT-5.6 Sol",
  modelId: "deployment-sol",
  parameterControls: {
    ...model.parameterControls,
    reasoningEffort: {
      defaultValue: "max",
      options: ["medium", "high", "max"],
      supported: true
    },
    reasoningMode: {
      defaultValue: "pro",
      options: ["standard", "pro"],
      supported: true
    }
  },
  provider: "connection-openai",
  providerFamily: "openai",
  upstreamModelId: "gpt-5.6-sol"
};

const deepProfileCatalog: Catalog = {
  ...catalog,
  defaults: {
    ...catalog.defaults,
    modelId: deepProfileModel.modelId,
    provider: deepProfileModel.provider
  },
  models: [deepProfileModel],
  providers: [{ id: deepProfileModel.provider, models: [deepProfileModel.modelId], name: "OpenAI" }],
  runProfiles: [
    {
      available: false,
      description: "Simple, well-defined questions",
      id: "fast",
      label: "Fast",
      unavailableReason: "model_unavailable"
    },
    {
      available: false,
      description: "Most everyday questions",
      id: "balanced",
      label: "Balanced",
      unavailableReason: "model_unavailable"
    },
    {
      available: true,
      configurationLabel: "GPT-5.6 Sol · Pro · Maximum",
      description: "Difficult or open-ended questions",
      id: "deep",
      label: "Deep",
      modelId: deepProfileModel.modelId,
      provider: deepProfileModel.provider,
      reasoningEffort: "max",
      reasoningMode: "pro"
    }
  ]
};

const readyComposerOverrides: Partial<ComponentProps<typeof MainThreadPane>> = {
  catalog,
  currentModel: model,
  currentParameterControls: model.parameterControls,
  searchOptions: catalog.searchStrategies
};

function userMessage(id: string, content = "Question"): ThreadMessage {
  return {
    content,
    id,
    parentMessageId: null,
    role: "user",
    status: "complete"
  };
}

function assistantMessage(
  id: string,
  overrides: Partial<ThreadMessage> = {}
): ThreadMessage {
  return {
    content: "Answer",
    id,
    modelId: "fake-qsa",
    parentMessageId: "question-1",
    provider: "fake",
    role: "assistant",
    status: "complete",
    ...overrides
  };
}

function renderPane(overrides: Partial<ComponentProps<typeof MainThreadPane>> = {}) {
  const props: ComponentProps<typeof MainThreadPane> = {
    activeChatDetailError: null,
    activeChatDetailLoading: false,
    activeChatId: "chat-1",
    activeChatStreaming: false,
    attachments: [],
    backgroundMode: false,
    catalog: null,
    catalogError: null,
    changeBackgroundMode: vi.fn(),
    changeMaxOutputTokens: vi.fn(),
    changeReasoningEffort: vi.fn(),
    changeReasoningMode: vi.fn(),
    changeStreamMode: vi.fn(),
    changeTemperature: vi.fn(),
    composerActions: {
      cancelMessageEdit: vi.fn(),
      changeDraft: vi.fn(),
      rejectAttachments: vi.fn(),
      removeAttachment: vi.fn()
    },
    composerContextLine: null,
    composerDisabledHint: null,
    composerSessionKey: "chat:chat-1",
    composerUsageStats: null,
    copyVisibleThread: vi.fn(),
    creatingChat: false,
    currentModel: undefined,
    currentParameterControls: defaultParameterControls(null),
    currentPrompt: null,
    currentRunId: null,
    draft: "",
    editingMessageId: null,
    editingMessagePending: false,
    flushPendingModelControlDefaults: vi.fn(),
    handleBranchFromMessage: vi.fn(),
    handleCopyMessage: vi.fn(),
    handleDeleteMessage: vi.fn(),
    handleEditMessage: vi.fn(),
    handleRegenerateMessage: vi.fn(),
    handleThreadScroll: vi.fn(),
    jumpToLatest: vi.fn(),
    liveArtifactSummary: null,
    maxOutputTokens: "1024",
    notificationSoundEnabled: false,
    operationError: null,
    openDetails: vi.fn(),
    openSettings: vi.fn(),
    reasoningEffort: "none",
    reasoningMode: "standard",
    retryActiveChatDetail: vi.fn(),
    retryCatalog: vi.fn(),
    retryWorkspace: vi.fn(),
    searchOptions: [],
    selectModel: vi.fn(),
    selectPrompt: vi.fn(),
    selectRunProfile: vi.fn(),
    selectSearchStrategy: vi.fn(),
    selectedModelId: "fake-qsa",
    selectedPromptId: null,
    selectedProvider: "fake",
    selectedProviderName: "Fake",
    selectedSearchStrategy: "search-disabled",
    showCitations: true,
    showJumpToLatest: false,
    showReasoningBlocks: false,
    showToolActivity: true,
    stopCurrentRun: vi.fn(),
    streamMode: false,
    submitComposer: vi.fn(),
    temperature: "1",
    threadScrollRef: { current: null },
    toggleCitationsVisibility: vi.fn(),
    toggleNotificationSound: vi.fn(),
    toggleReasoningBlockVisibility: vi.fn(),
    toggleToolActivityVisibility: vi.fn(),
    uploadFiles: vi.fn(),
    uploading: false,
    visibleMessages: [],
    workspaceError: null,
    workspaceLoading: false,
    workspaceReady: true,
    ...overrides
  };

  return { props, ...render(<MainThreadPane {...props} />) };
}

function installCompactComposerViewport() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() =>
      ({
        addEventListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn()
      }) as unknown as MediaQueryList
    )
  );
}

describe("MainThreadPane", () => {
  it("resolves runtime model identities to display names and uses a neutral missing-model fallback", () => {
    const runtimeModel: CatalogModel = {
      ...model,
      displayName: "Claude Opus 4.8",
      modelId: "018f47a0-opaque-deployment-id",
      provider: "018f47a0-opaque-connection-id",
      providerFamily: "anthropic",
      upstreamModelId: "claude-opus-4-8-20260701"
    };
    const runtimeCatalog: Catalog = {
      ...catalog,
      models: [runtimeModel],
      providers: [{
        family: "anthropic",
        id: runtimeModel.provider,
        models: [runtimeModel.modelId],
        name: "Anthropic production"
      }]
    };
    const view = renderPane({
      ...readyComposerOverrides,
      catalog: runtimeCatalog,
      visibleMessages: [assistantMessage("answer-runtime", {
        modelId: runtimeModel.upstreamModelId,
        provider: runtimeModel.providerFamily
      })]
    });

    expect(screen.getByText("Anthropic production / Claude Opus 4.8")).toBeVisible();
    expect(screen.queryByText(runtimeModel.upstreamModelId!)).not.toBeInTheDocument();

    view.rerender(
      <MainThreadPane
        {...view.props}
        visibleMessages={[assistantMessage("answer-missing", {
          modelId: "long-upstream-model-id-that-is-no-longer-available",
          provider: "anthropic"
        })]}
      />
    );
    expect(screen.getByText("Model unavailable")).toBeVisible();
    expect(screen.queryByText("long-upstream-model-id-that-is-no-longer-available")).not.toBeInTheDocument();
  });

  it.each([
    {
      hint: "Loading models…",
      label: "catalog loading",
      overrides: {} as Partial<ComponentProps<typeof MainThreadPane>>
    },
    {
      hint: "Loading workspace…",
      label: "workspace loading",
      overrides: { ...readyComposerOverrides, workspaceLoading: true, workspaceReady: false }
    },
    {
      hint: "Loading conversation…",
      label: "conversation loading",
      overrides: { ...readyComposerOverrides, activeChatDetailLoading: true }
    },
    {
      hint: "Creating chat…",
      label: "blank-chat creation",
      overrides: { ...readyComposerOverrides, creatingChat: true }
    },
    {
      hint: "No model is available for this account.",
      label: "no entitled model",
      overrides: {
        ...readyComposerOverrides,
        catalog: { ...catalog, models: [], providers: [] },
        composerDisabledHint: "No model is available for this account.",
        currentModel: undefined
      }
    }
  ])("disables and describes the composer during $label", ({ hint, overrides }) => {
    renderPane(overrides);

    const textarea = screen.getByLabelText("Message");
    const send = screen.getByRole("button", { name: "Send message" });

    expect(screen.getByTestId("composer-disabled-hint")).toHaveTextContent(hint);
    expect(textarea).toBeDisabled();
    expect(textarea).toHaveAccessibleDescription(hint);
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(hint);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("keeps drafting available but blocks Send and attachments during upload", () => {
    const { props, rerender } = renderPane({
      ...readyComposerOverrides,
      draft: "Send once the upload finishes",
      uploading: true
    });

    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.getByLabelText("Attach file")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Uploading…");
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAccessibleDescription(
      "Uploading…"
    );

    rerender(
      <MainThreadPane
        {...props}
        operationError="Upload response was malformed"
        uploading={false}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Upload response was malformed");
  });

  it("wires one-tap compact profiles beside the disclosed context statistics", () => {
    const selectRunProfile = vi.fn();
    renderPane({
      catalog: deepProfileCatalog,
      composerContextLine: "Approx. input: ~2k / 3k safe input · 4.1k total context",
      currentModel: deepProfileModel,
      currentParameterControls: deepProfileModel.parameterControls,
      reasoningEffort: "max",
      reasoningMode: "pro",
      searchOptions: deepProfileCatalog.searchStrategies,
      selectedModelId: deepProfileModel.modelId,
      selectedProvider: deepProfileModel.provider,
      selectedProviderName: "OpenAI",
      selectRunProfile
    });

    const compactProfiles = screen.getByTestId("composer-compact-run-profiles");
    expect(within(compactProfiles).getByRole("button", { name: "Use Fast run profile" })).toBeDisabled();
    expect(within(compactProfiles).getByRole("button", { name: "Use Balanced run profile" })).toBeDisabled();
    const deep = within(compactProfiles).getByRole("button", { name: "Use Deep run profile" });
    expect(deep).toHaveAttribute("aria-pressed", "true");
    expect(deep).toHaveClass("h-touch", "min-w-11");
    fireEvent.click(deep);

    expect(selectRunProfile).toHaveBeenCalledWith("deep");
    expect(screen.getByTestId("current-context-length")).toHaveClass(
      "max-sm:hidden",
      "[@media(max-height:32rem)]:!hidden"
    );
    fireEvent.click(screen.getByRole("button", { name: "Open context and usage statistics" }));
    expect(screen.getByRole("dialog", { name: "Context and usage statistics" })).toHaveTextContent(
      "Approx. input: ~2k / 3k safe input · 4.1k total context"
    );
  });

  it("keeps pending edit controls local to the rendered composer session", () => {
    const { props, rerender } = renderPane({
      ...readyComposerOverrides,
      draft: "Edited question",
      editingMessageId: "question-1",
      editingMessagePending: true,
      visibleMessages: [userMessage("question-1")]
    });

    expect(screen.getByRole("status")).toHaveTextContent("Saving edited branch…");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Branch from here" })).toBeEnabled();

    rerender(<MainThreadPane {...props} editingMessagePending={false} />);
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel edit" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit message" })).toBeEnabled();
  });

  it("selects a composer prompt for the next run without requesting default persistence", async () => {
    const selectPrompt = vi.fn();
    const promptCatalog: Catalog = {
      ...catalog,
      promptPresets: [
        {
          developerPrompt: null,
          id: "prompt-default",
          isDefault: true,
          name: "Helpful Assistant",
          systemPrompt: "Be helpful."
        },
        {
          developerPrompt: "Check sources.",
          id: "prompt-research",
          isDefault: false,
          name: "Research",
          systemPrompt: "Investigate carefully."
        }
      ]
    };
    renderPane({
      ...readyComposerOverrides,
      catalog: promptCatalog,
      currentPrompt: promptCatalog.promptPresets[0]!,
      selectPrompt,
      selectedPromptId: "prompt-default"
    });

    fireEvent.click(screen.getByRole("button", { name: "Run settings" }));
    const runSettings = screen.getByRole("dialog", { name: "Run settings" });
    fireEvent.click(within(runSettings).getByRole("button", { name: "Prompt preset" }));
    fireEvent.click(
      screen
        .getByTestId("prompt-picker-options")
        .querySelector('[data-option-value="prompt-research"]')!
    );

    await waitFor(() => expect(selectPrompt).toHaveBeenCalledWith("prompt-research"));
    expect(selectPrompt).not.toHaveBeenCalledWith(
      "prompt-research",
      expect.objectContaining({ persist: true })
    );
  });

  it("shows a described Stop state until an active run can be cancelled", () => {
    const stopCurrentRun = vi.fn();
    const { props, rerender } = renderPane({
      ...readyComposerOverrides,
      activeChatStreaming: true,
      currentRunId: null,
      draft: "Draft for the next run",
      stopCurrentRun
    });

    const pendingStop = screen.getByRole("button", { name: "Stop response" });
    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(pendingStop).toBeDisabled();
    expect(pendingStop).toHaveTextContent("Stop");
    expect(pendingStop).toHaveAccessibleDescription("Starting run…");

    rerender(<MainThreadPane {...props} currentRunId="run-1" />);

    const activeStop = screen.getByRole("button", { name: "Stop response" });
    expect(activeStop).toBeEnabled();
    fireEvent.click(activeStop);
    expect(stopCurrentRun).toHaveBeenCalledOnce();
  });

  it("shows a quiet readable turn skeleton without competing empty or error copy", () => {
    renderPane({ ...readyComposerOverrides, activeChatDetailLoading: true });

    const skeleton = screen.getByTestId("thread-loading-skeleton");
    expect(skeleton).toHaveAccessibleName("Loading chat");
    expect(skeleton.querySelector(".max-w-reading")).not.toBeNull();
    expect(skeleton.querySelectorAll(".skeleton-block")).toHaveLength(10);
    expect(screen.queryByTestId("thread-empty-state")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-detail-error")).not.toBeInTheDocument();
  });

  it("shows a retryable error state when chat detail loading fails", () => {
    const retryActiveChatDetail = vi.fn();
    renderPane({
      ...readyComposerOverrides,
      activeChatDetailError: "Chat detail load failed with HTTP 500 (chat_detail_failed_500)",
      retryActiveChatDetail
    });

    const errorState = screen.getByTestId("thread-detail-error");
    expect(errorState).toHaveTextContent("This conversation didn't load");
    expect(errorState).toHaveTextContent("Chat detail load failed with HTTP 500 (chat_detail_failed_500)");
    expect(screen.queryByTestId("thread-empty-state")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-loading-skeleton")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByTestId("composer-disabled-hint")).toHaveTextContent(
      "Conversation unavailable. Retry loading before sending."
    );
    expect(screen.getByRole("button", { name: "Select model" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search strategy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run settings" })).toBeDisabled();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryAllByRole("status")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Retry loading chat" }));
    expect(retryActiveChatDetail).toHaveBeenCalledOnce();
  });

  it("aligns the simplified empty state and composer to the same readable measure", () => {
    renderPane(readyComposerOverrides);

    const emptyState = screen.getByTestId("thread-empty-state");
    expect(emptyState).toHaveTextContent("Start a conversation");
    expect(emptyState).toHaveTextContent("Ask anything.");
    expect(emptyState).not.toHaveTextContent(
      "Ask a question, search when it helps, and build on the answer."
    );
    expect(screen.queryByLabelText("Question, optional Search, Answer")).not.toBeInTheDocument();
    expect(emptyState.querySelector(".max-w-reading")).not.toBeNull();
    expect(screen.getByTestId("composer-form").querySelector(".max-w-reading")).not.toBeNull();
    expect(emptyState).not.toHaveTextContent("Ctrl/Cmd+K");
    expect(emptyState).not.toHaveTextContent("Enter / Shift+Enter");
    expect(emptyState).not.toHaveTextContent("New Chat");
  });

  it("gives catalog recovery one deliberate owner and blocks sending until retry", () => {
    const retryCatalog = vi.fn();
    renderPane({ catalogError: "Catalog unavailable", retryCatalog, workspaceError: "Workspace refresh failed" });

    expect(screen.getByTestId("catalog-error-state")).toHaveTextContent("Models didn't load");
    expect(screen.getByTestId("catalog-error-state")).toHaveTextContent("Catalog unavailable");
    expect(screen.queryByTestId("workspace-error-state")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading models" }));
    expect(retryCatalog).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("thread-loading-skeleton")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-empty-state")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-detail-error")).not.toBeInTheDocument();
  });

  it("shows retryable initial workspace recovery but keeps a hydrated workspace usable during refresh", () => {
    const retryWorkspace = vi.fn();
    const initial = renderPane({
      ...readyComposerOverrides,
      retryWorkspace,
      workspaceError: "Workspace refresh failed",
      workspaceReady: false
    });

    expect(screen.getByTestId("workspace-error-state")).toHaveTextContent("Workspace didn't load");
    expect(screen.getByLabelText("Message")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading workspace" }));
    expect(retryWorkspace).toHaveBeenCalledOnce();

    initial.rerender(
      <MainThreadPane
        {...initial.props}
        workspaceError={null}
        workspaceLoading
        workspaceReady
      />
    );
    expect(screen.queryByTestId("workspace-error-state")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeEnabled();
  });

  it("uses truthful recovery copy when no models are entitled", () => {
    renderPane({
      ...readyComposerOverrides,
      catalog: { ...catalog, models: [], providers: [] },
      composerDisabledHint: "No model is available for this account.",
      currentModel: undefined
    });

    const state = screen.getByTestId("no-model-empty-state");
    expect(state).toHaveTextContent("Model access required");
    expect(state).toHaveTextContent("administrator needs to grant model access");
    expect(state).not.toHaveTextContent("Choose the model");
    expect(screen.queryByLabelText("Question, optional Search, Answer")).not.toBeInTheDocument();
  });

  it("shows only evidence-based activity on the active streaming tail", () => {
    const messages = [
      userMessage("question-1", "First question"),
      assistantMessage("assistant-old", { content: "Earlier answer", runId: "run-old" }),
      userMessage("question-2", "Current question"),
      assistantMessage("assistant-live", {
        content: "Partial",
        parentMessageId: "question-2",
        runId: "run-live",
        status: "streaming"
      })
    ];
    const { props, rerender } = renderPane({
      ...readyComposerOverrides,
      activeChatStreaming: true,
      currentRunId: "run-live",
      pipeline: {
        answer: "active",
        phase: "running",
        question: "done",
        search: "skipped"
      },
      runWarnings: [
        {
          runId: "run-live",
          text: "One malformed provider event was skipped."
        }
      ],
      selectedSearchStrategy: "search-disabled",
      visibleMessages: messages
    });

    const activity = screen.getByTestId("thread-run-activity");
    expect(activity.closest("article")).toHaveAttribute("data-message-id", "assistant-live");
    expect(activity).toHaveAccessibleName("Run status: Answering");
    expect(activity).toHaveTextContent("Answering…");
    expect(
      screen.getByText("Earlier answer").closest("article")?.querySelector('[data-testid="thread-run-activity"]')
    ).toBeNull();
    expect(screen.getByTestId("thread-run-warnings").closest("article")).toHaveAttribute(
      "data-message-id",
      "assistant-live"
    );

    rerender(
      <MainThreadPane
        {...props}
        pipeline={{
          answer: "idle",
          phase: "running",
          question: "done",
          search: "active"
        }}
      />
    );
    expect(screen.getByTestId("thread-run-activity")).toHaveAccessibleName("Run status: Searching");
    expect(screen.getByTestId("thread-run-activity")).toHaveTextContent("Searching…");
    expect(screen.getByTestId("thread-run-activity")).not.toHaveTextContent(/Question|waiting/i);

  });

  it("does not show run activity on a settled assistant tail", () => {
    renderPane({
      ...readyComposerOverrides,
      currentRunId: "run-live",
      pipeline: {
        answer: "done",
        phase: "settled",
        question: "done",
        search: "skipped"
      },
      visibleMessages: [
        userMessage("question-1"),
        assistantMessage("assistant-live", {
          content: "Finished",
          runId: "run-live",
          status: "complete"
        })
      ]
    });

    expect(screen.queryByTestId("thread-run-activity")).not.toBeInTheDocument();
  });

  it("attaches live tool activity only to its run and prefers it over a stale message summary", () => {
    const toolSummary = (callId: string, serverName: string, status: "complete" | "running") => ({
      citationCount: 0,
      citations: [],
      reasoningCount: 0,
      reasoningText: [],
      searchCount: 0,
      searchStrategy: null,
      toolCallCount: 1,
      toolCalls: [{
        argumentsPreview: { query: callId },
        callId,
        capability: "mcp" as const,
        credentialSources: ["personal" as const],
        durationMs: status === "complete" ? 40 : null,
        errorMessage: null,
        externalAccountLabel: null,
        ordinal: 0,
        resultPreview: status === "complete" ? { ok: true } : null,
        round: 1,
        serverName,
        status,
        toolName: "lookup"
      }]
    });
    const { container } = renderPane({
      ...readyComposerOverrides,
      currentRunId: "run-live",
      liveArtifactSummary: toolSummary("call-live", "Live MCP", "complete"),
      visibleMessages: [
        assistantMessage("assistant-history", {
          artifactSummary: toolSummary("call-history", "Historical MCP", "complete"),
          runId: "run-history"
        }),
        assistantMessage("assistant-live", {
          artifactSummary: toolSummary("call-live", "Stale MCP", "running"),
          runId: "run-live",
          status: "streaming"
        })
      ]
    });

    const historical = container.querySelector('[data-message-id="assistant-history"]');
    const live = container.querySelector('[data-message-id="assistant-live"]');
    expect(historical).toHaveTextContent("Historical MCP");
    expect(historical).not.toHaveTextContent("Live MCP");
    expect(live).toHaveTextContent("Live MCP");
    expect(live).not.toHaveTextContent("Stale MCP");
  });

  it("keeps warnings on their originating run across branch changes", () => {
    const warning = {
      runId: "run-branch-a",
      text: "Branch A provider warning"
    };
    const branchA = assistantMessage("assistant-a", {
      content: "Branch A answer",
      runId: "run-branch-a"
    });
    const branchB = assistantMessage("assistant-b", {
      content: "Branch B answer",
      runId: "run-branch-b"
    });
    const { props, rerender } = renderPane({
      ...readyComposerOverrides,
      runWarnings: [warning],
      visibleMessages: [branchA]
    });

    expect(screen.getByTestId("thread-run-warnings").closest("article")).toHaveAttribute(
      "data-message-id",
      "assistant-a"
    );

    rerender(<MainThreadPane {...props} visibleMessages={[branchB]} />);
    expect(screen.queryByTestId("thread-run-warnings")).not.toBeInTheDocument();

    rerender(<MainThreadPane {...props} visibleMessages={[branchA]} />);
    expect(screen.getByTestId("thread-run-warnings")).toHaveTextContent(
      "Branch A provider warning"
    );
  });

  it("keeps failed pipeline context on the error tail without attaching it to history", () => {
    const { container } = renderPane({
      ...readyComposerOverrides,
      pipeline: {
        answer: "error",
        phase: "error",
        question: "done",
        search: "done"
      },
      selectedSearchStrategy: "provider-search",
      visibleMessages: [
        assistantMessage("assistant-history"),
        userMessage("question-error"),
        assistantMessage("assistant-error", {
          content: "Provider failed",
          parentMessageId: "question-error",
          runId: "run-error",
          status: "error"
        })
      ]
    });

    const activity = screen.getByTestId("thread-run-activity");
    expect(activity).toHaveAccessibleName("Run status: Run error");
    expect(activity).toHaveTextContent("Run error");
    expect(activity.closest("article")).toHaveAttribute("data-message-id", "assistant-error");
    expect(
      container.querySelector('[data-message-id="assistant-history"] [data-testid="thread-run-activity"]')
    ).toBeNull();
  });

  it("does not re-render an unchanged historical row when only the streaming tail gains a token", () => {
    let historicalContentReads = 0;
    const historical = assistantMessage("assistant-historical", {
      runId: "run-historical"
    });
    Object.defineProperty(historical, "content", {
      configurable: true,
      enumerable: true,
      get() {
        historicalContentReads += 1;
        return "Historical answer";
      }
    });
    const streamingTail = assistantMessage("assistant-tail", {
      content: "Partial",
      parentMessageId: "question-tail",
      runId: "run-tail",
      status: "streaming"
    });
    const { props, rerender } = renderPane({
      ...readyComposerOverrides,
      activeChatStreaming: true,
      currentRunId: "run-tail",
      visibleMessages: [historical, userMessage("question-tail"), streamingTail]
    });
    const readsAfterInitialRender = historicalContentReads;

    rerender(
      <MainThreadPane
        {...props}
        visibleMessages={[
          historical,
          userMessage("question-tail"),
          { ...streamingTail, content: "Partial answer" }
        ]}
      />
    );

    expect(screen.getByText("Partial answer")).toBeVisible();
    expect(historicalContentReads).toBe(readsAfterInitialRender);
  });

  it.each([
    {
      expectedClassNames: ["h-24", "sm:h-32", "[@media(max-height:32rem)]:!h-0"],
      spacerTestId: "thread-complete-answer-spacer",
      status: "complete" as const
    },
    {
      expectedClassNames: ["h-16", "sm:h-24", "[@media(max-height:32rem)]:!h-0"],
      spacerTestId: "thread-terminal-answer-spacer",
      status: "cancelled" as const
    },
    {
      expectedClassNames: ["h-16", "sm:h-24", "[@media(max-height:32rem)]:!h-0"],
      spacerTestId: "thread-terminal-answer-spacer",
      status: "error" as const
    }
  ])(
    "reserves appropriate breathing room after a $status assistant tail",
    ({ expectedClassNames, spacerTestId, status }) => {
      renderPane({
        ...readyComposerOverrides,
        visibleMessages: [assistantMessage(`assistant-${status}`, { status })]
      });

      const spacer = screen.getByTestId(spacerTestId);
      expect(spacer).toHaveAttribute("data-status", status);
      for (const className of expectedClassNames) {
        expect(spacer).toHaveClass(className);
      }
    }
  );

  it("uses a reading spacer only for the streaming assistant tail", () => {
    const { props, rerender } = renderPane({
      ...readyComposerOverrides,
      activeChatStreaming: true,
      visibleMessages: [assistantMessage("assistant-streaming", { status: "streaming" })]
    });

    expect(screen.queryByTestId("thread-complete-answer-spacer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-terminal-answer-spacer")).not.toBeInTheDocument();
    expect(screen.getByTestId("thread-reading-spacer")).toHaveAttribute(
      "data-thread-reading-spacer",
      "true"
    );

    rerender(<MainThreadPane {...props} visibleMessages={[userMessage("user-tail")]} />);
    expect(screen.queryByTestId("thread-complete-answer-spacer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-terminal-answer-spacer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-reading-spacer")).not.toBeInTheDocument();
  });

  it("keeps thread toolbar and jump-to-latest actions wired", () => {
    const copyVisibleThread = vi.fn();
    const jumpToLatest = vi.fn();
    const openDetails = vi.fn();
    renderPane({
      ...readyComposerOverrides,
      copyVisibleThread,
      jumpToLatest,
      openDetails,
      showJumpToLatest: true
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Branch tree" }));
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest message" }));

    expect(screen.getByTestId("jump-to-latest-region")).not.toHaveClass("absolute");
    expect(screen.getByTestId("thread")).toHaveClass("min-h-0", "flex-1", "[overflow-anchor:none]");
    expect(screen.getByRole("toolbar", { name: "Chat actions" })).toHaveClass("hidden", "lg:flex");
    expect(copyVisibleThread).toHaveBeenCalledOnce();
    expect(openDetails).toHaveBeenCalledWith("branch");
    expect(screen.queryByRole("combobox", { name: "Chat folder" })).not.toBeInTheDocument();
    expect(jumpToLatest).toHaveBeenCalledOnce();
  });

  it("collapses idle compact controls after deliberate reading scroll and expands on focus or draft", async () => {
    installCompactComposerViewport();
    try {
      const handleThreadScroll = vi.fn();
      const { props, rerender } = renderPane({
        ...readyComposerOverrides,
        handleThreadScroll,
        visibleMessages: [assistantMessage("assistant-reading")]
      });
      const thread = screen.getByTestId("thread");

      fireEvent.scroll(thread, { target: { scrollTop: 60 } });
      fireEvent.scroll(thread, { target: { scrollTop: 120 } });
      expect(screen.getByTestId("composer-form")).not.toHaveAttribute(
        "data-reading-collapsed"
      );
      handleThreadScroll.mockClear();

      fireEvent.wheel(thread, { deltaY: 60 });
      fireEvent.scroll(thread, { target: { scrollTop: 100 } });
      fireEvent.scroll(thread, { target: { scrollTop: 160 } });

      await waitFor(() =>
        expect(screen.getByTestId("composer-form")).toHaveAttribute(
          "data-reading-collapsed",
          "true"
        )
      );
      expect(screen.getByTestId("composer-controls-disclosure")).toHaveAttribute(
        "aria-hidden",
        "true"
      );
      expect(screen.getByTestId("composer-actions-disclosure")).toHaveAttribute(
        "aria-hidden",
        "true"
      );
      expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
      expect(handleThreadScroll).toHaveBeenCalledTimes(2);

      fireEvent.focus(screen.getByRole("textbox", { name: "Message" }));
      await waitFor(() =>
        expect(screen.getByTestId("composer-form")).not.toHaveAttribute(
          "data-reading-collapsed"
        )
      );

      fireEvent.blur(screen.getByRole("textbox", { name: "Message" }));
      fireEvent.wheel(thread, { deltaY: -60 });
      fireEvent.scroll(thread, { target: { scrollTop: 260 } });
      fireEvent.scroll(thread, { target: { scrollTop: 200 } });
      await waitFor(() =>
        expect(screen.getByTestId("composer-form")).toHaveAttribute(
          "data-reading-collapsed",
          "true"
        )
      );

      rerender(<MainThreadPane {...props} draft="A protected draft" />);
      await waitFor(() =>
        expect(screen.getByTestId("composer-form")).not.toHaveAttribute(
          "data-reading-collapsed"
        )
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps compact run start expanded until Stop is addressable, then exposes Stop in reading mode", async () => {
    installCompactComposerViewport();
    try {
      const stopCurrentRun = vi.fn();
      const { props, rerender } = renderPane({
        ...readyComposerOverrides,
        activeChatStreaming: true,
        currentRunId: null,
        stopCurrentRun,
        visibleMessages: [assistantMessage("assistant-streaming", { status: "streaming" })]
      });
      const thread = screen.getByTestId("thread");

      fireEvent.wheel(thread, { deltaY: 80 });
      fireEvent.scroll(thread, { target: { scrollTop: 100 } });
      fireEvent.scroll(thread, { target: { scrollTop: 180 } });
      expect(screen.getByTestId("composer-form")).not.toHaveAttribute(
        "data-reading-collapsed"
      );

      rerender(<MainThreadPane {...props} currentRunId="run-1" />);
      fireEvent.wheel(thread, { deltaY: 60 });
      fireEvent.scroll(thread, { target: { scrollTop: 200 } });
      fireEvent.scroll(thread, { target: { scrollTop: 260 } });

      const stop = await screen.findByTestId("composer-reading-stop");
      expect(stop).toHaveAccessibleName("Stop response");
      expect(stop).toBeEnabled();
      fireEvent.click(stop);
      expect(stopCurrentRun).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders the custom chat delete confirmation dialog", () => {
    const chat: ChatSummary = {
      activeLeafMessageId: null,
      createdAt: "2026-06-10T00:00:00.000Z",
      defaultModelId: "fake-qsa",
      defaultPromptPresetId: null,
      defaultProvider: "fake",
      folderId: null,
      id: "chat-delete",
      messageCount: 0,
      title: "Planning notes",
      updatedAt: "2026-06-10T00:00:00.000Z"
    };
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ChatDeleteConfirmationDialog
        chatTitle={chat.title}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByRole("dialog", { name: "Delete chat Planning notes" })).toBeInTheDocument();
    expect(screen.getByTestId("delete-chat-confirmation")).toHaveTextContent("Planning notes");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete chat" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("renders the custom folder delete confirmation dialog", () => {
    const folder: FolderSummary = {
      id: "folder-delete",
      name: "Research",
      parentId: null,
      projectMemory: "",
      sortOrder: 0
    };
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <FolderDeleteConfirmationDialog
        folderName={folder.name}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByRole("dialog", { name: "Delete folder Research" })).toBeInTheDocument();
    expect(screen.getByTestId("delete-folder-confirmation")).toHaveTextContent(
      "Chats inside move to the top level"
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete folder" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("renders custom message and prompt delete confirmation dialogs", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <MessageDeleteConfirmationDialog onCancel={onCancel} onConfirm={onConfirm} />
    );

    expect(screen.getByRole("dialog", { name: "Delete message" })).toBeInTheDocument();
    expect(screen.getByTestId("delete-message-confirmation")).toHaveTextContent("every reply below");

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete message" }));
    expect(onConfirm).toHaveBeenCalledOnce();

    rerender(
      <PromptDeleteConfirmationDialog
        promptName="Research Prompt"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    );
    expect(screen.getByRole("dialog", { name: "Delete prompt Research Prompt" })).toBeInTheDocument();
    expect(screen.getByTestId("delete-prompt-confirmation")).toHaveTextContent("Research Prompt");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("renders a custom discard-changes confirmation dialog", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <DiscardChangesConfirmationDialog
        label="prompt"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByRole("dialog", { name: "Discard prompt changes" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onCancel).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
