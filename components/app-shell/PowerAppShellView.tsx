"use client";

import { CommandPalette } from "@/components/command-palette/CommandPalette";
import {
  ChatDeleteConfirmationDialog,
  FolderDeleteConfirmationDialog,
  MessageDeleteConfirmationDialog
} from "@/components/app-shell/ConfirmationDialog";
import {
  AccountMenu,
  AccountMenuTrigger,
  type AccountMenuInitialFocus,
  type DesktopAccountMenuAnchor
} from "@/components/app-shell/AccountMenu";
import { DetailedInspector } from "@/components/app-shell/InspectorPanels";
import { MainThreadPane } from "@/components/app-shell/MainThreadPane";
import type {
  PowerAppShellViewProps,
  ShellWorkspacePaneView
} from "@/components/app-shell/powerAppShellViewContracts";
import { ProjectSettingsDialog } from "@/components/app-shell/ProjectSettingsDialog";
import { ShareDialog } from "@/components/app-shell/ShareDialog";
import { AssistantLibrary } from "@/components/assistants/AssistantLibrary";
import { KnowledgeLibrary } from "@/components/knowledge/KnowledgeLibrary";
import { SettingsDialog } from "@/components/app-shell/SettingsDialog";
import { ShellLeftPane } from "@/components/app-shell/ShellLeftPane";
import { ShellNotice } from "@/components/app-shell/ShellNotice";
import { TopRail } from "@/components/app-shell/TopRail";
import { WorkspaceIconRail } from "@/components/app-shell/WorkspaceIconRail";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import {
  pipelineStage,
  runLifecycleAnnouncement,
  type PipelineSnapshot,
  type RunLifecycleAnnouncement
} from "@/components/app-shell/runState";
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

type ResponsiveNavigationOrigin = {
  element: HTMLElement;
  fallback: "account" | "chats";
};

