"use client";

import {
  memoryCategoryLabel,
  memoryUiCopy
} from "@/components/app-shell/memoryUiCopy";
import { attachmentDownloadHref } from "@/components/app-shell/workspaceClient";
import { formatAttachmentBytes } from "@/components/app-shell/attachmentLimitUsage";
import {
  type UiV2IconName,
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2IconSprite,
  UiV2MenuActions,
  UiV2MenuItem,
  UiV2MenuSurface
} from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import {
  MEMORY_CONSUMER_CATEGORIES,
  MEMORY_CONSUMER_QUERY_MAX_LENGTH,
  MEMORY_CONSUMER_STATEMENT_MAX_LENGTH,
  type MemoryConsumerItem
} from "@/lib/contracts/memoryConsumer";
import { knowledgeAggregateStatus } from "@/lib/domain/knowledgePresentation";
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import type {
  FileSummaryV2,
  KnowledgeSummaryV2,
  LibraryNavigationGuardV2,
  LibrarySubviewV2,
  LibraryTabIdV2,
  LibraryTabV2,
  MemoryOverviewV2
} from "./contracts";
import { fileTypeLabel, groupLibraryFiles } from "./filePresentation";
import { formatStudioDate, formatStudioTime } from "./studioDate";
import { MemorySettingsCardV2 } from "./MemorySettingsCardV2";
import { canPreviewFile, FilePreviewV2, FileTypeTileV2 } from "./FilePreviewV2";
import { useEventCallback } from "@/components/app-shell/useEventCallback";

function mt(key: Parameters<typeof memoryUiCopy>[0]): string {
  return memoryUiCopy(key);
}

export const libraryTabGroups: readonly Readonly<{ label: string | null; tabs: readonly LibraryTabIdV2[] }>[] = [
  { label: "Behavior", tabs: ["assistants", "instructions", "skills"] },
  { label: "Content", tabs: ["knowledge", "memory", "files", "artifacts"] },
  { label: "Tools", tabs: ["scheduled", "mcp", "secrets"] },
  { label: null, tabs: ["defaults"] }
];
const tabIcons: Record<LibraryTabIdV2, UiV2IconName> = {
  assistants: "assistant", instructions: "file-text", skills: "wand",
  knowledge: "book", memory: "memory", files: "file", artifacts: "artifact",
  mcp: "plug", secrets: "key", scheduled: "clock", defaults: "sliders"
};

