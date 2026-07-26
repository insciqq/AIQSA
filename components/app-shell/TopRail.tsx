import { runActivityLabel, type PipelineSnapshot } from "@/components/app-shell/runState";
import {
  Activity,
  Command,
  Copy,
  GitBranch,
  LogOut,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Plus,
  Settings,
  Share2,
  Shield,
  UserRound
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

const actionFocusClass =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proof/55 focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";

const menuItemClass =
  "flex min-h-touch w-full items-center gap-2 rounded-control px-3 text-left text-sm font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:bg-control-hover focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-proof/55 lg:min-h-9 [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";

function PipelineIndicator({
  onOpen,
  pipeline
}: {
  onOpen(): void;
  pipeline: PipelineSnapshot;
}) {
  if (pipeline.phase !== "running" && pipeline.phase !== "error") {
    return null;
  }

  const label = runActivityLabel(pipeline);
  const error = pipeline.phase === "error";

  return (
    <button
      className={[
        "pipeline-indicator inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-2 rounded-control px-2.5 text-xs font-medium max-lg:h-touch max-lg:min-w-touch [@media(hover:none)]:!h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!h-touch [@media(pointer:coarse)]:!min-w-touch",
        actionFocusClass,
        error
          ? "bg-critical/10 text-critical hover:bg-critical/15"
          : "bg-control-selected text-proof hover:bg-control-hover"
      ].join(" ")}
      type="button"
      aria-label={`${label} - open run events`}
      title={`${label} - open run events`}
      data-testid="pipeline-indicator"
      data-phase={pipeline.phase}
      onClick={onOpen}
    >
      <Activity className="size-4" data-run-activity="true" aria-hidden="true" />
      <span aria-live="polite" className="sr-only sm:not-sr-only">
        {label}
        {error ? "" : "…"}
      </span>
    </button>
  );
}

function ConversationActionsMenu({
  onCopyThread,
  onOpenBranches
}: {
  onCopyThread(): void;
  onOpenBranches(): void;
}) {
  const [open, setOpen] = useState(false);
  const boundaryRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function menuItems(): HTMLButtonElement[] {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
    );
  }

  function closeMenu({ restoreFocus = false } = {}) {
    setOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0);
    }
  }

  function runAction(action: () => void) {
    triggerRef.current?.focus({ preventScroll: true });
    setOpen(false);
    window.setTimeout(action, 0);
  }

  useEffect(() => {
    if (!open) {
      return;
    }

    const timer = window.setTimeout(() => menuItems()[0]?.focus({ preventScroll: true }), 0);

    function handlePointerDown(event: PointerEvent) {
      if (!boundaryRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ restoreFocus: true });
      return;
    }

    if (event.key === "Tab") {
      closeMenu();
      return;
    }

    const items = menuItems();
    if (items.length === 0) {
      return;
    }

    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex]?.focus({ preventScroll: true });
    }
  }

  return (
    <div className="relative" ref={boundaryRef}>
      <button
        ref={triggerRef}
        className={[
          "grid size-9 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink max-lg:size-11 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11",
          actionFocusClass
        ].join(" ")}
        type="button"
        aria-controls={open ? "conversation-actions-menu" : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Conversation actions"
        title="Conversation actions"
        onClick={() => (open ? closeMenu({ restoreFocus: true }) : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            closeMenu({ restoreFocus: true });
          }
        }}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={menuRef}
          className="pop-enter absolute right-0 top-12 z-[80] w-56 max-w-[calc(100vw-1rem)] rounded-panel border border-trace-subtle bg-overlay-surface p-2 shadow-overlay"
          id="conversation-actions-menu"
          role="menu"
          aria-label="Conversation actions"
          onKeyDown={handleMenuKeyDown}
        >
          <button className={menuItemClass} type="button" role="menuitem" onClick={() => runAction(onCopyThread)}>
            <Copy className="size-4 text-ink-muted" aria-hidden="true" />
            Copy thread
          </button>
          <button className={menuItemClass} type="button" role="menuitem" onClick={() => runAction(onOpenBranches)}>
            <GitBranch className="size-4 text-ink-muted" aria-hidden="true" />
            Branch tree
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AccountMenu({
  accountEmail,
  adminHref,
  onOpenPalette,
  onOpenSettings,
  onSignOut,
  signOutError,
  signingOut
}: {
  accountEmail: string | null;
  adminHref?: string | null;
  onOpenPalette(): void;
  onOpenSettings(): void;
  onSignOut(): void;
  signOutError?: string | null;
  signingOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");
  const boundaryRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const signOutErrorDescriptionId = "account-sign-out-error-description";
  const signOutErrorDetailId = "account-sign-out-error-detail";
  const accountIdentity = accountEmail?.trim() || "Email unavailable";

  function menuItems(): HTMLElement[] {
    const candidates = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]):not(:disabled)') ?? []
    );
    const visibleItems = candidates.filter((item) => item.offsetParent !== null || item.getClientRects().length > 0);

    // jsdom has no layout boxes; keep the keyboard model testable there while
    // real browsers still exclude responsive `display: none` menu items.
    return visibleItems.length > 0 ? visibleItems : candidates;
  }

  function closeMenu({ restoreFocus = false } = {}) {
    setOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0);
    }
  }

  function openMenu(focus: "first" | "last" = "first") {
    setInitialFocus(focus);
    setOpen(true);
  }

  function replaceMenuWith(openReplacement: () => void) {
    triggerRef.current?.focus({ preventScroll: true });
    setOpen(false);
    window.setTimeout(openReplacement, 0);
  }

  useEffect(() => {
    if (!open) {
      return;
    }

    const timer = window.setTimeout(() => {
      const items = menuItems();
      const target = initialFocus === "last" ? items.at(-1) : items[0];
      target?.focus({ preventScroll: true });
    }, 0);

    function handlePointerDown(event: PointerEvent) {
      if (!boundaryRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [initialFocus, open]);

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu("last");
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu({ restoreFocus: true });
    }
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ restoreFocus: true });
      return;
    }

    if (event.key === "Tab") {
      closeMenu();
      return;
    }

    const items = menuItems();
    if (items.length === 0) {
      return;
    }

    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex]?.focus({ preventScroll: true });
    }
  }

  return (
    <div className="relative" ref={boundaryRef}>
      <button
        ref={triggerRef}
        className={`relative grid size-9 shrink-0 place-items-center rounded-control hover:bg-control-hover hover:text-ink max-lg:size-11 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11 ${signOutError ? "bg-critical/10 text-critical" : "text-ink-muted"} ${actionFocusClass}`}
        type="button"
        aria-busy={signingOut || undefined}
        aria-controls={open ? "account-menu" : undefined}
        aria-describedby={signOutError ? signOutErrorDescriptionId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        title="Account menu"
        onClick={() => (open ? closeMenu({ restoreFocus: true }) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <UserRound className="size-4" aria-hidden="true" />
        {signOutError ? (
          <span
            className="absolute right-1 top-1 size-2 rounded-full border border-answer-paper bg-critical"
            aria-hidden="true"
            data-testid="account-error-cue"
          />
        ) : null}
      </button>

      {signOutError ? (
        <span className="sr-only" id={signOutErrorDescriptionId}>
          Sign out failed. {signOutError} Open Account to retry.
        </span>
      ) : null}

      {open ? (
        <div
          ref={menuRef}
          className="pop-enter absolute right-0 top-12 z-[80] w-64 max-w-[calc(100vw-1rem)] rounded-panel border border-trace-subtle bg-overlay-surface p-2 shadow-overlay"
          id="account-menu"
          role="menu"
          aria-label="Account"
          onKeyDown={handleMenuKeyDown}
        >
          <div className="min-w-0 px-3 pb-2 pt-1" role="presentation">
            <p className="text-xs font-medium text-ink-muted">Account</p>
            <p
              className="mt-0.5 break-words text-sm font-medium leading-5 text-ink [overflow-wrap:anywhere]"
              title={accountEmail?.trim() || undefined}
            >
              {accountIdentity}
            </p>
          </div>
          <button
            className={menuItemClass}
            type="button"
            role="menuitem"
            disabled={signingOut}
            onClick={() => {
              replaceMenuWith(onOpenPalette);
            }}
          >
            <Command className="size-4 text-ink-muted" aria-hidden="true" />
            Command palette
          </button>
          <button
            className={menuItemClass}
            type="button"
            role="menuitem"
            disabled={signingOut}
            onClick={() => {
              replaceMenuWith(onOpenSettings);
            }}
          >
            <Settings className="size-4 text-ink-muted" aria-hidden="true" />
            Settings
          </button>
          {adminHref ? (
            <a
              className={`${menuItemClass} ${signingOut ? "pointer-events-none text-ink-disabled opacity-60" : ""}`}
              href={adminHref}
              role="menuitem"
              aria-disabled={signingOut || undefined}
              tabIndex={signingOut ? -1 : undefined}
              onClick={(event) => {
                if (signingOut) {
                  event.preventDefault();
                  return;
                }
                closeMenu();
              }}
            >
              <Shield className="size-4 text-ink-muted" aria-hidden="true" />
              Control Center
            </a>
          ) : null}
          <div className="my-1 border-t border-trace-subtle" role="separator" />
          <button
            className={`${menuItemClass} text-critical hover:bg-critical/10 hover:text-critical focus-visible:bg-critical/10 focus-visible:text-critical`}
            type="button"
            role="menuitem"
            aria-describedby={signOutError ? signOutErrorDetailId : undefined}
            disabled={signingOut}
            onClick={onSignOut}
          >
            <LogOut className="size-4" aria-hidden="true" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
          {signOutError ? (
            <p
              className="mt-1 break-words rounded-control bg-critical/10 px-3 py-2 text-xs leading-5 text-critical [overflow-wrap:anywhere]"
              id={signOutErrorDetailId}
            >
              {signOutError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function TopRail({
  accountEmail,
  activeChatId,
  activeChatTitle,
  adminHref,
  conversationActionsAvailable = true,
  detailsOpen,
  newChatDisabled,
  onCopyThread,
  onOpenDetails,
  onOpenBranches,
  onOpenPalette,
  onOpenPipeline,
  onOpenSettings,
  onOpenWorkspace,
  onShare,
  onSignOut = () => undefined,
  onStartNewChat,
  pipeline,
  sharing,
  signOutError = null,
  signingOut = false
}: {
  accountEmail: string | null;
  activeChatId: string | null;
  activeChatTitle: string;
  adminHref?: string | null;
  conversationActionsAvailable?: boolean;
  detailsOpen: boolean;
  newChatDisabled: boolean;
  onCopyThread(): void;
  onOpenDetails(): void;
  onOpenBranches(): void;
  onOpenPalette(): void;
  onOpenPipeline(): void;
  onOpenSettings(): void;
  onOpenWorkspace(): void;
  onShare(): void;
  onSignOut?(): void;
  onStartNewChat(): void;
  pipeline: PipelineSnapshot;
  sharing: boolean;
  signOutError?: string | null;
  signingOut?: boolean;
}) {
  const chatTitle = activeChatId ? activeChatTitle : "New chat";
  const detailsLabel = detailsOpen ? "Close details" : "Open details";
  const iconActionClass = [
    "grid size-9 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink max-lg:size-11 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11",
    actionFocusClass
  ].join(" ");

  return (
    <header
      className="grid h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-trace-subtle bg-answer-paper pb-0 pl-[max(.5rem,env(safe-area-inset-left))] pr-[max(.5rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] sm:pl-[max(.75rem,env(safe-area-inset-left))] sm:pr-[max(.75rem,env(safe-area-inset-right))] lg:h-[calc(4rem+env(safe-area-inset-top))] lg:pl-5 lg:pr-[max(1rem,env(safe-area-inset-right))]"
      data-testid="top-rail"
    >
      <div className="flex min-w-0 items-center gap-0 sm:gap-1.5">
        <button
          className={`${iconActionClass} lg:hidden`}
          type="button"
          aria-label="Open workspace"
          title="Open workspace"
          data-testid="mobile-workspace-button"
          onClick={onOpenWorkspace}
        >
          <PanelLeft className="size-4" aria-hidden="true" />
        </button>
        <button
          className={`${iconActionClass} lg:hidden disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-55`}
          type="button"
          aria-label="Start new chat"
          title="Start new chat"
          data-testid="mobile-new-chat-button"
          disabled={newChatDisabled}
          onClick={onStartNewChat}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
        <h1
          className="min-w-0 flex-1 truncate px-2 text-sm font-semibold tracking-[-0.01em] text-ink sm:text-[0.9375rem] lg:px-0 lg:text-base"
          data-testid="current-chat-title"
          title={chatTitle}
        >
          {chatTitle}
        </h1>
      </div>

      <div className="flex min-w-0 items-center justify-end gap-0.5 sm:gap-1">
        <PipelineIndicator pipeline={pipeline} onOpen={onOpenPipeline} />
        {conversationActionsAvailable ? <button
          className={[
            "inline-flex size-11 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 lg:h-9 lg:w-auto lg:min-w-9 lg:gap-2 lg:px-3 lg:text-xs lg:font-medium lg:text-ink-secondary [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11",
            actionFocusClass
          ].join(" ")}
          type="button"
          aria-label="Share anonymously"
          aria-busy={sharing || undefined}
          title="Share anonymously"
          disabled={sharing}
          onClick={onShare}
        >
          <Share2 className="size-4" aria-hidden="true" />
          <span className="hidden lg:inline">Share</span>
        </button> : null}
        {conversationActionsAvailable ? <button
          className={[
            "inline-flex size-11 shrink-0 items-center justify-center rounded-control lg:h-9 lg:w-auto lg:min-w-9 lg:gap-2 lg:px-3 lg:text-xs lg:font-medium [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11",
            detailsOpen
              ? "bg-control-selected text-ink hover:bg-control-hover"
              : "text-ink-secondary hover:bg-control-hover hover:text-ink",
            actionFocusClass
          ].join(" ")}
          type="button"
          aria-controls="details-pane"
          aria-expanded={detailsOpen}
          aria-label={detailsLabel}
          title={detailsLabel}
          onClick={onOpenDetails}
        >
          <PanelRight className="size-4" aria-hidden="true" />
          <span className="hidden lg:inline">Details</span>
        </button> : null}
        {conversationActionsAvailable ? (
          <ConversationActionsMenu onCopyThread={onCopyThread} onOpenBranches={onOpenBranches} />
        ) : null}
        <AccountMenu
          accountEmail={accountEmail}
          adminHref={adminHref}
          onOpenPalette={onOpenPalette}
          onOpenSettings={onOpenSettings}
          onSignOut={onSignOut}
          signOutError={signOutError}
          signingOut={signingOut}
        />
      </div>
    </header>
  );
}
