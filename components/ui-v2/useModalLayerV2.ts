"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type RefObject
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

type ModalLayer = {
  dialogRef: RefObject<HTMLElement | null>;
  opener: HTMLElement | null;
  restoreFocus(): HTMLElement | null;
};

type IsolatedState = { ariaHidden: string | null; inert: boolean };

/*
 * Open layers share one page-level isolation owner. The page's original inert,
 * aria-hidden and body overflow values are recorded once, when an element is
 * first isolated, and restored only when the last layer closes; only the body
 * children other than the topmost layer's own root are isolated. Per-layer
 * snapshots cannot be used: a later layer's snapshot already contains the
 * earlier layer's isolation, so parent-first or same-commit sibling unmounts
 * would reapply it and leave the page inert. Layers stack in activation order.
 */
const layerStack: ModalLayer[] = [];
const isolated = new Map<HTMLElement, IsolatedState>();
let savedOverflow: string | null = null;
let closedLayers: { depth: number; layer: ModalLayer }[] = [];
let focusRestoreQueued = false;

function bodyChildContaining(element: HTMLElement | null): HTMLElement | null {
  let current = element;
  while (current && current.parentElement !== document.body) current = current.parentElement;
  return current;
}

function restoreIsolated(element: HTMLElement, state: IsolatedState) {
  element.inert = state.inert;
  if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", state.ariaHidden);
}

function topLayerRoot(): HTMLElement | null {
  const top = layerStack.at(-1);
  return top ? bodyChildContaining(top.dialogRef.current) : null;
}

function syncPageIsolation() {
  if (layerStack.length === 0) {
    for (const [element, state] of isolated) restoreIsolated(element, state);
    isolated.clear();
    if (savedOverflow !== null) document.body.style.overflow = savedOverflow;
    savedOverflow = null;
    return;
  }
  if (savedOverflow === null) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  for (const [element, state] of isolated) {
    if (element.isConnected) continue;
    restoreIsolated(element, state);
    isolated.delete(element);
  }
  const topRoot = topLayerRoot();
  for (const child of document.body.children) {
    const element = child as HTMLElement;
    const state = isolated.get(element);
    if (element === topRoot) {
      if (state) {
        restoreIsolated(element, state);
        isolated.delete(element);
      }
      continue;
    }
    if (!state) isolated.set(element, { ariaHidden: element.getAttribute("aria-hidden"), inert: element.inert });
    element.inert = true;
    element.setAttribute("aria-hidden", "true");
  }
}

function focusable(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element === document.body || element.matches(":disabled")) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.inert || current.hasAttribute("inert")) return false;
  }
  return true;
}

function layerFocusTarget(layer: ModalLayer): HTMLElement | null {
  if (focusable(layer.opener)) return layer.opener;
  const fallback = layer.restoreFocus();
  return focusable(fallback) ? fallback : null;
}

/*
 * Runs once after every layer change of a commit settled, so unmount order
 * within the commit does not matter. Focus returns to the nearest connected,
 * reachable opener of the closed layers (the innermost first), or to the
 * layer's own fallback when its opener is gone, disabled or was the page
 * itself; a layer that remains open keeps focus it already holds.
 */
function restoreClosedLayerFocus() {
  focusRestoreQueued = false;
  const closed = closedLayers.sort((left, right) => right.depth - left.depth);
  closedLayers = [];
  if (closed.length === 0) return;
  const topDialog = layerStack.at(-1)?.dialogRef.current ?? null;
  if (topDialog && bodyChildContaining(topDialog)?.contains(document.activeElement)) return;
  let target: HTMLElement | null = null;
  for (const { layer } of closed) {
    target = layerFocusTarget(layer);
    if (target) break;
  }
  if (target) target.focus();
  else if (topDialog) focusableElements(topDialog)[0]?.focus();
}