export function LibraryV2({
  activeTab: controlledTab,
  busy = false,
  initialTab = "assistants",
  navigationGuard,
  onBack,
  onTabChange,
  subview = null,
  tabs
}: Readonly<{
  activeTab?: LibraryTabIdV2;
  busy?: boolean;
  initialTab?: LibraryTabIdV2;
  navigationGuard?: LibraryNavigationGuardV2;
  onBack(): void;
  onTabChange?(tab: LibraryTabIdV2): void;
  /** The resource sub-view open in the selected section, if any (A14). */
  subview?: LibrarySubviewV2 | null;
  tabs: readonly LibraryTabV2[];
}>) {
  const [localTab, setActiveTab] = useState<LibraryTabIdV2>(initialTab);
  const activeTab = controlledTab ?? localTab;
  const previousInitialTab = useRef(initialTab);
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<LibraryTabIdV2, HTMLButtonElement | null>>>({});
  const backRef = useRef<HTMLButtonElement>(null);
  const previousSubview = useRef<{ key: string; resourceFocus: boolean } | null>(null);
  const groups = libraryTabGroups.map(group => ({ ...group, tabs: group.tabs.flatMap(id => {
    const tab = tabs.find(candidate => candidate.id === id);
    return tab ? [tab] : [];
  }) })).filter(group => group.tabs.length > 0);
  const availableTabs = groups.flatMap(group => group.tabs.map(tab => tab.id));
  const selected = tabs.find((tab) => tab.id === activeTab) ?? tabs.find(tab => tab.id === "assistants") ?? groups[0]?.tabs[0];
  const subviewKey = subview?.key ?? null;
  const resourceFocus = subview?.focus === "resource";
  const selectedId = selected?.id ?? null;

  // Entering a sub-view (or moving between two) focuses its Back control;
  // leaving it returns focus to the section tab so keyboard users stay in
  // the Library rather than on the document body. Editors may own both moves.
  useEffect(() => {
    const previous = previousSubview.current;
    previousSubview.current = subviewKey ? { key: subviewKey, resourceFocus } : null;
    if (subviewKey && subviewKey !== previous?.key && !resourceFocus) {
      backRef.current?.focus({ preventScroll: true });
    } else if (!subviewKey && previous && !previous.resourceFocus && selectedId) {
      tabRefs.current[selectedId]?.focus({ preventScroll: true });
    }
  }, [resourceFocus, selectedId, subviewKey]);

  // A deep-linked section can start beyond a narrow or short navigation area.
  // Keep the selected tab in the unfaded viewport without
  // changing focus or introducing a second responsive state owner.
  useEffect(() => {
    if (!selectedId) return;
    let frame = 0;
    const reveal = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const tabList = tabListRef.current;
        const tab = tabRefs.current[selectedId];
        if (!tabList || !tab || (tabList.scrollWidth <= tabList.clientWidth && tabList.scrollHeight <= tabList.clientHeight)) return;
        tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      });
    };
    reveal();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    if (tabListRef.current) observer?.observe(tabListRef.current);
    return () => { observer?.disconnect(); window.cancelAnimationFrame(frame); };
  }, [selectedId]);

  const commitTab = useEventCallback((next: LibraryTabIdV2, focusAfterCommit = false) => {
    if (busy || next === activeTab || !tabs.some((tab) => tab.id === next)) return;
    const proceed = () => {
      setActiveTab(next);
      onTabChange?.(next);
      if (focusAfterCommit) {
        window.requestAnimationFrame(() => tabRefs.current[next]?.focus());
      }
    };
    if (navigationGuard) navigationGuard({ from: activeTab, kind: "tab", to: next }, proceed);
    else proceed();
  });

  useEffect(() => {
    if (previousInitialTab.current === initialTab) return;
    previousInitialTab.current = initialTab;
    if (controlledTab === undefined) commitTab(initialTab);
  }, [commitTab, controlledTab, initialTab]);

  const requestExit = () => {
    if (busy) return;
    if (navigationGuard) navigationGuard({ from: activeTab, kind: "exit" }, onBack);
    else onBack();
  };

  // The selected section's tab and the crumb root both mean "back to the
  // list" while a sub-view is open (issue #31). The sub-view's own onBack
  // owns any unsaved-changes confirmation, so this bypasses navigationGuard.
  const leaveSubview = () => {
    if (!subview || busy || subview.busy) return;
    subview.onBack();
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    id: LibraryTabIdV2
  ) => {
    const index = availableTabs.indexOf(id);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % availableTabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + availableTabs.length) % availableTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = availableTabs.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = availableTabs[nextIndex];
    commitTab(next, true);
  };

  if (!selected) return null;

  return (
    <main className="v2-library" data-testid="library-v2">
      <UiV2IconSprite />
      {/* In the shell the header splits into the crumb row (right column) and
          the section column (left); below 768px it stacks as before. */}
      <header className="v2-library-header">
        <div className="v2-library-heading-row">
          <nav className="v2-library-crumb" aria-label="Studio location" data-subview={subview ? "true" : undefined}>
            {subview ? (
              <>
                <button
                  className="v2-library-crumb-root v2-focusable"
                  disabled={busy || subview.busy}
                  type="button"
                  onClick={leaveSubview}
                >
                  {selected.label}
                </button>
                {[...(subview.trail ?? []), subview.label].map((part, index, parts) => (
                  <Fragment key={`${part}:${index}`}>
                    <span aria-hidden="true"> / </span>
                    {index === parts.length - 1 ? <strong>{part}</strong> : <span>{part}</span>}
                  </Fragment>
                ))}
              </>
            ) : <strong>{selected.label}</strong>}
          </nav>
          {subview ? (
            <UiV2Button ref={backRef} disabled={busy || subview.busy} icon="arrow-left" onClick={subview.onBack}>
              {subview.backLabel}
            </UiV2Button>
          ) : (
            <UiV2Button disabled={busy} icon="arrow-left" onClick={requestExit}>Back to chat</UiV2Button>
          )}
        </div>
        <div ref={tabListRef} className="v2-library-tabs-scroll" role="tablist" aria-label="Studio sections">
          <p className="v2-library-column-title" aria-hidden="true">Studio</p>
          <div className="v2-library-tabs" role="presentation">
            {groups.map((group, groupIndex) => (
              <div className="v2-library-tabs-group" key={group.label ?? "defaults"} role="presentation">
                {group.label ? <p className="v2-library-column-label" aria-hidden="true">{group.label}</p>
                  : groupIndex > 0 ? <span className="v2-library-tabs-divider" aria-hidden="true" /> : null}
                {group.tabs.map((tab) => (
                  <Fragment key={tab.id}>
                    <button
                      ref={(node) => { tabRefs.current[tab.id] = node; }}
                      aria-controls={`v2-library-panel-${tab.id}`}
                      aria-describedby={tab.attention ? `v2-library-tab-${tab.id}-attention` : undefined}
                      aria-selected={tab.id === selected.id}
                      className="v2-library-tab v2-focusable"
                      data-selected={tab.id === selected.id || undefined}
                      disabled={busy}
                      id={`v2-library-tab-${tab.id}`}
                      role="tab"
                      tabIndex={tab.id === selected.id ? 0 : -1}
                      type="button"
                      onClick={() => (tab.id === selected.id ? leaveSubview() : commitTab(tab.id))}
                      onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                    >
                      <UiV2Icon name={tabIcons[tab.id]} />
                      <span>{tab.label}</span>
                      {tab.attention ? <span aria-hidden="true" className="v2-library-tab-signal" data-signal="attention" /> : null}
                    </button>
                    {/* A description, not a name suffix, keeps the section name stable for navigation. */}
                    {tab.attention ? <span hidden id={`v2-library-tab-${tab.id}-attention`}>Needs attention</span> : null}
                  </Fragment>
                ))}
              </div>
            ))}
          </div>
        </div>
      </header>
      <section
        aria-labelledby={`v2-library-tab-${selected.id}`}
        className="v2-library-panel"
        data-artifact-viewer={selected.id === "artifacts" && Boolean(subview) || undefined}
        data-instructions-editor={selected.id === "instructions" && subviewKey?.startsWith("instruction-editor-") || undefined}
        data-library-tab={selected.id}
        id={`v2-library-panel-${selected.id}`}
        key={selected.id}
        role="tabpanel"
        tabIndex={0}
      >
        <div className="v2-library-content">{selected.content}</div>
      </section>
    </main>
  );
}

