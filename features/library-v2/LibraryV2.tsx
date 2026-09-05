"use client";

import {
  memoryCategoryLabel,
  memoryUiCopy
} from "@/components/app-shell/memoryUiCopy";
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
import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
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
  AssistantSummaryV2,
  FileSummaryV2,
  KnowledgeSummaryV2,
  LibraryNavigationGuardV2,
  LibrarySubviewV2,
  LibraryTabIdV2,
  LibraryTabV2,
  MemoryOverviewV2
} from "./contracts";

function mt(key: Parameters<typeof memoryUiCopy>[0]): string {
  return memoryUiCopy(key);
}

const tabOrder: readonly LibraryTabIdV2[] = ["assistants", "knowledge", "files", "memory", "skills"];
const tabIcons: Record<LibraryTabIdV2, UiV2IconName> = {
  assistants: "assistant",
  files: "file",
  knowledge: "book",
  memory: "memory",
  skills: "wand"
};

export function LibraryV2({
  initialTab = "assistants",
  navigationGuard,
  onBack,
  onTabChange,
  subview = null,
  tabs
}: Readonly<{
  initialTab?: LibraryTabIdV2;
  navigationGuard?: LibraryNavigationGuardV2;
  onBack(): void;
  onTabChange?(tab: LibraryTabIdV2): void;
  /** The resource sub-view open in the selected section, if any (A14). */
  subview?: LibrarySubviewV2 | null;
  tabs: readonly LibraryTabV2[];
}>) {
  const [activeTab, setActiveTab] = useState<LibraryTabIdV2>(initialTab);
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<LibraryTabIdV2, HTMLButtonElement | null>>>({});
  const backRef = useRef<HTMLButtonElement>(null);
  const previousSubviewKey = useRef<string | null>(null);
  const availableTabs = tabOrder.filter((id) => tabs.some((tab) => tab.id === id));
  const selected = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  const primaryTabs = tabs.filter((tab) => tab.id !== "skills");
  const skillsTab = tabs.find((tab) => tab.id === "skills");
  const subviewKey = subview?.key ?? null;
  const selectedId = selected?.id ?? null;

  // Entering a sub-view (or moving between two) focuses its Back control;
  // leaving it returns focus to the section tab so keyboard users stay in
  // the Library rather than on the document body.
  useEffect(() => {
    const previous = previousSubviewKey.current;
    previousSubviewKey.current = subviewKey;
    if (subviewKey && subviewKey !== previous) {
      backRef.current?.focus({ preventScroll: true });
    } else if (!subviewKey && previous && selectedId) {
      tabRefs.current[selectedId]?.focus({ preventScroll: true });
    }
  }, [selectedId, subviewKey]);

  // A deep-linked mobile section can start beyond the clipped edge of the
  // horizontal strip. Keep the selected tab in the unfaded viewport without
  // changing focus or introducing a second responsive state owner.
  useEffect(() => {
    if (!selectedId) return;
    const frame = window.requestAnimationFrame(() => {
      const tabList = tabListRef.current;
      const tab = tabRefs.current[selectedId];
      if (!tabList || !tab || tabList.scrollWidth <= tabList.clientWidth) return;
      tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId]);

  const commitTab = (next: LibraryTabIdV2, focusAfterCommit = false) => {
    if (next === activeTab || !tabs.some((tab) => tab.id === next)) return;
    const proceed = () => {
      setActiveTab(next);
      onTabChange?.(next);
      if (focusAfterCommit) {
        window.requestAnimationFrame(() => tabRefs.current[next]?.focus());
      }
    };
    if (navigationGuard) navigationGuard({ from: activeTab, kind: "tab", to: next }, proceed);
    else proceed();
  };

  const requestExit = () => {
    if (navigationGuard) navigationGuard({ from: activeTab, kind: "exit" }, onBack);
    else onBack();
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
          <nav className="v2-library-crumb" aria-label="Library location" data-subview={subview ? "true" : undefined}>
            <span>Library</span>
            <span aria-hidden="true"> / </span>
            {subview ? (
              <>
                <span>{selected.label}</span>
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
            <UiV2Button ref={backRef} disabled={subview.busy} icon="arrow-left" onClick={subview.onBack}>
              {subview.backLabel}
            </UiV2Button>
          ) : (
            <UiV2Button icon="chevron-right" onClick={requestExit}>Back to chat</UiV2Button>
          )}
        </div>
        <div ref={tabListRef} className="v2-library-tabs-scroll" role="tablist" aria-label="Library sections">
          <p className="v2-library-column-title" aria-hidden="true">Library</p>
          <div className="v2-library-tabs" role="presentation">
            {primaryTabs.map((tab) => (
              <button
                ref={(node) => { tabRefs.current[tab.id] = node; }}
                aria-controls={`v2-library-panel-${tab.id}`}
                aria-selected={tab.id === selected.id}
                className="v2-library-tab v2-focusable"
                data-selected={tab.id === selected.id || undefined}
                id={`v2-library-tab-${tab.id}`}
                key={tab.id}
                role="tab"
                tabIndex={tab.id === selected.id ? 0 : -1}
                type="button"
                onClick={() => commitTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
              >
                <UiV2Icon name={tabIcons[tab.id]} />
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
          {skillsTab ? (
            <div className="v2-library-tabs-group" role="presentation">
              <p className="v2-library-column-label">Skills</p>
              <button
                ref={(node) => { tabRefs.current.skills = node; }}
                aria-controls="v2-library-panel-skills"
                aria-selected={skillsTab.id === selected.id}
                className="v2-library-tab v2-focusable"
                data-selected={skillsTab.id === selected.id || undefined}
                id="v2-library-tab-skills"
                role="tab"
                tabIndex={skillsTab.id === selected.id ? 0 : -1}
                type="button"
                onClick={() => commitTab("skills")}
                onKeyDown={(event) => handleTabKeyDown(event, "skills")}
              >
                <UiV2Icon name={tabIcons.skills} />
                <span>{skillsTab.label}</span>
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <section
        aria-labelledby={`v2-library-tab-${selected.id}`}
        className="v2-library-panel"
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

function SectionHeading({
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

type AssistantFilterV2 = "all" | "archived" | "pinned" | "shared" | "yours";

const assistantFilterLabels: Record<AssistantFilterV2, string> = {
  all: "All",
  archived: "Archived",
  pinned: "Pinned",
  shared: "Shared",
  yours: "Yours"
};

function assistantMatchesFilter(assistant: AssistantSummaryV2, filter: AssistantFilterV2): boolean {
  switch (filter) {
    case "all": return true;
    case "archived": return assistant.archived;
    case "pinned": return Boolean(assistant.pinned) && !assistant.archived;
    case "shared": return !assistant.owned && !assistant.archived;
    case "yours": return assistant.owned && !assistant.archived;
  }
}

export function AssistantsPanelV2({
  assistants,
  error,
  loadState = "ready",
  onArchiveToggle,
  onCreate,
  onCreateFromCurrentSetup,
  onDuplicate,
  onOpen,
  onPinToggle,
  onRetry,
  onUnavailableAction,
  onUse
}: Readonly<{
  assistants: readonly AssistantSummaryV2[];
  error?: string | null;
  loadState?: "error" | "loading" | "ready";
  onArchiveToggle?(id: string, archived: boolean): void;
  onCreate?(): void;
  onCreateFromCurrentSetup?(): void;
  onDuplicate?(id: string): void;
  onOpen?(id: string): void;
  onPinToggle?(id: string, pinned: boolean): void;
  onRetry?(): void;
  onUnavailableAction?(id: string, action: "mcp-settings" | "open-editor"): void;
  onUse?(id: string): void;
}>) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AssistantFilterV2>("all");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const counts = useMemo(() => ({
    all: assistants.length,
    pinned: assistants.filter((assistant) => assistant.pinned && !assistant.archived).length,
    shared: assistants.filter((assistant) => !assistant.owned && !assistant.archived).length,
    yours: assistants.filter((assistant) => assistant.owned && !assistant.archived).length
  }), [assistants]);
  const visible = assistants.filter((assistant) =>
    assistantMatchesFilter(assistant, filter) && (
      !normalizedQuery ||
      assistant.name.toLocaleLowerCase().includes(normalizedQuery) ||
      assistant.description.toLocaleLowerCase().includes(normalizedQuery)
    )
  );
  const filters: readonly AssistantFilterV2[] = ["all", "pinned", "yours", "shared", "archived"];

  return (
    <div data-testid="library-assistants-panel">
      <SectionHeading
        action={<UiV2Button icon="plus" tone="primary" onClick={onCreate}>New assistant</UiV2Button>}
        description="A saved setup: instructions, a model and the tools it may use. Use puts it on your next message; the chat tells you it is on."
      >
        Assistants
      </SectionHeading>
      <div className="v2-assistant-toolbar">
        <div className="v2-resource-filters" role="group" aria-label="Filter assistants">
          {filters.map((candidate) => (
            <button
              aria-pressed={filter === candidate}
              className="v2-resource-filter v2-focusable"
              data-selected={filter === candidate || undefined}
              key={candidate}
              type="button"
              onClick={() => setFilter(candidate)}
            >
              {assistantFilterLabels[candidate]}
              {candidate !== "archived" && candidate in counts
                ? <span> {counts[candidate as keyof typeof counts]}</span>
                : null}
            </button>
          ))}
        </div>
        <label className="v2-resource-search">
          <UiV2Icon name="search" />
          <input
            aria-label="Search assistants"
            placeholder="Search assistants…"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {loadState === "loading" && assistants.length === 0 ? (
        <div className="v2-assistant-skeletons" aria-label="Loading assistants" role="status">
          {Array.from({ length: 6 }, (_, index) => (
            <span className="v2-assistant-skeleton" key={index} aria-hidden="true">
              <span /><span /><span /><span />
            </span>
          ))}
          <p><span className="v2-spinner" aria-hidden="true" />Loading your assistants…</p>
        </div>
      ) : loadState === "error" && assistants.length === 0 ? (
        <div className="v2-assistant-empty" data-state="error" role="alert">
          <span className="v2-assistant-empty-icon"><UiV2Icon name="alert" /></span>
          <h3>The list did not load</h3>
          <p>{error ?? "Nothing was changed. Your assistants are still there."}</p>
          <UiV2Button icon="regenerate" tone="primary" onClick={onRetry}>Try again</UiV2Button>
        </div>
      ) : visible.length ? (
        <ul className="v2-assistant-grid" aria-label="Assistants">
          {visible.map((assistant) => (
            <AssistantCardV2
              assistant={assistant}
              key={assistant.id}
              onArchiveToggle={onArchiveToggle}
              onDuplicate={onDuplicate}
              onOpen={onOpen}
              onPinToggle={onPinToggle}
              onUnavailableAction={onUnavailableAction}
              onUse={onUse}
            />
          ))}
        </ul>
      ) : assistants.length ? (
        <p className="v2-resource-empty">No assistants match this view.</p>
      ) : (
        <div className="v2-assistant-empty" data-state="empty">
          <span className="v2-assistant-empty-icon"><UiV2Icon name="assistant" /></span>
          <h3>No assistants yet</h3>
          <p>Save a setup once and reuse it: the instructions, the model and the tools it may call. Nothing is shared until you publish it.</p>
          <div>
            <UiV2Button icon="plus" tone="primary" onClick={onCreate}>New assistant</UiV2Button>
            {onCreateFromCurrentSetup ? (
              <UiV2Button onClick={onCreateFromCurrentSetup}>Create from current chat</UiV2Button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function AssistantCardV2({
  assistant,
  onArchiveToggle,
  onDuplicate,
  onOpen,
  onPinToggle,
  onUnavailableAction,
  onUse
}: Readonly<{
  assistant: AssistantSummaryV2;
  onArchiveToggle?(id: string, archived: boolean): void;
  onDuplicate?(id: string): void;
  onOpen?(id: string): void;
  onPinToggle?(id: string, pinned: boolean): void;
  onUnavailableAction?(id: string, action: "mcp-settings" | "open-editor"): void;
  onUse?(id: string): void;
}>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [explanationOpen, setExplanationOpen] = useState(false);
  const unavailableAction = assistant.unavailable?.action;
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: () => setMenuOpen(false),
    open: menuOpen
  });

  const closeAndRun = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  const owner = assistant.owned
    ? "Yours"
    : assistant.ownerDisplayName ? `Shared by ${assistant.ownerDisplayName}` : "Shared with you";
  const meta = [owner, assistant.modelLabel].filter(Boolean).join(" · ");

  // Fixed card anatomy (PRD §4.10): header (avatar · name · meta · "⋯"),
  // two-line description, tag row, then Use (outline, fills on hover) and
  // Pin/Unpin; archived cards fade and offer only Restore.
  return (
    <li
      className="v2-assistant-card"
      data-archived={assistant.archived || undefined}
      data-testid={`assistant-card-${assistant.id}`}
      data-unavailable={!assistant.available || undefined}
    >
      <div className="v2-assistant-card-top">
        {assistant.avatar ? (
          <AssistantAvatarV2 className="v2-assistant-avatar" recipe={assistant.avatar} size={36} />
        ) : (
          <span className="v2-assistant-avatar" aria-hidden="true">
            {assistant.name.slice(0, 1).toLocaleUpperCase()}
          </span>
        )}
        <div className="v2-assistant-card-title">
          <h3>{assistant.name}</h3>
          <p>{meta}</p>
        </div>
        {assistant.pinned ? (
          <UiV2Icon className="v2-assistant-pin" name="star-fill" title="Pinned" />
        ) : null}
        <span className="v2-assistant-actions-menu">
          <UiV2IconButton
            ref={triggerRef}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            icon="more"
            label={`More actions for ${assistant.name}`}
            onClick={() => setMenuOpen((open) => !open)}
          />
          {menuOpen ? (
            <UiV2MenuSurface
              ref={menuRef}
              className="v2-assistant-actions-menu-surface"
              label={`Actions for ${assistant.name}`}
            >
              <UiV2MenuItem onClick={() => closeAndRun(() => onDuplicate?.(assistant.id))}>
                Duplicate
              </UiV2MenuItem>
              {!assistant.archived ? (
                <UiV2MenuItem onClick={() => closeAndRun(() => onPinToggle?.(assistant.id, !assistant.pinned))}>
                  {assistant.pinned ? "Unpin" : "Pin"}
                </UiV2MenuItem>
              ) : null}
              {assistant.owned ? (
                <UiV2MenuItem
                  onClick={() => closeAndRun(() => onArchiveToggle?.(assistant.id, !assistant.archived))}
                >
                  {assistant.archived ? "Restore" : "Archive"}
                </UiV2MenuItem>
              ) : null}
            </UiV2MenuSurface>
          ) : null}
        </span>
      </div>
      <p className="v2-assistant-description">{assistant.description}</p>
      <p className="v2-assistant-status" data-tone={assistant.available && !assistant.archived ? "ok" : "warn"} role="status">
        <span>{assistant.archived
          ? "Archived · not usable"
          : assistant.available
            ? "Ready to use"
            : assistant.unavailable?.headline ?? "Required access unavailable"}</span>
        {!assistant.available && !assistant.archived && assistant.unavailable ? (
          <button
            aria-controls={`assistant-unavailable-${assistant.id}`}
            aria-expanded={explanationOpen}
            className="v2-assistant-why v2-focusable"
            type="button"
            onClick={() => setExplanationOpen((open) => !open)}
          >Why?</button>
        ) : null}
      </p>
      {explanationOpen && assistant.unavailable ? (
        <p className="v2-resource-warning" id={`assistant-unavailable-${assistant.id}`}>
          {assistant.unavailable.explanation}
        </p>
      ) : null}
      <div className="v2-resource-actions">
        {assistant.archived ? (
          assistant.owned ? (
            <UiV2Button
              aria-label={`Restore ${assistant.name}`}
              onClick={() => onArchiveToggle?.(assistant.id, false)}
            >
              Restore
            </UiV2Button>
          ) : null
        ) : (
          <>
            <UiV2Button
              aria-label={`Use ${assistant.name}`}
              className="v2-assistant-use"
              disabled={!assistant.available}
              onClick={() => onUse?.(assistant.id)}
            >
              Use
            </UiV2Button>
            {assistant.owned ? (
              <UiV2Button onClick={() => onOpen?.(assistant.id)}>Edit</UiV2Button>
            ) : null}
            {!assistant.available && unavailableAction ? (
              <UiV2Button
                onClick={() => onUnavailableAction?.(assistant.id, unavailableAction.kind)}
              >
                {unavailableAction.label}
              </UiV2Button>
            ) : null}
          </>
        )}
      </div>
    </li>
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
  processing: "Processing",
  ready: "Ready"
};

export function FilesPanelV2({
  files,
  loadState = "ready",
  onRetry,
  onOpen
}: Readonly<{
  files: readonly FileSummaryV2[];
  loadState?: "error" | "idle" | "loading" | "ready";
  onOpen?(id: string): void;
  onRetry?(): void;
}>) {
  return (
    <div data-testid="library-files-panel">
      <SectionHeading description="Uploads stay bound to the messages where they were added.">
        Files
      </SectionHeading>
      <p className="v2-library-disclosure">
        <UiV2Icon name="lock" /> Files are private and visible only to you.
      </p>
      {loadState === "loading" && files.length === 0 ? (
        <p className="v2-resource-empty" role="status">Loading files…</p>
      ) : loadState === "error" && files.length === 0 ? (
        <div className="v2-resource-empty" role="alert">
          <p>Files could not be loaded.</p>
          <UiV2Button onClick={onRetry}>Retry</UiV2Button>
        </div>
      ) : files.length ? (
        <ul className="v2-resource-list" aria-label="Files">
          {files.map((file) => (
            <FileRowV2 file={file} key={file.id} onOpen={onOpen} />
          ))}
        </ul>
      ) : <p className="v2-resource-empty">No files yet.</p>}
    </div>
  );
}

function FileRowV2({
  file,
  onOpen
}: Readonly<{
  file: FileSummaryV2;
  onOpen?(id: string): void;
}>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({
    onClose: () => setMenuOpen(false),
    open: menuOpen
  });
  return (
    <li className="v2-resource-row v2-file-row">
      <span className="v2-resource-row-icon" aria-hidden="true"><UiV2Icon name="file" /></span>
      <div className="v2-resource-row-main">
        <div className="v2-resource-row-title">
          <h3>{file.name}</h3>
          <span data-status={file.status}>{fileStatusLabel[file.status]}</span>
        </div>
        <p>{file.meta}</p>
        {file.status === "failed" ? (
          <p className="v2-file-failure">Processing failed. The original upload remains in its chat.</p>
        ) : null}
      </div>
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
            <UiV2MenuItem
              disabled={!onOpen}
              icon="chat"
              onClick={() => {
                setMenuOpen(false);
                onOpen?.(file.id);
              }}
            >
              Open in chat
            </UiV2MenuItem>
          </UiV2ResponsiveMenu>
        ) : null}
      </span>
    </li>
  );
}

/** Library › Memory owns the direct saved-memory list and row-level CRUD. */
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
  notice,
  onCancelRow,
  onConfirmForget,
  onCreate,
  onDraftChange,
  onEdit,
  onForget,
  onLoadMore,
  onOpenSettings,
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
  notice: string | null;
  onCancelRow(): void;
  onConfirmForget(): void;
  onCreate(): void;
  onDraftChange(value: string): void;
  onEdit(memoryRef: string): void;
  onForget(memoryRef: string): void;
  onLoadMore(): void;
  onOpenSettings?(): void;
  onQueryChange(value: string): void;
  onRetry?(): void;
  onSave(): void;
  onSubmitQuery(): void;
  query: string;
  searchActive: boolean;
  rowMode: "create" | "edit" | "forget" | null;
}>) {
  const statusLabel = memory.loadState === "error"
    ? mt("library.statusLoadError")
    : memory.loadState !== "ready"
      ? mt("settings.loading")
      : memory.status === "ON"
      ? mt("library.statusOn")
      : memory.status === "PREPARING"
        ? mt("library.statusPreparing")
        : memory.status === "UNAVAILABLE"
          ? mt("library.statusUnavailable")
          : memory.status === "NEEDS_ADMIN_SETUP"
            ? mt("library.statusNeedsSetup")
            : memory.status === "PAUSED"
              ? mt("library.statusPaused")
              : mt("settings.loading");
  const statusDescription = memory.loadState === "error"
    ? mt("library.loadErrorDescription")
    : memory.loadState !== "ready"
      ? mt("library.loadingDescription")
      : memory.status === "ON"
      ? mt("library.onDescription")
      : memory.status === "PREPARING"
        ? mt("library.preparingDescription")
        : memory.status === "UNAVAILABLE"
          ? mt("library.unavailableDescription")
          : memory.status === "NEEDS_ADMIN_SETUP"
            ? memory.disabledReason ?? mt("library.needsSetupDescription")
            : memory.status === "PAUSED"
              ? mt("library.pausedDescription")
              : mt("library.loadingDescription");
  const groups = useMemo(() => MEMORY_CONSUMER_CATEGORIES.flatMap((category) => {
    const groupedItems = items.filter((item) => item.category === category);
    return groupedItems.length ? [{ category, items: groupedItems }] : [];
  }), [items]);
  const initialLoading = (listState === "idle" || listState === "loading") && items.length === 0;
  const initialError = (listState === "error" || Boolean(listError)) && items.length === 0;
  const empty = listState === "ready" && items.length === 0 && rowMode !== "create";
  const longFactPresent = items.some((item) => item.statement.length > 240);
  const summary = memory.status === "ON"
    ? "Learning from your ordinary chats"
    : memory.status === "PAUSED"
      ? "Answers do not read these facts. Nothing was deleted."
      : statusDescription;
  const note = longFactPresent
    ? { icon: "alert" as const, text: mt("library.longFactDescription") }
    : memory.status === "PAUSED"
      ? { icon: "alert" as const, text: mt("library.pausedManagementDescription") }
      : { icon: "lock" as const, text: mt("library.temporaryDescription") };
  const saveDisabled = busy !== null || draft.trim().length === 0 ||
    draft.length > MEMORY_CONSUMER_STATEMENT_MAX_LENGTH;

  return (
    <div data-testid="library-memory-panel">
      <SectionHeading
        action={(
          <>
            {onOpenSettings ? (
              <UiV2Button className="v2-memory-settings-text" icon="settings" onClick={onOpenSettings}>
                Memory settings
              </UiV2Button>
            ) : null}
            <UiV2Button
              disabled={!memory.explicitCrudAvailable || busy !== null || rowMode !== null}
              icon="plus"
              tone="primary"
              onClick={onCreate}
            >
              Add memory
            </UiV2Button>
          </>
        )}
        description={mt("library.description")}
        meta={<span className="v2-memory-mobile-status" role="status">{statusLabel}</span>}
      >
        {mt("settings.heading")}
      </SectionHeading>
      <div className="v2-memory-toolbar">
        <span className="v2-memory-state" data-tone={memory.status === "ON" ? "ok" : memory.status === "PAUSED" ? "off" : "warn"}>
          <UiV2Icon name={memory.status === "ON" ? "check" : "memory"} />
          {statusLabel}
        </span>
        <p>{summary}</p>
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitQuery();
          }}
        >
          <label className="v2-resource-search">
            <UiV2Icon name="search" />
            <input
              aria-label="Search memories"
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
        <div className="v2-resource-empty" role="alert">
          <p>{mt("manager.loadError")}</p>
          <UiV2Button onClick={onRetry}>{mt("manager.retry")}</UiV2Button>
        </div>
      ) : null}
      {listError && items.length > 0 ? (
        <div className="v2-memory-error v2-memory-list-error" role="alert">
          <span>{mt("manager.loadError")}</span>
          <UiV2Button onClick={onRetry}>{mt("manager.retry")}</UiV2Button>
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
              disabled={!memory.explicitCrudAvailable}
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
                    item={item}
                    key={item.memoryRef}
                    onCancel={onCancelRow}
                    onConfirm={onConfirmForget}
                  />
                );
              }
              return (
                <MemoryListRowV2
                  disabled={!memory.explicitCrudAvailable || busy !== null || rowMode !== null}
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
          <UiV2Button busy={listState === "loading"} onClick={onLoadMore}>
            {mt("manager.loadMore")}
          </UiV2Button>
        </div>
      ) : null}
      <p className="v2-library-note">
        <UiV2Icon name={note.icon} />
        <span>{note.text}</span>
      </p>
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
          {` · ${formatMemoryDate(item.updatedAt)}`}
          {!item.sourceAvailable ? ` · ${mt("manager.sourceUnavailable")}` : ""}
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
  item,
  onCancel,
  onConfirm
}: Readonly<{
  busy: boolean;
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
          <UiV2Button busy={busy} tone="destructive" onClick={onConfirm}>{mt("manager.forget")}</UiV2Button>
          <UiV2Button disabled={busy} onClick={onCancel}>{mt("manager.cancel")}</UiV2Button>
        </div>
      </div>
    </li>
  );
}

function formatMemoryDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? mt("manager.notSet")
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
