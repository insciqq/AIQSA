import { BookOpen, ChevronDown, ChevronUp, Command, LogOut, ScrollText, Settings, Shield, UserRound } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from "react";

const menuItemClass =
  "flex min-h-touch w-full items-center gap-2 rounded-control px-3 text-left text-sm font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:bg-control-hover focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-focus min-[1281px]:min-h-9 [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";

export type DesktopAccountMenuAnchor = "rail";
export type AccountMenuAnchor = DesktopAccountMenuAnchor | "mobile";
export type AccountMenuInitialFocus = "first" | "last";

export type AccountMenuTriggerProps = {
  accountEmail: string | null;
  active: boolean;
  controlsId: string;
  layout: AccountMenuAnchor;
  onClose(): void;
  onOpen(initialFocus: AccountMenuInitialFocus): void;
  signOutError?: string | null;
  signingOut: boolean;
  tooltipId?: string;
};

export const AccountMenuTrigger = forwardRef<HTMLButtonElement, AccountMenuTriggerProps>(
  function AccountMenuTrigger(
    {
      accountEmail,
      active,
      controlsId,
      layout,
      onClose,
      onOpen,
      signOutError,
      signingOut,
      tooltipId
    },
    ref
  ) {
    const accountIdentity = accountEmail?.trim() || "Email unavailable";
    const rail = layout === "rail";
    const errorDescriptionId = `${layout}-account-sign-out-error-description`;
    const describedBy = [tooltipId, signOutError ? errorDescriptionId : null]
      .filter((value): value is string => Boolean(value))
      .join(" ") || undefined;
    const label = rail ? "Account" : `Account menu for ${accountIdentity}`;
    const focusClass =
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-workspace-rail";

    function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        onOpen("first");
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        onOpen("last");
      } else if (event.key === "Escape" && active) {
        event.preventDefault();
        onClose();
      }
    }

    return (
      <>
        <button
          ref={ref}
          className={
            rail
              ? `relative flex min-h-[3.25rem] w-[4.5rem] shrink-0 flex-col items-center justify-center gap-1 rounded-control px-1 hover:bg-control-hover [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch ${signOutError ? "bg-critical/10 text-critical" : active ? "bg-control-selected text-ink" : "text-ink-secondary"} ${focusClass}`
              : `relative flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-left hover:bg-control-hover [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch ${signOutError ? "bg-critical/10 text-critical" : "text-ink-secondary"} ${focusClass}`
          }
          type="button"
          aria-busy={signingOut || undefined}
          aria-controls={active ? controlsId : undefined}
          aria-describedby={describedBy}
          aria-expanded={active}
          aria-haspopup="menu"
          aria-label={label}
          data-account-menu-trigger={layout}
          data-desktop-navigation-control={layout === "mobile" ? undefined : layout}
          title={label}
          onClick={() => (active ? onClose() : onOpen("first"))}
          onKeyDown={handleKeyDown}
        >
          <span className={rail ? "relative grid size-4 shrink-0 place-items-center" : "relative grid size-7 shrink-0 place-items-center"} aria-hidden="true">
            <UserRound className="size-4" />
            {signOutError ? (
              <span
                className="absolute right-0 top-0 size-2 rounded-full border border-workspace-rail bg-critical"
                data-testid={rail ? "rail-account-error-cue" : "account-error-cue"}
              />
            ) : null}
          </span>
          {rail ? (
            <span className="max-w-full truncate text-[0.6875rem] font-medium leading-none">Account</span>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={accountIdentity}>
                {accountIdentity}
              </span>
              {active ? (
                <ChevronDown className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              ) : (
                <ChevronUp className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              )}
            </>
          )}
        </button>
        {signOutError ? (
          <span className="sr-only" id={errorDescriptionId}>
            Sign out failed. {signOutError} Open Account to retry.
          </span>
        ) : null}
      </>
    );
  }
);

export type AccountMenuProps = {
  accountEmail: string | null;
  activeTriggerRef: RefObject<HTMLButtonElement | null>;
  adminHref?: string | null;
  anchor: AccountMenuAnchor;
  initialFocus?: AccountMenuInitialFocus;
  menuId: string;
  onClose(): void;
  onOpenKnowledge(): void;
  onOpenLibrary(): void;
  onOpenPalette(): void;
  onOpenSettings(): void;
  onSignOut(): void;
  signOutError?: string | null;
  signingOut: boolean;
  triggerRefs: readonly RefObject<HTMLButtonElement | null>[];
};

