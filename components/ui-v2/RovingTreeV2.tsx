"use client";

import {
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode
} from "react";

const TREE_ITEM_SELECTOR = "[data-v2-tree-item='true']";
const ROW_MENU_TRIGGER_SELECTOR = "[data-v2-row-menu-trigger='true']";

function treeItems(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>(TREE_ITEM_SELECTOR)].filter((item) => {
    if (item.hasAttribute("disabled") || item.getAttribute("aria-disabled") === "true") return false;
    return !item.closest("[hidden], [aria-hidden='true']");
  });
}

function makeCurrent(items: readonly HTMLElement[], item: HTMLElement, focus = true): void {
  for (const candidate of items) candidate.tabIndex = candidate === item ? 0 : -1;
  if (focus) item.focus();
}

function itemLevel(item: HTMLElement): number {
  const value = Number(item.getAttribute("aria-level"));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Roving keyboard owner for personal and Project chat trees. Rows opt in with
 * `data-v2-tree-item="true"`; their adjacent ellipsis opts in with
 * `data-v2-row-menu-trigger="true"` for Shift+F10 / ContextMenu.
 */
export function UiV2RovingTree({
  children,
  className = "",
  label,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "children" | "onContextMenu" | "onKeyDown"> & {
  children: ReactNode;
  label: string;
}) {
  const treeRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const items = treeItems(tree);
    if (items.length === 0) return;
    const focused = document.activeElement instanceof HTMLElement && tree.contains(document.activeElement)
      ? document.activeElement.closest<HTMLElement>(TREE_ITEM_SELECTOR)
      : null;
    const current = focused ?? items.find((item) => item.tabIndex === 0) ??
      items.find((item) => item.getAttribute("aria-current") === "page" || item.dataset.selected === "true") ??
      items[0];
    if (current) makeCurrent(items, current, false);
  });

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tree = treeRef.current;
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>(TREE_ITEM_SELECTOR)
      : null;
    if (!tree || !target || document.activeElement !== target) return;
    const items = treeItems(tree);
    const index = items.indexOf(target);
    if (index < 0) return;

    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      const row = target.closest<HTMLElement>("[data-v2-tree-row='true']");
      const trigger = row?.querySelector<HTMLButtonElement>(ROW_MENU_TRIGGER_SELECTOR);
      if (!trigger || trigger.disabled) return;
      event.preventDefault();
      trigger.click();
      return;
    }

    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[Math.min(items.length - 1, index + 1)];
    else if (event.key === "ArrowUp") next = items[Math.max(0, index - 1)];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "ArrowRight") {
      if (target.getAttribute("aria-expanded") === "false") {
        event.preventDefault();
        target.click();
        return;
      }
      const child = items[index + 1];
      if (target.getAttribute("aria-expanded") === "true" && child && itemLevel(child) > itemLevel(target)) {
        next = child;
      }
    } else if (event.key === "ArrowLeft") {
      if (target.getAttribute("aria-expanded") === "true") {
        event.preventDefault();
        target.click();
        return;
      }
      const level = itemLevel(target);
      for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
        if (itemLevel(items[candidate]!) < level) {
          next = items[candidate];
          break;
        }
      }
    } else return;

    if (!next) return;
    event.preventDefault();
    makeCurrent(items, next);
  };

  return (
    <div
      {...props}
      aria-label={label}
      className={className}
      ref={treeRef}
      role="tree"
      onFocusCapture={(event) => {
        const target = event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>(TREE_ITEM_SELECTOR)
          : null;
        if (target && treeRef.current?.contains(target)) {
          makeCurrent(treeItems(treeRef.current), target, false);
        }
      }}
      onContextMenu={(event) => {
        // Browsers dispatch a native contextmenu event after Shift+F10. Its
        // default action can reclaim focus from the menu that just opened.
        // The tree owns that gesture, so suppress the native surface.
        if (event.target instanceof HTMLElement && event.target.closest(TREE_ITEM_SELECTOR)) {
          event.preventDefault();
        }
      }}
      onKeyDown={onTreeKeyDown}
    >
      {children}
    </div>
  );
}
