"use client";

import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2IconSprite,
  UiV2MenuItem,
  UiV2MenuSurface
} from "@/components/ui-v2";
import {
  useEffect,
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

const tabOrder: readonly LibraryTabIdV2[] = ["assistants", "knowledge", "files", "memory"];

export function LibraryV2({
  initialTab = "assistants",
  navigationGuard,
  onBack,
  onTabChange,
  tabs
}: Readonly<{
  initialTab?: LibraryTabIdV2;
  navigationGuard?: LibraryNavigationGuardV2;
  onBack(): void;
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
      <header className="v2-library-header">
        <div className="v2-library-heading-row">
          <UiV2Button icon="chevron-right" onClick={requestExit}>Back to chat</UiV2Button>
          <div className="v2-library-title">
            <span className="v2-library-title-icon" aria-hidden="true">
              <UiV2Icon name="library" />
            </span>
            <div>
              <h1>Library</h1>
              <p>Your working resources and memory in one place</p>
            </div>
          </div>
        </div>
        <div className="v2-library-tabs-scroll">
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
                {tab.label}
              </button>
            ))}
          </div>
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
  description
}: Readonly<{ action?: ReactNode; children: ReactNode; description: string }>) {
  return (
    <header className="v2-resource-heading">
      <div>
        <h2>{children}</h2>
        <p>{description}</p>
      </div>
      {action ? <div className="v2-resource-heading-action">{action}</div> : null}
    </header>
  );
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
  return (
    <div data-testid="library-assistants-panel">
      <SectionHeading
        action={<UiV2Button icon="plus" tone="primary" onClick={onCreate}>New Assistant</UiV2Button>}
        description="Pick a ready Assistant or create your own. It applies only through the Use action."
      >
        Assistants
      </SectionHeading>
      {assistants.length ? (
        <ul className="v2-assistant-grid" aria-label="Assistants">
          {assistants.map((assistant) => (
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
      ) : <p className="v2-resource-empty">No Assistants yet.</p>}
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

  return (
    <li
      className="v2-assistant-card"
      data-testid={`assistant-card-${assistant.id}`}
      data-unavailable={!assistant.available || undefined}
    >
      <div className="v2-assistant-card-top">
        <span className="v2-assistant-avatar" aria-hidden="true">
          {assistant.name.slice(0, 1).toLocaleUpperCase()}
        </span>
        <div className="v2-assistant-card-title">
          <h3>{assistant.name}</h3>
          <p>
            Revision {assistant.revision}
            {assistant.pinned ? " · Pinned" : ""}
            {assistant.archived ? " · Archived" : ""}
          </p>
        </div>
      </div>
      <p className="v2-assistant-description">{assistant.description}</p>
      {!assistant.available ? (
        <p className="v2-resource-warning" role="status">
          {assistant.unavailableReason ?? "Required access unavailable"}
        </p>
      ) : null}
      <div className="v2-resource-actions">
        <UiV2Button
          aria-label={`${assistant.pinned ? "Unpin" : "Pin"} ${assistant.name}`}
          aria-pressed={assistant.pinned}
          onClick={() => onPinToggle?.(assistant.id, !assistant.pinned)}
        >
          {assistant.pinned ? "Unpin" : "Pin"}
        </UiV2Button>
        <UiV2Button
          aria-label={`Use ${assistant.name}`}
          disabled={!assistant.available || assistant.archived}
          onClick={() => onUse?.(assistant.id)}
        >
          Use
        </UiV2Button>
        {assistant.owned ? (
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
                <UiV2MenuItem onClick={() => closeAndRun(() => onOpen?.(assistant.id))}>
                  Edit
                </UiV2MenuItem>
                <UiV2MenuItem onClick={() => closeAndRun(() => onOpenHistory?.(assistant.id))}>
                  Version history
                </UiV2MenuItem>
                <UiV2MenuItem onClick={() => closeAndRun(() => onDuplicate?.(assistant.id))}>
                  Duplicate
                </UiV2MenuItem>
                <UiV2MenuItem
                  onClick={() => closeAndRun(() => onArchiveToggle?.(assistant.id, !assistant.archived))}
                >
                  {assistant.archived ? "Restore" : "Archive"}
                </UiV2MenuItem>
              </UiV2MenuSurface>
            ) : null}
          </span>
        ) : (
          <UiV2Button
            aria-label={`Duplicate ${assistant.name}`}
            onClick={() => onDuplicate?.(assistant.id)}
          >
            Duplicate
          </UiV2Button>
        )}
      </div>
    </li>
  );
}

const knowledgeStatusLabel: Record<KnowledgeSummaryV2["status"], string> = {
  archived: "Archived",
  indexing: "Indexing",
  ready: "Ready",
  unavailable: "Unavailable"
};

export function KnowledgePanelV2({
  bases,
  onCreate,
  onOpen
}: Readonly<{
  bases: readonly KnowledgeSummaryV2[];
  onCreate?(): void;
  onOpen?(id: string): void;
}>) {
  return (
    <div data-testid="library-knowledge-panel">
      <SectionHeading
        action={<UiV2Button icon="plus" tone="primary" onClick={onCreate}>New base</UiV2Button>}
        description="Documents you can explicitly attach to your next run. Indexing and access remain server truth."
      >
        Knowledge
      </SectionHeading>
      {bases.length ? (
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
                <small>{base.owned ? "Your base" : "Shared with you"} · {base.documentCount} {base.documentCount === 1 ? "file" : "files"}</small>
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
  generatedFilesEnabled,
  onOpen
}: Readonly<{
  files: readonly FileSummaryV2[];
  generatedFilesEnabled: boolean;
  onOpen?(id: string): void;
}>) {
  return (
    <div data-testid="library-files-panel">
      <SectionHeading description="Uploads stay bound to their messages; generated files show version and lineage when the feature is enabled.">
        Files
      </SectionHeading>
      <p className="v2-library-disclosure">
        <UiV2Icon name="lock" /> Files are private and visible only to you.
      </p>
      {!generatedFilesEnabled ? (
        <p className="v2-library-note">AIQSA-generated files are not yet enabled in this installation.</p>
      ) : null}
      {files.length ? (
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
                <small>{file.kind === "generated" ? "Generated by AIQSA" : "Upload"}{file.private ? " · Private" : ""}</small>
              </div>
              <UiV2Button disabled={file.status !== "ready"} onClick={() => onOpen?.(file.id)}>
                {file.kind === "generated" ? "Preview" : "Go to source"}
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
        aria-checked={value}
        className="v2-memory-switch v2-focusable"
        data-on={value || undefined}
        disabled={disabled}
        role="switch"
        type="button"
        onClick={() => onChange?.(!value)}
      >
        {value ? "On" : "Off"}
      </button>
    </div>
  );
}

export function MemoryPanelV2({
  memory,
  onChangeAutomaticLearning,
  onChangeReferenceHistory,
  onChangeUseFacts,
  onForget,
  onManage,
  onOpenHistory,
  onOpenOperations
}: Readonly<{
  memory: MemoryOverviewV2;
  onChangeAutomaticLearning?(value: boolean): void;
  onChangeReferenceHistory?(value: boolean): void;
  onChangeUseFacts?(value: boolean): void;
  onForget?(id: string): void;
  onManage?(): void;
  onOpenHistory?(): void;
  onOpenOperations?(): void;
}>) {
  const gatesDisabled = memory.administratorDisabled;
  return (
    <div data-testid="library-memory-panel">
      <SectionHeading description="Control what AIQSA can remember and inspect the exact facts available to future runs.">
        Memory
      </SectionHeading>

      {memory.administratorDisabled ? (
        <div className="v2-memory-disabled" role="status">
          <strong>Memory is disabled by the administrator</strong>
          <span>{memory.disabledReason ?? "New answers do not use Memory."}</span>
        </div>
      ) : null}

      <section className="v2-memory-pulse" aria-labelledby="v2-memory-health">
        <span className="v2-memory-pulse-dot" data-ok={!memory.administratorDisabled || undefined} aria-hidden="true" />
        <div>
          <h3 id="v2-memory-health">{memory.healthLabel}</h3>
          <p>{memory.healthDetail}</p>
        </div>
      </section>

      <section className="v2-memory-section" aria-labelledby="v2-memory-controls">
        <h3 id="v2-memory-controls">Memory controls</h3>
        <div className="v2-memory-settings">
          <MemorySwitch disabled={gatesDisabled} label="Use saved memories" value={memory.useMemoryFacts} onChange={onChangeUseFacts} />
          <MemorySwitch disabled={gatesDisabled} label="Reference chat history" value={memory.referenceChatHistory} onChange={onChangeReferenceHistory} />
          <MemorySwitch disabled={gatesDisabled} label="Learn automatically" value={memory.automaticLearning} onChange={onChangeAutomaticLearning} />
        </div>
      </section>

      <section className="v2-memory-section" aria-labelledby="v2-memory-facts">
        <div className="v2-memory-section-heading">
          <div>
            <h3 id="v2-memory-facts">Saved memories</h3>
            <p>Exact statements only. Source and history stay available in the detail task.</p>
          </div>
          <UiV2Button disabled={!memory.explicitCrudAvailable} onClick={onManage}>Manage memories</UiV2Button>
        </div>
        {memory.facts.length ? (
          <ul className="v2-memory-fact-list">
            {memory.facts.map((fact) => (
              <li key={fact.id}>
                <div>
                  <p>{fact.statement}</p>
                  <small>{fact.scope}{fact.pinned ? " · Pinned" : ""}</small>
                </div>
                <UiV2IconButton
                  disabled={!memory.explicitCrudAvailable}
                  icon="close"
                  label={`Forget: ${fact.statement}`}
                  onClick={() => onForget?.(fact.id)}
                />
              </li>
            ))}
          </ul>
        ) : <p className="v2-resource-empty">No saved memories.</p>}
      </section>

      <section className="v2-memory-section" aria-labelledby="v2-memory-tools">
        <h3 id="v2-memory-tools">Inspect and maintain</h3>
        <div className="v2-resource-actions">
          <UiV2Button icon="search" onClick={onOpenHistory}>Search chat history</UiV2Button>
          <UiV2Button icon="settings" onClick={onOpenOperations}>Memory operations</UiV2Button>
        </div>
      </section>

      <details className="v2-library-advanced">
        <summary className="v2-focusable">Advanced evidence</summary>
        <p>
          Temporary chats do not use Memory. Turning a preference off is non-destructive;
          deleting Memory does not rewrite retained chats or frozen accepted runs.
        </p>
      </details>
    </div>
  );
}
