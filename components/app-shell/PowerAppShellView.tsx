"use client";

import { CommandPalette } from "@/components/command-palette/CommandPalette";
import {
  ChatDeleteConfirmationDialog,
  FolderDeleteConfirmationDialog,
  MessageDeleteConfirmationDialog,
  PromptDeleteConfirmationDialog
} from "@/components/app-shell/ConfirmationDialog";
import { AccountMenu } from "@/components/app-shell/AccountMenu";
import { DetailedInspector } from "@/components/app-shell/InspectorPanels";
import { MainThreadPane } from "@/components/app-shell/MainThreadPane";
import type {
  PowerAppShellViewProps,
  ShellWorkspacePaneView
} from "@/components/app-shell/powerAppShellViewContracts";
import { ProjectSettingsDialog } from "@/components/app-shell/ProjectSettingsDialog";
import { ShareDialog } from "@/components/app-shell/ShareDialog";
import { PromptWorkbench } from "@/components/app-shell/PromptWorkbench";
import { SettingsDialog } from "@/components/app-shell/SettingsDialog";
import { ShellLeftPane } from "@/components/app-shell/ShellLeftPane";
import { ShellNotice } from "@/components/app-shell/ShellNotice";
import { TopRail } from "@/components/app-shell/TopRail";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { pipelineStage } from "@/components/app-shell/runState";
import { signOutCurrentSession } from "@/components/app-shell/sessionActions";
import {
  rememberWorkspaceRailHidden,
  storedWorkspaceRailHidden
} from "@/components/app-shell/shellStorage";
import type { RunEventView } from "@/components/app-shell/types";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type { PowerAppShellViewProps } from "@/components/app-shell/powerAppShellViewContracts";

export const mobileWorkspaceDesktopMediaQuery = "(min-width: 1281px)";

