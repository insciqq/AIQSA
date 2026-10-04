import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { resetSkillLibraryStoreForTest } from "@/components/app-shell/skillLibraryStore";
import { initialSettingsDestinationSnapshot, useSettingsDestinationStore } from "@/components/app-shell/settingsDestinationStore";
import { resetComposerControlStoreForTest, resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";
import { isCurrentChatRouteResolution, navigateToChatAddress, resolveChatRoute, type ChatRoute } from "@/components/app-shell/chatRoute";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import {
  AnswerSoundSettingsRowV2,
  RunSetupV2,
  TemporaryChatIndicatorV2,
  WorkspaceHeaderV2,
  knowledgeReferenceForMessageV2,
  liveAnswerSourceV2,
  announcedPresentationV2,
  presentAnswerV2,
  retryAutoMcpDiscoveryV2,
  applyLoadAllAfterMcpDiscoveryFailureV2,
  settingsBusyMessageV2,
  composerMcpServersV2,
  openPersonalConnectionsSettingsV2,
  blankConversationOrientationV2,
  chatLocationCrumbV2,
  BackgroundRunStatusV2,
  ComposerOperationErrorV2,
  SkillLibraryOverlayV2,
  selectNavigationChatV2,
  type RunSetupComposerV2
} from "./PowerAppShellV2View";
import { formatTemporaryRetentionDeadlineV2 } from "./WorkspaceHeaderV2";
import { CONTINUATION_SUGGESTED_DESCRIPTION } from "./ChatContextIndicatorV2";
import { makeContextCompactionStatus } from "@/lib/contracts/contextCompaction";
import { presentRunLifecycleV2 } from "@/features/run-lifecycle-v2/runPresentation";
import { RunLifecycleAnnouncerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import type { RunEventView, ThreadMessage, WorkspaceChatSummary } from "@/components/app-shell/types";

const galleryModels = composerGalleryConfig.catalog.models;

afterEach(() => {
  resetComposerControlStoreForTest();
  resetSkillLibraryStoreForTest();
  vi.unstubAllGlobals();
});

describe("Skill Library overlay v2", () => {
  it("performs no list request until the shell opens the Library", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({
      nextCursor: null,
      publishableWorkspaces: [],
      skills: [],
      viewer: { canPublishInstallation: false }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      onClose: vi.fn(),
      onSelectionChange: vi.fn(),
      selectedIds: []
    };
    const { rerender } = render(<SkillLibraryOverlayV2 {...props} open={false} />);

    expect(fetchMock).not.toHaveBeenCalled();
    rerender(<SkillLibraryOverlayV2 {...props} open />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/me/skills");
  });
});

describe("MCP discovery failure actions v2", () => {
  it("discloses enabled personal connections after installation servers, with their source and readiness", () => {
    const installation = { accountLabel: null, description: "", enabled: false, fields: [], id: "office", knownToolCount: 2,
      name: "office", oauthAvailable: false, oauthState: null, readiness: "disabled" as const, runtimeErrorCode: null, tools: [] };
    const personal = { accountLabel: null, authHeaderName: null, authMode: "oauth" as const, availableTools: [], description: "",
      enabled: true, fields: [], id: "notion", knownToolCount: 3, name: "Notion", oauthAvailable: true,
      oauthState: "reauthorization_required" as const, readiness: "reauthorization_required" as const, runtimeErrorCode: null,
      sourceType: "personal" as const, tools: [], userDisabledToolNames: [] };
    expect(composerMcpServersV2([installation], [personal, { ...personal, enabled: false, id: "off", name: "Off" }])).toEqual([
      expect.objectContaining({ enabled: false, id: "office", source: "installation" }),
      expect.objectContaining({ attention: "reauthorization_required", enabled: true, id: "notion", knownToolCount: 3, source: "personal" })
    ]);
  });

  it("opens Settings on Connections for a personal connection", () => {
    useSettingsDestinationStore.setState(initialSettingsDestinationSnapshot);
    openPersonalConnectionsSettingsV2();
    expect(useSettingsDestinationStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: "connections" });
    useSettingsDestinationStore.setState(initialSettingsDestinationSnapshot);
  });

  it("reports Settings busy with the owner's message, connections first", () => {
    expect(settingsBusyMessageV2({ accountBusy: false, connectedAppsBusy: false, connectionsBusyMessage: null })).toBeNull();
    expect(settingsBusyMessageV2({ accountBusy: true, connectedAppsBusy: false, connectionsBusyMessage: null })).toBe("Updating account…");
    expect(settingsBusyMessageV2({ accountBusy: false, connectedAppsBusy: true, connectionsBusyMessage: null })).toBe("Revoking app access…");
    expect(settingsBusyMessageV2({ accountBusy: true, connectedAppsBusy: true, connectionsBusyMessage: "Disconnecting…" })).toBe("Disconnecting…");
  });

  it("preserves Auto on Retry and switches only on explicit Load all", () => {
    const regenerate = vi.fn();
    useComposerControlStore.getState().setMcpSelection({ mode: "load_all" });

    retryAutoMcpDiscoveryV2(regenerate);
    expect(useComposerControlStore.getState().mcpSelection).toEqual({ mode: "auto" });

    applyLoadAllAfterMcpDiscoveryFailureV2(regenerate);
    expect(useComposerControlStore.getState().mcpSelection).toEqual({ mode: "load_all" });
    expect(regenerate).toHaveBeenCalledTimes(2);
  });
});

describe("Navigation chat selection v2", () => {
  const chatSummary = (id: string): WorkspaceChatSummary => ({
    activeLeafMessageId: null,
    createdAt: "2026-10-03T00:00:00.000Z",
    defaultModelId: "model",
    defaultProvider: "provider",
    folderId: null,
    id,
    messageCount: 0,
    pinned: false,
    projectId: null,
    title: "Chat",
    updatedAt: "2026-10-03T00:00:00.000Z"
  });

  afterEach(() => {
    resetWorkspaceStoreForTest();
    window.history.replaceState(null, "", "/");
  });

  // The shell's address action over a fake route owner whose personal list
  // arrives only after the click, as on a reload of a busy server.
  function addressOwner() {
    let loadList!: () => void;
    const listLoaded = new Promise<void>((resolve) => { loadList = resolve; });
    const activated: string[] = [];
    let shown: ChatRoute = { chatId: null, projectId: null };
    const settled: Promise<ChatRoute | null>[] = [];
    const openChatAddress = vi.fn((chatId: string) => navigateToChatAddress(
      { chatId, projectId: null },
      (route, resolution) => {
        settled.push(resolveChatRoute(route, resolution, {
          openAssistant: async () => "opened",
          openBlank: () => { shown = { chatId: null, projectId: null }; },
          async openChat(id) {
            await listLoaded;
            useWorkspaceStore.getState().setChats([chatSummary(id)]);
            // Like the shell's workspace read, a superseded address activates nothing.
            if (!isCurrentChatRouteResolution(resolution)) return "failed";
            activated.push(id);
            shown = { chatId: id, projectId: null };
            return "opened";
          },
          openProject: async () => "unavailable",
          showUnavailable: vi.fn(),
          stateRoute: () => shown
        }));
      }
    ));
    return { activated, loadList, openChatAddress, settled };
  }

  it("opens a row the unloaded workspace list does not hold yet once the list arrives", async () => {
    const owner = addressOwner();
    const actions = { activateChat: vi.fn(), openChatAddress: owner.openChatAddress };
    const leaveProject = vi.fn();

    selectNavigationChatV2("chat-1", actions, leaveProject);

    expect(owner.openChatAddress).toHaveBeenCalledExactlyOnceWith("chat-1");
    expect(actions.activateChat).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/c/chat-1");
    owner.loadList();
    await expect(Promise.all(owner.settled)).resolves.toEqual([{ chatId: "chat-1", projectId: null }]);
    expect(owner.activated).toEqual(["chat-1"]);
    expect(window.location.pathname).toBe("/c/chat-1");
  });

  it("lets a later row choice supersede a row still waiting for the list", async () => {
    const owner = addressOwner();
    const actions = { activateChat: vi.fn(), openChatAddress: owner.openChatAddress };

    selectNavigationChatV2("chat-1", actions, vi.fn());
    selectNavigationChatV2("chat-2", actions, vi.fn());
    owner.loadList();
    await expect(Promise.all(owner.settled)).resolves.toEqual([null, { chatId: "chat-2", projectId: null }]);
    expect(owner.activated).toEqual(["chat-2"]);
    expect(window.location.pathname).toBe("/c/chat-2");
  });

  it("activates a known row directly, leaving an open Project", () => {
    const known = chatSummary("chat-1");
    useWorkspaceStore.getState().setChats([known]);
    const actions = { activateChat: vi.fn(), openChatAddress: vi.fn() };
    const leaveProject = vi.fn();

    selectNavigationChatV2("chat-1", actions, leaveProject);

    expect(leaveProject).toHaveBeenCalledOnce();
    expect(actions.activateChat).toHaveBeenCalledExactlyOnceWith(known);
    expect(actions.openChatAddress).not.toHaveBeenCalled();
  });
});

describe("Background run status v2", () => {
  it("keeps a persistent Check run action while a resumed run waits in the background", () => {
    const onCheck = vi.fn();
    const { rerender } = render(<BackgroundRunStatusV2 onCheck={onCheck} waiting />);

    expect(screen.getByRole("status")).toHaveTextContent("Run is still active in the background.");
    fireEvent.click(screen.getByRole("button", { name: "Check run" }));
    expect(onCheck).toHaveBeenCalledOnce();

    rerender(<BackgroundRunStatusV2 onCheck={onCheck} waiting={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Composer operation error v2", () => {
  it("offers one explicit Retry action only for a retryable send rejection", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ComposerOperationErrorV2
        error="Provider unavailable. Try again."
        live
        onRetry={onRetry}
        retryable
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Provider unavailable. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(
      <ComposerOperationErrorV2
        error="Upload failed."
        live={false}
        onRetry={onRetry}
        retryable={false}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Upload failed.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

function runSetupComposer(overrides: Partial<RunSetupComposerV2> = {}): RunSetupComposerV2 {
  return {
    backgroundMode: false,
    changeBackgroundMode: vi.fn(),
    changeMaxOutputTokens: vi.fn(),
    changeReasoningEffort: vi.fn(),
    changeReasoningMode: vi.fn(),
    changeStreamMode: vi.fn(),
    changeTemperature: vi.fn(),
    currentModel: galleryModels[0],
    currentParameterControls: galleryModels[0]!.parameterControls,
    maxOutputTokens: "8192",
    reasoningEffort: "medium",
    reasoningMode: "",
    searchPlanMode: "all_selected",
    selectSearchPlan: vi.fn(),
    selectedSearchOptionIds: [],
    streamMode: true,
    temperature: "0.7",
    useOrganizationModelDefault: vi.fn(),
    useOrganizationSearchDefault: vi.fn(),
    ...overrides
  };
}

describe("Run setup v2", () => {
  it("names the current model and confirms organization-default resets visibly", () => {
    const composer = runSetupComposer();
    const { rerender } = render(<RunSetupV2 composer={composer} onClose={vi.fn()} />);

    expect(screen.getByTestId("run-setup-current-model")).toHaveTextContent(
      "Current model: GPT-5.2"
    );

    fireEvent.click(screen.getByRole("button", { name: "Use organization model default" }));
    expect(composer.useOrganizationModelDefault).toHaveBeenCalledOnce();
    expect(screen.getByTestId("run-setup-defaults-feedback")).toHaveTextContent(
      "Organization model default applied."
    );

    rerender(
      <RunSetupV2
        composer={runSetupComposer({ currentModel: galleryModels[2] })}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByTestId("run-setup-current-model")).toHaveTextContent(
      "Current model: Gemini 3 Pro"
    );

  });

  it("closes the params sheet from scrim tap, the close control, and Escape", () => {
    const onClose = vi.fn();
    render(<RunSetupV2 composer={runSetupComposer()} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Model parameters" });
    const scrim = dialog.parentElement!;

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close parameters" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("keeps only model parameters as switches; display settings live in Settings", () => {
    const composer = runSetupComposer();
    render(<RunSetupV2 composer={composer} onClose={vi.fn()} />);

    // Citations, Reasoning blocks and the answer sound moved to Settings ›
    // General (UX audit 2026-09-02 B2): no duplicate toggles here.
    expect(screen.queryByRole("switch", { name: /Citations/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Reasoning blocks/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /sound/i })).toBeNull();

    const streaming = screen.getByRole("switch", { name: /Streaming/ });
    expect(streaming).toHaveAttribute("aria-checked", "true");
    fireEvent.click(streaming);
    expect(composer.changeStreamMode).toHaveBeenCalledWith(false);
  });
});

describe("Knowledge citation provenance v2", () => {
  it("uses the original answer authority for a copied branch message", () => {
    expect(knowledgeReferenceForMessageV2({
      citationMessageId: "assistant-source",
      id: "assistant-branch",
      runId: "run-source"
    }, {
      citations: [],
      knowledgeCitations: [{ handle: "K1" }],
      reasoningText: [],
      sources: []
    }, true)).toEqual({
      messageId: "assistant-source",
      runId: "run-source"
    });
  });

  it("does not expose a citation authority for unsettled or uncited answers", () => {
    const message = { id: "assistant", runId: "run" };
    expect(knowledgeReferenceForMessageV2(message, null, true)).toBeUndefined();
    expect(knowledgeReferenceForMessageV2(message, {
      citations: [],
      knowledgeCitations: [{ handle: "K1" }],
      reasoningText: [],
      sources: []
    }, false)).toBeUndefined();
  });
});

describe("Live answer source v2", () => {
  const runningEvent = {
    data: {
      artifactType: "context_compaction",
      payload: makeContextCompactionStatus({ beforeTokens: 1_200, outcome: "pending", state: "running" })
    },
    type: "artifact"
  };
  const saved = {
    citations: [{ index: 1, title: "Saved source", url: "https://example.com/saved" }],
    reasoningText: ["Saved reasoning"],
    sources: []
  };
  const liveArtifactSummary = {
    citations: [],
    contextCompaction: makeContextCompactionStatus({ beforeTokens: 1_200, outcome: "pending", state: "running" }),
    reasoningText: [],
    sources: []
  };

  it("never lends the live run to an answer without a run id, even with no current run", () => {
    for (const currentRunId of [null, "run-live"]) {
      const source = liveAnswerSourceV2({ artifactSummary: saved, runId: null }, {
        currentRunId, events: [runningEvent], liveArtifactSummary
      });
      expect(source).toEqual({ artifact: saved, events: [], ownsLiveRun: false });
      expect(presentRunLifecycleV2({
        authoritativeMessageStatus: "complete",
        content: "Saved answer",
        contextCompaction: source.artifact?.contextCompaction,
        events: source.events,
        runId: null
      })).toEqual({ kind: "complete", runId: null });
    }
    expect(liveAnswerSourceV2({ runId: undefined }, { currentRunId: null, events: [runningEvent], liveArtifactSummary }))
      .toEqual({ artifact: null, events: [], ownsLiveRun: false });
  });

  it("gives the current run its live events and merges its summary over the saved outputs", () => {
    const source = liveAnswerSourceV2({ artifactSummary: saved, runId: "run-live" }, {
      currentRunId: "run-live", events: [runningEvent], liveArtifactSummary
    });
    expect(source.ownsLiveRun).toBe(true);
    expect(source.events).toEqual([runningEvent]);
    expect(source.artifact).toMatchObject({
      citations: saved.citations,
      contextCompaction: { state: "running" },
      reasoningText: saved.reasoningText
    });
    expect(liveAnswerSourceV2({ artifactSummary: saved, runId: "run-older" }, {
      currentRunId: "run-live", events: [runningEvent], liveArtifactSummary
    })).toEqual({ artifact: saved, events: [], ownsLiveRun: false });
  });
});

describe("Run announcer wiring v2", () => {
  const READY = "Answer ready. The message field is available.";
  const thread = (overrides: Partial<Parameters<typeof announcedPresentationV2>[1]> = {}) => ({
    activeChatStreaming: false, currentRunId: null, events: [], interruptedRun: null, liveArtifactSummary: null, ...overrides
  });
  const answer = (overrides: Partial<ThreadMessage> = {}): ThreadMessage => ({
    content: "Conversation summary", id: "message-summary", parentMessageId: null, role: "assistant",
    runId: null, status: "complete", ...overrides
  });

  /** Follows the view's announced presentation through the real announcer and records what it speaks. */
  function follow(steps: readonly Readonly<{ tail?: ThreadMessage; thread?: ReturnType<typeof thread> }>[]) {
    vi.useFakeTimers();
    try {
      const spoken: string[] = [];
      const element = (step: (typeof steps)[number]) => <RunLifecycleAnnouncerV2 activeChatId="chat-a"
        presentation={announcedPresentationV2(step.tail, step.thread ?? thread())} sourceChatId="chat-a" />;
      const view = render(element(steps[0]!));
      let last = "";
      const sample = () => {
        const text = screen.getByTestId("run-lifecycle-announcer").textContent ?? "";
        if (text && text !== last) spoken.push(text);
        last = text;
      };
      for (const step of steps) {
        view.rerender(element(step));
        for (let elapsed = 0; elapsed < 2_000; elapsed += 100) {
          act(() => {
            vi.advanceTimersByTime(100);
          });
          sample();
        }
      }
      view.unmount();
      return spoken;
    } finally {
      vi.useRealTimers();
    }
  }

  it("keeps a loaded settled tail without a run id silent after the chat was empty", () => {
    // An uncached chat has no tail while it loads; a continuation summary answer carries no run.
    expect(follow([{}, { tail: answer() }, { tail: answer() }])).toEqual([]);
    // Control: the same history with a run id stays silent too.
    expect(follow([{}, { tail: answer({ runId: "run-old" }) }])).toEqual([]);
  });

  it("still announces an answer followed from running to complete exactly once", () => {
    const streaming = answer({ content: "", id: "message-live", runId: "run-live", status: "streaming" });
    const live = thread({ activeChatStreaming: true, currentRunId: "run-live" });
    expect(follow([
      {},
      { tail: streaming, thread: live },
      { tail: { ...streaming, content: "Done", status: "complete" }, thread: thread({ currentRunId: "run-live" }) },
      { tail: { ...streaming, content: "Done", status: "complete" } }
    ])).toEqual(["Working on the answer…", READY]);
  });

  it("keeps a send refused after earlier answers silent and speaks the next send again", () => {
    const earlier = answer({ content: "Earlier answer", id: "message-old", runId: "run-old" });
    const optimistic = (id: string) => answer({ content: "", id, runId: undefined, status: "streaming" });
    const sending = thread({ activeChatStreaming: true });
    const durable = answer({ content: "", id: "message-new", runId: "run-new", status: "streaming" });
    // The refusal rolls the optimistic answer back: the earlier answer is the tail again.
    expect(follow([
      { tail: earlier },
      { tail: optimistic("assistant-1"), thread: sending },
      { tail: earlier },
      { tail: optimistic("assistant-2"), thread: sending },
      { tail: durable, thread: thread({ activeChatStreaming: true, currentRunId: "run-new" }) },
      { tail: { ...durable, content: "Done", status: "complete" }, thread: thread({ currentRunId: "run-new" }) }
    ])).toEqual(["Working on the answer…", "Working on the answer…", READY]);
  });

  it("projects a failed cycle superseded in one replayed batch for the answer that owns the run", () => {
    const cycle = (status: ReturnType<typeof makeContextCompactionStatus>): RunEventView =>
      ({ data: { artifactType: "context_compaction", payload: status }, type: "artifact" });
    const failed = makeContextCompactionStatus({ beforeTokens: 9_000, cycle: 1, outcome: "summary_failed", state: "failed" });
    const masked = makeContextCompactionStatus({ afterTokens: 4_000, beforeTokens: 9_000, cycle: 2, outcome: "masking_applied", state: "complete" });
    const events = [cycle(makeContextCompactionStatus({ beforeTokens: 9_000, cycle: 1, outcome: "pending", state: "running" })),
      cycle(failed), cycle(masked)];
    const owner = answer({ content: "", id: "message-live", runId: "run-live", status: "streaming" });
    expect(presentAnswerV2(owner, thread({ activeChatStreaming: true, currentRunId: "run-live", events })).presentation)
      .toMatchObject({ compaction: masked, compactionFailures: [failed] });
    // Another answer never adopts the live failures.
    expect(presentAnswerV2({ ...owner, id: "message-old", runId: null, status: "complete" },
      thread({ currentRunId: "run-live", events })).presentation).toEqual({ kind: "complete", runId: null });
  });
});

describe("Temporary chat indicator v2", () => {
  const memory = {
    explanation: "Temporary Chat reads and writes no personal Memory.",
    externalRetention: "External providers may retain data under their disclosed policies.",
    label: "Temporary chat",
    retention: "The complete chat aggregate is deleted after 24 hours.",
    retentionDeadline: "2026-08-14T12:00:00.000Z"
  };

  it("stays quiet until clicked, then disclosing the retention explainer", () => {
    render(<TemporaryChatIndicatorV2 memory={memory} />);

    const trigger = screen.getByTestId("header-temporary-indicator");
    expect(trigger).toHaveTextContent("Temporary chat");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Temporary chat" });
    expect(dialog).toHaveTextContent("deleted after 24 hours");
    expect(dialog).toHaveTextContent("External providers");
    const deadline = screen.getByTestId("temporary-retention-deadline");
    expect(deadline).toHaveTextContent("Scheduled deletion:");
    expect(deadline).not.toHaveTextContent("2026-08-14T12:00:00.000Z");
    expect(deadline.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-08-14T12:00:00.000Z"
    );

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("localizes the server retention instant instead of exposing raw ISO", () => {
    const formatted = formatTemporaryRetentionDeadlineV2(
      "2026-08-22T10:15:00.000Z",
      "en-US",
      "UTC"
    );

    expect(formatted).toBe("Aug 22, 2026, 10:15 AM");
    expect(formatted).not.toContain("T10:15:00.000Z");
  });
});

describe("Workspace header v2", () => {
  const temporaryMemory = {
    explanation: "Temporary Chat reads and writes no personal Memory.",
    externalRetention: "External providers may retain data under their disclosed policies.",
    label: "Temporary chat",
    retention: "The complete chat aggregate is deleted after 24 hours.",
    retentionDeadline: null
  };
  const folders = [
    { id: "root-a", name: "Research", parentId: null },
    { id: "child-a", name: "Recall", parentId: "root-a" },
    { id: "root-b", name: "Ops", parentId: null }
  ];

  function headerProps(overrides: Partial<Parameters<typeof WorkspaceHeaderV2>[0]> = {}) {
    return {
      active: true,
      editingTitle: null,
      folders,
      onArchive: vi.fn(),
      onBranches: vi.fn(),
      onCopyThread: vi.fn(),
      onDelete: vi.fn(),
      onExport: vi.fn(),
      onMove: vi.fn(),
      onRenameCancel: vi.fn(),
      onRenameChange: vi.fn(),
      onRenameSave: vi.fn(),
      onRenameStart: vi.fn(),
      onShare: vi.fn(),
      shareDisabled: false,
      temporaryMemory: null,
      title: "Release checklist",
      ...overrides
    } satisfies Parameters<typeof WorkspaceHeaderV2>[0];
  }

  it("refreshes cumulative spending in the open header popover without resetting its context", () => {
    const props = headerProps({ contextStats: { approximateInputTokens: 100,
      safeInputBudgetTokens: 1000, totalContextTokens: 2000 },
      usageStats: { hasCompletedAnswer: true, totalTokens: 1500, estimatedCostMicros: 100000,
        recordCount: 2, knownCostRecordCount: 2, incompleteRecordCount: 0 } });
    const view = render(<WorkspaceHeaderV2 {...props} />);
    const trigger = screen.getByTestId("header-context-indicator");
    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: "Spent" })).toHaveTextContent("Tokens spent1,500");
    view.rerender(<WorkspaceHeaderV2 {...props} usageStats={{ ...props.usageStats!, totalTokens: 4000,
      estimatedCostMicros: 250000, recordCount: 3, knownCostRecordCount: 3 }} />);
    expect(trigger).toHaveTextContent("5%");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Spent" })).toHaveTextContent("Tokens spent4,000");
    expect(screen.getByRole("group", { name: "Spent" })).toHaveTextContent("Approximate cost≈ $0.250");
  });

  it.each([false, true])("marks a suggested continuation on the gauge or the phone ⋯ without opening the panel (phone: %s)", (phone) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: phone, addEventListener() {}, removeEventListener() {} })));
    const continuation = { busy: false, error: null, progress: null, suggested: true, uploading: false,
      onCancel: vi.fn(), onContinue: vi.fn(), onDismiss: vi.fn() };
    const props = headerProps({ continuation, contextStats: { approximateInputTokens: 750,
      safeInputBudgetTokens: 1000, totalContextTokens: 2000 } });
    const view = render(<WorkspaceHeaderV2 {...props} />);
    expect(screen.queryByRole("dialog", { name: "Chat context" })).toBeNull();
    const more = screen.getByTestId("header-more-trigger");
    expect(screen.getByTestId("header-context-indicator")).toHaveAttribute("data-suggested", "true");
    if (phone) {
      expect(more).toHaveAttribute("data-attention", "true");
      expect(more).toHaveAccessibleDescription(CONTINUATION_SUGGESTED_DESCRIPTION);
      fireEvent.click(more);
      fireEvent.click(screen.getByRole("menuitem", { name: /^Context · \d+%$/u }));
    } else {
      expect(more).not.toHaveAttribute("data-attention");
      fireEvent.click(screen.getByTestId("header-context-indicator"));
    }
    expect(screen.getByRole("dialog", { name: "Chat context" })).toContainElement(
      screen.getByRole("button", { name: "Stay here" }));
    view.rerender(<WorkspaceHeaderV2 {...props} continuation={{ ...continuation, suggested: false }} />);
    expect(screen.getByTestId("header-more-trigger")).not.toHaveAttribute("data-attention");
  });

  it("keeps one kicker-free header: Share plus a single complete ⋯ menu", () => {
    const props = headerProps({
      favorite: true,
      memoryUsed: true,
      onFavorite: vi.fn(),
      onMemoryMode: vi.fn()
    });
    render(<WorkspaceHeaderV2 {...props} />);

    // No kicker and no standalone Copy/Branches buttons remain.
    expect(screen.queryByText("Conversation")).toBeNull();
    expect(screen.queryByText("Reading Room")).toBeNull();
    expect(screen.queryByRole("button", { name: "Копировать" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Branches" })).toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).toBeVisible();

    const trigger = screen.getByTestId("header-more-trigger");
    fireEvent.click(trigger);
    const menu = screen.getByTestId("header-more-menu");
    // Three groups (UX audit F17): chat · content · destructive last.
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual([
      "Rename",
      "Move to…",
      "Favorite",
      "Exclude from Memory",
      "Share",
      "Branches",
      "Export",
      "Archive",
      "Delete…"
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    expect(within(menu).getByRole("menuitem", { name: "Delete…" }))
      .toHaveAttribute("data-tone", "destructive");
    expect(within(menu).getByRole("menuitem", { name: "Archive" }))
      .not.toHaveAttribute("data-tone");
    // Share is a mobile-only route; ≤767px CSS owns the breakpoint and
    // toggles this exact marker.
    expect(within(menu).getByRole("menuitem", { name: "Share" }))
      .toHaveAttribute("data-mobile-only");

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Export" }));
    expect(within(screen.getByLabelText("Export")).getAllByRole("menuitem")
      .map((item) => item.textContent)).toEqual([
      "Markdown",
      "JSON",
      "Copy entire thread"
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Markdown" }));
    expect(props.onExport).toHaveBeenLastCalledWith("markdown");
    expect(screen.queryByTestId("header-more-menu")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "JSON" }));
    expect(props.onExport).toHaveBeenLastCalledWith("json");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy entire thread" }));
    expect(props.onCopyThread).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Branches" }));
    expect(props.onBranches).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(props.onArchive).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });

  it("chooses the model from the header selector and opens a locked one in its fixed state", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <WorkspaceHeaderV2
        {...headerProps({ active: false })}
        modelSelector={{
          expanded: false,
          family: "anthropic",
          label: "Anthropic",
          name: "Claude Opus 5",
          onToggle
        }}
      />
    );

    // The blank chat keeps the header for the selector alone: no title, no actions.
    const trigger = screen.getByTestId("header-model-trigger");
    expect(trigger).toHaveAccessibleName("Claude Opus 5");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.querySelector("use")).toHaveAttribute("href", "#v2-icon-provider-anthropic");
    expect(screen.queryByTestId("header-title")).toBeNull();
    expect(screen.queryByTestId("header-more-trigger")).toBeNull();
    fireEvent.click(trigger);
    expect(onToggle).toHaveBeenCalledWith(trigger);

    rerender(
      <WorkspaceHeaderV2
        {...headerProps()}
        modelSelector={{
          expanded: true,
          family: "openai_compatible",
          label: "Custom OpenAI",
          locked: true,
          name: "Decision Writer · gpt-5.6-terra",
          onToggle
        }}
      />
    );
    // A fixed model keeps its lock but still opens the picker.
    const locked = screen.getByTestId("header-model-trigger");
    expect(locked).toBeEnabled();
    expect(locked).toHaveAttribute("data-locked");
    expect(locked).toHaveAttribute("title", "Managed by the Assistant");
    expect(locked).toHaveAccessibleName("Decision Writer · gpt-5.6-terra");
    fireEvent.click(locked);
    expect(onToggle).toHaveBeenLastCalledWith(locked);
    expect(locked).toHaveAttribute("aria-expanded", "true");
    expect([...locked.querySelectorAll("use")].map((use) => use.getAttribute("href")))
      .toEqual(["#v2-icon-plug", "#v2-icon-lock"]);
    expect(screen.getByTestId("header-title")).toBeVisible();
  });

  it("orders the model, the Assistant selector and the title, with the model's provenance dot", () => {
    render(
      <WorkspaceHeaderV2
        {...headerProps()}
        assistantSelector={<button data-testid="assistant-slot" type="button">HR Helper</button>}
        modelSelector={{
          expanded: false,
          family: "gemini",
          fromAssistant: true,
          label: "Gemini",
          name: "Gemini 3.8 Flash",
          onToggle: vi.fn(),
          title: "Gemini 3.8 Flash · recommended by HR Helper"
        }}
      />
    );

    const trigger = screen.getByTestId("header-model-trigger");
    expect(trigger).toHaveTextContent(/^Gemini 3\.8 Flash$/u);
    expect(trigger).toHaveAttribute("data-provenance", "assistant");
    expect(trigger).toHaveAttribute("title", "Gemini 3.8 Flash · recommended by HR Helper");
    expect(trigger).toBeEnabled();
    const order = [trigger, screen.getByTestId("assistant-slot"), screen.getByTestId("header-title")];
    for (const [index, element] of order.slice(1).entries()) {
      expect(order[index]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("gates Delete… on the capability and lists nested move destinations", () => {
    const props = headerProps({ onDelete: null });
    const { rerender } = render(<WorkspaceHeaderV2 {...props} />);

    fireEvent.click(screen.getByTestId("header-more-trigger"));
    expect(screen.queryByRole("menuitem", { name: "Delete…" })).toBeNull();

    const onDelete = vi.fn();
    const onMove = vi.fn();
    rerender(<WorkspaceHeaderV2 {...headerProps({ onDelete, onMove })} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(onDelete).toHaveBeenCalledTimes(1);

    // Move discloses the complete nested folder list with indentation.
    fireEvent.click(screen.getByTestId("header-more-trigger"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const submenu = screen.getByLabelText("Move to…");
    const labels = within(submenu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(labels).toEqual(["No folder", "Research", "Recall", "Ops"]);
    const nested = within(submenu).getByRole("menuitem", { name: "Recall" });
    expect(nested.style.paddingLeft).toBe("1.25rem");
    fireEvent.click(nested);
    expect(onMove).toHaveBeenCalledWith("child-a");
    expect(screen.queryByTestId("header-more-menu")).toBeNull();
  });

  it("uses Project root for manager movement and hides movement without authority", () => {
    const onMove = vi.fn();
    const projectFolders = folders.map((folder) => ({ ...folder, parentId: null }));
    const { rerender } = render(
      <WorkspaceHeaderV2
        {...headerProps({ folders: projectFolders, moveRootLabel: "Project root", onMove })}
      />
    );

    fireEvent.click(screen.getByTestId("header-more-trigger"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const submenu = screen.getByLabelText("Move to…");
    expect(within(submenu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Project root", "Research", "Recall", "Ops"]);
    fireEvent.click(within(submenu).getByRole("menuitem", { name: "Research" }));
    expect(onMove).toHaveBeenCalledWith("root-a");

    rerender(<WorkspaceHeaderV2 {...headerProps({ folders: projectFolders, onMove: null })} />);
    fireEvent.click(screen.getByTestId("header-more-trigger"));
    expect(screen.queryByRole("menuitem", { name: "Move to…" })).toBeNull();
  });

  it("starts inline rename from the title with the shared ✓/✕ pattern", () => {
    const props = headerProps();
    const { rerender } = render(<WorkspaceHeaderV2 {...props} />);

    fireEvent.click(screen.getByTestId("header-title"));
    expect(props.onRenameStart).toHaveBeenCalledTimes(1);

    rerender(<WorkspaceHeaderV2 {...props} editingTitle="Черновик названия" />);
    const input = screen.getByRole("textbox", { name: "New title: Release checklist" });
    expect(input).toHaveValue("Черновик названия");
    fireEvent.change(input, { target: { value: "Новое имя" } });
    expect(props.onRenameChange).toHaveBeenCalledWith("Новое имя");

    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    expect(props.onRenameSave).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel rename" }));
    expect(props.onRenameCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onRenameCancel).toHaveBeenCalledTimes(2);
  });

  it("reveals the full title on hover while the title button still announces Rename", () => {
    const title = "Quarterly release checklist for the payments platform migration and rollback drills";
    const { rerender } = render(<WorkspaceHeaderV2 {...headerProps({ title })} />);
    const button = screen.getByTestId("header-title");
    expect(button).toHaveAttribute("title", title);
    expect(button).toHaveAccessibleName(title);
    expect(button).toHaveAccessibleDescription("Rename chat");
    expect(button).toHaveTextContent(new RegExp(`^${title}$`));
    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName(title);

    rerender(<WorkspaceHeaderV2 {...headerProps({ renameDisabled: true, title })} />);
    expect(screen.getByTestId("header-title")).toHaveAttribute("title", title);
    expect(screen.getByTestId("header-title")).not.toHaveAccessibleDescription("Rename chat");
  });

  it("shows the canonical New chat placeholder until a real title exists", () => {
    render(<WorkspaceHeaderV2 {...headerProps({ title: "New Chat" })} />);

    expect(screen.getByTestId("header-title")).toHaveTextContent("New chat");
    expect(screen.queryByText("New Chat")).toBeNull();
  });

  it("keeps the welcome header empty and carries no account menu", () => {
    const props = headerProps({ active: false });
    render(<WorkspaceHeaderV2 {...props} />);

    // Welcome: no title, no kicker, no chat actions — a quiet bar.
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByTestId("header-more-trigger")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Commands" })).toBeNull();
    // The account menu is the sidebar footer's single entry, never a header one.
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
  });

  it("keeps Share governance, the Temporary indicator, and shared dismissal", () => {
    const props = headerProps({ shareDisabled: true, temporaryMemory });
    render(<WorkspaceHeaderV2 {...props} />);

    expect(screen.getByTestId("header-temporary-indicator")).toHaveTextContent("Temporary chat");

    const trigger = screen.getByTestId("header-more-trigger");
    fireEvent.click(trigger);
    const share = screen.getByRole("menuitem", { name: "Share" });
    expect(share).toBeDisabled();
    fireEvent.click(share);
    expect(props.onShare).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Branches" }), { key: "Escape" });
    expect(screen.queryByTestId("header-more-menu")).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("header-more-menu")).toBeNull();
  });

});

describe("Chat location crumb v2", () => {
  it("uses the Project-owned hierarchy and prefixes the Project name", () => {
    expect(chatLocationCrumbV2({
      chat: { folderId: "project-child", projectId: "project-1" },
      personalFolders: [{ id: "project-child", name: "Personal leak", parentId: null }],
      project: { id: "project-1", name: "Ingest pipeline" },
      projectFolders: [
        { id: "project-root", name: "Specs", parentId: null },
        { id: "project-child", name: "Retries", parentId: "project-root" }
      ]
    })).toBe("Ingest pipeline / Specs / Retries");

    expect(chatLocationCrumbV2({
      chat: { folderId: null, projectId: "project-1" },
      personalFolders: [],
      project: { id: "project-1", name: "Ingest pipeline" },
      projectFolders: []
    })).toBe("Ingest pipeline");
  });

  it("starts at the Project folders while the header chip names the Project", () => {
    const project = { id: "project-1", name: "Ingest pipeline" };
    const projectFolders = [{ id: "project-root", name: "Specs", parentId: null }];
    expect(chatLocationCrumbV2({
      chat: { folderId: "project-root", projectId: "project-1" }, personalFolders: [], project, projectNamed: true, projectFolders
    })).toBe("Specs");
    expect(chatLocationCrumbV2({
      chat: { folderId: null, projectId: "project-1" }, personalFolders: [], project, projectNamed: true, projectFolders
    })).toBeNull();
  });

  it("keeps personal paths separate and fails closed for a mismatched Project", () => {
    const personalFolders = [
      { id: "personal-root", name: "Research", parentId: null },
      { id: "personal-child", name: "Recall", parentId: "personal-root" }
    ];
    expect(chatLocationCrumbV2({
      chat: { folderId: "personal-child", projectId: null },
      personalFolders,
      project: null,
      projectFolders: []
    })).toBe("Research / Recall");
    expect(chatLocationCrumbV2({
      chat: { folderId: "personal-child", projectId: "project-missing" },
      personalFolders,
      project: { id: "other-project", name: "Other" },
      projectFolders: []
    })).toBeNull();
  });
});

describe("Blank welcome v2", () => {
  it("shows the Project Assistant intro instead of hiding it behind Project orientation", () => {
    render(<>{blankConversationOrientationV2({
      assistantOrientation: <section data-testid="project-assistant-intro">Assistant starters</section>,
      projectOrientation: <section data-testid="project-generic-intro">Shared project</section>,
      projectSelected: true
    })}</>);

    expect(screen.getByTestId("project-assistant-intro")).toBeVisible();
    expect(screen.queryByTestId("project-generic-intro")).toBeNull();
  });

  it("leaves the personal blank chat to the quiet greeting with no generic starter prompts", () => {
    expect(blankConversationOrientationV2({
      projectOrientation: <section>Shared project</section>,
      projectSelected: false
    })).toBeUndefined();

    render(<>{blankConversationOrientationV2({
      assistantOrientation: <section data-testid="assistant-intro">Assistant</section>,
      projectSelected: false
    })}</>);
    expect(screen.getByTestId("assistant-intro")).toBeVisible();
  });
});

describe("answer sound settings", () => {
  it("offers ten choices and plays only an explicit preview, including while muted", async () => {
    const composer = {
      notificationSoundEnabled: false, notificationSoundId: "rise" as const, notificationSoundReady: true,
      previewAnswerSound: vi.fn(async () => true), selectAnswerSound: vi.fn(), toggleNotificationSound: vi.fn()
    };
    const { rerender } = render(<AnswerSoundSettingsRowV2 composer={composer} />);
    expect(composer.previewAnswerSound).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Completion sound" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rise", "Bell", "Drop", "Double tap", "Soft bell", "Warm success", "Marimba",
      "Gentle pop", "Minimal confirm", "Liquid bubble"
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Marimba" }));
    expect(composer.selectAnswerSound).toHaveBeenCalledWith("marimba");
    expect(composer.previewAnswerSound).not.toHaveBeenCalled();
    rerender(<AnswerSoundSettingsRowV2 composer={{ ...composer, notificationSoundId: "marimba" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Play preview" }));
    await waitFor(() => expect(composer.previewAnswerSound).toHaveBeenCalledWith("marimba"));
    expect(composer.toggleNotificationSound).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Answer sound" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("switch", { name: "Answer sound" }));
    expect(composer.toggleNotificationSound).toHaveBeenCalledOnce();
    expect(composer.previewAnswerSound).toHaveBeenCalledOnce();
  });

  it("disables loading preferences and reports a failed preview without enabling sound", async () => {
    const composer = {
      notificationSoundEnabled: false, notificationSoundId: "rise" as const, notificationSoundReady: false,
      previewAnswerSound: vi.fn(async () => false), selectAnswerSound: vi.fn(), toggleNotificationSound: vi.fn()
    };
    const { rerender } = render(<AnswerSoundSettingsRowV2 composer={composer} />);
    expect(screen.getByRole("switch", { name: "Answer sound" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Play preview" })).toBeDisabled();
    rerender(<AnswerSoundSettingsRowV2 composer={{ ...composer, notificationSoundReady: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Play preview" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Preview could not play"));
    expect(composer.toggleNotificationSound).not.toHaveBeenCalled();
  });
});
