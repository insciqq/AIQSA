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
  if (!element?.isConnected) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.inert || current.hasAttribute("inert")) return false;
  }
  return true;
}

/*
 * Runs once after every layer change of a commit settled, so unmount order
 * within the commit does not matter. Focus returns to the nearest connected,
 * reachable opener of the closed layers (the innermost first); a layer that
 * remains open keeps focus it already holds.
 */
function restoreClosedLayerFocus() {
  focusRestoreQueued = false;
  const closed = closedLayers.sort((left, right) => right.depth - left.depth);
  closedLayers = [];
  if (closed.length === 0) return;
  const topDialog = layerStack.at(-1)?.dialogRef.current ?? null;
  if (topDialog && bodyChildContaining(topDialog)?.contains(document.activeElement)) return;
  const opener = closed.map(({ layer }) => layer.opener).find(focusable);
  if (opener) opener.focus();
  else if (topDialog) focusableElements(topDialog)[0]?.focus();
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
  onClose
}: {
  closeBlocked?: boolean;
  enabled?: boolean;
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
    const layer: ModalLayer = { dialogRef, opener: openerRef.current };
    openLayer(layer);
    return () => closeLayer(layer);
  }, [enabled, portalReady]);

  const onDialogKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!enabled || event.defaultPrevented) return;
    // A nested confirmation owns its Escape and Tab before the enclosing sheet.
    const owner = event.target instanceof Element ? event.target.closest("[role='dialog']") : null;
    if (owner && owner !== dialogRef.current) return;
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
  }, [closeBlocked, enabled, onClose]);

  return {
    dialogRef,
    initialFocusRef,
    onDialogKeyDown,
    portalReady
  };
}
