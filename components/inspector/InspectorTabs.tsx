"use client";

import { useRef } from "react";

export type InspectorTabId = "branch" | "events";

export const inspectorTabs: { id: InspectorTabId; label: string }[] = [
  { id: "branch", label: "Branch" },
  { id: "events", label: "Events" }
];

export function inspectorTabId(tab: InspectorTabId): string {
  return `details-tab-${tab}`;
}

export function inspectorPanelId(tab: InspectorTabId): string {
  return `details-panel-${tab}`;
}

export function InspectorTabs({
  activeTab,
  onTabChange
}: {
  activeTab: InspectorTabId;
  onTabChange(tab: InspectorTabId): void;
}) {
  const tabRefs = useRef<Record<InspectorTabId, HTMLButtonElement | null>>({
    branch: null,
    events: null
  });

  function moveTab(currentTab: InspectorTabId, direction: "end" | "home" | "next" | "previous") {
    const currentIndex = inspectorTabs.findIndex((tab) => tab.id === currentTab);
    const nextIndex =
      direction === "home"
        ? 0
        : direction === "end"
          ? inspectorTabs.length - 1
          : direction === "next"
            ? (currentIndex + 1) % inspectorTabs.length
            : (currentIndex - 1 + inspectorTabs.length) % inspectorTabs.length;
    const nextTab = inspectorTabs[nextIndex];

    onTabChange(nextTab.id);
    tabRefs.current[nextTab.id]?.focus();
  }

  return (
    <div
      className="flex min-w-0 shrink-0 gap-1 overflow-x-auto border-b border-separator-subtle px-3"
      role="tablist"
      aria-label="Details tabs"
      aria-orientation="horizontal"
    >
      {inspectorTabs.map((tab) => {
        const active = activeTab === tab.id;

        return (
          <button
            className={[
              "relative flex min-h-touch shrink-0 items-center justify-center rounded-control px-3 text-sm font-medium outline-none transition-colors duration-100 after:pointer-events-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch",
              active
                ? "text-content-primary after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-pill after:bg-accent-cyan"
                : "text-content-secondary hover:bg-surface-hover hover:text-content-primary"
            ].join(" ")}
            key={tab.id}
            id={inspectorTabId(tab.id)}
            ref={(node) => {
              tabRefs.current[tab.id] = node;
            }}
            type="button"
            role="tab"
            aria-controls={inspectorPanelId(tab.id)}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                moveTab(tab.id, "next");
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                moveTab(tab.id, "previous");
              } else if (event.key === "Home") {
                event.preventDefault();
                moveTab(tab.id, "home");
              } else if (event.key === "End") {
                event.preventDefault();
                moveTab(tab.id, "end");
              }
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