function warningText(event: RunEventView): string | null {
  if (event.type !== "warning" || typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) {
    return null;
  }

  const message = (event.data as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message.trim() : "The run reported a warning.";
}

export function PowerAppShellView(props: PowerAppShellViewProps) {
  const { composer, details, overlays, session, settings, thread, workspace } = props;
  const {
    accountEmail,
    activeChatId,
    activeChatTitle,
    adminEntryVisible,
    notice,
    shareActiveBranch
  } = session;
  const { copyVisibleThread, ...threadPane } = thread;
  const { activeChatStreaming, currentRunId } = threadPane;
  const {
    activeLeafId: renderActiveLeafId,
    activeTab: inspectorActiveTab,
    changeActiveTab: setInspectorActiveTab,
    changeMode: setInspectorMode,
    checkoutBranch,
    errorText: currentErrorText,
    events: runEvents,
    messages,
    mode: inspectorMode,
    open: openDetails,
    pinningAvailable: inspectorPinningAvailable
  } = details;
  const openRunDetails = useEventCallback(() => openDetails("events"));
  const { confirmations, palette, share } = overlays;
  const {
    cancelChat: cancelDeleteChat,
    cancelFolder: cancelDeleteFolder,
    cancelMessage: cancelDeleteMessage,
    chat: deleteChatConfirmation,
    confirmChat: confirmDeleteChat,
    confirmFolder: confirmDeleteFolder,
    confirmMessage: confirmDeleteMessage,
    folder: deleteFolderConfirmation,
    message: deleteMessageConfirmation
  } = confirmations;
  const {
    actions: promptSettingsActions,
    notice: settingsNotice,
    prompt: settingsPrompt,
    updateTheme
  } = settings;
  const promptSettings = {
    deletePromptConfirmation: settingsPrompt.deleteConfirmation,
    editor: settingsPrompt.editor,
    open: settingsPrompt.open,
    section: settingsPrompt.section,
    saving: settingsPrompt.saving,
    themeId: settingsPrompt.themeId
  };
  const {
    mobile: {
      close: closeMobileWorkspace,
      dialogRef: mobileWorkspaceDialogRef,
      open: mobileWorkspaceOpen
    },
    projectSettings: {
      changeDraft: setProjectMemoryDraft,
      draft: projectMemoryDraft,
      folder: projectSettingsFolder,
      save: saveProjectSettings
    }
  } = workspace;
  const {
    catalog,
    catalogError,
    selectedPromptId,
    selectedSearchOptionIds,
    selectedSearchStrategy
  } = composer;

  const availableChatModelKeys = useMemo(
    () => (catalog ? new Set(catalog.models.map((model) => `${model.provider}:${model.modelId}`)) : null),
    [catalog]
  );
  const chatModelLabels = useMemo(() => {
    if (!catalog) {
      return null;
    }

    const providerLabels = new Map(catalog.providers.map((provider) => [provider.id, provider.name]));
    return new Map(
      catalog.models.map((model) => [
        `${model.provider}:${model.modelId}`,
        `${providerLabels.get(model.provider) ?? "Provider"} · ${model.displayName}`
      ])
    );
  }, [catalog]);
  const pipeline = useMemo(
    () => {
      if (!activeChatId || (messages.length === 0 && !activeChatStreaming)) {
        return null;
      }

      return pipelineStage({
        events: runEvents,
        searchEnabled: selectedSearchOptionIds.length > 0,
        streaming: activeChatStreaming
      });
    },
    [activeChatId, activeChatStreaming, messages.length, runEvents, selectedSearchOptionIds.length]
  );
  const runWarnings = useMemo(
    () => {
      if (!currentRunId) {
        return [];
      }

      return runEvents
        .map(warningText)
        .filter((warning): warning is string => Boolean(warning))
        .map((text) => ({ runId: currentRunId, text }));
    },
    [currentRunId, runEvents]
  );
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [desktopAccountMenuOpen, setDesktopAccountMenuOpen] = useState(false);
  const [accountBreakpointFocusTransferred, setAccountBreakpointFocusTransferred] = useState(false);
  const [mobileAccountMenuOpen, setMobileAccountMenuOpen] = useState(false);
  const [workspaceRailHidden, setWorkspaceRailHidden] = useState(false);
  const desktopAccountButtonRef = useRef<HTMLButtonElement>(null);
  const desktopWorkspaceToggleRef = useRef<HTMLButtonElement>(null);
  const mobileWorkspaceButtonRef = useRef<HTMLButtonElement>(null);
  const mobileWorkspaceScrollTopRef = useRef<number | undefined>(undefined);
  const cancelDeleteChatEvent = useEventCallback(cancelDeleteChat);
  const cancelDeleteFolderEvent = useEventCallback(cancelDeleteFolder);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setWorkspaceRailHidden(storedWorkspaceRailHidden());
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const closeMobileWorkspaceEvent = useEventCallback(() => {
    setMobileAccountMenuOpen(false);
    closeMobileWorkspace();
  });
  const closeMobileWorkspaceForDesktop = useCallback(() => {
    if (deleteChatConfirmation) {
      cancelDeleteChatEvent();
    }
    if (deleteFolderConfirmation) {
      cancelDeleteFolderEvent();
    }
    if (deleteChatConfirmation || deleteFolderConfirmation) {
      window.setTimeout(closeMobileWorkspaceEvent, 0);
      return;
    }
    closeMobileWorkspaceEvent();
  }, [
    cancelDeleteChatEvent,
    cancelDeleteFolderEvent,
    closeMobileWorkspaceEvent,
    deleteChatConfirmation,
    deleteFolderConfirmation
  ]);
  useEffect(() => {
    if (!mobileWorkspaceOpen || typeof window.matchMedia !== "function") {
      return;
    }

    const desktopViewport = window.matchMedia(mobileWorkspaceDesktopMediaQuery);
    if (desktopViewport.matches) {
      closeMobileWorkspaceForDesktop();
      return;
    }

    function handleDesktopViewport(event: MediaQueryListEvent) {
      if (event.matches) {
        closeMobileWorkspaceForDesktop();
      }
    }

    desktopViewport.addEventListener("change", handleDesktopViewport);
    return () => desktopViewport.removeEventListener("change", handleDesktopViewport);
  }, [closeMobileWorkspaceForDesktop, mobileWorkspaceOpen]);
  useEffect(() => {
    if (
      (!desktopAccountMenuOpen && !accountBreakpointFocusTransferred) ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const desktopViewport = window.matchMedia(mobileWorkspaceDesktopMediaQuery);
    function preserveAccountFocusAcrossBreakpoint(event: Pick<MediaQueryListEvent, "matches">) {
      const desktopRailVisible = event.matches && !workspaceRailHidden;
      if (!desktopRailVisible && desktopAccountMenuOpen) {
        setDesktopAccountMenuOpen(false);
        setAccountBreakpointFocusTransferred(true);
        window.setTimeout(() => mobileWorkspaceButtonRef.current?.focus({ preventScroll: true }), 0);
        return;
      }

      if (desktopRailVisible && accountBreakpointFocusTransferred) {
        setAccountBreakpointFocusTransferred(false);
        window.setTimeout(() => desktopAccountButtonRef.current?.focus({ preventScroll: true }), 0);
      }
    }

    preserveAccountFocusAcrossBreakpoint(desktopViewport);
    desktopViewport.addEventListener("change", preserveAccountFocusAcrossBreakpoint);
    return () => desktopViewport.removeEventListener("change", preserveAccountFocusAcrossBreakpoint);
  }, [accountBreakpointFocusTransferred, desktopAccountMenuOpen, workspaceRailHidden]);
  useEffect(() => {
    if (!accountBreakpointFocusTransferred) {
      return;
    }

    function releaseTransferredAccountFocus(event: FocusEvent) {
      if (event.target !== mobileWorkspaceButtonRef.current) {
        setAccountBreakpointFocusTransferred(false);
      }
    }

    document.addEventListener("focusin", releaseTransferredAccountFocus);
    return () => document.removeEventListener("focusin", releaseTransferredAccountFocus);
  }, [accountBreakpointFocusTransferred]);
  const closeDetails = useCallback(() => {
    setInspectorMode("closed");
  }, [setInspectorMode]);
  const hideWorkspaceRail = useCallback(() => {
    workspace.pane.actions.closeMenus();
    setDesktopAccountMenuOpen(false);
    rememberWorkspaceRailHidden(true);
    setWorkspaceRailHidden(true);
    window.setTimeout(() => mobileWorkspaceButtonRef.current?.focus({ preventScroll: true }), 0);
  }, [workspace.pane.actions]);
  const showWorkspaceRail = useCallback(() => {
    rememberWorkspaceRailHidden(false);
    setWorkspaceRailHidden(false);
    window.setTimeout(() => desktopWorkspaceToggleRef.current?.focus({ preventScroll: true }), 0);
  }, []);
  const openWorkspaceFromRail = useCallback(() => {
    if (
      workspaceRailHidden &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(mobileWorkspaceDesktopMediaQuery).matches
    ) {
      showWorkspaceRail();
      return;
    }
    workspace.mobile.show();
  }, [showWorkspaceRail, workspace.mobile, workspaceRailHidden]);
  const handleSignOut = useCallback(async () => {
    if (signingOut) {
      return;
    }

    setSignOutError(null);
    setSigningOut(true);
    const result = await signOutCurrentSession();
    if (!result.ok) {
      setSignOutError(result.error);
      setSigningOut(false);
    }
  }, [signingOut]);
  const openPaletteFromMobileAccount = useEventCallback(() => {
    closeMobileWorkspaceEvent();
    window.setTimeout(palette.show, 0);
  });
  const openPromptLibraryFromMobileAccount = useEventCallback(() => {
    closeMobileWorkspaceEvent();
    window.setTimeout(settings.openPromptLibrary, 0);
  });
  const openSettingsFromMobileAccount = useEventCallback(() => {
    closeMobileWorkspaceEvent();
    window.setTimeout(settings.open, 0);
  });
  const desktopAccountFooter = useMemo(
    () => (
      <AccountMenu
        ref={desktopAccountButtonRef}
        accountEmail={accountEmail}
        adminHref={adminEntryVisible ? "/admin" : null}
        onOpenChange={setDesktopAccountMenuOpen}
        onOpenPalette={palette.show}
        onOpenPromptLibrary={settings.openPromptLibrary}
        onOpenSettings={settings.open}
        onSignOut={handleSignOut}
        open={desktopAccountMenuOpen}
        signOutError={signOutError}
        signingOut={signingOut}
      />
    ),
    [
      accountEmail,
      adminEntryVisible,
      desktopAccountMenuOpen,
      handleSignOut,
      palette.show,
      settings.open,
      settings.openPromptLibrary,
      signOutError,
      signingOut
    ]
  );
  const mobileAccountFooter = useMemo(
    () => (
      <AccountMenu
        accountEmail={accountEmail}
        adminHref={adminEntryVisible ? "/admin" : null}
        idPrefix="mobile-"
        layout="mobile"
        onOpenChange={setMobileAccountMenuOpen}
        onOpenPalette={openPaletteFromMobileAccount}
        onOpenPromptLibrary={openPromptLibraryFromMobileAccount}
        onOpenSettings={openSettingsFromMobileAccount}
        onSignOut={handleSignOut}
        open={mobileAccountMenuOpen}
        signOutError={signOutError}
        signingOut={signingOut}
      />
    ),
    [
      accountEmail,
      adminEntryVisible,
      handleSignOut,
      mobileAccountMenuOpen,
      openPaletteFromMobileAccount,
      openPromptLibraryFromMobileAccount,
      openSettingsFromMobileAccount,
      signOutError,
      signingOut
    ]
  );
  const detailsSurfaceRef = useDialogFocus<HTMLElement>({
    active: inspectorMode !== "closed",
    autoFocus: inspectorMode === "overlay",
    closeOnEscape: inspectorMode === "overlay",
    containFocus: inspectorMode === "overlay",
    onClose: closeDetails
  });
  const detailsPanel = (pinned: boolean) => (
    <DetailedInspector
      activeLeafId={renderActiveLeafId}
      activeTab={inspectorActiveTab}
      catalog={composer.catalog}
      errorText={currentErrorText}
      events={runEvents}
      messages={messages}
      pinned={pinned}
      pinningAvailable={inspectorPinningAvailable}
      runId={currentRunId}
      streaming={activeChatStreaming}
      onActiveTabChange={setInspectorActiveTab}
      onClose={closeDetails}
      onPinToggle={() => setInspectorMode(pinned ? "overlay" : "pinned")}
      onSelectBranch={(messageId) => void checkoutBranch(messageId)}
    />
  );
  const primaryContentInert =
    inspectorMode === "overlay" ||
    mobileWorkspaceOpen ||
    Boolean(projectSettingsFolder) ||
    Boolean(share.target) ||
    promptSettings.open ||
    palette.open ||
    Boolean(deleteChatConfirmation) ||
    Boolean(deleteFolderConfirmation) ||
    Boolean(deleteMessageConfirmation) ||
    Boolean(promptSettings.deletePromptConfirmation);
  const workspaceChildDialogOpen =
    mobileWorkspaceOpen && Boolean(deleteChatConfirmation || deleteFolderConfirmation);
  const shellNotice = notice;
  const persistentNoticeSlot = shellNotice?.persistent ? (
    <div
      className="shrink-0 border-b border-trace-subtle bg-answer-paper px-3 pb-2 pt-[calc(4rem+env(safe-area-inset-top))] min-[1281px]:py-2"
      data-testid="persistent-notice-region"
    >
      <div className="mx-auto flex w-full max-w-reading justify-center">
        <ShellNotice notice={shellNotice} onDismiss={session.dismissNotice} />
      </div>
    </div>
  ) : null;
  const mobileWorkspacePane = {
    actions: {
      ...workspace.pane.actions,
      activateChat(chat) {
        workspace.pane.actions.activateChat(chat);
        closeMobileWorkspaceEvent();
      },
      createChat(folderId) {
        const result = workspace.pane.actions.createChat(folderId);
        closeMobileWorkspaceEvent();
        return result;
      },
      openProjectSettings(folder) {
        closeMobileWorkspaceEvent();
        window.setTimeout(() => workspace.pane.actions.openProjectSettings(folder), 0);
      }
    },
    state: workspace.pane.state
  } satisfies ShellWorkspacePaneView;

  return (
    <main
      className="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-research-canvas text-ink"
      data-testid="app-shell"
    >
      {signOutError ? (
        <p className="sr-only" role="alert" data-testid="sign-out-error-alert">
          Sign out failed. {signOutError} Open Account to retry.
        </p>
      ) : null}
      <div
        className="relative min-h-0 flex-1"
        data-testid="shell-primary-content"
        aria-hidden={primaryContentInert || undefined}
        inert={primaryContentInert || undefined}
      >
        <div
          className={[
            "grid h-full min-h-0 grid-cols-1 overflow-hidden bg-research-canvas",
            workspaceRailHidden ? "" : "min-[1281px]:grid-cols-[16rem_minmax(0,1fr)]",
            inspectorMode === "pinned"
              ? workspaceRailHidden
                ? "min-[1440px]:grid-cols-[minmax(0,1fr)_23rem]"
                : "min-[1440px]:grid-cols-[16rem_minmax(0,1fr)_23rem]"
              : ""
          ].join(" ")}
          data-details-presentation={inspectorMode}
          data-workspace-rail-hidden={workspaceRailHidden ? "true" : undefined}
          data-testid="shell-workspace-grid"
        >
          <div
            className={[
              "hidden min-h-0 min-w-0 bg-workspace-rail",
              workspaceRailHidden
                ? ""
                : "min-[1281px]:grid min-[1281px]:grid-rows-[minmax(0,1fr)] min-[1281px]:pl-[env(safe-area-inset-left)] min-[1281px]:pt-[env(safe-area-inset-top)]"
            ].join(" ")}
            data-testid="workspace-rail"
          >
            <ShellLeftPane
              activeChatId={activeChatId}
              availableChatModelKeys={availableChatModelKeys}
              chatModelLabels={chatModelLabels}
              footer={mobileWorkspaceOpen ? null : desktopAccountFooter}
              onHideWorkspace={hideWorkspaceRail}
              pane={workspace.pane}
              workspaceToggleRef={desktopWorkspaceToggleRef}
            />
          </div>

          <div
            className="relative flex min-h-0 min-w-0 flex-col bg-answer-paper"
            data-desktop-action-clearance={
              messages.length > 0 || pipeline?.phase === "running" || pipeline?.phase === "error"
                ? "true"
                : undefined
            }
            data-testid="conversation-column"
          >
            <TopRail
              activeChatId={activeChatId}
              activeChatTitle={activeChatTitle}
              conversationActionsAvailable={messages.length > 0}
              detailsOpen={inspectorMode !== "closed"}
              newChatDisabled={!workspace.pane.state.workspaceReady || workspace.pane.state.creatingChat}
              pipeline={pipeline}
              onCopyThread={() => void copyVisibleThread()}
              onOpenDetails={() => {
                if (inspectorMode === "closed") {
                  setInspectorMode("overlay");
                } else {
                  closeDetails();
                }
              }}
              onOpenBranches={() => openDetails("branch")}
              onOpenPipeline={() => openDetails("events")}
              onOpenWorkspace={openWorkspaceFromRail}
              onShare={() => void shareActiveBranch()}
              onStartNewChat={() => void workspace.pane.actions.createChat()}
              workspaceButtonRef={mobileWorkspaceButtonRef}
              workspaceRailHidden={workspaceRailHidden}
              workspaceAttention={Boolean(signOutError)}
            />

            <MainThreadPane
              {...threadPane}
              {...composer}
              activeChatId={activeChatId}
              adminEntryVisible={adminEntryVisible}
              creatingChat={workspace.pane.state.creatingChat}
              noticeSlot={persistentNoticeSlot}
              openMcpSettings={settings.openMcp}
              openPromptLibrary={settings.openPromptLibrary}
              openRunDetails={openRunDetails}
              pipeline={pipeline}
              retryWorkspace={workspace.pane.actions.retry}
              runWarnings={runWarnings}
              workspaceError={workspace.pane.state.workspaceError}
              workspaceLoading={workspace.pane.state.workspaceLoading}
              workspaceReady={workspace.pane.state.workspaceReady}
            />
          </div>

          {inspectorMode === "pinned" ? (
            <aside
              ref={detailsSurfaceRef}
              className="hidden min-h-0 min-w-0 border-l border-trace-subtle bg-overlay-surface min-[1440px]:flex min-[1440px]:flex-col"
              id="details-pane"
              aria-label="Details"
              data-presentation="pinned"
              data-testid="details-pane"
            >
              {detailsPanel(true)}
            </aside>
          ) : null}
        </div>
      </div>

      {shellNotice && !shellNotice.persistent && !promptSettings.open ? (
        <div
          className="pointer-events-none absolute inset-x-3 top-32 z-[70] flex justify-center sm:top-16"
          data-testid="shell-notice-layer"
        >
          <ShellNotice
            interactive={!primaryContentInert}
            notice={shellNotice}
            onDismiss={session.dismissNotice}
          />
        </div>
      ) : null}

      {inspectorMode === "overlay" ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-scrim/55"
            data-testid="details-pane-backdrop"
            role="presentation"
            onMouseDown={closeDetails}
          />
          <aside
            ref={detailsSurfaceRef}
            className="pop-enter fixed bottom-[max(0.5rem,env(safe-area-inset-bottom))] right-[max(0.5rem,env(safe-area-inset-right))] top-[max(0.5rem,env(safe-area-inset-top))] z-50 flex w-[min(28rem,calc(100vw-1rem))] min-w-0 flex-col overflow-hidden rounded-panel border border-trace-subtle bg-overlay-surface shadow-overlay max-sm:inset-0 max-sm:w-auto max-sm:rounded-none max-sm:border-0 max-sm:pb-[env(safe-area-inset-bottom)] max-sm:pl-[env(safe-area-inset-left)] max-sm:pr-[env(safe-area-inset-right)] max-sm:pt-[env(safe-area-inset-top)]"
            id="details-pane"
            role="dialog"
            aria-labelledby="details-heading"
            aria-modal="true"
            data-presentation="overlay"
            data-testid="details-pane"
          >
            {detailsPanel(false)}
          </aside>
        </>
      ) : null}

      {mobileWorkspaceOpen ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-scrim/55 min-[1281px]:hidden"
            data-testid="workspace-pane-mobile-backdrop"
            role="presentation"
            onMouseDown={closeMobileWorkspaceEvent}
          />
          <div
            ref={mobileWorkspaceDialogRef}
            className={`pop-enter fixed bottom-[max(0.5rem,env(safe-area-inset-bottom))] left-[max(0.5rem,env(safe-area-inset-left))] top-[max(0.5rem,env(safe-area-inset-top))] flex w-[min(22rem,calc(100vw_-_1rem_-_env(safe-area-inset-left)_-_env(safe-area-inset-right)))] flex-col overflow-hidden rounded-panel border border-trace-subtle bg-workspace-rail shadow-overlay min-[1281px]:hidden ${
              mobileAccountMenuOpen ? "z-[80]" : "z-50"
            }`}
            data-testid="workspace-pane-mobile"
            role="dialog"
            aria-modal="true"
            aria-hidden={workspaceChildDialogOpen || undefined}
            aria-labelledby="workspace-pane-mobile-heading"
            inert={workspaceChildDialogOpen || undefined}
          >
            <div className="flex min-h-touch shrink-0 items-center justify-between gap-3 border-b border-trace-subtle px-3">
              <h2 className="text-sm font-semibold text-ink" id="workspace-pane-mobile-heading">
                Workspace
              </h2>
              <button
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                type="button"
                aria-label="Close workspace"
                title="Close workspace"
                onClick={closeMobileWorkspaceEvent}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <ShellLeftPane
                activeChatId={activeChatId}
                availableChatModelKeys={availableChatModelKeys}
                chatModelLabels={chatModelLabels}
                footer={mobileAccountFooter}
                layout="mobile"
                pane={mobileWorkspacePane}
                scrollTopRef={mobileWorkspaceScrollTopRef}
              />
            </div>
          </div>
        </>
      ) : null}

      {share.target ? (
        <ShareDialog key={share.target.chat.id} target={share.target} onClose={share.close} />
      ) : null}

      {projectSettingsFolder ? (
        <ProjectSettingsDialog
          folder={projectSettingsFolder}
          memoryDraft={projectMemoryDraft}
          saving={workspace.pane.state.folderActionId === projectSettingsFolder.id}
          onCancel={workspace.projectSettings.close}
          onMemoryDraftChange={setProjectMemoryDraft}
          onSave={() => void saveProjectSettings(projectSettingsFolder)}
          restoreFocus={() =>
            document.querySelector<HTMLElement>(
              '[data-testid="left-chat-pane"] button[aria-label="Start new chat"]'
            )
          }
        />
      ) : null}

      {promptSettings.open ? (
        promptSettings.section === "prompts" ? (
          <PromptWorkbench
            defaultPromptId={catalog?.defaults.promptPresetId ?? null}
            editor={promptSettings.editor}
            nestedDialogOpen={Boolean(promptSettings.deletePromptConfirmation)}
            notice={settingsNotice}
            promptCatalogError={catalogError}
            promptCatalogState={catalog ? "ready" : catalogError ? "error" : "loading"}
            prompts={catalog?.promptPresets ?? []}
            saving={promptSettings.saving}
            onClose={() => {
              if (settingsNotice) {
                settings.dismissNotice();
              }
              promptSettingsActions.closeSettings();
            }}
            onCreatePrompt={() => void promptSettingsActions.createSettingsPrompt()}
            onDeletePrompt={(prompt) => void promptSettingsActions.deleteSettingsPrompt(prompt)}
            onDuplicatePrompt={(prompt) => void promptSettingsActions.duplicateSettingsPrompt(prompt)}
            onEditPrompt={promptSettingsActions.editSettingsPrompt}
            onEditorChange={promptSettingsActions.setSettingsPromptEditor}
            onNewPrompt={promptSettingsActions.newSettingsPrompt}
            onRetryCatalog={composer.retryCatalog}
            onDismissNotice={settings.dismissNotice}
            onSetDefaultPrompt={(promptId) => void promptSettingsActions.setDefaultPromptPreset(promptId)}
            onUpdatePrompt={() => void promptSettingsActions.updateSettingsPrompt()}
          />
        ) : (
          <SettingsDialog
            initialSection={promptSettings.section}
            notice={settingsNotice}
            themeId={promptSettings.themeId}
            onClose={() => {
              if (settingsNotice) {
                settings.dismissNotice();
              }
              promptSettingsActions.closeSettings();
            }}
            onDismissNotice={settings.dismissNotice}
            onThemeChange={updateTheme}
          />
        )
      ) : null}

      {deleteChatConfirmation ? (
        <ChatDeleteConfirmationDialog
          chatTitle={deleteChatConfirmation.title}
          onCancel={cancelDeleteChat}
          onConfirm={confirmDeleteChat}
        />
      ) : null}

      {deleteFolderConfirmation ? (
        <FolderDeleteConfirmationDialog
          folderName={deleteFolderConfirmation.name}
          onCancel={cancelDeleteFolder}
          onConfirm={confirmDeleteFolder}
        />
      ) : null}

      {deleteMessageConfirmation ? (
        <MessageDeleteConfirmationDialog onCancel={cancelDeleteMessage} onConfirm={confirmDeleteMessage} />
      ) : null}

      {promptSettings.deletePromptConfirmation ? (
        <PromptDeleteConfirmationDialog
          promptName={promptSettings.deletePromptConfirmation.name}
          onCancel={promptSettingsActions.cancelDeletePrompt}
          onConfirm={promptSettingsActions.confirmDeletePrompt}
        />
      ) : null}

      {palette.open ? (
        <CommandPalette
          items={palette.items}
          onClose={palette.close}
          onRun={palette.run}
        />
      ) : null}
    </main>
  );
}
