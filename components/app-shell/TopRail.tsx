import { runActivityLabel, type PipelineSnapshot } from "@/components/app-shell/runState";
import {
  Activity,
  Braces,
  Command,
  Copy,
  GitBranch,
  LogOut,
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
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-navigation";

const menuItemClass =
  "flex min-h-touch w-full items-center gap-2 rounded-control px-3 text-left text-sm font-medium text-content-secondary outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:bg-surface-hover focus-visible:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55 lg:min-h-9 [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";

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
          ? "bg-accent-rose/10 text-accent-rose hover:bg-accent-rose/15"
          : "bg-surface-active text-accent-cyan hover:bg-surface-hover"
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
        className={`relative grid size-9 shrink-0 place-items-center rounded-control hover:bg-surface-hover hover:text-content-primary max-lg:size-11 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11 ${signOutError ? "bg-accent-rose/10 text-accent-rose" : "text-content-muted"} ${actionFocusClass}`}
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
            className="absolute right-1 top-1 size-2 rounded-full border border-surface-navigation bg-accent-rose"
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
          className="pop-enter absolute right-0 top-12 z-[80] w-64 max-w-[calc(100vw-1rem)] rounded-panel border border-separator-subtle bg-surface-overlay p-2 shadow-overlay"
          id="account-menu"
          role="menu"
          aria-label="Account"
          onKeyDown={handleMenuKeyDown}
        >
          <div className="min-w-0 px-3 pb-2 pt-1" role="presentation">
            <p className="text-xs font-medium text-content-muted">Account</p>
            <p
              className="mt-0.5 break-words text-sm font-medium leading-5 text-content-primary [overflow-wrap:anywhere]"
              title={accountEmail?.trim() || undefined}
            >
              {accountIdentity}
            </p>
          </div>
          <button
            className={`${menuItemClass} lg:hidden`}
            type="button"
            role="menuitem"
            disabled={signingOut}
            onClick={() => {
              replaceMenuWith(onOpenPalette);
            }}
          >
            <Command className="size-4 text-content-muted" aria-hidden="true" />
            Command palette
          </button>
          <button
            className={`${menuItemClass} lg:hidden`}
            type="button"
            role="menuitem"
            disabled={signingOut}
            onClick={() => {
              replaceMenuWith(onOpenSettings);
            }}
          >
            <Settings className="size-4 text-content-muted" aria-hidden="true" />
            Settings
          </button>
          {adminHref ? (
            <a
              className={`${menuItemClass} ${signingOut ? "pointer-events-none text-content-disabled opacity-60" : ""}`}
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
              <Shield className="size-4 text-content-muted" aria-hidden="true" />
              Admin console
            </a>
          ) : null}
          <div className="my-1 border-t border-separator-subtle" role="separator" />
          <button
            className={`${menuItemClass} text-accent-rose hover:bg-accent-rose/10 hover:text-accent-rose focus-visible:bg-accent-rose/10 focus-visible:text-accent-rose`}
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
              className="mt-1 break-words rounded-control bg-accent-rose/10 px-3 py-2 text-xs leading-5 text-accent-rose [overflow-wrap:anywhere]"
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
    "grid size-9 shrink-0 place-items-center rounded-control text-content-muted hover:bg-surface-hover hover:text-content-primary max-lg:size-11 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11",
    actionFocusClass
  ].join(" ");

  return (
    <header className="grid h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 border-b border-separator-subtle bg-surface-navigation pb-0 pl-[max(.5rem,env(safe-area-inset-left))] pr-[max(.5rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] sm:gap-2 lg:gap-4 lg:pl-[max(1rem,env(safe-area-inset-left))] lg:pr-[max(1rem,env(safe-area-inset-right))]" data-testid="top-rail">
      <div className="flex min-w-0 items-center gap-0 sm:gap-2">
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
          className={`${iconActionClass} lg:hidden disabled:cursor-not-allowed disabled:text-content-disabled disabled:opacity-55`}
          type="button"
          aria-label="Start new chat"
          title="Start new chat"
          data-testid="mobile-new-chat-button"
          disabled={newChatDisabled}
          onClick={onStartNewChat}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
        <div className="hidden min-w-0 items-center gap-2 sm:flex" aria-label="AIQSA">
          <div className="grid size-8 shrink-0 place-items-center rounded-control bg-accent-cyan/10 text-accent-cyan">
            <Braces className="size-4" aria-hidden="true" />
          </div>
          <span className="hidden text-sm font-semibold text-content-primary md:inline">AIQSA</span>
        </div>
      </div>

      <h1
        className="sr-only min-w-0 truncate text-sm font-semibold text-content-primary lg:not-sr-only"
        data-testid="current-chat-title"
        title={chatTitle}
      >
        {chatTitle}
      </h1>

      <div className="flex min-w-0 items-center justify-end gap-0 sm:gap-1">
        <PipelineIndicator pipeline={pipeline} onOpen={onOpenPipeline} />
        <button
          className={`${iconActionClass} lg:hidden`}
          type="button"
          aria-label="Copy thread"
          title="Copy thread"
          onClick={onCopyThread}
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </button>
        <button
          className={`${iconActionClass} lg:hidden`}
          type="button"
          aria-label="Branch tree"
          title="Branch tree"
          onClick={onOpenBranches}
        >
          <GitBranch className="size-3.5" aria-hidden="true" />
        </button>
        <button
          className={`${iconActionClass} hidden lg:grid`}
          type="button"
          aria-label="Open command palette"
          title="Open command palette"
          onClick={onOpenPalette}
        >
          <Command className="size-4" aria-hidden="true" />
        </button>
        <button
          className={`${iconActionClass} hidden lg:grid`}
          type="button"
          aria-label="Open settings"
          title="Open settings"
          onClick={onOpenSettings}
        >
          <Settings className="size-4" aria-hidden="true" />
        </button>
        <button
          className={[
            "inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-2 rounded-control px-2 text-xs font-medium text-content-secondary hover:bg-surface-hover hover:text-content-primary disabled:cursor-not-allowed disabled:text-content-disabled disabled:opacity-60 sm:px-3 max-lg:h-touch max-lg:min-w-touch [@media(hover:none)]:!h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!h-touch [@media(pointer:coarse)]:!min-w-touch",
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
          <span className="hidden sm:inline">Share</span>
        </button>
        <button
          className={[
            "inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-2 rounded-control px-2 text-xs font-medium sm:px-3 max-lg:h-touch max-lg:min-w-touch [@media(hover:none)]:!h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!h-touch [@media(pointer:coarse)]:!min-w-touch",
            detailsOpen
              ? "bg-surface-active text-content-primary hover:bg-surface-hover"
              : "text-content-secondary hover:bg-surface-hover hover:text-content-primary",
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
          <span className="hidden md:inline">Details</span>
        </button>
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
