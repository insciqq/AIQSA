"use client";

import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import {
  type UiV2IconName,
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2IconSprite,
  UiV2MenuItem,
  UiV2MenuSurface
} from "@/components/ui-v2";
import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import {
  useEffect,
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
  LibraryTabIdV2,
  LibraryTabV2,
  MemoryOverviewV2
} from "./contracts";

function mt(key: Parameters<typeof memoryUiCopy>[0]): string {
  return memoryUiCopy(key);
}

const tabOrder: readonly LibraryTabIdV2[] = ["assistants", "knowledge", "files", "memory"];
const tabIcons: Record<LibraryTabIdV2, UiV2IconName> = {
  assistants: "assistant",
  files: "file",
  knowledge: "book",
  memory: "memory"
};

export function LibraryV2({
  initialTab = "assistants",
  navigationGuard,
  onBack,
  onOpenSkillLibrary,
  onTabChange,
  tabs
}: Readonly<{
  initialTab?: LibraryTabIdV2;
  navigationGuard?: LibraryNavigationGuardV2;
  onBack(): void;
  /** Opens the Skill Library overlay from the "Skills" group of the section column. */
  onOpenSkillLibrary?(): void;
  onTabChange?(tab: LibraryTabIdV2): void;
  tabs: readonly LibraryTabV2[];
}>) {
  const [activeTab, setActiveTab] = useState<LibraryTabIdV2>(initialTab);
  const tabRefs = useRef<Partial<Record<LibraryTabIdV2, HTMLButtonElement | null>>>({});
  const availableTabs = tabOrder.filter((id) => tabs.some((tab) => tab.id === id));
  const selected = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

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
          the section column (left); below 900px it stacks as before. */}
      <header className="v2-library-header">
        <div className="v2-library-heading-row">
          <nav className="v2-library-crumb" aria-label="Library location">
            <span>Library</span>
            <span aria-hidden="true"> / </span>
            <strong>{selected.label}</strong>
          </nav>
          <UiV2Button icon="chevron-right" onClick={requestExit}>Back to chat</UiV2Button>
        </div>
        <div className="v2-library-tabs-scroll">
          <p className="v2-library-column-title" aria-hidden="true">Library</p>
          <div className="v2-library-tabs" role="tablist" aria-label="Library sections">
            {tabs.map((tab) => (
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
          {onOpenSkillLibrary ? (
            <div className="v2-library-tabs-group">
              <p className="v2-library-column-label">Skills</p>
              <button className="v2-library-tab v2-focusable" type="button" onClick={onOpenSkillLibrary}>
                <UiV2Icon name="wand" />
                <span>Skill library</span>
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
  search
}: Readonly<{ action?: ReactNode; children: ReactNode; description: string; search?: ReactNode }>) {
  return (
    <header className="v2-resource-heading">
      <div>
        <h2>{children}</h2>
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
  onArchiveToggle,
  onCreate,
  onDuplicate,
  onOpen,
  onOpenHistory,
  onPinToggle,
  onUse
}: Readonly<{
  assistants: readonly AssistantSummaryV2[];
  onArchiveToggle?(id: string, archived: boolean): void;
  onCreate?(): void;
  onDuplicate?(id: string): void;
  onOpen?(id: string): void;
  onOpenHistory?(id: string): void;
  onPinToggle?(id: string, pinned: boolean): void;
  onUse?(id: string): void;
}>) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AssistantFilterV2>("all");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const counts = useMemo(() => ({
    all: assistants.length,
    pinned: assistants.filter((assistant) => assistant.pinned && !assistant.archived).length
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
        action={<UiV2Button icon="plus" tone="primary" onClick={onCreate}>New Assistant</UiV2Button>}
        description="Pick a ready Assistant or create your own. It applies only through the Use action."
        search={(
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
        )}
      >
        Assistants
      </SectionHeading>
      {/* Filter pills (PRD §4.10): the active pill carries the accent wash. */}
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
            {candidate === "all" ? <span> · {counts.all}</span> : null}
            {candidate === "pinned" ? <span> · {counts.pinned}</span> : null}
          </button>
        ))}
      </div>
      {visible.length ? (
        <ul className="v2-assistant-grid" aria-label="Assistants">
          {visible.map((assistant) => (
            <AssistantCardV2
              assistant={assistant}
              key={assistant.id}
              onArchiveToggle={onArchiveToggle}
              onDuplicate={onDuplicate}
              onOpen={onOpen}
              onOpenHistory={onOpenHistory}
              onPinToggle={onPinToggle}
              onUse={onUse}
            />
          ))}
        </ul>
      ) : (
        <p className="v2-resource-empty">
          {assistants.length ? "No Assistants match this view." : "No Assistants yet."}
        </p>
      )}
    </div>
  );
}

function AssistantCardV2({
  assistant,
  onArchiveToggle,
  onDuplicate,
  onOpen,
  onOpenHistory,
  onPinToggle,
  onUse
}: Readonly<{
  assistant: AssistantSummaryV2;
  onArchiveToggle?(id: string, archived: boolean): void;
  onDuplicate?(id: string): void;
  onOpen?(id: string): void;
  onOpenHistory?(id: string): void;
  onPinToggle?(id: string, pinned: boolean): void;
  onUse?(id: string): void;
}>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuContainerRef = useRef<HTMLSpanElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuContainerRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  const closeAndRun = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  const meta = assistant.archived
    ? "Archived"
    : assistant.pinned
      ? "Pinned"
      : assistant.owned ? "Yours" : "Shared with you";

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
        <span
          ref={menuContainerRef}
          className="v2-assistant-actions-menu"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !menuOpen) return;
            event.preventDefault();
            event.stopPropagation();
            setMenuOpen(false);
            menuTriggerRef.current?.focus();
          }}
        >
          <UiV2IconButton
            ref={menuTriggerRef}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            icon="more"
            label={`More actions for ${assistant.name}`}
            onClick={() => setMenuOpen((open) => !open)}
          />
          {menuOpen ? (
            <UiV2MenuSurface
              className="v2-assistant-actions-menu-surface"
              label={`Actions for ${assistant.name}`}
            >
              {assistant.owned ? (
                <>
                  <UiV2MenuItem onClick={() => closeAndRun(() => onOpen?.(assistant.id))}>
                    Edit
                  </UiV2MenuItem>
                  <UiV2MenuItem onClick={() => closeAndRun(() => onOpenHistory?.(assistant.id))}>
                    Version history
                  </UiV2MenuItem>
                </>
              ) : null}
              <UiV2MenuItem onClick={() => closeAndRun(() => onDuplicate?.(assistant.id))}>
                Duplicate
              </UiV2MenuItem>
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
      <div className="v2-assistant-tags">
        {!assistant.available ? (
          <span className="v2-assistant-tag" data-tone="warn" role="status">
            {assistant.unavailableReason ?? "Required access unavailable"}
          </span>
        ) : null}
      </div>
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
            <UiV2Button
              aria-label={`${assistant.pinned ? "Unpin" : "Pin"} ${assistant.name}`}
              aria-pressed={assistant.pinned}
              onClick={() => onPinToggle?.(assistant.id, !assistant.pinned)}
            >
              {assistant.pinned ? "Unpin" : "Pin"}
            </UiV2Button>
          </>
        )}
      </div>
    </li>
  );
}

