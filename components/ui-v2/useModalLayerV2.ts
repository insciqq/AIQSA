"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent
} from "react";

const subscribeToBrowser = () => () => undefined;
const browserSnapshot = () => true;
const serverSnapshot = () => false;

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), " +
    "textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])"
  )].filter((element) => {
    if (element.hidden) return false;
    const closedDetails = element.closest<HTMLDetailsElement>("details:not([open])");
    return !closedDetails || (
      element.tagName === "SUMMARY" && closedDetails.firstElementChild === element
    );
  });
}

export function useModalLayerV2({
  closeBlocked = false,
  onClose
}: {
  closeBlocked?: boolean;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const portalReady = useSyncExternalStore(
    subscribeToBrowser,
    browserSnapshot,
    serverSnapshot
  );

  useLayoutEffect(() => {
    if (!portalReady) return;
    const activeElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (!openerRef.current && !dialogRef.current?.contains(activeElement)) {
      openerRef.current = activeElement;
    }
    initialFocusRef.current?.focus();
    const portalRoot = dialogRef.current?.parentElement;
    const siblings = [...document.body.children].filter((element) => element !== portalRoot);
    const prior = siblings.map((element) => ({
      ariaHidden: element.getAttribute("aria-hidden"),
      element: element as HTMLElement,
      inert: (element as HTMLElement).inert
    }));
    for (const item of prior) {
      item.element.inert = true;
      item.element.setAttribute("aria-hidden", "true");
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      for (const item of prior) {
        item.element.inert = item.inert;
        if (item.ariaHidden === null) item.element.removeAttribute("aria-hidden");
        else item.element.setAttribute("aria-hidden", item.ariaHidden);
      }
      queueMicrotask(() => {
        if (openerRef.current?.isConnected) openerRef.current.focus();
      });
    };
  }, [portalReady]);

  const onDialogKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      if (closeBlocked) return;
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const items = focusableElements(dialogRef.current);
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [closeBlocked, onClose]);

  return {
    dialogRef,
    initialFocusRef,
    onDialogKeyDown,
    portalReady
  };
}