export function SectionHeading({
  action,
  children,
  description,
  meta,
  search
}: Readonly<{
  action?: ReactNode;
  children: ReactNode;
  description: string;
  meta?: ReactNode;
  search?: ReactNode;
}>) {
  return (
    <header className="v2-resource-heading">
      <div>
        <h2>{children}</h2>
        {meta}
        <p>{description}</p>
      </div>
      {action || search ? (
        <div className="v2-resource-heading-action">
          {search}
          {action}
        </div>
      ) : null}
    </header>
  );
}

type KnowledgeFilterV2 = "all" | "archived" | "shared" | "trash" | "yours";

const knowledgeFilterLabels: Record<KnowledgeFilterV2, string> = {
  all: "All",
  archived: "Archived",
  shared: "Shared",
  trash: "Trash",
  yours: "Yours"
};

function knowledgeFilterMatch(base: KnowledgeSummaryV2, filter: KnowledgeFilterV2): boolean {
  const trashed = base.trashed ?? base.status === "trashed";
  const archived = base.archived ?? base.status === "archived";
  if (filter === "trash") return trashed;
  if (filter === "archived") return archived && !trashed;
  if (archived || trashed) return false;
  if (filter === "yours") return base.owned;
  if (filter === "shared") return !base.owned;
  return true;
}