/*
 * Whether an Escape that reached the document belongs to the topmost layer: focus fell out of every dialog, for
 * example to the page after a click on a picture, onto the layer's own wrapper around its dialog, or onto the
 * isolated page behind it. A target inside a dialog belongs to that dialog's own key handler, which already ran
 * (or deliberately let the key through, as the live browser does while the person controls the page), so the
 * document never handles it a second time.
 */
function escapeFellOutOfDialogs(target: EventTarget | null, dialog: HTMLElement | null): boolean {
  if (!dialog?.isConnected) return false;
  // A confirmation open inside this dialog (not a layer of its own, such as a non-portal ConfirmationDialog) owns Escape.
  if (dialog.querySelector("[role='dialog'], [role='alertdialog']")) return false;
  if (!(target instanceof Element) || target === document.body || target === document.documentElement) return true;
  if (!(target instanceof HTMLElement)) return false;
  if (dialog.contains(target) || target.closest("[role='dialog'], [role='alertdialog']")) return false;
  if (target.contains(dialog)) return true;
  const root = bodyChildContaining(target);
  return root !== null && isolated.has(root);
}

function openLayer(layer: ModalLayer) {
  // StrictMode re-runs the effect after its cleanup; the layer is open again.
  closedLayers = closedLayers.filter((entry) => entry.layer.dialogRef !== layer.dialogRef);
  layerStack.push(layer);
  syncPageIsolation();
}

function closeLayer(layer: ModalLayer) {
  const depth = layerStack.indexOf(layer);
  if (depth >= 0) layerStack.splice(depth, 1);
  syncPageIsolation();
  closedLayers.push({ depth, layer });
  if (focusRestoreQueued) return;
  focusRestoreQueued = true;
  queueMicrotask(restoreClosedLayerFocus);
}

export function useModalLayerV2({
  closeBlocked = false,
  enabled = true,
  onClose,
  restoreFocus
}: {
  closeBlocked?: boolean;
  enabled?: boolean;
  onClose(): void;
  /** Where focus goes on close when the control that opened the layer is gone. */
  restoreFocus?(): HTMLElement | null;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(restoreFocus);
  const closeBlockedRef = useRef(closeBlocked);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    restoreFocusRef.current = restoreFocus;
    closeBlockedRef.current = closeBlocked;
    onCloseRef.current = onClose;
  }, [closeBlocked, onClose, restoreFocus]);
  const portalReady = useSyncExternalStore(
    subscribeToBrowser,
    browserSnapshot,
    serverSnapshot
  );

  useLayoutEffect(() => {
    if (!portalReady || !enabled) {
      openerRef.current = null;
      return;
    }
    const activeElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (!openerRef.current && !dialogRef.current?.contains(activeElement)) {
      openerRef.current = activeElement;
    }
    initialFocusRef.current?.focus();
    const layer: ModalLayer = {
      dialogRef,
      opener: openerRef.current,
      restoreFocus: () => restoreFocusRef.current?.() ?? null
    };
    openLayer(layer);
    // Escape still closes the topmost layer when focus has left its dialog; the dialog's own handler runs first.
    const closeFromPage = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (layerStack.at(-1) !== layer || !escapeFellOutOfDialogs(event.target, dialogRef.current)) return;
      if (closeBlockedRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", closeFromPage);
    return () => {
      document.removeEventListener("keydown", closeFromPage);
      closeLayer(layer);
    };
  }, [enabled, portalReady]);

  const onDialogKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!enabled || event.defaultPrevented) return;
    // A nested confirmation owns its Escape and Tab before the enclosing sheet.
    const owner = event.target instanceof Element ? event.target.closest("[role='dialog']") : null;
    if (owner && owner !== dialogRef.current) return;
    if (event.key === "Escape") {
      if (closeBlocked || event.nativeEvent.isComposing) return;
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
  }, [closeBlocked, enabled, onClose]);

  return {
    dialogRef,
    initialFocusRef,
    onDialogKeyDown,
    portalReady
  };
}
