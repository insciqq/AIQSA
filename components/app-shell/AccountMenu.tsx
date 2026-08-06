import { ChevronDown, ChevronUp, Command, LogOut, ScrollText, Settings, Shield, UserRound } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";

const menuItemClass =
  "flex min-h-touch w-full items-center gap-2 rounded-control px-3 text-left text-sm font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:bg-control-hover focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-focus min-[1281px]:min-h-9 [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";

export type AccountMenuProps = {
  accountEmail: string | null;
  adminHref?: string | null;
  idPrefix?: string;
  layout?: "desktop" | "mobile";
  onOpenChange?(open: boolean): void;
  onOpenPalette(): void;
  onOpenLibrary(): void;
  onOpenSettings(): void;
  onSignOut(): void;
  open?: boolean;
  signOutError?: string | null;
  signingOut: boolean;
};

export const AccountMenu = forwardRef<HTMLButtonElement, AccountMenuProps>(function AccountMenu(
  {
    accountEmail,
    adminHref,
    idPrefix = "",
    layout = "desktop",
    onOpenChange,
    onOpenPalette,
    onOpenLibrary,
    onOpenSettings,
    onSignOut,
    open: controlledOpen,
    signOutError,
    signingOut
  },
  forwardedTriggerRef
) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");
  const [menuCanScrollDown, setMenuCanScrollDown] = useState(false);
  const boundaryRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const accountMenuId = `${idPrefix}account-menu`;
  const signOutErrorDescriptionId = `${idPrefix}account-sign-out-error-description`;
  const signOutErrorDetailId = `${idPrefix}account-sign-out-error-detail`;
  const accountIdentity = accountEmail?.trim() || "Email unavailable";
  const accountTriggerLabel = `Account menu for ${accountIdentity}`;
  const open = controlledOpen ?? uncontrolledOpen;
  const accountFocusClass =
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-workspace-rail";
  const setTriggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof forwardedTriggerRef === "function") {
        forwardedTriggerRef(node);
      } else if (forwardedTriggerRef) {
        forwardedTriggerRef.current = node;
      }
    },
    [forwardedTriggerRef]
  );

  function menuItems(): HTMLElement[] {
    const candidates = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]):not(:disabled)') ?? []
    );
    const visibleItems = candidates.filter((item) => item.offsetParent !== null || item.getClientRects().length > 0);

    // jsdom has no layout boxes; keep the keyboard model testable there while
    // real browsers still exclude responsive `display: none` menu items.
    return visibleItems.length > 0 ? visibleItems : candidates;
  }

  function focusMenuItem(item: HTMLElement | undefined) {
    item?.focus({ preventScroll: true });
    if (item && typeof item.scrollIntoView === "function") {
      item.scrollIntoView({ block: "nearest" });
    }
  }

  function updateScrollCue() {
    const menu = menuRef.current;
    if (!menu) {
      setMenuCanScrollDown(false);
      return;
    }
    // The final 8px is the menu's own bottom padding, not hidden content.
    setMenuCanScrollDown(menu.scrollHeight - menu.scrollTop - menu.clientHeight > 8);
  }

  const updateOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange]
  );

  function closeMenu({ restoreFocus = false } = {}) {
    updateOpen(false);
    setMenuCanScrollDown(false);
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0);
    }
  }

  function openMenu(focus: "first" | "last" = "first") {
    setInitialFocus(focus);
    setMenuCanScrollDown(false);
    updateOpen(true);
  }

  function replaceMenuWith(openReplacement: () => void) {
    triggerRef.current?.focus({ preventScroll: true });
    updateOpen(false);
    window.setTimeout(openReplacement, 0);
  }

  useEffect(() => {
    if (!open) {
      return;
    }

    const timer = window.setTimeout(() => {
      const items = menuItems();
      const target = initialFocus === "last" ? items.at(-1) : items[0];
      focusMenuItem(target);
      updateScrollCue();
    }, 0);

    function handlePointerDown(event: PointerEvent) {
      if (!boundaryRef.current?.contains(event.target as Node)) {
        updateOpen(false);
        setMenuCanScrollDown(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", updateScrollCue);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", updateScrollCue);
    };
  }, [initialFocus, open, updateOpen]);

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
      focusMenuItem(items[nextIndex]);
    }
  }

  return (
    <div className="relative w-full" data-account-menu-root="true" ref={boundaryRef}>
      <button
        ref={setTriggerRef}
        className={`relative flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-left hover:bg-control-hover [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch ${signOutError ? "bg-critical/10 text-critical" : "text-ink-secondary"} ${accountFocusClass}`}
        type="button"
        aria-busy={signingOut || undefined}
        aria-controls={open ? accountMenuId : undefined}
        aria-describedby={signOutError ? signOutErrorDescriptionId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={accountTriggerLabel}
        title={accountTriggerLabel}
        onClick={() => (open ? closeMenu({ restoreFocus: true }) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="relative grid size-7 shrink-0 place-items-center" aria-hidden="true">
          <UserRound className="size-4" />
          {signOutError ? (
            <span
              className="absolute right-0 top-0 size-2 rounded-full border border-workspace-rail bg-critical"
              data-testid="account-error-cue"
            />
          ) : null}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={accountIdentity}>
          {accountIdentity}
        </span>
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        ) : (
          <ChevronUp className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        )}
      </button>

      {signOutError ? (
        <span className="sr-only" id={signOutErrorDescriptionId}>
          Sign out failed. {signOutError} Open Account to retry.
        </span>
      ) : null}

      {open ? (
        <div
          ref={menuRef}
          className={`account-menu-scrollbar pop-enter absolute bottom-12 left-0 z-[80] w-full max-w-64 overflow-y-auto overscroll-contain rounded-panel border border-trace-subtle bg-overlay-surface p-2 shadow-overlay ${
            layout === "mobile" ? "" : "max-h-[calc(100dvh-7.5rem)]"
          }`}
          id={accountMenuId}
          role="menu"
          aria-label="Account"
          style={
            layout === "mobile"
              ? {
                  maxHeight:
                    "calc(100dvh - max(0.5rem, env(safe-area-inset-top)) - max(0.5rem, env(safe-area-inset-bottom)) - 6.5rem)"
                }
              : undefined
          }
          onScroll={updateScrollCue}
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
              replaceMenuWith(onOpenLibrary);
            }}
          >
            <ScrollText className="size-4 text-ink-muted" aria-hidden="true" />
            Library
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
      {open && menuCanScrollDown ? (
        <div
          className="pointer-events-none absolute bottom-12 left-0 z-[81] flex h-8 w-full max-w-64 items-end justify-center rounded-b-panel bg-gradient-to-t from-overlay-surface via-overlay-surface/90 to-transparent pb-1 text-ink-muted"
          data-testid="account-menu-scroll-cue"
          aria-hidden="true"
        >
          <ChevronDown className="size-3.5" />
        </div>
      ) : null}
    </div>
  );
});
