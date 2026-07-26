import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import type { ChatSummary, FolderSummary, InspectorMode } from "./types";
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
  | "creatingChat"
  | "noticeSlot"
  | "openMcpSettings"
  | "openSettings"
  | "pipeline"
  | "retryWorkspace"
  | "runWarnings"
  | "workspaceError"
  | "workspaceLoading"
  | "workspaceReady";

vi.mock("@/components/app-shell/ShellLeftPane", () => ({
  ShellLeftPane: ({
    layout,
    pane,
    scrollTopRef
  }: {
    layout?: "desktop" | "mobile";
    pane: ShellWorkspacePaneView;
    scrollTopRef?: { current: number | undefined };
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
      </aside>
    );
  }
}));

vi.mock("@/components/app-shell/MainThreadPane", () => ({
  MainThreadPane: ({ noticeSlot }: { noticeSlot?: ReactNode }) => (
    <section data-testid="main-thread-pane">
      Conversation
      {noticeSlot}
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
      attachments: [],
      backgroundMode: false,
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
        rejectAttachments: noop,
        removeAttachment: noop
      },
      composerContextLine: null,
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
      currentPrompt: null,
      draft: "",
      flushPendingModelControlDefaults: noop,
      maxOutputTokens: "1024",
      notificationSoundEnabled: false,
      operationError: null,
      reasoningEffort: "none",
      reasoningMode: "standard",
      retryCatalog: noop,
      searchOptions: [],
      selectModel: noop,
      selectPrompt: noop,
      selectRunProfile: noop,
      selectSearchStrategy: noop,
      selectedModelId: "test-model",
      selectedPromptId: null,
      selectedProvider: "test-provider",
      selectedProviderName: "Test provider",
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
      uploading: false
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
      sharing: false
    },
    settings: {
      actions: {
        cancelDeletePrompt: noop,
        closeSettings: noop,
        confirmDeletePrompt: noop,
        createSettingsPrompt: async () => undefined,
        deleteSettingsPrompt: async () => undefined,
        duplicateSettingsPrompt: async () => undefined,
        editSettingsPrompt: noop,
        newSettingsPrompt: noop,
        openSettings: noop,
        selectPrompt: () => null,
        setDefaultPromptPreset: async () => undefined,
        setSettingsPromptEditor: noop,
        updateSettingsPrompt: async () => undefined,
        usePromptForNextRun: noop
      },
      dismissNotice: noop,
      notice: null,
      open: noop,
      openMcp: noop,
      prompt: {
        deleteConfirmation: null,
        editor: {
          developerPrompt: "",
          id: null,
          name: "",
          systemPrompt: ""
        },
        open: false,
        section: "prompts",
        saving: false,
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
        changeMode: setMode,
        mode,
        pinningAvailable
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
  defaultPromptPresetId: null,
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

describe("PowerAppShellView compact New chat", () => {
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
});

describe("PowerAppShellView Details composition", () => {
  it("defaults to navigation plus an unsqueezed conversation with Details absent", () => {
    render(<StatefulView />);

    const shell = screen.getByTestId("app-shell");
    const grid = screen.getByTestId("shell-workspace-grid");
    const rail = screen.getByTestId("workspace-rail");
    const conversation = screen.getByTestId("conversation-column");

    expect(shell).toHaveClass("h-dvh", "bg-research-canvas", "text-ink");
    expect(shell).not.toHaveClass("shell-reveal");
    expect(rail).toHaveClass("bg-workspace-rail", "lg:grid");
    expect(rail).toContainElement(screen.getByTestId("left-chat-pane"));
    expect(conversation).toHaveClass("bg-answer-paper", "flex-col");
    expect(conversation).toContainElement(screen.getByTestId("top-rail"));
    expect(conversation).toContainElement(screen.getByTestId("main-thread-pane"));
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();
    expect(grid).toHaveAttribute("data-details-presentation", "closed");
    expect(grid).toHaveClass("lg:grid-cols-[16rem_minmax(0,1fr)]");
    expect(grid.className).not.toContain("minmax(480px");
    expect(screen.getByTestId("shell-primary-content")).not.toHaveAttribute("inert");
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
      "min-[1440px]:grid-cols-[16rem_minmax(0,1fr)_23rem]"
    );
    expect(trigger).not.toHaveFocus();

    fireEvent.click(pinned.querySelector("button[aria-label='Close details']") as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("makes the shell inert while Settings owns notices inside its layout", () => {
    const props = baseProps();
    const setSettingsNotice = vi.fn();
    render(
      <PowerAppShellView
        {...props}
        settings={{
          ...props.settings,
          dismissNotice: () => setSettingsNotice(null),
          notice: { kind: "error", scope: "settings", text: "Prompt save failed" },
          prompt: {
            ...props.settings.prompt,
            open: true,
            themeId: "aiqsa"
          }
        }}
      />
    );

    const primaryContent = screen.getByTestId("shell-primary-content");
    const settings = screen.getByRole("dialog", { name: "Settings" });
    const noticeRegion = screen.getByTestId("settings-notice-region");
    expect(primaryContent).toHaveAttribute("inert");
    expect(primaryContent).toHaveAttribute("aria-hidden", "true");
    expect(settings).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Prompt save failed");
    expect(screen.getByRole("alert")).toHaveClass("pointer-events-auto");
    expect(settings).toContainElement(noticeRegion);
    expect(screen.queryByTestId("shell-notice-layer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(setSettingsNotice).toHaveBeenCalledWith(null);
    expect(props.session.dismissNotice).not.toHaveBeenCalled();
  });

  it("keeps shell and Settings notice channels independent", () => {
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
          actions: {
            ...props.settings.actions,
            closeSettings
          },
          dismissNotice: () => setSettingsNotice(null),
          notice: { kind: "error", scope: "settings", text: "Prompt save failed" },
          prompt: { ...props.settings.prompt, open: true }
        }}
      />
    );

    const primaryContent = screen.getByTestId("shell-primary-content");
    const noticeRegion = screen.getByTestId("persistent-notice-region");
    expect(primaryContent).toContainElement(noticeRegion);
    expect(primaryContent).toHaveAttribute("inert");
    expect(screen.getByTestId("settings-notice-region")).toHaveTextContent("Prompt save failed");
    expect(screen.getByTestId("settings-notice-region")).not.toHaveTextContent("Public link ready");
    expect(screen.queryByTestId("shell-notice-layer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(closeSettings).toHaveBeenCalledOnce();
    expect(setSettingsNotice).toHaveBeenCalledWith(null);
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("keeps account sign-out pending and exposes retryable network feedback", async () => {
    let rejectSignOut!: (reason?: unknown) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectSignOut = reject;
        })
    );
    render(<PowerAppShellView {...baseProps()} />);

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByText("shell.user@example.com")).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("menuitem", { name: "Signing out…" })).toBeDisabled();

    act(() => rejectSignOut(new Error("offline")));

    expect(await screen.findByTestId("sign-out-error-alert")).toHaveTextContent("Could not reach the server");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeEnabled();
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

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
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
    expect(workspace.style.width).toContain("env(safe-area-inset-right)");
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
    let viewportListener: ((event: MediaQueryListEvent) => void) | null = null;
    const removeEventListener = vi.fn();
    const matchMedia = vi.fn((query: string) =>
      ({
        addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
          viewportListener = listener;
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
      viewportListener?.({ matches: true } as MediaQueryListEvent);
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).not.toBeInTheDocument());
    expect(screen.getByTestId("shell-primary-content")).not.toHaveAttribute("inert");
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it("cancels a Workspace confirmation before the lg breakpoint unmounts its opener", async () => {
    let viewportListener: ((event: MediaQueryListEvent) => void) | null = null;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) =>
        ({
          addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
            viewportListener = listener;
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
      viewportListener?.({ matches: true } as MediaQueryListEvent);
    });

    expect(screen.queryByRole("dialog", { name: "Delete chat Mobile delete" })).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-mobile")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("workspace-pane-mobile")).not.toBeInTheDocument());
  });
});