const knowledgeStatusLabel: Record<KnowledgeSummaryV2["status"], string> = {
  archived: "Archived",
  empty: "Empty",
  needs_attention: "Needs attention",
  processing: "Processing",
  ready: "Ready",
  trashed: "In Trash",
  unavailable: "Unavailable"
};

export function KnowledgePanelV2({
  bases,
  error,
  loadState = "ready",
  onBrowseSources,
  onCreate,
  onOpen,
  onRetry
}: Readonly<{
  bases: readonly KnowledgeSummaryV2[];
  error?: string | null;
  loadState?: "error" | "loading" | "ready";
  onBrowseSources?(): void;
  onCreate?(): void;
  onOpen?(id: string): void;
  onRetry?(): void;
}>) {
  return (
    <div data-testid="library-knowledge-panel">
      <SectionHeading
        action={(
          <>
            <UiV2Button onClick={onBrowseSources}>Browse Sources</UiV2Button>
            <UiV2Button icon="plus" tone="primary" onClick={onCreate}>New base</UiV2Button>
          </>
        )}
        description="Bases group reusable Sources into the exact Knowledge scopes selected for Chat, Projects, and Assistants."
      >
        Knowledge
      </SectionHeading>
      {loadState === "loading" && bases.length === 0 ? (
        <p className="v2-resource-empty" role="status">Loading knowledge…</p>
      ) : loadState === "error" && bases.length === 0 ? (
        <div className="v2-resource-empty" role="alert">
          <p>{error || "Knowledge could not be loaded."}</p>
          <UiV2Button onClick={onRetry}>Retry</UiV2Button>
        </div>
      ) : bases.length ? (
        <ul className="v2-resource-list" aria-label="Knowledge bases">
          {bases.map((base) => (
            <li className="v2-resource-row" key={base.id}>
              <span className="v2-resource-row-icon" aria-hidden="true"><UiV2Icon name="book" /></span>
              <div className="v2-resource-row-main">
                <div className="v2-resource-row-title">
                  <h3>{base.name}</h3>
                  <span data-status={base.status}>{knowledgeStatusLabel[base.status]}</span>
                </div>
                <p>{base.description}</p>
                <small>{base.owned ? "Your base" : "Shared with you"} · {base.sourceCount} {base.sourceCount === 1 ? "Source" : "Sources"}</small>
              </div>
              <UiV2Button onClick={() => onOpen?.(base.id)}>Open</UiV2Button>
            </li>
          ))}
        </ul>
      ) : <p className="v2-resource-empty">No knowledge bases yet.</p>}
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
            <li className="v2-resource-row" key={file.id}>
              <span className="v2-resource-row-icon" aria-hidden="true"><UiV2Icon name="file" /></span>
              <div className="v2-resource-row-main">
                <div className="v2-resource-row-title">
                  <h3>{file.name}</h3>
                  <span data-status={file.status}>{fileStatusLabel[file.status]}</span>
                </div>
                <p>{file.meta}</p>
                <small>Upload{file.private ? " · Private" : ""}</small>
              </div>
              <UiV2Button
                disabled={file.status !== "ready" || !onOpen}
                onClick={() => onOpen?.(file.id)}
              >
                Go to source
              </UiV2Button>
            </li>
          ))}
        </ul>
      ) : <p className="v2-resource-empty">No files yet.</p>}
    </div>
  );
}

