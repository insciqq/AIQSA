import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { MainThreadPaneProps } from "./MainThreadPane";
import { powerAppShellViewFeatureKeys } from "./powerAppShellViewContracts";
import type {
  ShellComposerView,
  ShellDetailsView,
  ShellThreadView,
  ShellWorkspacePaneActions,
  ShellWorkspacePaneState,
  ShellWorkspacePaneView
} from "./powerAppShellViewContracts";
import type { ShellLeftPaneProps } from "./ShellLeftPane";
import type { AssistantLibraryView } from "@/components/assistants/libraryViewContracts";
import type { KnowledgeLibraryView } from "@/components/knowledge/libraryViewContracts";
import type { ChatSummary, FolderSummary, InspectorMode, ThreadMessage } from "./types";
import { AIQSA_WORKSPACE_RAIL_STORAGE_KEY } from "./shellStorage";
import {
  mobileWorkspaceDesktopMediaQuery,
  PowerAppShellView,
  type PowerAppShellViewProps
} from "./PowerAppShellView";

type RootSetterKey<T extends object> = {
  [Key in keyof T]: Key extends string
    ? Key extends `set${infer Suffix}`
      ? Suffix extends Capitalize<Suffix>
        ? Key
        : never
      : never
    : never;
}[keyof T];

const expectedFeatureKeys = [
  "session",
  "workspace",
  "thread",
  "composer",
  "details",
  "settings",
  "overlays"
] as const;

type MainThreadProjectionKeys =
  | Exclude<keyof ShellThreadView, "copyVisibleThread">
  | keyof ShellComposerView
  | "activeChatId"
  | "adminEntryVisible"
  | "creatingChat"
  | "noticeSlot"
  | "openMcpSettings"
  | "openRunDetails"
  | "pipeline"
  | "retryWorkspace"
  | "runWarnings"
  | "workspaceError"
  | "workspaceLoading"
  | "workspaceReady";

vi.mock("@/components/app-shell/McpSettingsSection", () => ({
  McpSettingsSection: () => <section data-testid="mcp-settings-section">MCP settings</section>
}));

vi.mock("@/components/assistants/AssistantLibrary", () => ({
  AssistantLibrary: () => <section data-testid="assistant-library">Assistant library</section>
}));

vi.mock("@/components/knowledge/KnowledgeLibrary", () => ({
  KnowledgeLibrary: () => <section data-testid="knowledge-library">Knowledge library</section>
}));

vi.mock("@/components/app-shell/ShellLeftPane", () => ({
  ShellLeftPane: ({
    footer,
    layout,
    onHideWorkspace,
    pane,
    scrollTopRef,
    workspaceToggleRef
  }: {
    footer?: ReactNode;
    layout?: "desktop" | "mobile";
    onHideWorkspace?(): void;
    pane: ShellWorkspacePaneView;
    scrollTopRef?: { current: number | undefined };
    workspaceToggleRef?: Ref<HTMLButtonElement>;
  }) => {
    const navigationRef = useRef<HTMLElement>(null);
    useLayoutEffect(() => {
      const initialScrollTop = scrollTopRef?.current;
      if (initialScrollTop !== undefined && navigationRef.current) {
        navigationRef.current.scrollTop = initialScrollTop;
      }
    }, [scrollTopRef]);

    return (
      <aside
        ref={navigationRef}
        aria-label="Workspace chats and folders"
        data-testid={layout === "mobile" ? "left-chat-pane-mobile" : "left-chat-pane"}
        role="navigation"
        onScroll={(event) => {
          if (scrollTopRef) {
            scrollTopRef.current = event.currentTarget.scrollTop;
          }
        }}
      >
        Workspace navigation
        {layout !== "mobile" && onHideWorkspace ? (
          <button ref={workspaceToggleRef} type="button" onClick={onHideWorkspace}>
            Hide workspace
          </button>
        ) : null}
        {layout === "mobile" ? (
          <button
            type="button"
            onClick={() => {
              pane.actions.openProjectSettings({
                id: "folder-mobile",
                name: "Mobile project",
                parentId: null,
                projectMemory: "Mobile memory",
                sortOrder: 0
              });
            }}
          >
            Open mobile project settings
          </button>
        ) : null}
        {footer ? <div data-testid="mock-workspace-account-footer">{footer}</div> : null}
      </aside>
    );
  }
}));

vi.mock("@/components/app-shell/MainThreadPane", () => ({
  MainThreadPane: ({
    noticeSlot,
    operationError,
    operationErrorLive
  }: {
    noticeSlot?: ReactNode;
    operationError?: string | null;
    operationErrorLive?: boolean;
  }) => (
    <section data-testid="main-thread-pane">
      Conversation
      {noticeSlot}
      {operationError ? (
        <div
          data-testid="composer-operation-error"
          role={operationErrorLive ? "alert" : undefined}
        >
          {operationError}
        </div>
      ) : null}
    </section>
  )
}));

vi.mock("@/components/app-shell/InspectorPanels", () => ({
  DetailedInspector: ({
    onClose,
    onPinToggle,
    pinned,
    pinningAvailable
  }: {
    onClose(): void;
    onPinToggle(): void;
    pinned: boolean;
    pinningAvailable: boolean;
  }) => (
    <div>
      <h2 id="details-heading">Details</h2>
      {pinningAvailable ? (
        <button type="button" aria-label={pinned ? "Unpin details" : "Pin details"} onClick={onPinToggle}>
          {pinned ? "Unpin" : "Pin"}
        </button>
      ) : null}
      <button type="button" aria-label="Close details" onClick={onClose}>
        Close
      </button>
    </div>
  )
}));