function elementCanReceiveResponsiveRestore(
  element: HTMLElement,
  pane: HTMLElement | null,
  paneHidden: boolean
): boolean {
  if (!element.isConnected || element.getAttribute("aria-disabled") === "true") {
    return false;
  }
  if (paneHidden && pane?.contains(element)) {
    return false;
  }

  let current: HTMLElement | null = element;
  while (current) {
    if (current.hidden || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

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
    knowledge: knowledgeView,
    library: libraryView,
    notice: settingsNotice,
    settings: settingsState,
    updateTheme
  } = settings;
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
  const [desktopAccountAnchor, setDesktopAccountAnchor] = useState<DesktopAccountMenuAnchor | null>(null);
  const [desktopAccountInitialFocus, setDesktopAccountInitialFocus] = useState<AccountMenuInitialFocus>("first");
  const [responsiveNavigationTransferActive, setResponsiveNavigationTransferActive] = useState(false);
  const [mobileAccountMenuOpen, setMobileAccountMenuOpen] = useState(false);
  const [mobileAccountInitialFocus, setMobileAccountInitialFocus] = useState<AccountMenuInitialFocus>("first");
  const [workspacePaneHidden, setWorkspacePaneHidden] = useState(false);
  const runAnnouncerRef = useRef<HTMLParagraphElement>(null);
  const runAnnouncementStateRef = useRef<{
    activeChatId: string | null;
    lastPipeline: PipelineSnapshot | null;
    observedRunning: boolean;
  }>({
    activeChatId,
    lastPipeline: null,
    observedRunning: false
  });
  const desktopIconNavigationRef = useRef<HTMLDivElement>(null);
  const desktopPaneNavigationRef = useRef<HTMLDivElement>(null);
  const desktopPaneAccountButtonRef = useRef<HTMLButtonElement>(null);
  const desktopRailAccountButtonRef = useRef<HTMLButtonElement>(null);
  const desktopRailAssistantsButtonRef = useRef<HTMLButtonElement>(null);
  const desktopRailKnowledgeButtonRef = useRef<HTMLButtonElement>(null);
  const desktopRailSettingsButtonRef = useRef<HTMLButtonElement>(null);
  const desktopWorkspaceToggleRef = useRef<HTMLButtonElement>(null);
  const mobileAccountButtonRef = useRef<HTMLButtonElement>(null);
  const mobileWorkspaceButtonRef = useRef<HTMLButtonElement>(null);
  const mobileWorkspaceScrollTopRef = useRef<number | undefined>(undefined);
  const responsiveNavigationOriginRef = useRef<ResponsiveNavigationOrigin | null>(null);
  const overlayDesktopOpenerRef = useRef<HTMLElement | null>(null);
  const workspaceChatsButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceNewChatButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceControlCenterRef = useRef<HTMLAnchorElement>(null);
  const cancelDeleteChatEvent = useEventCallback(cancelDeleteChat);
  const cancelDeleteFolderEvent = useEventCallback(cancelDeleteFolder);
  useEffect(() => {
    const previous = runAnnouncementStateRef.current;
    const chatChanged = previous.activeChatId !== activeChatId;
    if (!chatChanged && previous.lastPipeline === pipeline) {
      return;
    }

    const state = chatChanged
      ? { activeChatId, lastPipeline: pipeline, observedRunning: false }
      : previous;
    state.lastPipeline = pipeline;
    let announcement: RunLifecycleAnnouncement | "" = "";

    if (activeChatId && pipeline?.phase === "running") {
      const initial = !state.observedRunning;
      state.observedRunning = true;
      announcement = initial ? "Working" : (runLifecycleAnnouncement(pipeline) ?? "");
    } else if (
      activeChatStreaming &&
      pipeline &&
      state.observedRunning &&
      (pipeline.phase === "settled" || pipeline.phase === "error" || pipeline.phase === "cancelled")
    ) {
      runAnnouncementStateRef.current = state;
      return;
    } else if (
      pipeline &&
      state.observedRunning &&
      (pipeline.phase === "settled" || pipeline.phase === "error" || pipeline.phase === "cancelled")
    ) {
      state.observedRunning = false;
      announcement = runLifecycleAnnouncement(pipeline) ?? "";
    }

    runAnnouncementStateRef.current = state;
    if (runAnnouncerRef.current && runAnnouncerRef.current.textContent !== announcement) {
      runAnnouncerRef.current.textContent = announcement;
    }
  }, [activeChatId, activeChatStreaming, pipeline]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const hidden = storedWorkspaceRailHidden();
      setWorkspacePaneHidden(hidden);
      if (hidden) {
        setDesktopAccountAnchor((anchor) => (anchor === "pane" ? "rail" : anchor));
      }
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
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const desktopViewport = window.matchMedia(mobileWorkspaceDesktopMediaQuery);
    function originFor(element: HTMLElement | null): ResponsiveNavigationOrigin | null {
      if (!element) {
        return null;
      }
      const inRail = desktopIconNavigationRef.current?.contains(element);
      const inPane = desktopPaneNavigationRef.current?.contains(element);
      if (!inRail && !inPane) {
        return null;
      }
      return {
        element,
        fallback: element === desktopPaneAccountButtonRef.current ? "account" : "chats"
      };
    }

    function activeDesktopOrigin(): ResponsiveNavigationOrigin | null {
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const directOrigin = originFor(activeElement);
      if (directOrigin) {
        return directOrigin;
      }

      if (desktopAccountAnchor && activeElement?.closest('[data-account-menu-root="true"]')) {
        const accountTrigger = desktopAccountAnchor === "rail"
          ? desktopRailAccountButtonRef.current
          : desktopPaneAccountButtonRef.current;
        return originFor(accountTrigger);
      }

      if (settingsState.open || libraryView || knowledgeView) {
        return originFor(overlayDesktopOpenerRef.current);
      }
      return null;
    }

    function preserveNavigationFocusAcrossBreakpoint(event: Pick<MediaQueryListEvent, "matches">) {
      if (!event.matches) {
        const origin = activeDesktopOrigin();
        const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const overlayOwnsFocus = Boolean(
          activeElement?.closest('[data-testid="settings-dialog"], [data-testid="assistant-library"], [data-testid="knowledge-library"]')
        );
        if (origin) {
          responsiveNavigationOriginRef.current = origin;
          setResponsiveNavigationTransferActive(true);
        }
        if (desktopAccountAnchor) {
          setDesktopAccountAnchor(null);
        }
        if (origin && !overlayOwnsFocus && !settingsState.open && !libraryView && !knowledgeView) {
          window.setTimeout(() => mobileWorkspaceButtonRef.current?.focus({ preventScroll: true }), 0);
        }
        return;
      }

      const transfer = responsiveNavigationOriginRef.current;
      if (!transfer) {
        return;
      }
      const activeElement = document.activeElement;
      const compactFallbackStillOwnsFocus =
        activeElement === mobileWorkspaceButtonRef.current ||
        (responsiveNavigationTransferActive &&
          (activeElement === document.body || activeElement === document.documentElement));
      if (!compactFallbackStillOwnsFocus) {
        if (!settingsState.open && !libraryView && !knowledgeView) {
          responsiveNavigationOriginRef.current = null;
          setResponsiveNavigationTransferActive(false);
        }
        return;
      }

      window.setTimeout(() => {
        const target = elementCanReceiveResponsiveRestore(
          transfer.element,
          desktopPaneNavigationRef.current,
          workspacePaneHidden
        )
          ? transfer.element
          : transfer.fallback === "account"
            ? desktopRailAccountButtonRef.current
            : workspaceChatsButtonRef.current;
        target?.focus({ preventScroll: true });
        responsiveNavigationOriginRef.current = null;
        setResponsiveNavigationTransferActive(false);
      }, 0);
    }

    desktopViewport.addEventListener("change", preserveNavigationFocusAcrossBreakpoint);
    return () => desktopViewport.removeEventListener("change", preserveNavigationFocusAcrossBreakpoint);
  }, [
    desktopAccountAnchor,
    knowledgeView,
    libraryView,
    responsiveNavigationTransferActive,
    settingsState.open,
    workspacePaneHidden
  ]);
  useEffect(() => {
    if (!responsiveNavigationTransferActive) {
      return;
    }

    function releaseTransferredNavigationFocus(event: FocusEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target === mobileWorkspaceButtonRef.current ||
        target?.closest('[data-testid="settings-dialog"], [data-testid="assistant-library"], [data-testid="knowledge-library"]')
      ) {
        return;
      }
      responsiveNavigationOriginRef.current = null;
      setResponsiveNavigationTransferActive(false);
    }

    document.addEventListener("focusin", releaseTransferredNavigationFocus);
    return () => document.removeEventListener("focusin", releaseTransferredNavigationFocus);
  }, [responsiveNavigationTransferActive]);
  const closeDetails = useCallback(() => {
    setInspectorMode("closed");
  }, [setInspectorMode]);
  const hideWorkspacePane = useCallback(() => {
    workspace.pane.actions.closeMenus();
    setDesktopAccountAnchor((anchor) => (anchor === "pane" ? "rail" : anchor));
    rememberWorkspaceRailHidden(true);
    setWorkspacePaneHidden(true);
    if (!desktopAccountAnchor) {
      window.setTimeout(() => workspaceChatsButtonRef.current?.focus({ preventScroll: true }), 0);
    }
  }, [desktopAccountAnchor, workspace.pane.actions]);
  const showWorkspacePane = useCallback(() => {
    rememberWorkspaceRailHidden(false);
    setWorkspacePaneHidden(false);
    window.setTimeout(() => desktopWorkspaceToggleRef.current?.focus({ preventScroll: true }), 0);
  }, []);
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
    overlayDesktopOpenerRef.current = null;
    closeMobileWorkspaceEvent();
    window.setTimeout(palette.show, 0);
  });
  const openLibraryFromMobileAccount = useEventCallback(() => {
    overlayDesktopOpenerRef.current = null;
    closeMobileWorkspaceEvent();
    window.setTimeout(settings.openLibrary, 0);
  });
  const openKnowledgeFromMobileAccount = useEventCallback(() => {
    overlayDesktopOpenerRef.current = null;
    closeMobileWorkspaceEvent();
    window.setTimeout(settings.openKnowledge, 0);
  });
  const openSettingsFromMobileAccount = useEventCallback(() => {
    overlayDesktopOpenerRef.current = null;
    closeMobileWorkspaceEvent();
    window.setTimeout(settings.open, 0);
  });
  const openDesktopAccount = useCallback(
    (anchor: DesktopAccountMenuAnchor, initialFocus: AccountMenuInitialFocus) => {
      setDesktopAccountInitialFocus(initialFocus);
      setDesktopAccountAnchor(anchor);
    },
    []
  );
  const openPaletteFromDesktopAccount = useEventCallback(() => {
    overlayDesktopOpenerRef.current = null;
    palette.show();
  });
  const openLibraryFromDesktopAccount = useEventCallback(() => {
    overlayDesktopOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : desktopPaneAccountButtonRef.current;
    settings.openLibrary();
  });
  const openKnowledgeFromDesktopAccount = useEventCallback(() => {
    overlayDesktopOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : desktopPaneAccountButtonRef.current;
    settings.openKnowledge();
  });
  const openSettingsFromDesktopAccount = useEventCallback(() => {
    overlayDesktopOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : desktopPaneAccountButtonRef.current;
    settings.open();
  });
  const openLibraryFromRail = useEventCallback(() => {
    desktopRailAssistantsButtonRef.current?.focus({ preventScroll: true });
    overlayDesktopOpenerRef.current = desktopRailAssistantsButtonRef.current;
    setDesktopAccountAnchor(null);
    settings.openLibrary();
  });
  const openKnowledgeFromRail = useEventCallback(() => {
    desktopRailKnowledgeButtonRef.current?.focus({ preventScroll: true });
    overlayDesktopOpenerRef.current = desktopRailKnowledgeButtonRef.current;
    setDesktopAccountAnchor(null);
    settings.openKnowledge();
  });
  const openSettingsFromRail = useEventCallback(() => {
    desktopRailSettingsButtonRef.current?.focus({ preventScroll: true });
    overlayDesktopOpenerRef.current = desktopRailSettingsButtonRef.current;
    setDesktopAccountAnchor(null);
    settings.open();
  });
  const responsiveOverlayRestoreFocus = useEventCallback(() =>
    responsiveNavigationOriginRef.current ? mobileWorkspaceButtonRef.current : null
  );
  const desktopAccountFooter = useMemo(
    () => (
      <AccountMenuTrigger
        ref={desktopPaneAccountButtonRef}
        accountEmail={accountEmail}
        active={desktopAccountAnchor === "pane"}
        controlsId="account-menu"
        layout="pane"
        onClose={() => setDesktopAccountAnchor(null)}
        onOpen={(initialFocus) => openDesktopAccount("pane", initialFocus)}
        signOutError={signOutError}
        signingOut={signingOut}
      />
    ),
    [
      accountEmail,
      desktopAccountAnchor,
      openDesktopAccount,
      signOutError,
      signingOut
    ]
  );
  const mobileAccountFooter = useMemo(
    () => (
      <div className="relative w-full">
        <AccountMenuTrigger
          ref={mobileAccountButtonRef}
          accountEmail={accountEmail}
          active={mobileAccountMenuOpen}
          controlsId="mobile-account-menu"
          layout="mobile"
          onClose={() => setMobileAccountMenuOpen(false)}
          onOpen={(initialFocus) => {
            setMobileAccountInitialFocus(initialFocus);
            setMobileAccountMenuOpen(true);
          }}
          signOutError={signOutError}
          signingOut={signingOut}
        />
        {mobileAccountMenuOpen ? (
          <AccountMenu
            accountEmail={accountEmail}
            activeTriggerRef={mobileAccountButtonRef}
            adminHref={adminEntryVisible ? "/admin" : null}
            anchor="mobile"
            initialFocus={mobileAccountInitialFocus}
            menuId="mobile-account-menu"
            onClose={() => setMobileAccountMenuOpen(false)}
            onOpenKnowledge={openKnowledgeFromMobileAccount}
            onOpenLibrary={openLibraryFromMobileAccount}
            onOpenPalette={openPaletteFromMobileAccount}
            onOpenSettings={openSettingsFromMobileAccount}
            onSignOut={handleSignOut}
            signOutError={signOutError}
            signingOut={signingOut}
            triggerRefs={[mobileAccountButtonRef]}
          />
        ) : null}
      </div>
    ),
    [
      accountEmail,
      adminEntryVisible,
      handleSignOut,
      mobileAccountInitialFocus,
      mobileAccountMenuOpen,
      openKnowledgeFromMobileAccount,
      openPaletteFromMobileAccount,
      openLibraryFromMobileAccount,
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
    settingsState.open ||
    Boolean(libraryView) ||
    Boolean(knowledgeView) ||
    palette.open ||
    Boolean(deleteChatConfirmation) ||
    Boolean(deleteFolderConfirmation) ||
    Boolean(deleteMessageConfirmation);
  const activeDocumentTitle = activeChatId && activeChatTitle.trim()
    ? activeChatTitle.trim()
    : workspace.pane.state.workspaceLoading
      ? "Chat"
      : "New chat";
  const documentTitle = knowledgeView
    ? "Knowledge · AIQSA"
    : libraryView
      ? "Assistants · AIQSA"
      : settingsState.open
        ? "Settings · AIQSA"
        : `${activeDocumentTitle} · AIQSA`;
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);
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
      className="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-app-canvas text-ink"
      data-testid="app-shell"
    >
      {signOutError ? (
        <p className="sr-only" role="alert" data-testid="sign-out-error-alert">
          Sign out failed. {signOutError} Open Account to retry.
        </p>
      ) : null}
      <p
        ref={runAnnouncerRef}
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-testid="run-lifecycle-announcer"
        role="status"
      />
      <div
        className="relative min-h-0 flex-1"
        data-testid="shell-primary-content"
        aria-hidden={primaryContentInert || undefined}
        inert={primaryContentInert || undefined}
      >
        <div
          className={[
            "grid h-full min-h-0 grid-cols-1 overflow-hidden bg-app-canvas",
            workspacePaneHidden
              ? "min-[1281px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_minmax(0,1fr)]"
              : "min-[1281px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_16rem_minmax(0,1fr)]",
            inspectorMode === "pinned"
              ? workspacePaneHidden
                ? "min-[1440px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_minmax(0,1fr)_23rem]"
                : "min-[1440px]:grid-cols-[calc(3rem+env(safe-area-inset-left))_16rem_minmax(0,1fr)_23rem]"
              : ""
          ].join(" ")}
          data-details-presentation={inspectorMode}
          data-workspace-pane-hidden={workspacePaneHidden ? "true" : undefined}
          data-testid="shell-workspace-grid"
        >
          <div
            ref={desktopIconNavigationRef}
            className="hidden min-h-0 min-w-0 bg-workspace-rail min-[1281px]:block"
            data-testid="workspace-icon-track"
          >
            <WorkspaceIconRail
              accountTrigger={(tooltipId) => (
                <AccountMenuTrigger
                  ref={desktopRailAccountButtonRef}
                  accountEmail={accountEmail}
                  active={desktopAccountAnchor === "rail"}
                  controlsId="account-menu"
                  layout="rail"
                  onClose={() => setDesktopAccountAnchor(null)}
                  onOpen={(initialFocus) => openDesktopAccount("rail", initialFocus)}
                  signOutError={signOutError}
                  signingOut={signingOut}
                  tooltipId={tooltipId}
                />
              )}
              adminHref={adminEntryVisible ? "/admin" : null}
              assistantsRef={desktopRailAssistantsButtonRef}
              chatsRef={workspaceChatsButtonRef}
              controlCenterRef={workspaceControlCenterRef}
              creatingChat={workspace.pane.state.creatingChat}
              knowledgeRef={desktopRailKnowledgeButtonRef}
              newChatRef={workspaceNewChatButtonRef}
              onNewChat={() => void workspace.pane.actions.createChat()}
              onOpenAssistants={openLibraryFromRail}
              onOpenKnowledge={openKnowledgeFromRail}
              onOpenSettings={openSettingsFromRail}
              onRestoreChats={showWorkspacePane}
              paneHidden={workspacePaneHidden}
              settingsRef={desktopRailSettingsButtonRef}
              signingOut={signingOut}
              workspaceReady={workspace.pane.state.workspaceReady}
            />
          </div>

          <div
            ref={desktopPaneNavigationRef}
            className={[
              "hidden min-h-0 min-w-0 bg-workspace-rail",
              workspacePaneHidden
                ? ""
                : "min-[1281px]:grid min-[1281px]:grid-rows-[minmax(0,1fr)] min-[1281px]:pt-[env(safe-area-inset-top)]"
            ].join(" ")}
            aria-hidden={workspacePaneHidden || undefined}
            data-testid="workspace-pane-desktop"
            inert={workspacePaneHidden || undefined}
          >
            <ShellLeftPane
              activeChatId={activeChatId}
              availableChatModelKeys={availableChatModelKeys}
              chatModelLabels={chatModelLabels}
              footer={mobileWorkspaceOpen ? null : desktopAccountFooter}
              onHideWorkspace={hideWorkspacePane}
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
              onOpenWorkspace={workspace.mobile.show}
              onShare={() => void shareActiveBranch()}
              onStartNewChat={() => void workspace.pane.actions.createChat()}
              workspaceButtonRef={mobileWorkspaceButtonRef}
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

      {desktopAccountAnchor ? (
        <AccountMenu
          accountEmail={accountEmail}
          activeTriggerRef={
            desktopAccountAnchor === "rail"
              ? desktopRailAccountButtonRef
              : desktopPaneAccountButtonRef
          }
          adminHref={adminEntryVisible ? "/admin" : null}
          anchor={desktopAccountAnchor}
          initialFocus={desktopAccountInitialFocus}
          menuId="account-menu"
          onClose={() => setDesktopAccountAnchor(null)}
          onOpenKnowledge={openKnowledgeFromDesktopAccount}
          onOpenLibrary={openLibraryFromDesktopAccount}
          onOpenPalette={openPaletteFromDesktopAccount}
          onOpenSettings={openSettingsFromDesktopAccount}
          onSignOut={handleSignOut}
          signOutError={signOutError}
          signingOut={signingOut}
          triggerRefs={[desktopRailAccountButtonRef, desktopPaneAccountButtonRef]}
        />
      ) : null}

      {shellNotice && !shellNotice.persistent && !settingsState.open && !libraryView && !knowledgeView ? (
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

      {libraryView && !knowledgeView ? (
        <AssistantLibrary restoreFocus={responsiveOverlayRestoreFocus} view={libraryView} />
      ) : null}

      {knowledgeView ? (
        <KnowledgeLibrary restoreFocus={responsiveOverlayRestoreFocus} view={knowledgeView} />
      ) : null}

      {settingsState.open && !libraryView && !knowledgeView ? (
        <SettingsDialog
          initialSection={settingsState.section}
          notice={settingsNotice}
          themeId={settingsState.themeId}
          onClose={() => {
            if (settingsNotice) {
              settings.dismissNotice();
            }
            settings.closeSettings();
          }}
          onDismissNotice={settings.dismissNotice}
          onThemeChange={updateTheme}
          restoreFocus={responsiveOverlayRestoreFocus}
        />
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