function MemorySwitch({
  disabled,
  label,
  onChange,
  value
}: Readonly<{
  disabled: boolean;
  label: string;
  onChange?(value: boolean): void;
  value: boolean;
}>) {
  return (
    <div className="v2-memory-setting">
      <span>{label}</span>
      <button
        aria-label={`${label}: ${value ? mt("common.on") : mt("common.off")}`}
        aria-checked={value}
        className="v2-memory-switch v2-focusable"
        data-on={value || undefined}
        disabled={disabled}
        role="switch"
        type="button"
        onClick={() => onChange?.(!value)}
      >
        {value ? mt("common.on") : mt("common.off")}
      </button>
    </div>
  );
}

export function MemoryPanelV2({
  memory,
  onChangeAutomaticLearning,
  onChangeReferenceHistory,
  onChangeUseFacts,
  onManage,
  onRetry
}: Readonly<{
  memory: MemoryOverviewV2;
  onChangeAutomaticLearning?(value: boolean): void;
  onChangeReferenceHistory?(value: boolean): void;
  onChangeUseFacts?(value: boolean): void;
  onManage?(): void;
  onRetry?(): void;
}>) {
  const loadUnavailable = memory.loadState !== "ready";
  const subordinateDisabled = memory.administratorDisabled || loadUnavailable;
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
  return (
    <div data-testid="library-memory-panel">
      <SectionHeading description={mt("library.description")}>
        {mt("settings.heading")}
      </SectionHeading>

      <section
        aria-busy={memory.loadState === "loading"}
        aria-labelledby="v2-memory-health"
        aria-live="polite"
        className="v2-memory-pulse"
      >
        <span
          aria-hidden="true"
          className="v2-memory-pulse-dot"
          data-ok={memory.loadState === "ready" && memory.status === "ON" || undefined}
        />
        <div>
          <h3 id="v2-memory-health">
            {statusLabel}
          </h3>
          <p>
            {statusDescription}
          </p>
          {memory.loadState === "error" ? (
            <UiV2Button onClick={onRetry}>{mt("settings.retry")}</UiV2Button>
          ) : null}
        </div>
      </section>

      <section className="v2-memory-section" aria-labelledby="v2-memory-controls">
        <h3 id="v2-memory-controls">{mt("library.controlsHeading")}</h3>
        <div className="v2-memory-settings">
          <MemorySwitch disabled={subordinateDisabled} label={mt("settings.memoryLabel")} value={memory.useMemoryFacts} onChange={onChangeUseFacts} />
          <MemorySwitch disabled={subordinateDisabled} label={mt("settings.searchPastChatsLabel")} value={memory.referenceChatHistory} onChange={onChangeReferenceHistory} />
          <MemorySwitch disabled={subordinateDisabled} label={mt("settings.learnAutomaticallyLabel")} value={memory.automaticLearning} onChange={onChangeAutomaticLearning} />
        </div>
      </section>

      <section className="v2-memory-section" aria-labelledby="v2-memory-manage">
        <h3 id="v2-memory-manage">{mt("library.savedHeading")}</h3>
        <p>{mt("library.savedDescription")}</p>
        <div className="v2-resource-actions">
          <UiV2Button disabled={!memory.explicitCrudAvailable} onClick={onManage}>
            {mt("settings.manageLabel")}
          </UiV2Button>
        </div>
      </section>

      <p className="v2-resource-empty">
        {mt("library.temporaryDescription")}
      </p>
    </div>
  );
}
