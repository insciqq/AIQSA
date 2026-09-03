"use client";

import { createPortal } from "react-dom";
import {
  useCallback,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
  type RefObject
} from "react";
import { UiV2MenuItem, UiV2MenuSeparator, UiV2MenuSurface, moveMenuFocusV2 } from "./index";
import { useModalLayerV2 } from "./useModalLayerV2";

const MOBILE_MENU_QUERY = "(max-width: 767px)";
const VIEWPORT_GUTTER_PX = 8;
const ANCHOR_GAP_PX = 6;

const subscribeToBrowser = () => () => undefined;
const browserSnapshot = () => true;
const serverSnapshot = () => false;

function mobileSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  return typeof window.matchMedia === "function"
    ? window.matchMedia(MOBILE_MENU_QUERY).matches
    : window.innerWidth < 768;
}

function subscribeToMobileMenu(change: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (typeof window.matchMedia !== "function") {
    window.addEventListener("resize", change);
    return () => window.removeEventListener("resize", change);
  }
  const media = window.matchMedia(MOBILE_MENU_QUERY);
  media.addEventListener?.("change", change);
  return () => media.removeEventListener?.("change", change);
}

type ResponsiveMenuProps = Readonly<{
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  label: string;
  menuRef: RefObject<HTMLDivElement | null>;
  onClose(): void;
}>;

function firstEnabledItem(menu: HTMLElement | null): HTMLElement | null {
  return menu?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)") ?? null;
}

/**
 * One row-action surface across the shell. At mobile width it becomes a
 * modal, scrim-backed sheet; otherwise it is a portalled anchored popover
 * that flips above its trigger when the lower viewport has less room.
 */
export function UiV2ResponsiveMenu({
  anchorRef,
  children,
  className = "",
  label,
  menuRef,
  onClose
}: ResponsiveMenuProps) {
  const browserReady = useSyncExternalStore(
    subscribeToBrowser,
    browserSnapshot,
    serverSnapshot
  );
  const mobile = useSyncExternalStore(
    subscribeToMobileMenu,
    mobileSnapshot,
    () => false
  );

  if (!browserReady) return null;
  if (mobile) {
    return (
      <MobileMenuSheet
        className={className}
        label={label}
        menuRef={menuRef}
        onClose={onClose}
      >
        {children}
      </MobileMenuSheet>
    );
  }
  return createPortal(
    <AnchoredMenuPopover
      anchorRef={anchorRef}
      className={className}
      label={label}
      menuRef={menuRef}
      onClose={onClose}
    >
      {children}
    </AnchoredMenuPopover>,
    document.body
  );
}

function AnchoredMenuPopover({
  anchorRef,
  children,
  className,
  label,
  menuRef,
  onClose
}: ResponsiveMenuProps) {
  const updatePlacement = useCallback(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const anchorBounds = anchor.getBoundingClientRect();
    const width = Math.min(
      Math.max(menu.offsetWidth, 208),
      Math.max(208, window.innerWidth - VIEWPORT_GUTTER_PX * 2)
    );
    const below = Math.max(
      0,
      window.innerHeight - anchorBounds.bottom - ANCHOR_GAP_PX - VIEWPORT_GUTTER_PX
    );
    const above = Math.max(
      0,
      anchorBounds.top - ANCHOR_GAP_PX - VIEWPORT_GUTTER_PX
    );
    const wantedHeight = Math.max(1, menu.scrollHeight);
    const side = below >= Math.min(wantedHeight, 176) || below >= above ? "bottom" : "top";
    const available = side === "bottom" ? below : above;
    const maxHeight = Math.max(1, available);
    const renderedHeight = Math.min(wantedHeight, maxHeight);
    const left = Math.min(
      Math.max(VIEWPORT_GUTTER_PX, anchorBounds.right - width),
      Math.max(VIEWPORT_GUTTER_PX, window.innerWidth - width - VIEWPORT_GUTTER_PX)
    );
    const top = side === "bottom"
      ? anchorBounds.bottom + ANCHOR_GAP_PX
      : Math.max(VIEWPORT_GUTTER_PX, anchorBounds.top - ANCHOR_GAP_PX - renderedHeight);
    menu.dataset.side = side;
    Object.assign(menu.style, {
      left: `${left}px`,
      maxHeight: `${maxHeight}px`,
      position: "fixed",
      top: `${top}px`,
      visibility: "visible",
      width: `${width}px`,
      zIndex: "100"
    });
  }, [anchorRef, menuRef]);

  useLayoutEffect(() => {
    updatePlacement();
    // Shift+F10 finishes its native key sequence after this portal commits.
    // Move focus after the keyboard-generated context-menu sequence settles
    // so the browser cannot hand it back to the tree row afterward.
    let focusFrame = window.requestAnimationFrame(() => {
      focusFrame = window.requestAnimationFrame(() => {
        firstEnabledItem(menuRef.current)?.focus();
      });
    });
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [menuRef, updatePlacement]);

  return (
    <UiV2MenuSurface
      className={`v2-responsive-menu v2-responsive-menu-popover ${className}`.trim()}
      label={label}
      ref={menuRef}
      style={{ position: "fixed", visibility: "hidden" }}
      onKeyDown={(event) => moveMenuFocusV2(event, menuRef.current, onClose)}
    >
      {children}
    </UiV2MenuSurface>
  );
}

function MobileMenuSheet({
  children,
  className,
  label,
  menuRef,
  onClose
}: Omit<ResponsiveMenuProps, "anchorRef">) {
  const { dialogRef, onDialogKeyDown, portalReady } = useModalLayerV2({ onClose });

  useLayoutEffect(() => {
    if (!portalReady) return;
    let focusFrame = window.requestAnimationFrame(() => {
      focusFrame = window.requestAnimationFrame(() => {
        firstEnabledItem(menuRef.current)?.focus();
      });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [menuRef, portalReady]);

  if (!portalReady) return null;
  return createPortal(
    <div className="v2-responsive-menu-layer">
      <button
        aria-label={`Close ${label}`}
        className="v2-responsive-menu-scrim"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <section
        aria-label={`${label} sheet`}
        aria-modal="true"
        className="v2-responsive-menu-sheet"
        ref={dialogRef}
        role="dialog"
        onKeyDown={onDialogKeyDown}
      >
        <div aria-hidden="true" className="v2-responsive-menu-handle" />
        <div className="v2-responsive-menu-title">{label}</div>
        <UiV2MenuSurface
          className={`v2-responsive-menu ${className}`.trim()}
          label={label}
          ref={menuRef}
          onKeyDown={(event) => moveMenuFocusV2(event, menuRef.current, onClose)}
        >
          {children}
          <UiV2MenuSeparator />
          <UiV2MenuItem onClick={onClose}>Close</UiV2MenuItem>
        </UiV2MenuSurface>
      </section>
    </div>,
    document.body
  );
}