function baseProps(): PowerAppShellViewProps {
  const noop = vi.fn();

  return {
    composer: {
      assistant: {
        clearRemovedNotice: noop,
        openLibrary: noop,
        openPicker: false,
        pickerItems: [],
        pickerLoading: false,
        recentIds: [],
        remove: noop,
        removedNotice: false,
        selectById: noop,
        selected: null,
        sendStarter: noop,
        setPickerOpen: noop,
        startFromCurrentSetup: noop
      },
      attachments: [],
      backgroundMode: false,
      compatibleSearchOptionIds: [],
      catalog: null,
      catalogError: null,
      changeBackgroundMode: noop,
      changeMaxOutputTokens: noop,
      changeReasoningEffort: noop,
      changeReasoningMode: noop,
      changeStreamMode: noop,
      changeTemperature: noop,
      composerActions: {
        cancelMessageEdit: noop,
        changeDraft: noop,
        rejectAttachmentCount: noop,
        rejectAttachments: noop,
        removeAttachment: noop
      },
      composerContextStats: null,
      composerDisabledHint: null,
      composerUsageStats: null,
      currentModel: undefined,
      currentParameterControls: {
        background: { defaultValue: false, supported: false },
        maxOutputTokens: { defaultValue: 1024, maxValue: 4096 },
        reasoningEffort: { defaultValue: "none", options: ["none"], supported: false },
        stream: { defaultValue: false, supported: false },
        temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
      },
      draft: "",
      flushPendingModelControlDefaults: noop,
      maxOutputTokens: "1024",
      notificationSoundEnabled: false,
      operationError: null,
      operationErrorLive: true,
      reasoningEffort: "none",
      reasoningMode: "standard",
      retryCatalog: noop,
      searchOptions: [],
      searchPreferenceSource: "personal",
      searchPlanMode: "all_selected",
      selectModel: noop,
      selectSearchPlan: noop,
      selectSearchStrategy: noop,
      selectedModelId: "test-model",
      selectedProvider: "test-provider",
      selectedProviderName: "Test provider",
      selectedSearchOptionIds: [],
      selectedSearchStrategy: "search-disabled",
      showCitations: true,
      showReasoningBlocks: true,
      showToolActivity: true,
      stopCurrentRun: noop,
      streamMode: false,
      submitComposer: noop,
      temperature: "1",
      toggleCitationsVisibility: noop,
      toggleNotificationSound: noop,
      toggleReasoningBlockVisibility: noop,
      toggleToolActivityVisibility: noop,
      uploadFiles: noop,
      uploading: false,
      useOrganizationSearchDefault: noop
    },
    details: {
      activeLeafId: null,
      activeTab: "branch",
      changeActiveTab: noop,
      changeMode: noop,
      checkoutBranch: noop,
      errorText: null,
      events: [],
      messages: [],
      mode: "closed",
      open: noop,
      pinningAvailable: false
    },
    overlays: {
      confirmations: {
        cancelChat: noop,
        cancelFolder: noop,
        cancelMessage: noop,
        chat: null,
        confirmChat: noop,
        confirmFolder: noop,
        confirmMessage: noop,
        folder: null,
        message: null
      },
      palette: {
        close: noop,
        items: [],
        open: false,
        run: noop,
        show: noop
      },
      share: {
        close: noop,
        target: null
      }
    },
    session: {
      accountEmail: "shell.user@example.com",
      activeChatId: "chat-1",
      activeChatTitle: "Shell test chat",
      adminEntryVisible: false,
      dismissNotice: noop,
      notice: null,
      shareActiveBranch: noop,
    },
    settings: {
      closeSettings: noop,
      dismissNotice: noop,
      knowledge: null,
      library: null,
      notice: null,
      open: noop,
      openKnowledge: noop,
      openLibrary: noop,
      openMcp: noop,
      settings: {
        open: false,
        section: "appearance",
        themeId: "aiqsa"
      },
      updateTheme: noop
    },
    thread: {
      activeChatDetailError: null,
      activeChatDetailLoading: false,
      activeChatStreaming: false,
      copyVisibleThread: noop,
      currentRunId: null,
      editingMessageId: null,
      editingMessagePending: false,
      handleBranchFromMessage: noop,
      handleCopyMessage: noop,
      handleDeleteMessage: noop,
      handleEditMessage: noop,
      handleRegenerateMessage: noop,
      handleThreadScroll: noop,
      jumpToLatest: noop,
      lastRun: null,
      liveArtifactSummary: null,
      retryActiveChatDetail: noop,
      showJumpToLatest: false,
      threadScrollRef: { current: null },
      visibleMessages: []
    },
    workspace: {
      mobile: {
        close: noop,
        dialogRef: { current: null },
        open: false,
        show: noop
      },
      pane: {
        actions: {
          activateChat: noop,
          cancelChatEdit: noop,
          cancelFolderEdit: noop,
          cancelSubfolder: noop,
          changeChatQuery: noop,
          changeEditingChatTitle: noop,
          changeEditingFolderName: noop,
          changeNewFolderName: noop,
          changeSubfolderName: noop,
          closeMenus: noop,
          createChat: noop,
          createFolder: noop,
          deleteChat: noop,
          deleteFolder: noop,
          exportChat: noop,
          moveChat: noop,
          moveFolder: noop,
          openProjectSettings: noop,
          retry: noop,
          saveChatTitle: noop,
          saveFolder: noop,
          shareChat: noop,
          startChatEdit: noop,
          startFolderEdit: noop,
          startSubfolder: noop,
          toggleChatActions: noop,
          toggleChatFavorite: noop,
          toggleFolderCollapsed: noop,
          toggleFolderMenu: noop
        },
        state: {
          activeRunChatIds: new Set<string>(),
          chatActionId: null,
          chatContentMatchIds: new Set<string>(),
          chatContentSearchError: null,
          chatContentSearchLoading: false,
          chatGroups: [],
          chatQuery: "",
          collapsedFolderIds: new Set<string>(),
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
      projectSettings: {
        changeDraft: noop,
        close: noop,
        draft: "",
        folder: null,
        save: noop
      }
    }
  };
}

const detailsTestMessage: ThreadMessage = {
  content: "How does the details panel behave?",
  id: "details-test-message",
  parentMessageId: null,
  role: "user",
  status: "complete"
};

/**
 * AssistantLibrary is mocked in this file; the shell only needs a non-null
 * view value to route to the standalone library surface.
 */
function minimalLibraryView(): AssistantLibraryView {
  return { close: vi.fn() } as unknown as AssistantLibraryView;
}

/**
 * KnowledgeLibrary is mocked in this file; the shell only needs a non-null
 * view value to route to the standalone Knowledge surface.
 */
function minimalKnowledgeView(): KnowledgeLibraryView {
  return { onBackToChat: vi.fn() } as unknown as KnowledgeLibraryView;
}

function StatefulView({
  flushPendingModelControlDefaults,
  initialMode = "closed",
  pinningAvailable = false
}: {
  flushPendingModelControlDefaults?: () => void;
  initialMode?: InspectorMode;
  pinningAvailable?: boolean;
}) {
  const [mode, setMode] = useState<InspectorMode>(initialMode);
  const props = baseProps();
  return (
    <PowerAppShellView
      {...props}
      composer={{
        ...props.composer,
        flushPendingModelControlDefaults:
          flushPendingModelControlDefaults ?? props.composer.flushPendingModelControlDefaults
      }}
      details={{
        ...props.details,
        activeLeafId: detailsTestMessage.id,
        changeMode: setMode,
        messages: [detailsTestMessage],
        mode,
        pinningAvailable
      }}
      thread={{
        ...props.thread,
        visibleMessages: [detailsTestMessage]
      }}
    />
  );
}

function StatefulNavigationOverlayView({ adminEntryVisible = true }: { adminEntryVisible?: boolean }) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const props = baseProps();
  return (
    <PowerAppShellView
      {...props}
      session={{ ...props.session, adminEntryVisible }}
      settings={{
        ...props.settings,
        closeSettings: () => setSettingsOpen(false),
        library: libraryOpen ? minimalLibraryView() : null,
        open: () => setSettingsOpen(true),
        openLibrary: () => setLibraryOpen(true),
        settings: { ...props.settings.settings, open: settingsOpen }
      }}
    />
  );
}

const mobileProjectFolder: FolderSummary = {
  id: "folder-mobile",
  name: "Mobile project",
  parentId: null,
  projectMemory: "Mobile memory",
  sortOrder: 0
};

const mobileDeleteChat: ChatSummary = {
  activeLeafMessageId: null,
  createdAt: "2026-07-11T00:00:00.000Z",
  defaultModelId: "fake-qsa",
  defaultProvider: "fake",
  folderId: null,
  id: "chat-mobile-delete",
  messageCount: 1,
  title: "Mobile delete",
  updatedAt: "2026-07-11T00:00:00.000Z"
};

function StatefulWorkspaceView() {
  const [mobileWorkspaceOpen, setMobileWorkspaceOpen] = useState(true);
  const [projectSettingsFolder, setProjectSettingsFolder] = useState<FolderSummary | null>(null);
  const [projectMemoryDraft, setProjectMemoryDraft] = useState("");
  const props = baseProps();

  return (
    <PowerAppShellView
      {...props}
      workspace={{
        mobile: {
          ...props.workspace.mobile,
          close: () => setMobileWorkspaceOpen(false),
          open: mobileWorkspaceOpen,
          show: () => setMobileWorkspaceOpen(true)
        },
        pane: {
          ...props.workspace.pane,
          actions: {
            ...props.workspace.pane.actions,
            openProjectSettings: (folder) => {
              setProjectMemoryDraft(folder.projectMemory);
              setProjectSettingsFolder(folder);
            }
          },
          state: {
            ...props.workspace.pane.state,
            folders: [mobileProjectFolder]
          }
        },
        projectSettings: {
          ...props.workspace.projectSettings,
          changeDraft: setProjectMemoryDraft,
          close: () => {
            setProjectSettingsFolder(null);
            setProjectMemoryDraft("");
          },
          draft: projectMemoryDraft,
          folder: projectSettingsFolder
        }
      }}
    />
  );
}

function StatefulConfirmedWorkspaceView() {
  const [mobileWorkspaceOpen, setMobileWorkspaceOpen] = useState(true);
  const [deleteChatConfirmation, setDeleteChatConfirmation] = useState<ChatSummary | null>(mobileDeleteChat);
  const props = baseProps();

  return (
    <PowerAppShellView
      {...props}
      overlays={{
        ...props.overlays,
        confirmations: {
          ...props.overlays.confirmations,
          cancelChat: () => setDeleteChatConfirmation(null),
          chat: deleteChatConfirmation
        }
      }}
      workspace={{
        ...props.workspace,
        mobile: {
          ...props.workspace.mobile,
          close: () => setMobileWorkspaceOpen(false),
          open: mobileWorkspaceOpen
        }
      }}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.removeItem(AIQSA_WORKSPACE_RAIL_STORAGE_KEY);
  document.title = "AIQSA";
});

describe("PowerAppShellView feature boundary", () => {
  it("exposes seven disjoint feature contracts without leaf props or raw setter bags", () => {
    expect(powerAppShellViewFeatureKeys).toEqual(expectedFeatureKeys);
    expect(Object.keys(baseProps()).sort()).toEqual([...expectedFeatureKeys].sort());
    expect(powerAppShellViewFeatureKeys).toHaveLength(7);
    expectTypeOf<keyof PowerAppShellViewProps>().toEqualTypeOf<
      (typeof expectedFeatureKeys)[number]
    >();
    expectTypeOf<
      Extract<keyof PowerAppShellViewProps, keyof MainThreadPaneProps | keyof ShellLeftPaneProps>
    >().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof MainThreadPaneProps, MainThreadProjectionKeys>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<MainThreadProjectionKeys, keyof MainThreadPaneProps>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof ShellThreadView, keyof ShellComposerView>>().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof ShellDetailsView, keyof ShellThreadView | keyof ShellComposerView>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof ShellWorkspacePaneState, keyof ShellThreadView | keyof ShellComposerView | keyof ShellDetailsView>
    >().toEqualTypeOf<never>();
    expectTypeOf<RootSetterKey<PowerAppShellViewProps>>().toEqualTypeOf<never>();
    expectTypeOf<RootSetterKey<ShellWorkspacePaneActions>>().toEqualTypeOf<never>();
  });
});

describe("PowerAppShellView document title", () => {
  it("tracks visible chat identity, focused account workspaces, and the blank-chat fallback", async () => {
    const props = baseProps();
    const { rerender } = render(<PowerAppShellView {...props} />);

    await waitFor(() => expect(document.title).toBe("Shell test chat · AIQSA"));

    rerender(
      <PowerAppShellView
        {...props}
        session={{ ...props.session, activeChatId: null, activeChatTitle: "Ignored title" }}
        workspace={{
          ...props.workspace,
          pane: {
            ...props.workspace.pane,
            state: { ...props.workspace.pane.state, workspaceLoading: true }
          }
        }}
      />
    );
    await waitFor(() => expect(document.title).toBe("Chat · AIQSA"));

    rerender(
      <PowerAppShellView
        {...props}
        session={{ ...props.session, activeChatId: null, activeChatTitle: "Ignored title" }}
      />
    );
    await waitFor(() => expect(document.title).toBe("New chat · AIQSA"));

    rerender(
      <PowerAppShellView
        {...props}
        settings={{
          ...props.settings,
          settings: { ...props.settings.settings, open: true, section: "appearance" }
        }}
      />
    );
    await waitFor(() => expect(document.title).toBe("Settings · AIQSA"));

    rerender(
      <PowerAppShellView
        {...props}
        settings={{
          ...props.settings,
          library: minimalLibraryView()
        }}
      />
    );
    await waitFor(() => expect(document.title).toBe("Assistants · AIQSA"));

    rerender(
      <PowerAppShellView
        {...props}
        settings={{
          ...props.settings,
          knowledge: minimalKnowledgeView()
        }}
      />
    );
    await waitFor(() => expect(document.title).toBe("Knowledge · AIQSA"));

    rerender(
      <PowerAppShellView
        {...props}
        overlays={{
          ...props.overlays,
          palette: { ...props.overlays.palette, open: true }
        }}
      />
    );
    await waitFor(() => expect(document.title).toBe("Shell test chat · AIQSA"));
  });
});

describe("PowerAppShellView compact New chat", () => {
  it("keeps global Account in Workspace while the prompt-first top rail stays conversation-local", () => {
    render(<PowerAppShellView {...baseProps()} />);

    expect(screen.queryByRole("button", { name: "Share anonymously" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conversation actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start new chat" })).toBeVisible();
    const topRail = screen.getByTestId("top-rail");
    const workspace = screen.getByTestId("left-chat-pane");
    expect(topRail).not.toContainElement(screen.getByRole("button", { name: /Account menu/ }));
    expect(workspace).toContainElement(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.getAllByRole("button", { name: /Account menu/ })).toHaveLength(1);
  });

  it("closes the desktop Account menu and moves focus to Workspace when the viewport becomes compact", async () => {
    let viewportListener: ((event: MediaQueryListEvent) => void) | null = null;
    let viewportMatches = true;
    const removeEventListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) =>
        ({
          addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
            viewportListener = listener;
          },
          dispatchEvent: vi.fn(),
          matches: viewportMatches,
          media: query,
          onchange: null,
          removeEventListener,
          addListener: vi.fn(),
          removeListener: vi.fn()
        }) as unknown as MediaQueryList
      )
    );
    render(<PowerAppShellView {...baseProps()} />);

    const accountTrigger = screen.getByRole("button", { name: /Account menu/ });
    fireEvent.click(accountTrigger);
    const paletteItem = await screen.findByRole("menuitem", { name: "Command palette" });
    await waitFor(() => expect(paletteItem).toHaveFocus());

    act(() => {
      viewportMatches = false;
      viewportListener?.({ matches: false } as MediaQueryListEvent);
    });

    await waitFor(() => expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open workspace" })).toHaveFocus());
    expect(accountTrigger).toHaveAttribute("aria-expanded", "false");

    act(() => {
      viewportMatches = true;
      viewportListener?.({ matches: true } as MediaQueryListEvent);
    });

    await waitFor(() => expect(accountTrigger).toHaveFocus());
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
    expect(removeEventListener).toHaveBeenCalled();
  });

  it("routes the hydrated top-rail action through the existing blank workspace owner", () => {
    const props = baseProps();
    const createChat = vi.fn();
    const renderView = (state: Partial<ShellWorkspacePaneState> = {}) => (
      <PowerAppShellView
        {...props}
        thread={{ ...props.thread, activeChatStreaming: true }}
        workspace={{
          ...props.workspace,
          pane: {
            actions: { ...props.workspace.pane.actions, createChat },
            state: { ...props.workspace.pane.state, ...state }
          }
        }}
      />
    );
    const { rerender } = render(renderView());
    const newChat = screen.getByRole("button", { name: "Start new chat" });

    expect(newChat).toBeEnabled();
    fireEvent.click(newChat);
    expect(createChat).toHaveBeenCalledOnce();
    expect(createChat.mock.calls[0]).toEqual([]);

    rerender(renderView({ workspaceReady: false }));
    expect(screen.getByRole("button", { name: "Start new chat" })).toBeDisabled();

    rerender(renderView({ creatingChat: true }));
    expect(screen.getByRole("button", { name: "Start new chat" })).toBeDisabled();
  });

  it("hides a stale run-error chip until the current conversation owns visible run state", () => {
    const props = baseProps();
    const errorEvent = {
      data: { message: "First send was rejected" },
      type: "error" as const
    };
    const renderView = (withMessage: boolean) => (
      <PowerAppShellView
        {...props}
        details={{
          ...props.details,
          events: [errorEvent],
          messages: withMessage ? [detailsTestMessage] : []
        }}
        thread={{
          ...props.thread,
          visibleMessages: withMessage ? [detailsTestMessage] : []
        }}
      />
    );
    const { rerender } = render(renderView(false));

    expect(screen.queryByTestId("pipeline-indicator")).not.toBeInTheDocument();

    rerender(renderView(true));
    expect(
      screen.getByRole("button", { name: "Run error - open run events" })
    ).toBeVisible();
  });
});

describe("PowerAppShellView run lifecycle announcements", () => {
  const searchEvent = {
    data: { artifactType: "search", payload: { query: "current research" } },
    type: "artifact" as const
  };
  const tokenEvent = {
    data: { delta: "Answer" },
    type: "token" as const
  };
  const completeEvent = {
    data: { status: "complete" },
    type: "done" as const
  };
  const stoppedEvent = {
    data: { status: "cancelled" },
    type: "done" as const
  };
  const errorEvent = {
    data: { message: "Provider failed" },
    type: "error" as const
  };

  function lifecycleView({
    activeChatId = "chat-1",
    events = [],
    operationError = null,
    operationErrorLive = true,
    streaming = false
  }: {
    activeChatId?: string | null;
    events?: PowerAppShellViewProps["details"]["events"];
    operationError?: string | null;
    operationErrorLive?: boolean;
    streaming?: boolean;
  }) {
    const props = baseProps();
    const messages = activeChatId ? [detailsTestMessage] : [];

    return (
      <PowerAppShellView
        {...props}
        composer={{ ...props.composer, operationError, operationErrorLive }}
        details={{ ...props.details, events, messages }}
        session={{ ...props.session, activeChatId }}
        thread={{
          ...props.thread,
          activeChatStreaming: streaming,
          currentRunId: streaming ? "run-current" : null,
          visibleMessages: messages
        }}
      />
    );
  }

  it("keeps one stable live owner outside inert shell content and announces meaningful stages", async () => {
    const { rerender } = render(lifecycleView({ events: [searchEvent], streaming: true }));
    const announcer = screen.getByTestId("run-lifecycle-announcer");
    const primaryContent = screen.getByTestId("shell-primary-content");

    expect(announcer).toHaveAttribute("aria-live", "polite");
    expect(announcer).toHaveAttribute("aria-atomic", "true");
    expect(announcer).toHaveAttribute("role", "status");
    expect(announcer).toHaveClass("sr-only");
    expect(announcer.nextElementSibling).toBe(primaryContent);
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    await waitFor(() => expect(announcer).toHaveTextContent(/^Working$/));

    rerender(lifecycleView({ events: [searchEvent], streaming: true }));
    await waitFor(() => expect(announcer).toHaveTextContent(/^Searching$/));

    rerender(lifecycleView({ events: [searchEvent, tokenEvent], streaming: true }));
    await waitFor(() => expect(announcer).toHaveTextContent(/^Answering$/));
    expect(screen.getByTestId("run-lifecycle-announcer")).toBe(announcer);
  });

  it.each([
    {
      events: [tokenEvent, completeEvent],
      expected: "Run complete. Message composer ready."
    },
    {
      events: [tokenEvent, stoppedEvent],
      expected: "Run stopped. Message composer ready."
    },
    {
      events: [tokenEvent, errorEvent],
      expected: "Run error. Message composer ready."
    }
  ])("announces the observed run terminal as $expected", async ({ events, expected }) => {
    const { rerender } = render(lifecycleView({ streaming: true }));
    const announcer = screen.getByTestId("run-lifecycle-announcer");
    await waitFor(() => expect(announcer).toHaveTextContent(/^Working$/));

    rerender(lifecycleView({ events, streaming: true }));
    await waitFor(() => expect(announcer).toHaveTextContent(/^Working$/));

    rerender(lifecycleView({ events, streaming: false }));

    await waitFor(() => expect(announcer).toHaveTextContent(expected));
  });

  it("does not replay historical terminals on mount or chat switch", async () => {
    const { rerender } = render(lifecycleView({ events: [tokenEvent, completeEvent] }));
    const announcer = screen.getByTestId("run-lifecycle-announcer");

    await waitFor(() => expect(announcer).toBeEmptyDOMElement());

    rerender(lifecycleView({ streaming: true }));
    await waitFor(() => expect(announcer).toHaveTextContent(/^Working$/));

    rerender(lifecycleView({ activeChatId: "chat-2", events: [errorEvent] }));
    await waitFor(() => expect(announcer).toBeEmptyDOMElement());

    rerender(lifecycleView({ activeChatId: "chat-1", events: [tokenEvent, completeEvent] }));
    await waitFor(() => expect(announcer).toBeEmptyDOMElement());
  });

  it("keeps accepted run recovery visible but non-live beside the shell-owned error terminal", async () => {
    const { rerender } = render(lifecycleView({ streaming: true }));
    const announcer = screen.getByTestId("run-lifecycle-announcer");
    await waitFor(() => expect(announcer).toHaveTextContent(/^Working$/));

    rerender(lifecycleView({
      events: [errorEvent],
      operationError: "Send failed. Your draft was preserved.",
      operationErrorLive: false,
      streaming: false
    }));

    await waitFor(() =>
      expect(announcer).toHaveTextContent("Run error. Message composer ready.")
    );
    expect(screen.getByTestId("composer-operation-error")).toHaveTextContent(
      "Send failed. Your draft was preserved."
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("leaves a pre-run rejection with the Composer owner and no historical run terminal", async () => {
    render(lifecycleView({
      events: [],
      operationError: "Send failed. Your draft was preserved.",
      operationErrorLive: true
    }));

    expect(screen.getByTestId("run-lifecycle-announcer")).toBeEmptyDOMElement();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Send failed. Your draft was preserved."
    );
  });
});

describe("PowerAppShellView Details composition", () => {
  it("defaults to the icon rail, expanded Workspace pane, and an unsqueezed conversation", () => {
    render(<StatefulView />);

    const shell = screen.getByTestId("app-shell");
    const grid = screen.getByTestId("shell-workspace-grid");
    const rail = screen.getByTestId("workspace-icon-rail");
    const pane = screen.getByTestId("workspace-pane-desktop");
    const conversation = screen.getByTestId("conversation-column");

    expect(shell).toHaveClass("h-dvh", "bg-app-canvas", "text-ink");
    expect(rail).toHaveClass(
      "bg-workspace-rail",
      "min-[1281px]:flex",
      "w-[calc(3rem+env(safe-area-inset-left))]"
    );
    expect(pane).toHaveClass("bg-workspace-rail", "min-[1281px]:grid");
    expect(pane).not.toHaveClass("min-[1281px]:pl-[env(safe-area-inset-left)]");
    expect(pane).toContainElement(screen.getByTestId("left-chat-pane"));
    expect(conversation).toHaveClass("bg-answer-paper", "flex-col", "relative");
    expect(conversation).toContainElement(screen.getByTestId("top-rail"));
    expect(conversation).toContainElement(screen.getByTestId("main-thread-pane"));
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();
    expect(grid).toHaveAttribute("data-details-presentation", "closed");
    expect(grid).toHaveClass(
      "min-[1281px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_16rem_minmax(0,1fr)]"
    );
    expect(grid.className).not.toContain("minmax(480px");
    expect(screen.getByTestId("shell-primary-content")).not.toHaveAttribute("inert");
  });

  it("hides only the Workspace pane and restores it from current Chats without replacing conversation state", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) =>
        ({
          addEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
          matches: true,
          media: query,
          onchange: null,
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn()
        }) as unknown as MediaQueryList
      )
    );
    render(<StatefulView />);

    const grid = screen.getByTestId("shell-workspace-grid");
    fireEvent.click(screen.getByRole("button", { name: "Hide workspace" }));

    await waitFor(() => expect(grid).toHaveAttribute("data-workspace-pane-hidden", "true"));
    expect(grid).toHaveClass(
      "min-[1281px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_minmax(0,1fr)]"
    );
    expect(screen.getByTestId("workspace-pane-desktop")).toHaveAttribute("inert");
    expect(window.localStorage.getItem(AIQSA_WORKSPACE_RAIL_STORAGE_KEY)).toBe("hidden");
    await waitFor(() => expect(screen.getByRole("button", { name: "Chats" })).toHaveFocus());
    expect(screen.getByTestId("main-thread-pane")).toHaveTextContent("Conversation");
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Workspace controls" })).toHaveClass("min-[1281px]:hidden");

    fireEvent.click(screen.getByRole("button", { name: "Chats" }));

    await waitFor(() => expect(grid).not.toHaveAttribute("data-workspace-pane-hidden"));
    expect(grid).toHaveClass(
      "min-[1281px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_16rem_minmax(0,1fr)]"
    );
    expect(window.localStorage.getItem(AIQSA_WORKSPACE_RAIL_STORAGE_KEY)).toBe("visible");
    await waitFor(() => expect(screen.getByRole("button", { name: "Hide workspace" })).toHaveFocus());
  });

  it("restores a hidden Workspace preference after hydration", async () => {
    window.localStorage.setItem(AIQSA_WORKSPACE_RAIL_STORAGE_KEY, "hidden");
    render(<StatefulView />);

    await waitFor(() =>
      expect(screen.getByTestId("shell-workspace-grid")).toHaveAttribute(
        "data-workspace-pane-hidden",
        "true"
      )
    );
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-desktop")).toHaveAttribute("inert");
    expect(screen.getByRole("group", { name: "Workspace controls" })).toHaveClass("min-[1281px]:hidden");
  });

  it("keeps all four icon-track, pane, conversation, and pinned Details grid templates explicit", async () => {
    render(<StatefulView initialMode="pinned" />);
    const grid = screen.getByTestId("shell-workspace-grid");

    expect(grid).toHaveClass(
      "min-[1281px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_16rem_minmax(0,1fr)]",
      "min-[1440px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_16rem_minmax(0,1fr)_23rem]"
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide workspace" }));
    await waitFor(() => expect(grid).toHaveAttribute("data-workspace-pane-hidden", "true"));
    expect(grid).toHaveClass(
      "min-[1281px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_minmax(0,1fr)]",
      "min-[1440px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_minmax(0,1fr)_23rem]"
    );
  });

  it("re-anchors an open pane Account surface to the surviving rail before hiding the pane", async () => {
    render(<StatefulView />);
    const paneAccount = screen.getByRole("button", { name: /Account menu for/ });
    fireEvent.click(paneAccount);
    expect(screen.getByRole("menu", { name: "Account" }).parentElement).toHaveAttribute(
      "data-account-menu-anchor",
      "pane"
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide workspace" }));

    await waitFor(() =>
      expect(screen.getByRole("menu", { name: "Account" }).parentElement).toHaveAttribute(
        "data-account-menu-anchor",
        "rail"
      )
    );
    expect(screen.getByTestId("shell-workspace-grid")).toHaveAttribute("data-workspace-pane-hidden", "true");
    expect(screen.getByRole("button", { name: "Account" })).toHaveAttribute("aria-controls", "account-menu");
    expect(paneAccount).not.toHaveAttribute("aria-controls");
    expect(screen.getAllByRole("menu", { name: "Account" })).toHaveLength(1);
  });

  it("opens direct rail destinations with one overlay and restores the exact Settings opener", async () => {
    render(<StatefulNavigationOverlayView />);
    const directSettings = screen.getByRole("button", { name: "Settings" });
    const paneAccount = screen.getByRole("button", { name: /Account menu for/ });
    fireEvent.click(paneAccount);
    expect(screen.getByRole("menu", { name: "Account" })).toBeVisible();

    fireEvent.click(directSettings);
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    expect(directSettings).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Assistants" }));
    expect(screen.getByTestId("assistant-library")).toBeVisible();
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
  });

  it("restores Settings to the invoking pane or rail Account trigger", async () => {
    render(<StatefulNavigationOverlayView />);
    const paneAccount = screen.getByRole("button", { name: /Account menu for/ });
    fireEvent.click(paneAccount);
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(paneAccount).toHaveFocus());

    const railAccount = screen.getByRole("button", { name: "Account" });
    fireEvent.click(railAccount);
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(railAccount).toHaveFocus());
  });

  it("transfers focus from controls in either desktop navigation column and restores by source", async () => {
    let viewportMatches = true;
    const viewportListeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) =>
        ({
          addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
            viewportListeners.add(listener);
          },
          dispatchEvent: vi.fn(),
          matches: viewportMatches,
          media: query,
          onchange: null,
          removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
            viewportListeners.delete(listener);
          },
          addListener: vi.fn(),
          removeListener: vi.fn()
        }) as unknown as MediaQueryList
      )
    );
    render(<StatefulView />);

    const railSettings = screen.getByRole("button", { name: "Settings" });
    railSettings.focus();
    act(() => {
      viewportMatches = false;
      Array.from(viewportListeners).forEach((listener) => listener({ matches: false } as MediaQueryListEvent));
    });
    const compactWorkspace = screen.getByRole("button", { name: "Open workspace" });
    await waitFor(() => expect(compactWorkspace).toHaveFocus());
    compactWorkspace.blur();
    expect(compactWorkspace).not.toHaveFocus();
    act(() => {
      viewportMatches = true;
      Array.from(viewportListeners).forEach((listener) => listener({ matches: true } as MediaQueryListEvent));
    });
    await waitFor(() => expect(railSettings).toHaveFocus());

    const paneHide = screen.getByRole("button", { name: "Hide workspace" });
    paneHide.focus();
    act(() => {
      viewportMatches = false;
      Array.from(viewportListeners).forEach((listener) => listener({ matches: false } as MediaQueryListEvent));
    });
    await waitFor(() => expect(compactWorkspace).toHaveFocus());
    act(() => {
      viewportMatches = true;
      Array.from(viewportListeners).forEach((listener) => listener({ matches: true } as MediaQueryListEvent));
    });
    await waitFor(() => expect(paneHide).toHaveFocus());
  });

  it("opens a modal drawer, contains focus, closes with Escape, and restores the trigger", async () => {
    const flushPendingModelControlDefaults = vi.fn();
    render(<StatefulView flushPendingModelControlDefaults={flushPendingModelControlDefaults} />);
    const trigger = screen.getByRole("button", { name: "Open details" });

    trigger.focus();
    fireEvent.click(trigger);

    const drawer = await screen.findByRole("dialog", { name: "Details" });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(drawer.className).toContain("right-[max(0.5rem,env(safe-area-inset-right))]");
    expect(drawer.className).toContain("max-sm:pl-[env(safe-area-inset-left)]");
    expect(drawer.className).toContain("max-sm:pr-[env(safe-area-inset-right)]");
    expect(screen.getByTestId("details-pane-backdrop")).not.toHaveClass("backdrop-blur-sm");
    expect(screen.getByTestId("shell-primary-content")).toHaveAttribute("inert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Close details" })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close details" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(flushPendingModelControlDefaults).not.toHaveBeenCalled();
  });

  it("closes the drawer from its backdrop", async () => {
    const flushPendingModelControlDefaults = vi.fn();
    render(<StatefulView flushPendingModelControlDefaults={flushPendingModelControlDefaults} />);
    fireEvent.click(screen.getByRole("button", { name: "Open details" }));
    await screen.findByRole("dialog", { name: "Details" });

    fireEvent.mouseDown(screen.getByTestId("details-pane-backdrop"));

    await waitFor(() => expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument());
    expect(flushPendingModelControlDefaults).not.toHaveBeenCalled();
  });

  it("pins without modal semantics or premature focus restoration, then restores on final close", async () => {
    render(<StatefulView pinningAvailable />);
    const trigger = screen.getByRole("button", { name: "Open details" });
    trigger.focus();
    fireEvent.click(trigger);

    const pin = await screen.findByRole("button", { name: "Pin details" });
    await waitFor(() => expect(pin).toHaveFocus());
    fireEvent.click(pin);

    const pinned = screen.getByTestId("details-pane");
    expect(pinned).toHaveAttribute("data-presentation", "pinned");
    expect(pinned).toHaveClass("border-trace-subtle", "bg-overlay-surface", "min-[1440px]:flex");
    expect(pinned).not.toHaveAttribute("role", "dialog");
    expect(screen.queryByTestId("details-pane-backdrop")).not.toBeInTheDocument();
    expect(screen.getByTestId("shell-primary-content")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("shell-workspace-grid")).toHaveClass(
      "min-[1440px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_16rem_minmax(0,1fr)_23rem]"
    );
    expect(trigger).not.toHaveFocus();

    fireEvent.click(pinned.querySelector("button[aria-label='Close details']") as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("renders the Assistants surface standalone and suppresses shell notices", () => {
    const props = baseProps();
    render(
      <PowerAppShellView
        {...props}
        session={{
          ...props.session,
          notice: { kind: "success", text: "Copied" }
        }}
        settings={{
          ...props.settings,
          library: minimalLibraryView(),
          settings: { ...props.settings.settings, open: true, section: "appearance" }
        }}
      />
    );

    const primaryContent = screen.getByTestId("shell-primary-content");
    expect(primaryContent).toHaveAttribute("inert");
    expect(primaryContent).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("assistant-library")).toBeVisible();
    expect(screen.queryByTestId("settings-dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-notice-region")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shell-notice-layer")).not.toBeInTheDocument();
  });

  it("renders the Knowledge surface standalone and suppresses competing shell overlays", () => {
    const props = baseProps();
    render(
      <PowerAppShellView
        {...props}
        session={{
          ...props.session,
          notice: { kind: "success", text: "Copied" }
        }}
        settings={{
          ...props.settings,
          knowledge: minimalKnowledgeView(),
          library: minimalLibraryView(),
          settings: { ...props.settings.settings, open: true, section: "appearance" }
        }}
      />
    );

    const primaryContent = screen.getByTestId("shell-primary-content");
    expect(primaryContent).toHaveAttribute("inert");
    expect(primaryContent).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("knowledge-library")).toBeVisible();
    expect(screen.queryByTestId("assistant-library")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shell-notice-layer")).not.toBeInTheDocument();
  });

  it.each(["appearance", "mcp"] as const)(
    "renders the %s section only in bounded Settings and keeps notices there",
    (section) => {
      const props = baseProps();
      const closeSettings = vi.fn();
      const setNotice = vi.fn();
      const setSettingsNotice = vi.fn();
      render(
        <PowerAppShellView
          {...props}
          session={{
            ...props.session,
            dismissNotice: () => setNotice(null),
            notice: {
              href: "https://example.test/share/secret",
              kind: "success",
              persistent: true,
              text: "Public link ready"
            }
          }}
          settings={{
            ...props.settings,
            closeSettings,
            dismissNotice: () => setSettingsNotice(null),
            notice: { kind: "error", scope: "settings", text: "Settings update failed" },
            settings: { ...props.settings.settings, open: true, section }
          }}
        />
      );

      const primaryContent = screen.getByTestId("shell-primary-content");
      const shellNoticeRegion = screen.getByTestId("persistent-notice-region");
      const settings = screen.getByTestId("settings-dialog");
      const settingsNoticeRegion = screen.getByTestId("settings-notice-region");
      expect(primaryContent).toContainElement(shellNoticeRegion);
      expect(primaryContent).toHaveAttribute("inert");
      expect(primaryContent).toHaveAttribute("aria-hidden", "true");
      expect(settings).toBeVisible();
      expect(screen.queryByTestId("assistant-library")).not.toBeInTheDocument();
      expect(settings).toContainElement(settingsNoticeRegion);
      expect(settingsNoticeRegion).toHaveTextContent("Settings update failed");
      expect(settingsNoticeRegion).not.toHaveTextContent("Public link ready");
      expect(screen.queryByTestId("shell-notice-layer")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
      expect(closeSettings).toHaveBeenCalledOnce();
      expect(setSettingsNotice).toHaveBeenCalledWith(null);
      expect(setNotice).not.toHaveBeenCalled();
    }
  );

  it("keeps account sign-out pending and exposes retryable network feedback", async () => {
    let rejectSignOut!: (reason?: unknown) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectSignOut = reject;
        })
    );
    render(<PowerAppShellView {...baseProps()} />);

    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.getAllByText("shell.user@example.com")).toHaveLength(2);
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("menuitem", { name: "Signing out…" })).toBeDisabled();

    act(() => rejectSignOut(new Error("offline")));

    expect(await screen.findByTestId("sign-out-error-alert")).toHaveTextContent("Could not reach the server");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeEnabled();
  });

  it("opens the entitled Control Center entry at the default Providers task", () => {
    const props = baseProps();
    render(
      <PowerAppShellView
        {...props}
        session={{
          ...props.session,
          adminEntryVisible: true
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.getByRole("menuitem", { name: "Control Center" })).toHaveAttribute(
      "href",
      "/admin"
    );
  });

  it("keeps the sign-out failure announcement outside inert shell content", async () => {
    let rejectSignOut!: (reason?: unknown) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectSignOut = reject;
        })
    );
    const props = baseProps();
    const { rerender } = render(<PowerAppShellView {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    fireEvent.keyDown(screen.getByRole("menu", { name: "Account" }), { key: "Escape" });
    rerender(
      <PowerAppShellView
        {...props}
        details={{
          ...props.details,
          mode: "overlay"
        }}
      />
    );
    expect(await screen.findByRole("dialog", { name: "Details" })).toBeVisible();

    act(() => rejectSignOut(new Error("offline")));

    const alert = await screen.findByTestId("sign-out-error-alert");
    expect(screen.getByTestId("shell-primary-content")).toHaveAttribute("inert");
    expect(screen.getByTestId("app-shell")).toContainElement(alert);
    expect(screen.getByTestId("shell-primary-content")).not.toContainElement(alert);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});

describe("PowerAppShellView mobile Workspace composition", () => {
  it("moves the single visible Account trigger into the drawer and closes Workspace before replacement", async () => {
    render(<StatefulWorkspaceView />);

    const workspace = screen.getByRole("dialog", { name: "Workspace" });
    const topRail = screen.getByTestId("top-rail");
    const accountTrigger = screen.getByRole("button", { name: /Account menu/ });
    expect(topRail).not.toContainElement(accountTrigger);
    expect(workspace).toContainElement(accountTrigger);
    expect(screen.getAllByRole("button", { name: /Account menu/ })).toHaveLength(1);
    expect(workspace).toHaveClass("z-50");

    fireEvent.click(accountTrigger);
    expect(workspace).toHaveClass("z-[80]");
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).not.toBeInTheDocument());
  });

  it("keeps a failed Account action discoverable after the mobile Workspace closes", async () => {
    let rejectSignOut!: (reason?: unknown) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectSignOut = reject;
        })
    );
    render(<StatefulWorkspaceView />);

    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    fireEvent.click(screen.getByRole("button", { name: "Close workspace" }));
    expect(screen.queryByRole("dialog", { name: "Workspace" })).not.toBeInTheDocument();

    act(() => rejectSignOut(new Error("offline")));

    const workspace = screen.getByRole("button", { name: "Open workspace" });
    await waitFor(() => expect(screen.getByTestId("workspace-account-attention")).toBeVisible());
    expect(workspace).toHaveAttribute("aria-describedby", "workspace-account-attention-description");
  });

  it("makes the Workspace inert while its destructive confirmation owns the modal layer", () => {
    const props = baseProps();
    render(
      <PowerAppShellView
        {...props}
        overlays={{
          ...props.overlays,
          confirmations: {
            ...props.overlays.confirmations,
            chat: {
              ...mobileDeleteChat,
              id: "chat-delete",
              pinned: false,
              title: "Delete me"
            }
          }
        }}
        workspace={{
          ...props.workspace,
          mobile: {
            ...props.workspace.mobile,
            open: true
          }
        }}
      />
    );

    const workspace = screen.getByTestId("workspace-pane-mobile");
    expect(workspace).toHaveAttribute("aria-hidden", "true");
    expect(workspace).toHaveAttribute("inert");
    expect(screen.getByRole("dialog", { name: "Delete chat Delete me" })).toBeVisible();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("provides a touch-sized safe-area close action and unlocks the shell", async () => {
    render(<StatefulWorkspaceView />);

    const workspace = screen.getByRole("dialog", { name: "Workspace" });
    const close = screen.getByRole("button", { name: "Close workspace" });
    expect(workspace.className).toContain("left-[max(0.5rem,env(safe-area-inset-left))]");
    expect(workspace.className).toContain("top-[max(0.5rem,env(safe-area-inset-top))]");
    expect(workspace.className).toContain("bottom-[max(0.5rem,env(safe-area-inset-bottom))]");
    expect(workspace.className).toContain("env(safe-area-inset-right)");
    expect(workspace).toHaveClass("border-trace-subtle", "bg-workspace-rail");
    expect(screen.getByTestId("workspace-pane-mobile-backdrop")).not.toHaveClass("backdrop-blur-sm");
    expect(close.className).toContain("size-11");
    expect(screen.getByTestId("shell-primary-content")).toHaveAttribute("inert");

    fireEvent.click(close);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).not.toBeInTheDocument());
    expect(screen.getByTestId("shell-primary-content")).not.toHaveAttribute("inert");
  });

  it("closes the mobile drawer before opening Project Settings", async () => {
    render(<StatefulWorkspaceView />);

    fireEvent.click(screen.getByRole("button", { name: "Open mobile project settings" }));

    expect(screen.queryByRole("dialog", { name: "Workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Project Settings Mobile project" })).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "Project Settings Mobile project" })).toBeVisible();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("shell-primary-content")).toHaveAttribute("inert");
  });

  it("restores the mobile Workspace browse position after closing and reopening", async () => {
    render(<StatefulWorkspaceView />);
    const navigation = screen.getByTestId("left-chat-pane-mobile");
    navigation.scrollTop = 173;
    fireEvent.scroll(navigation);

    fireEvent.click(screen.getByRole("button", { name: "Close workspace" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));

    expect(await screen.findByRole("dialog", { name: "Workspace" })).toBeVisible();
    expect(screen.getByTestId("left-chat-pane-mobile").scrollTop).toBe(173);
  });

  it("closes and unlocks an open mobile Workspace when the viewport crosses lg", async () => {
    const viewportListeners: Array<(event: MediaQueryListEvent) => void> = [];
    const removeEventListener = vi.fn();
    const matchMedia = vi.fn((query: string) =>
      ({
        addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
          viewportListeners.push(listener);
        },
        dispatchEvent: vi.fn(),
        matches: false,
        media: query,
        onchange: null,
        removeEventListener,
        addListener: vi.fn(),
        removeListener: vi.fn()
      }) as unknown as MediaQueryList
    );
    vi.stubGlobal("matchMedia", matchMedia);
    render(<StatefulWorkspaceView />);

    expect(matchMedia).toHaveBeenCalledWith(mobileWorkspaceDesktopMediaQuery);
    expect(screen.getByRole("dialog", { name: "Workspace" })).toBeVisible();

    act(() => {
      viewportListeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent));
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).not.toBeInTheDocument());
    expect(screen.getByTestId("shell-primary-content")).not.toHaveAttribute("inert");
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it("cancels a Workspace confirmation before the lg breakpoint unmounts its opener", async () => {
    const viewportListeners: Array<(event: MediaQueryListEvent) => void> = [];
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) =>
        ({
          addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
            viewportListeners.push(listener);
          },
          dispatchEvent: vi.fn(),
          matches: false,
          media: query,
          onchange: null,
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn()
        }) as unknown as MediaQueryList
      )
    );
    render(<StatefulConfirmedWorkspaceView />);
    expect(screen.getByRole("dialog", { name: "Delete chat Mobile delete" })).toBeVisible();

    act(() => {
      viewportListeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent));
    });

    expect(screen.queryByRole("dialog", { name: "Delete chat Mobile delete" })).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-mobile")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("workspace-pane-mobile")).not.toBeInTheDocument());
  });
});