function placementClass(anchor: AccountMenuAnchor): string {
  if (anchor === "mobile") {
    return "absolute bottom-12 left-0 w-full max-w-64";
  }

  return "fixed left-[calc(5rem+env(safe-area-inset-left)+0.5rem)] top-[calc(max(0.5rem,env(safe-area-inset-top))+7rem)] w-64 max-w-[calc(100vw-5.5rem-env(safe-area-inset-left)-env(safe-area-inset-right))]";
}

export function AccountMenu({
  accountEmail,
  activeTriggerRef,
  adminHref,
  anchor,
  initialFocus = "first",
  menuId,
  onClose,
  onOpenKnowledge,
  onOpenLibrary,
  onOpenPalette,
  onOpenSettings,
  onSignOut,
  signOutError,
  signingOut,
  triggerRefs
}: AccountMenuProps) {
  const [menuCanScrollDown, setMenuCanScrollDown] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const accountIdentity = accountEmail?.trim() || "Email unavailable";
  const signOutErrorDetailId = `${menuId}-sign-out-error-detail`;

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
    setMenuCanScrollDown(menu.scrollHeight - menu.scrollTop - menu.clientHeight > 8);
  }

  function closeMenu({ restoreFocus = false } = {}) {
    onClose();
    setMenuCanScrollDown(false);
    if (restoreFocus) {
      window.setTimeout(() => activeTriggerRef.current?.focus({ preventScroll: true }), 0);
    }
  }

  function replaceMenuWith(openReplacement: () => void) {
    activeTriggerRef.current?.focus({ preventScroll: true });
    onClose();
    window.setTimeout(openReplacement, 0);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const items = menuItems();
      const target = initialFocus === "last" ? items.at(-1) : items[0];
      focusMenuItem(target);
      updateScrollCue();
    }, 0);

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      const triggerHit = triggerRefs.some((triggerRef) => triggerRef.current?.contains(target));
      if (!menuRef.current?.contains(target) && !triggerHit) {
        closeMenu();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", updateScrollCue);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", updateScrollCue);
    };
    // Trigger refs are stable containers owned by the shell. Re-running for
    // array identity would move menu focus on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, initialFocus]);

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

  const desktopMaxHeight =
    "calc(100dvh - max(0.5rem, env(safe-area-inset-top)) - max(0.5rem, env(safe-area-inset-bottom)) - 4.5rem)";
  const mobileMaxHeight =
    "calc(100dvh - max(0.5rem, env(safe-area-inset-top)) - max(0.5rem, env(safe-area-inset-bottom)) - 6.5rem)";

  return (
    <div
      className={`${placementClass(anchor)} z-[80] min-w-0`}
      data-account-menu-anchor={anchor}
      data-account-menu-root="true"
    >
      <div
        ref={menuRef}
        className="account-menu-scrollbar pop-enter w-full overflow-y-auto overscroll-contain rounded-panel border border-trace-subtle bg-overlay-surface p-2 shadow-overlay"
        id={menuId}
        role="menu"
        aria-label="Account"
        style={{ maxHeight: anchor === "mobile" ? mobileMaxHeight : desktopMaxHeight }}
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
          onClick={() => replaceMenuWith(onOpenPalette)}
        >
          <Command className="size-4 text-ink-muted" aria-hidden="true" />
          Command palette
        </button>
        <button
          className={menuItemClass}
          type="button"
          role="menuitem"
          disabled={signingOut}
          onClick={() => replaceMenuWith(onOpenLibrary)}
        >
          <ScrollText className="size-4 text-ink-muted" aria-hidden="true" />
          Assistants
        </button>
        <button
          className={menuItemClass}
          type="button"
          role="menuitem"
          disabled={signingOut}
          onClick={() => replaceMenuWith(onOpenKnowledge)}
        >
          <BookOpen className="size-4 text-ink-muted" aria-hidden="true" />
          Knowledge
        </button>
        <button
          className={menuItemClass}
          type="button"
          role="menuitem"
          disabled={signingOut}
          onClick={() => replaceMenuWith(onOpenSettings)}
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
      {menuCanScrollDown ? (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[81] flex h-8 items-end justify-center rounded-b-panel bg-gradient-to-t from-overlay-surface via-overlay-surface/90 to-transparent pb-1 text-ink-muted"
          data-testid="account-menu-scroll-cue"
          aria-hidden="true"
        >
          <ChevronDown className="size-3.5" />
        </div>
      ) : null}
    </div>
  );
}
