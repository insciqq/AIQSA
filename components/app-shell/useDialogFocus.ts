import { useEffect, useRef } from "react";

const focusableSelector = [
  "button:not([disabled]):not([tabindex='-1'])",
  "a[href]:not([tabindex='-1'])",
  "input:not([disabled]):not([tabindex='-1'])",
  "select:not([disabled]):not([tabindex='-1'])",
  "textarea:not([disabled]):not([tabindex='-1'])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function eventOwningDialog(event: KeyboardEvent) {
  const pathDialog = event
    .composedPath()
    .find(
      (target): target is HTMLElement =>
        target instanceof HTMLElement && target.getAttribute("role") === "dialog"
    );
  if (pathDialog) {
    return pathDialog;
  }

  const activeElement = document.activeElement;
  return activeElement instanceof HTMLElement
    ? activeElement.closest<HTMLElement>("[role='dialog']")
    : null;
}

function isRestorableFocusTarget(target: HTMLElement | null): target is HTMLElement {
  if (
    !target?.isConnected ||
    target === document.body ||
    target === document.documentElement
  ) {
    return false;
  }

  let current: HTMLElement | null = target;
  while (current) {
    if (
      current.hidden ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
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

function restoreElementFocus(target: HTMLElement | null) {
  if (!isRestorableFocusTarget(target)) {
    return false;
  }

  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

export function useDialogFocus<T extends HTMLElement>({
  active = true,
  autoFocus = true,
  closeOnEscape = true,
  containFocus = true,
  onClose,
  restoreFocus
}: {
  active?: boolean;
  autoFocus?: boolean;
  closeOnEscape?: boolean;
  containFocus?: boolean;
  onClose(): void;
  restoreFocus?(): HTMLElement | null;
}) {
  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  const restoreFocusRef = useRef(restoreFocus);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    restoreFocusRef.current = restoreFocus;
  }, [restoreFocus]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.hasAttribute("tabindex")) {
      dialog.tabIndex = -1;
    }

    return () => {
      if (!restoreElementFocus(previouslyFocused)) {
        restoreElementFocus(restoreFocusRef.current?.() ?? null);
      }
    };
  }, [active]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>(focusableSelector);
    const focusTimer = autoFocus
      ? window.setTimeout(() => {
          (firstFocusable ?? dialog)?.focus();
        }, 0)
      : null;

    function handleKeyDown(event: KeyboardEvent) {
      // An inner control may own Escape without being a nested dialog (for
      // example, an inline rename form inside a modal Workspace drawer).
      // Respect that ownership before applying the dialog-level close rule.
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === "Escape" && closeOnEscape) {
        const eventDialog = eventOwningDialog(event);
        if (dialog && eventDialog && eventDialog !== dialog) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key === "Tab" && containFocus) {
        const currentDialog = dialogRef.current;
        if (!currentDialog) {
          return;
        }

        const eventDialog = eventOwningDialog(event);
        if (eventDialog && eventDialog !== currentDialog) {
          return;
        }

        const focusable = Array.from(currentDialog.querySelectorAll<HTMLElement>(focusableSelector));
        if (focusable.length === 0) {
          event.preventDefault();
          currentDialog.focus();
          return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const activeElement = document.activeElement;

        if (!activeElement || !currentDialog.contains(activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
          return;
        }

        if (event.shiftKey && activeElement === first) {
          event.preventDefault();
          last.focus();
          return;
        }

        if (!event.shiftKey && activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    if (closeOnEscape || containFocus) {
      document.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      if (focusTimer !== null) {
        window.clearTimeout(focusTimer);
      }
      if (closeOnEscape || containFocus) {
        document.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, [active, autoFocus, closeOnEscape, containFocus]);

  return dialogRef;
}
