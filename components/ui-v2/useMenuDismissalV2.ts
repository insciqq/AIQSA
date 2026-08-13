"use client";

import { useEffect, useRef } from "react";

/**
 * Shared dismissal contract for anchored `UiV2MenuSurface` menus:
 * - Escape closes the menu and returns focus to its trigger;
 * - pointerdown outside the menu and trigger closes it;
 * - focus moving outside the menu and trigger closes it;
 * - unmount (navigation, view swap) removes every listener with the menu.
 *
 * Consumers own the `open` state; attach `triggerRef` to the toggle control and
 * `menuRef` to the rendered menu surface.
 */
export function useMenuDismissalV2<
  TriggerElement extends HTMLElement = HTMLButtonElement,
  MenuElement extends HTMLElement = HTMLDivElement
>({
  onClose,
  open
}: {
  onClose(): void;
  open: boolean;
}) {
  const menuRef = useRef<MenuElement | null>(null);
  const triggerRef = useRef<TriggerElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const ownsTarget = (target: EventTarget | null) =>
      target instanceof Node && Boolean(
        menuRef.current?.contains(target) || triggerRef.current?.contains(target)
      );
    const closeFromPointer = (event: PointerEvent) => {
      if (!ownsTarget(event.target)) onCloseRef.current();
    };
    const closeFromFocus = (event: FocusEvent) => {
      if (!ownsTarget(event.target)) onCloseRef.current();
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeFromPointer);
    document.addEventListener("focusin", closeFromFocus);
    document.addEventListener("keydown", closeFromEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromPointer);
      document.removeEventListener("focusin", closeFromFocus);
      document.removeEventListener("keydown", closeFromEscape, true);
    };
  }, [open]);

  return { menuRef, triggerRef };
}