function KnowledgeCardV2({
  base,
  onArchiveToggle,
  onOpen
}: Readonly<{
  base: KnowledgeSummaryV2;
  onArchiveToggle?(id: string, archived: boolean): void;
  onOpen?(id: string): void;
}>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: () => setMenuOpen(false),
    open: menuOpen
  });
  const trashed = base.trashed ?? base.status === "trashed";
  const archived = base.archived ?? base.status === "archived";
  const lifecycle = trashed
    ? base.purgeScheduledAt ? `Purge scheduled ${base.purgeScheduledAt}` : "In Trash"
    : base.updatedLabel ? `Updated ${base.updatedLabel}` : null;
  return (
    <li className="v2-knowledge-card" data-status={base.status}>
      <button
        aria-label={`Open ${base.name}`}
        className="v2-knowledge-card-open v2-focusable"
        type="button"
        onClick={() => onOpen?.(base.id)}
      >
        <span className="v2-knowledge-card-icon" aria-hidden="true"><UiV2Icon name={trashed ? "trash" : "book"} /></span>
        <span className="v2-knowledge-card-copy">
          <strong>{base.name}</strong>
          <small>{base.owned ? "Yours" : `Shared by ${base.sharedBy ?? "its owner"}`}</small>
          {base.description ? <span>{base.description}</span> : null}
          <span className="v2-knowledge-card-meta">
            {base.sourceCount} {base.sourceCount === 1 ? "document" : "documents"}
            {lifecycle ? ` · ${lifecycle}` : ""}
          </span>
        </span>
        <span className="v2-knowledge-status" data-tone={base.status === "ready" ? "ok" : base.status === "needs_attention" || base.status === "unavailable" ? "danger" : base.status === "processing" ? "live" : "neutral"}>
          {base.readinessLabel ?? knowledgeAggregateStatus({ state: base.status }).label}
        </span>
      </button>
      {base.owned && !trashed ? (
        <span className="v2-knowledge-card-menu">
          <UiV2IconButton
            ref={triggerRef}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            icon="more"
            label={`More actions for ${base.name}`}
            onClick={() => setMenuOpen((open) => !open)}
          />
          {menuOpen ? (
            <UiV2ResponsiveMenu
              anchorRef={triggerRef}
              label={`Actions for ${base.name}`}
              menuRef={menuRef}
              onClose={() => setMenuOpen(false)}
            >
              <UiV2MenuItem icon={archived ? "regenerate" : "archive"} onClick={() => {
                setMenuOpen(false);
                onArchiveToggle?.(base.id, !archived);
              }}>
                {archived ? "Restore" : "Archive"}
              </UiV2MenuItem>
            </UiV2ResponsiveMenu>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

export function KnowledgePanelV2({
  bases,
  canCreate = true,
  error,
  filter = "all",
  loadState = "ready",
  onArchiveToggle,
  onBrowseSources,
  onCreate,
  onFilterChange,
  onOpen,
  onQueryChange,
  onRetry,
  query = ""
}: Readonly<{
  bases: readonly KnowledgeSummaryV2[];
  /** False while the installation cannot create or reprocess Knowledge. */
  canCreate?: boolean;
  error?: string | null;
  filter?: KnowledgeFilterV2;
  loadState?: "error" | "loading" | "ready";
  onArchiveToggle?(id: string, archived: boolean): void;
  onBrowseSources?(): void;
  onCreate?(): void;
  onFilterChange?(filter: KnowledgeFilterV2): void;
  onOpen?(id: string): void;
  onQueryChange?(query: string): void;
  onRetry?(): void;
  query?: string;
}>) {
  const counts = Object.fromEntries(
    (Object.keys(knowledgeFilterLabels) as KnowledgeFilterV2[]).map((candidate) => [
      candidate,
      bases.filter((base) => knowledgeFilterMatch(base, candidate)).length
    ])
  ) as Record<KnowledgeFilterV2, number>;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleBases = bases.filter((base) => knowledgeFilterMatch(base, filter)).filter((base) =>
    !normalizedQuery || [base.name, base.description, base.sharedBy ?? ""]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  );
  return (
    <div data-testid="library-knowledge-panel">
      <SectionHeading
        action={(
          <>
            <UiV2Button onClick={onBrowseSources}>All documents</UiV2Button>
            <UiV2Button disabled={!canCreate} icon="plus" tone="primary" onClick={onCreate}>New base</UiV2Button>
          </>
        )}
        description="A base is a set of documents an answer may read. Pick one in the composer, in a project or in an assistant."
        search={(
          <label className="v2-resource-search">
            <span className="v2-sr-only">Search bases</span>
            <UiV2Icon name="search" />
            <input
              aria-label="Search bases"
              placeholder="Search bases…"
              type="search"
              value={query}
              onChange={(event) => onQueryChange?.(event.currentTarget.value)}
            />
          </label>
        )}
      >
        Knowledge
      </SectionHeading>
      <div aria-label="Knowledge filter" className="v2-resource-filters" role="group">
        {(Object.keys(knowledgeFilterLabels) as KnowledgeFilterV2[]).map((candidate) => (
          <button
            aria-pressed={filter === candidate}
            className="v2-resource-filter v2-focusable"
            data-selected={filter === candidate || undefined}
            key={candidate}
            type="button"
            onClick={() => onFilterChange?.(candidate)}
          >
            {knowledgeFilterLabels[candidate]}{candidate === "trash" && counts[candidate] === 0 ? "" : ` ${counts[candidate]}`}
          </button>
        ))}
      </div>
      {!canCreate ? (
        <div className="v2-memory-disabled" role="status">
          <strong>Knowledge is temporarily unavailable</strong>
          You can still open existing bases. Contact your administrator before creating or reprocessing content.
        </div>
      ) : null}
      {loadState === "loading" && bases.length === 0 ? (
        <p className="v2-resource-empty" role="status">Loading knowledge…</p>
      ) : loadState === "error" && bases.length === 0 ? (
        <div className="v2-resource-empty" role="alert">
          <p>{error || "Knowledge could not be loaded."}</p>
          <UiV2Button onClick={onRetry}>Retry</UiV2Button>
        </div>
      ) : visibleBases.length ? (
        <ul className="v2-knowledge-card-grid" aria-label="Knowledge bases">
          {visibleBases.map((base) => (
            <KnowledgeCardV2
              base={base}
              key={base.id}
              onArchiveToggle={onArchiveToggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : (
        <p className="v2-resource-empty">
          {normalizedQuery ? `No bases match “${query.trim()}”.`
            : filter === "trash" ? "Trash is empty."
              : filter === "shared" ? "Nothing shared with you yet."
                : filter === "archived" ? "No archived bases."
                  : filter === "yours" ? "You have no active bases yet."
                    : "No knowledge bases yet."}
        </p>
      )}
      <p className="v2-library-disclosure v2-knowledge-privacy">
        <UiV2Icon name="lock" /> Documents are private. Sharing a base is a separate, explicit step.
      </p>
    </div>
  );
}

const fileStatusLabel: Record<FileSummaryV2["status"], string> = {
  failed: "Failed",
  processing: "Processing…",
  ready: "Ready"
};

export function FilesPanelV2({
  complete = true,
  files,
  loadState = "ready",
  onRetry,
  onOpen,
  onSave,
  onRemove,
  onUse,
  onLoadMore,
  useDisabled = false
}: Readonly<{
  complete?: boolean;
  files: readonly FileSummaryV2[];
  loadState?: "error" | "idle" | "loading" | "ready";
  onOpen?(id: string): void;
  onRetry?(): void;
  onSave?(id: string): void;
  onRemove?(id: string): void;
  onUse?(id: string): void;
  useDisabled?: boolean;
  onLoadMore?(): void;
}>) {
  const [filter, setFilter] = useState<"all" | "saved" | "recent">("all");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<{ id: string; group: string } | null>(null);
  const [compact, setCompact] = useState(true);
  const layoutRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const viewRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastSelectedId = useRef<string | null>(null);
  useEffect(() => {
    const node = layoutRef.current;
    if (!node) return;
    // The complete workspace to the right of the section column: list + dock.
    const measure = () => setCompact(node.getBoundingClientRect().width < 1040);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const normalizedQuery = query.trim().toLowerCase();
  const counts = {
    all: files.length,
    saved: files.filter(file => file.savedAt !== null).length,
    recent: files.filter(file => file.savedAt === null).length
  };
  const groups = groupLibraryFiles(files).filter(group =>
    filter === "all" || (filter === "saved" ? group.saved : !group.saved)
  ).map(group => ({
    ...group,
    visible: group.files.filter(file => !normalizedQuery ||
      [file.name, file.chatTitle ?? ""].some(value => value.toLowerCase().includes(normalizedQuery)))
  })).filter(group => group.visible.length);
  const selectedGroup = groups.find(group => group.key === selection?.group);
  const previewable = selectedGroup?.visible.filter(canPreviewFile) ?? [];
  const selectedFile = previewable.find(file => file.id === selection?.id);
  if (selection && !selectedFile) setSelection(null);
  useEffect(() => {
    const previousId = lastSelectedId.current;
    lastSelectedId.current = selection?.id ?? null;
    if (previousId && !selection) {
      const frame = requestAnimationFrame(() => {
        (viewRefs.current.get(previousId) ?? searchRef.current)?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [selection]);
  function closePreview() { setSelection(null); }
  return (
    <div className="v2-files-layout" data-testid="library-files-panel" ref={layoutRef}
      data-preview-docked={selectedFile && !compact || undefined} onKeyDown={event => {
        if (selectedFile && event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closePreview(); }
      }}>
    <div className="v2-files-list"><div className="v2-files-list-content">
      <SectionHeading description="Save files to use them in another chat. Files are private and visible only to you.">
        Files
      </SectionHeading>
      <div className="v2-file-toolbar">
        <div aria-label="Filter files" className="v2-resource-filters" role="group">
          {(["all", "saved", "recent"] as const).map(candidate => (
            <button aria-pressed={filter === candidate} className="v2-resource-filter v2-focusable"
              data-selected={filter === candidate || undefined} key={candidate} type="button"
              onClick={() => setFilter(candidate)}>
              {candidate === "all" ? "All" : candidate === "saved" ? "Saved" : "From chats"}
              {complete && loadState === "ready" ? ` ${counts[candidate]}` : ""}
            </button>
          ))}
        </div>
        <label className="v2-resource-search">
          <UiV2Icon name="search" />
          <input aria-label="Search files" placeholder="Search files…" type="search" value={query} ref={searchRef}
            onChange={event => setQuery(event.currentTarget.value)} />
        </label>
      </div>
      {loadState === "error" && files.length > 0 ? (
        <p role="alert">Files could not be refreshed. <UiV2Button onClick={onRetry}>Retry</UiV2Button></p>
      ) : null}
      {(loadState === "loading" || loadState === "idle") && files.length === 0 ? (
        <p className="v2-resource-empty" role="status">Loading files…</p>
      ) : loadState === "error" && files.length === 0 ? (
        <div className="v2-resource-empty" role="alert">
          <p>Files could not be loaded.</p>
          <UiV2Button onClick={onRetry}>Retry</UiV2Button>
        </div>
      ) : groups.length ? groups.map(group => {
        const latest = group.files[0];
        const chatFile = group.files.find(file => file.canOpenChat);
        const names = new Map<string, number>();
        for (const file of group.files) names.set(file.name, (names.get(file.name) ?? 0) + 1);
        return <section className="v2-file-group" key={group.key} aria-label={group.saved ? "Saved files" : `Files from ${latest.chatTitle ?? "chat"}`}>
          <div className="v2-file-group-heading">
            <h3>{group.saved ? <>Saved · {group.visible.length} {group.visible.length === 1 ? "file" : "files"}</>
              : <>From chat · <strong>{latest.chatTitle ?? "Chat unavailable"}</strong> · {formatStudioDate(latest.createdAt)}</>}</h3>
            {!group.saved ? <UiV2Button disabled={!chatFile || !onOpen} icon="external" onClick={() => chatFile && onOpen?.(chatFile.id)}>Open chat</UiV2Button> : null}
          </div>
          <ul className="v2-resource-list" aria-label={group.saved ? "Saved files" : `Files from ${latest.chatTitle ?? "chat"}`}>
            {group.visible.map(file => <FileRowV2 file={file} key={file.id} repeatedName={(names.get(file.name) ?? 0) > 1}
              onOpen={onOpen} onSave={onSave} onRemove={onRemove} onUse={onUse} useDisabled={useDisabled}
              selected={selectedFile?.id === file.id} onView={() => setSelection({ id: file.id, group: group.key })}
              viewRef={node => { if (node) viewRefs.current.set(file.id, node); else viewRefs.current.delete(file.id); }} />)}
          </ul>
        </section>;
      }) : <p className="v2-resource-empty">{normalizedQuery ? `No loaded files match “${query.trim()}”.`
        : filter === "saved" ? "No saved files yet." : "No files yet."}</p>}
      {onLoadMore ? <div className="v2-file-pagination">
        {normalizedQuery && !complete ? <span>Searching {files.length} loaded files.</span> : null}
        <UiV2Button disabled={loadState === "loading"} onClick={onLoadMore}>Load more files</UiV2Button>
      </div> : null}
    </div></div>
    {selectedFile && selectedGroup ? <FilePreviewV2 compact={compact} file={selectedFile} group={previewable}
      saved={selectedGroup.saved} onClose={closePreview} onSelect={id => setSelection({ id, group: selectedGroup.key })}
      onOpen={onOpen} onUse={onUse} useDisabled={useDisabled} /> : null}
    </div>
  );
}

function FileRowV2({
  file,
  repeatedName,
  onOpen,
  onSave,
  onRemove,
  onUse,
  useDisabled,
  selected,
  onView,
  viewRef
}: Readonly<{
  file: FileSummaryV2;
  repeatedName: boolean;
  onOpen?(id: string): void;
  onSave?(id: string): void;
  onRemove?(id: string): void;
  onUse?(id: string): void;
  useDisabled: boolean;
  selected: boolean;
  onView(): void;
  viewRef(node: HTMLButtonElement | null): void;
}>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: () => setMenuOpen(false),
    open: menuOpen
  });
  return (
    <li className="v2-resource-row v2-file-row" data-selected={selected || undefined}>
      <FileTypeTileV2 file={file} thumbnail />
      <div className="v2-resource-row-main">
        <div className="v2-resource-row-title">
          <h3 title={file.name}>{file.name}</h3>
          {file.status !== "ready" ? <span data-status={file.status}>{fileStatusLabel[file.status]}</span> : null}
        </div>
        <p>{fileTypeLabel(file.name)} · {formatAttachmentBytes(file.byteSize)}
          {file.savedAt ? ` · Saved ${formatStudioDate(file.savedAt)}` : ""}
          {repeatedName ? ` · ${formatStudioTime(file.savedAt ?? file.createdAt)}` : ""}</p>
        {file.status === "failed" ? (
          <p className="v2-file-failure">Text processing failed. You can still download the file or use it in Workspace.</p>
        ) : null}
        {file.mutation === "error" ? <p role="alert">The file action failed. Try again.</p> : null}
      </div>
      <span className="v2-file-row-actions">
      {onUse ? <UiV2Button disabled={useDisabled} onClick={() => onUse(file.id)}>Use in chat</UiV2Button> : null}
      {canPreviewFile(file) ? <UiV2IconButton icon="eye" label={`View ${file.name}`} onClick={onView} ref={viewRef} /> : null}
      {file.status === "ready" ? <a aria-label={`Download ${file.name}`} className="v2-icon-button v2-focusable" download href={attachmentDownloadHref(file.id)} title={`Download ${file.name}`}><UiV2Icon name="download" /></a> : null}
      <span className="v2-file-actions-menu">
        <UiV2IconButton
          ref={triggerRef}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          icon="more"
          label={`More actions for ${file.name}`}
          onClick={() => setMenuOpen((open) => !open)}
        />
        {menuOpen ? (
          <UiV2ResponsiveMenu
            anchorRef={triggerRef}
            label={`Actions for ${file.name}`}
            menuRef={menuRef}
            onClose={() => setMenuOpen(false)}
          >
            {!file.savedAt ? <UiV2MenuItem
              disabled={!onOpen || !file.canOpenChat}
              icon="chat"
              onClick={() => {
                setMenuOpen(false);
                onOpen?.(file.id);
              }}
            >
              Open in chat
            </UiV2MenuItem> : null}
            {file.savedAt ? (
              <UiV2MenuItem
                disabled={!onRemove || file.mutation === "removing"}
                onClick={() => { setMenuOpen(false); onRemove?.(file.id); }}
              >Remove from saved</UiV2MenuItem>
            ) : (
              <UiV2MenuItem
                disabled={!onSave || file.mutation === "saving" || file.mutation === "saved"}
                onClick={() => { setMenuOpen(false); onSave?.(file.id); }}
              >{file.mutation === "saved" ? "Saved" : "Save file"}</UiV2MenuItem>
            )}
          </UiV2ResponsiveMenu>
        ) : null}
      </span>
      </span>
    </li>
  );
}

/** The Memory page owns the saved-memory list and row-level CRUD. */
export function MemoryPanelV2({
  activeRef,
  busy,
  draft,
  hasMore,
  items,
  listError,
  listState,
  memory,
  mutationError,
  mutationOutcomeUnknown = false,
  notice,
  onCancelRow,
  onConfirmForget,
  onCreate,
  onDraftChange,
  onEdit,
  onForget,
  onLoadMore,
  settingsContent,
  resetPending = false,
  onQueryChange,
  onRetry,
  onSave,
  onSubmitQuery,
  query,
  searchActive,
  rowMode
}: Readonly<{
  activeRef: string | null;
  busy: "forgetting" | "saving" | null;
  draft: string;
  hasMore: boolean;
  items: readonly MemoryConsumerItem[];
  listError: string | null;
  listState: "error" | "idle" | "loading" | "ready";
  memory: MemoryOverviewV2;
  mutationError: string | null;
  mutationOutcomeUnknown?: boolean;
  notice: string | null;
  onCancelRow(): void;
  onConfirmForget(): void;
  onCreate(): void;
  onDraftChange(value: string): void;
  onEdit(memoryRef: string): void;
  onForget(memoryRef: string): void;
  onLoadMore(): void;
  settingsContent?: ReactNode;
  resetPending?: boolean;
  onQueryChange(value: string): void;
  onRetry?(): void;
  onSave(): void;
  onSubmitQuery(): void;
  query: string;
  searchActive: boolean;
  rowMode: "create" | "edit" | "forget" | null;
}>) {
  // The last known status stays visible during refreshes. Unavailability and
  // load failures show no status at all; the data and controls stay usable.
  const loading = memory.status === null && memory.loadState !== "error";
  const statusLabel = memory.status === "ON"
    ? mt("library.statusOn")
    : memory.status === "PREPARING"
      ? mt("library.statusPreparing")
      : memory.status === "NEEDS_ADMIN_SETUP"
        ? mt("library.statusNeedsSetup")
        : memory.status === "PAUSED"
          ? mt("library.statusPaused")
          : loading ? mt("settings.loading") : null;
  const statusDescription = memory.status === "ON"
    ? mt("library.onDescription")
    : memory.status === "PREPARING"
      ? mt("library.preparingDescription")
      : memory.status === "NEEDS_ADMIN_SETUP"
        ? memory.disabledReason ?? mt("library.needsSetupDescription")
        : memory.status === "PAUSED"
          ? mt("library.pausedDescription")
          : loading ? mt("library.loadingDescription") : null;
  const groups = useMemo(() => MEMORY_CONSUMER_CATEGORIES.flatMap((category) => {
    const groupedItems = items.filter((item) => item.category === category);
    return groupedItems.length ? [{ category, items: groupedItems }] : [];
  }), [items]);
  const initialLoading = (listState === "idle" || listState === "loading") && items.length === 0;
  const initialError = (listState === "error" || Boolean(listError)) && items.length === 0;
  const empty = listState === "ready" && items.length === 0 && rowMode !== "create";
  const longFactPresent = items.some((item) => item.statement.length > 240);
  const summary = memory.status === "ON" && memory.automaticLearning
    ? "Learning from your ordinary chats"
    : memory.status === "PAUSED"
      ? "Answers do not read these facts. Nothing was deleted."
      : statusDescription;
  const listControlsDisabled = resetPending || busy !== null || rowMode !== null;
  const note = longFactPresent
    ? { icon: "alert" as const, text: mt("library.longFactDescription") }
    : memory.status === "PAUSED"
      ? { icon: "alert" as const, text: mt("library.pausedManagementDescription") }
      : null;
  const saveDisabled = busy !== null || mutationOutcomeUnknown || draft.trim().length === 0 ||
    draft.length > MEMORY_CONSUMER_STATEMENT_MAX_LENGTH;

  return (
    <div data-testid="library-memory-panel">
      <SectionHeading
        action={(
          <>
            <UiV2Button
              disabled={!memory.explicitCrudAvailable || mutationOutcomeUnknown || listControlsDisabled || listState === "loading"}
              icon="plus"
              tone="primary"
              onClick={onCreate}
            >
              Add memory
            </UiV2Button>
          </>
        )}
        description={mt("library.description")}
        meta={statusLabel ? <span className="v2-memory-mobile-status" role="status">{statusLabel}</span> : undefined}
      >
        {mt("settings.heading")}
      </SectionHeading>
      <div className="v2-memory-layout" data-with-settings={Boolean(settingsContent) || undefined}>
      {settingsContent ? <MemorySettingsCardV2 status={statusLabel ?? ""}>{settingsContent}</MemorySettingsCardV2> : null}
      <div className="v2-memory-main">
      {resetPending ? <p className="v2-resource-empty" role="status">{mt("settings.resetStarted")}</p> : <>
      <div className="v2-memory-toolbar">
        {statusLabel ? (
          <span className="v2-memory-state" data-tone={memory.status === "ON" ? "ok" : "off"}>
            <UiV2Icon name={memory.status === "ON" ? "check" : "memory"} />
            {statusLabel}
          </span>
        ) : null}
        {summary ? <p>{summary}</p> : null}
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (!listControlsDisabled) onSubmitQuery();
          }}
        >
          <label className="v2-resource-search">
            <UiV2Icon name="search" />
            <input
              aria-label="Search memories"
              disabled={listControlsDisabled}
              maxLength={MEMORY_CONSUMER_QUERY_MAX_LENGTH}
              placeholder={mt("manager.searchPlaceholder")}
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </label>
        </form>
      </div>

      {notice ? <p className="v2-memory-notice" role="status">{notice}</p> : null}
      {mutationError ? <p className="v2-memory-error" role="alert">{mutationError}</p> : null}
      {rowMode === "create" ? (
        <ul className="v2-memory-list v2-memory-create" aria-label="New memory">
          <MemoryDraftRowV2
            busy={busy}
            draft={draft}
            saveDisabled={saveDisabled}
            onCancel={onCancelRow}
            onChange={onDraftChange}
            onSave={onSave}
          />
        </ul>
      ) : null}
      {initialLoading ? <p className="v2-resource-empty" role="status">{mt("manager.loading")}</p> : null}
      {initialError ? (
        <div className="v2-resource-empty" data-testid="memory-list-reload">
          <p>{mt("manager.reloadHint")}</p>
          <UiV2Button disabled={listControlsDisabled} onClick={onRetry}>{mt("manager.reload")}</UiV2Button>
        </div>
      ) : null}
      {empty ? (
        searchActive ? (
          <p className="v2-resource-empty">{mt("manager.noResults")}</p>
        ) : (
          <div className="v2-memory-empty">
            <span aria-hidden="true"><UiV2Icon name="memory" /></span>
            <strong>{mt("manager.empty")}</strong>
            <p>{mt("manager.emptyDescription")}</p>
            <UiV2Button
              disabled={!memory.explicitCrudAvailable || mutationOutcomeUnknown}
              icon="plus"
              tone="primary"
              onClick={onCreate}
            >
              {mt("manager.new")}
            </UiV2Button>
          </div>
        )
      ) : null}
      {groups.map((group) => (
        <section className="v2-memory-group" key={group.category}>
          <h3 aria-label={!hasMore ? `${memoryCategoryLabel(group.category)} ${group.items.length}` : undefined}>
            {memoryCategoryLabel(group.category)}
            {!hasMore ? <span>{group.items.length}</span> : null}
          </h3>
          <ul className="v2-memory-list" aria-label={`${memoryCategoryLabel(group.category)} memories`}>
            {group.items.map((item) => {
              if (activeRef === item.memoryRef && rowMode === "edit") {
                return (
                  <MemoryDraftRowV2
                    busy={busy}
                    draft={draft}
                    item={item}
                    key={item.memoryRef}
                    saveDisabled={saveDisabled}
                    onCancel={onCancelRow}
                    onChange={onDraftChange}
                    onSave={onSave}
                  />
                );
              }
              if (activeRef === item.memoryRef && rowMode === "forget") {
                return (
                  <MemoryForgetRowV2
                    busy={busy === "forgetting"}
                    disabled={mutationOutcomeUnknown}
                    item={item}
                    key={item.memoryRef}
                    onCancel={onCancelRow}
                    onConfirm={onConfirmForget}
                  />
                );
              }
              return (
                <MemoryListRowV2
                  disabled={!memory.explicitCrudAvailable || mutationOutcomeUnknown || listControlsDisabled || listState === "loading"}
                  item={item}
                  key={item.memoryRef}
                  onEdit={onEdit}
                  onForget={onForget}
                />
              );
            })}
          </ul>
        </section>
      ))}
      {hasMore ? (
        <div className="v2-memory-load-more">
          <UiV2Button busy={listState === "loading"} disabled={listControlsDisabled} onClick={onLoadMore}>
            {mt("manager.loadMore")}
          </UiV2Button>
        </div>
      ) : null}
      </>}
      {note ? <p className="v2-library-note">
        <UiV2Icon name={note.icon} />
        <span>{note.text}</span>
      </p> : null}
      <p className="v2-library-note">
        <UiV2Icon name="lock" />
        <span>{mt("library.temporaryDescription")}</span>
      </p>
      </div>
      </div>
    </div>
  );
}

function MemoryListRowV2({
  disabled,
  item,
  onEdit,
  onForget
}: Readonly<{
  disabled: boolean;
  item: MemoryConsumerItem;
  onEdit(memoryRef: string): void;
  onForget(memoryRef: string): void;
}>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: () => setMenuOpen(false),
    open: menuOpen
  });
  const canEdit = item.allowedActions.includes("EDIT");
  const canForget = item.allowedActions.includes("FORGET");
  const actions = [
    ...(canEdit ? [{ icon: "edit" as const, label: mt("manager.edit"), onSelect: () => onEdit(item.memoryRef) }] : []),
    ...(canForget ? [{
      icon: "trash" as const,
      label: mt("manager.forget"),
      onSelect: () => onForget(item.memoryRef),
      separatorBefore: canEdit,
      tone: "destructive" as const
    }] : [])
  ];
  return (
    <li className="v2-memory-row">
      <span className="v2-memory-row-icon" aria-hidden="true"><UiV2Icon name="memory" /></span>
      <div className="v2-memory-row-copy">
        <p data-expanded={expanded || undefined}>{item.statement}</p>
        {item.statement.length > 240 ? (
          <button
            aria-expanded={expanded}
            className="v2-memory-expand v2-focusable"
            type="button"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : `Show all ${item.statement.length} characters`}
          </button>
        ) : null}
        <small>
          {item.provenance === "SAVED" ? mt("manager.savedByYou") : mt("manager.learnedFromChat")}
          {` · ${formatStudioDate(item.updatedAt)}`}
        </small>
      </div>
      <div className="v2-memory-row-actions">
        {canEdit ? (
          <UiV2Button
            className="v2-memory-row-edit"
            disabled={disabled}
            icon="edit"
            onClick={() => onEdit(item.memoryRef)}
          >
            {mt("manager.edit")}
          </UiV2Button>
        ) : null}
        {actions.length ? (
          <span className="v2-memory-menu-wrap">
            <UiV2IconButton
              ref={triggerRef}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              icon="more"
              label={`Memory actions: ${item.statement}`}
              disabled={disabled}
              onClick={() => setMenuOpen((open) => !open)}
            />
            {menuOpen ? (
              <UiV2MenuSurface ref={menuRef} className="v2-memory-menu" label={`Actions for ${item.statement}`}>
                <UiV2MenuActions actions={actions} onClose={() => setMenuOpen(false)} />
              </UiV2MenuSurface>
            ) : null}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function MemoryDraftRowV2({
  busy,
  draft,
  item,
  onCancel,
  onChange,
  onSave,
  saveDisabled
}: Readonly<{
  busy: "forgetting" | "saving" | null;
  draft: string;
  item?: MemoryConsumerItem;
  onCancel(): void;
  onChange(value: string): void;
  onSave(): void;
  saveDisabled: boolean;
}>) {
  const fieldId = useId();
  const label = item ? `Edit ${item.statement}` : "New memory";
  return (
    <li className="v2-memory-row v2-memory-row-draft" data-state={item ? "edit" : "create"}>
      <span className="v2-memory-row-icon" aria-hidden="true"><UiV2Icon name="edit" /></span>
      <form
        className="v2-memory-row-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saveDisabled) onSave();
        }}
      >
        <label className="v2-sr-only" htmlFor={fieldId}>{label}</label>
        <textarea
          autoFocus
          id={fieldId}
          maxLength={MEMORY_CONSUMER_STATEMENT_MAX_LENGTH}
          value={draft}
          onChange={(event) => onChange(event.target.value)}
        />
        <div className="v2-memory-row-form-actions">
          <UiV2Button busy={busy === "saving"} disabled={saveDisabled} tone="primary" type="submit">
            {item ? mt("manager.saveChanges") : mt("manager.saveNew")}
          </UiV2Button>
          <UiV2Button disabled={busy !== null} type="button" onClick={onCancel}>{mt("manager.cancel")}</UiV2Button>
          <span>{draft.length} / {MEMORY_CONSUMER_STATEMENT_MAX_LENGTH}</span>
        </div>
        <small>{mt("manager.statementHelp")}</small>
        {!item ? <small>{mt("manager.formAutomaticClassification")}</small> : null}
      </form>
    </li>
  );
}

function MemoryForgetRowV2({
  busy,
  disabled,
  item,
  onCancel,
  onConfirm
}: Readonly<{
  busy: boolean;
  disabled: boolean;
  item: MemoryConsumerItem;
  onCancel(): void;
  onConfirm(): void;
}>) {
  const target = item.statement.length > 96 ? `${item.statement.slice(0, 93)}…` : item.statement;
  return (
    <li className="v2-memory-row v2-memory-row-forget" data-state="forget">
      <span className="v2-memory-row-icon" aria-hidden="true"><UiV2Icon name="trash" /></span>
      <div className="v2-memory-row-confirm" role="group" aria-label={`Forget ${target}?`}>
        <p>Forget “{target}”? Answers stop using it. This cannot be undone.</p>
        <div>
          <UiV2Button busy={busy} disabled={disabled} tone="destructive" onClick={onConfirm}>{mt("manager.forget")}</UiV2Button>
          <UiV2Button disabled={busy} onClick={onCancel}>{mt("manager.cancel")}</UiV2Button>
        </div>
      </div>
    </li>
  );
}
