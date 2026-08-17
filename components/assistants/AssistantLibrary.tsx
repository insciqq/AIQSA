import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import { AssistantAvatar } from "@/components/assistants/AssistantAvatar";
import type {
  AssistantEditorView,
  AssistantHistoryView,
  AssistantLibraryListView,
  AssistantLibraryView,
  LibraryFilter,
  LibraryMode,
  LibraryNotice
} from "@/components/assistants/libraryViewContracts";
import {
  ASSISTANT_CATEGORIES,
  ASSISTANT_CATEGORY_LABELS,
  ASSISTANT_DESCRIPTION_MAX_LENGTH,
  ASSISTANT_DEVELOPER_PROMPT_MAX_LENGTH,
  ASSISTANT_MAX_STARTER_PROMPTS,
  ASSISTANT_NAME_MAX_LENGTH,
  ASSISTANT_STARTER_PROMPT_MAX_LENGTH,
  ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH,
  type AssistantCapabilityFingerprint,
  type AssistantCategory,
  type AssistantSummary
} from "@/lib/contracts/assistants";
import { KNOWLEDGE_PLAN_MAX_BASES } from "@/lib/contracts/knowledge";
import { SKILL_MAX_SELECTED, type SkillSummary } from "@/lib/contracts/skills";
import { MAX_SEARCH_PLAN_OPTIONS } from "@/lib/domain/search";
import { ArrowLeft, ChevronDown, LoaderCircle, Plus, RotateCcw, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app-canvas";
const coarsePointerTarget = "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const quietButton = `inline-flex min-h-touch shrink-0 items-center justify-center gap-2 rounded-control px-3 text-xs font-medium text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`;
const surfaceButton = `inline-flex min-h-touch shrink-0 items-center justify-center gap-2 rounded-control bg-control-surface px-3 text-xs font-medium text-ink hover:bg-control-hover disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`;
const primaryButton = `inline-flex min-h-touch shrink-0 items-center justify-center gap-2 rounded-control bg-proof px-4 text-sm font-semibold text-proof-contrast hover:bg-proof-hover disabled:cursor-not-allowed disabled:bg-control-surface disabled:text-ink-disabled sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const useButton = `inline-flex min-h-touch shrink-0 items-center justify-center gap-2 rounded-control px-3 text-xs font-semibold text-proof hover:bg-control-hover hover:text-proof-hover disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`;
const menuItem = `flex min-h-touch w-full items-center rounded-control px-3 text-left text-xs font-medium text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`;
const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const fieldInput = `min-h-touch w-full rounded-control border border-control-boundary bg-answer-paper px-3 text-sm text-ink placeholder:text-ink-muted disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled sm:min-h-control ${coarsePointerTarget} ${focusRing}`;
const fieldTextarea = `w-full resize-y rounded-control border border-control-boundary bg-answer-paper px-3 py-2 text-sm leading-6 text-ink placeholder:text-ink-muted disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled ${focusRing}`;
const checkboxRow = `flex min-h-touch items-center gap-2 rounded-control bg-control-surface px-3 text-xs text-ink-secondary ${coarsePointerTarget}`;
const readOnlyLabel = "text-xs font-medium text-ink-secondary";
const promptBlock =
  "mt-1 whitespace-pre-wrap break-words rounded-control bg-control-surface px-3 py-2 font-sans text-sm leading-6 text-ink [overflow-wrap:anywhere]";

const DISCOVER_FILTERS: readonly (readonly [LibraryFilter, string])[] = [
  ["all", "All"],
  ["pinned", "Pinned"],
  ["groups", "My groups"],
  ["installation", "Installation"],
  ["unavailable", "Unavailable"]
];
const YOURS_FILTERS: readonly (readonly [LibraryFilter, string])[] = [
  ["all", "All"],
  ["pinned", "Pinned"],
  ["archived", "Archived"]
];

const HISTORY_SECTION_LABELS: Readonly<Record<string, string>> = {
  identity: "Identity",
  instructions: "Instructions",
  knowledge: "Knowledge",
  model: "Model",
  "run-setup": "Run setup",
  search: "Search",
  skills: "Skills",
  starters: "Starters",
  tools: "Tools"
};

function historySectionLabel(sectionId: string): string {
  return HISTORY_SECTION_LABELS[sectionId] ?? sectionId;
}

function tabClass(selected: boolean): string {
  return `-mb-px min-h-touch shrink-0 border-b-2 px-0.5 text-sm font-medium ${coarsePointerTarget} ${focusRing} ${
    selected
      ? "border-proof text-ink"
      : "border-transparent text-ink-muted hover:border-trace-strong hover:text-ink-secondary"
  }`;
}

function chipClass(selected: boolean): string {
  return `inline-flex min-h-touch shrink-0 items-center rounded-pill px-3 text-xs font-medium sm:min-h-control-sm ${coarsePointerTarget} ${focusRing} ${
    selected ? "bg-control-selected text-ink" : "bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink"
  }`;
}

function capabilityLine(fingerprint: AssistantCapabilityFingerprint): string {
  const parts: string[] = [];
  if (fingerprint.modelLabel) {
    parts.push(fingerprint.modelLabel);
  }
  if (fingerprint.searchOptionCount === 1) {
    parts.push("Search");
  } else if (fingerprint.searchOptionCount > 1) {
    parts.push(`${fingerprint.searchOptionCount} Search`);
  }
  if (fingerprint.mcpServerCount > 0) {
    parts.push(`${fingerprint.mcpServerCount} MCP`);
  }
  return parts.join(" · ");
}

function skillScopeLabel(skill: SkillSummary): string {
  if (skill.owned) return "Yours";
  if (skill.scope.kind === "workspace") {
    return skill.scope.workspaceNames.join(", ") || "Shared Workspace";
  }
  return "Shared with everyone";
}

function matchesFilter(assistant: AssistantSummary, filter: LibraryFilter, mode: LibraryMode): boolean {
  switch (filter) {
    case "archived":
      return assistant.archived;
    case "groups":
      return assistant.scope.kind === "group";
    case "installation":
      return assistant.scope.kind === "installation";
    case "pinned":
      return assistant.pinned;
    case "unavailable":
      return !assistant.availability.ok;
    default:
      return mode === "yours" ? !assistant.archived : true;
  }
}

function matchesQuery(assistant: AssistantSummary, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }
  return [
    assistant.name,
    assistant.description,
    assistant.category ? ASSISTANT_CATEGORY_LABELS[assistant.category] : ""
  ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}

function visibleAssistants(modeAssistants: AssistantSummary[], list: AssistantLibraryListView): AssistantSummary[] {
  const normalizedQuery = list.query.trim().toLocaleLowerCase();
  return modeAssistants
    .filter((assistant) => matchesFilter(assistant, list.filter, list.mode))
    .filter((assistant) => list.category === null || assistant.category === list.category)
    .filter((assistant) => matchesQuery(assistant, normalizedQuery))
    .sort((left, right) =>
      left.pinned === right.pinned ? left.name.localeCompare(right.name) : left.pinned ? -1 : 1
    );
}

export function AssistantLibrary({
  restoreFocus,
  view
}: {
  restoreFocus?(): HTMLElement | null;
  view: AssistantLibraryView;
}) {
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const taskEntryRef = useRef<HTMLButtonElement>(null);
  const editorDirty = Boolean(
    view.task === "editor" && view.editor?.dirty
  );
  useBeforeUnloadGuard(editorDirty);
  const editorMutationLocked =
    view.task === "editor" && view.editor !== null && (view.busy || view.editor.saving);
  const historyMutationLocked =
    view.task === "history" && view.history !== null && (view.busy || view.history.restoring);
  const libraryNavigationLocked = view.busy || editorMutationLocked || historyMutationLocked;
  const requestEditorClose = () => {
    if (view.task !== "editor" || !view.editor || editorMutationLocked) {
      return;
    }
    if (view.editor.dirty) {
      setDiscardConfirmationOpen(true);
      return;
    }
    view.editor.onCancel();
  };
  const escapeAction =
    view.task === "editor" && view.editor
      ? requestEditorClose
      : view.task === "history" && view.history
        ? view.history.onBack
        : view.onBackToChat;
  const dialogRef = useDialogFocus<HTMLDivElement>({
    autoFocus: false,
    closeOnEscape: !discardConfirmationOpen && !libraryNavigationLocked,
    containFocus: !discardConfirmationOpen,
    onClose: escapeAction,
    restoreFocus
  });

  useEffect(() => {
    if (discardConfirmationOpen) return;
    const timer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      const active = document.activeElement;
      const activeInside =
        dialog !== null &&
        active instanceof HTMLElement &&
        active !== dialog &&
        dialog.contains(active);
      if (!dialog || activeInside) return;
      const entry = taskEntryRef.current;
      if (entry && !entry.disabled) {
        entry.focus({ preventScroll: true });
      } else {
        dialog.focus({ preventScroll: true });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    dialogRef,
    discardConfirmationOpen,
    view.busy,
    view.editor?.saving,
    view.history?.loading,
    view.history?.restoring,
    view.task
  ]);

  return (
    <>
      <div
        ref={dialogRef}
        className="fixed inset-0 z-50 flex h-[100dvh] w-full flex-col overflow-hidden bg-app-canvas pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-ink"
        role="dialog"
        aria-busy={
          view.busy || view.editor?.saving || view.history?.loading || view.history?.restoring || undefined
        }
        aria-hidden={discardConfirmationOpen || undefined}
        aria-label="Assistants"
        aria-modal="true"
        data-testid="assistant-library"
        inert={discardConfirmationOpen || undefined}
      >
        {view.task === "editor" && view.editor ? (
          <EditorTask
            busy={view.busy}
            entryRef={taskEntryRef}
            editor={view.editor}
            notice={view.notice}
            onDismissNotice={view.onDismissNotice}
            onRequestClose={requestEditorClose}
          />
        ) : view.task === "history" && view.history ? (
          <HistoryTask
            busy={view.busy}
            entryRef={taskEntryRef}
            history={view.history}
            notice={view.notice}
            onDismissNotice={view.onDismissNotice}
          />
        ) : (
          <ListTask
            busy={view.busy}
            catalogError={view.catalogError}
            catalogState={view.catalogState}
            list={view.list}
            entryRef={taskEntryRef}
            notice={view.notice}
            onBackToChat={view.onBackToChat}
            onDismissNotice={view.onDismissNotice}
            onRetryCatalog={view.onRetryCatalog}
          />
        )}
      </div>
      {discardConfirmationOpen ? (
        <DiscardChangesConfirmationDialog
          label="assistant draft"
          onCancel={() => setDiscardConfirmationOpen(false)}
          onConfirm={() => {
            setDiscardConfirmationOpen(false);
            view.editor?.onCancel();
          }}
        />
      ) : null}
    </>
  );
}

function NoticeRow({ notice, onDismiss }: { notice: LibraryNotice; onDismiss(): void }) {
  return (
    <div
      className="shrink-0 border-b border-trace-subtle bg-app-canvas px-3 py-2 sm:px-6 lg:px-8"
      data-testid="assistant-library-notice"
    >
      <div
        className={[
          "flex w-full max-w-2xl items-center justify-between gap-3 rounded-control border-l-2 bg-overlay-surface px-3 py-2 text-sm text-ink-secondary shadow-float",
          notice.kind === "error" ? "border-critical/45" : "border-positive/45"
        ].join(" ")}
        role={notice.kind === "error" ? "alert" : "status"}
        aria-live={notice.kind === "error" ? "assertive" : "polite"}
      >
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{notice.text}</span>
        <button className={quietButton} type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function ListTask({
  busy,
  catalogError,
  catalogState,
  entryRef,
  list,
  notice,
  onBackToChat,
  onDismissNotice,
  onRetryCatalog
}: {
  busy: boolean;
  catalogError: string | null;
  catalogState: "error" | "loading" | "ready";
  entryRef: Ref<HTMLButtonElement>;
  list: AssistantLibraryListView;
  notice: LibraryNotice | null;
  onBackToChat(): void;
  onDismissNotice(): void;
  onRetryCatalog(): void;
}) {
  const modeAssistants = list.assistants.filter((assistant) =>
    list.mode === "yours" ? assistant.owned : !assistant.owned
  );
  const visible = visibleAssistants(modeAssistants, list);
  const filters = list.mode === "yours" ? YOURS_FILTERS : DISCOVER_FILTERS;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-trace-subtle bg-app-canvas px-3 pt-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
          <button ref={entryRef} className={quietButton} disabled={busy} type="button" onClick={onBackToChat}>
            <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
            Back to chat
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold tracking-tight text-ink">Assistants</h1>
          </div>
          <label className="relative block w-full min-w-0 sm:w-64" htmlFor="assistant-library-search">
            <span className="sr-only">Search assistants</span>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
              aria-hidden="true"
            />
            <input
              className={`${fieldInput} pl-9`}
              disabled={busy}
              id="assistant-library-search"
              type="search"
              autoComplete="off"
              placeholder="Search assistants"
              value={list.query}
              onChange={(event) => list.onQueryChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && list.query) {
                  event.preventDefault();
                  event.stopPropagation();
                  list.onQueryChange("");
                }
              }}
            />
          </label>
          <button className={primaryButton} disabled={busy} type="button" onClick={list.onNewAssistant}>
            <Plus className="size-4" aria-hidden="true" />
            New assistant
          </button>
        </div>
        <div aria-label="Assistant views" className="mt-2 flex gap-6" role="tablist">
          {(
            [
              ["discover", "Discover"],
              ["yours", "Yours"]
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              aria-selected={list.mode === mode}
              className={tabClass(list.mode === mode)}
              disabled={busy}
              onClick={() => list.onModeChange(mode)}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}

      {catalogState !== "ready" ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto overscroll-contain px-4 py-8">
          <div className="w-full max-w-sm text-center">
            {catalogState === "loading" ? (
              <>
                <LoaderCircle className="mx-auto size-6 animate-spin text-proof" aria-hidden="true" />
                <p className="mt-3 text-sm font-semibold text-ink" role="status">
                  Loading assistants…
                </p>
                <p className="mt-1 text-xs leading-5 text-ink-muted">
                  Assistants appear when the catalog finishes loading.
                </p>
              </>
            ) : (
              <>
                <RotateCcw className="mx-auto size-6 text-critical" aria-hidden="true" />
                <p className="mt-3 text-sm font-semibold text-ink" role="alert">
                  Assistants didn’t load
                </p>
                <p className="mt-1 text-xs leading-5 text-ink-secondary">
                  {catalogError ?? "Try loading assistants again."}
                </p>
                <button className={`${surfaceButton} mt-4`} disabled={busy} type="button" onClick={onRetryCatalog}>
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Retry
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 lg:px-8">
          <div aria-label="Filters" className="flex flex-wrap gap-2" role="group">
            {filters.map(([filter, label]) => (
              <button
                key={filter}
                aria-pressed={list.filter === filter}
                className={chipClass(list.filter === filter)}
                disabled={busy}
                onClick={() => list.onFilterChange(filter)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          <div aria-label="Categories" className="mt-2 flex flex-wrap gap-2" role="group">
            <button
              aria-label="All categories"
              aria-pressed={list.category === null}
              className={chipClass(list.category === null)}
              disabled={busy}
              onClick={() => list.onCategoryChange(null)}
              type="button"
            >
              All
            </button>
            {ASSISTANT_CATEGORIES.map((category) => (
              <button
                key={category}
                aria-pressed={list.category === category}
                className={chipClass(list.category === category)}
                disabled={busy}
                onClick={() => list.onCategoryChange(category)}
                type="button"
              >
                {ASSISTANT_CATEGORY_LABELS[category]}
              </button>
            ))}
          </div>

          {modeAssistants.length === 0 ? (
            <div className="px-2 py-10 text-center">
              <p className="text-sm font-semibold text-ink">
                {list.mode === "yours" ? "No assistants yet" : "Nothing shared yet"}
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-ink-muted">
                {list.mode === "yours"
                  ? "Save a model, instructions, and tools once, then reuse them in any chat."
                  : "Assistants shared with your groups or the whole installation appear here."}
              </p>
              <button className={`${surfaceButton} mt-4`} disabled={busy} type="button" onClick={list.onNewAssistant}>
                <Plus className="size-4" aria-hidden="true" />
                Create your first assistant
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="px-2 py-10 text-center" role="status">
              <p className="text-sm font-semibold text-ink">No matching assistants</p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-ink-muted">
                Try another search, filter, or category.
              </p>
            </div>
          ) : (
            <ul
              aria-label="Assistants"
              className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
              data-testid="assistant-library-grid"
            >
              {visible.map((assistant) => (
                <AssistantCard key={assistant.id} assistant={assistant} busy={busy} list={list} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function AssistantCard({
  assistant,
  busy,
  list
}: {
  assistant: AssistantSummary;
  busy: boolean;
  list: AssistantLibraryListView;
}) {
  const capability = capabilityLine(assistant.fingerprint);
  const metadata = [
    assistant.owned ? "Yours" : assistant.ownerDisplayName,
    assistant.category ? ASSISTANT_CATEGORY_LABELS[assistant.category] : null,
    `Rev ${assistant.revisionNumber}`
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
  const useDisabled = !assistant.availability.ok || assistant.archived;

  return (
    <li
      className="flex min-w-0 flex-col gap-2 rounded-panel border border-trace-subtle bg-answer-paper p-4"
      data-testid={`assistant-card-${assistant.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <AssistantAvatar className="shrink-0" recipe={assistant.avatar} size={44} />
        {assistant.archived ? (
          <span className="rounded-pill bg-control-surface px-2 py-0.5 text-metadata font-medium text-ink-secondary">
            Archived
          </span>
        ) : null}
      </div>
      <h2 className="break-words text-sm font-semibold leading-5 text-ink [overflow-wrap:anywhere]">
        {assistant.name}
      </h2>
      {assistant.description ? (
        <p className="line-clamp-3 break-words text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">
          {assistant.description}
        </p>
      ) : null}
      {assistant.availability.ok ? (
        capability ? (
          <p className="text-metadata text-ink-muted">{capability}</p>
        ) : null
      ) : (
        <p className="text-metadata font-medium text-caution">Required access unavailable</p>
      )}
      <p className="text-metadata text-ink-muted">{metadata}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
        <button
          aria-label={`${assistant.pinned ? "Unpin" : "Pin"} ${assistant.name}`}
          aria-pressed={assistant.pinned}
          className={quietButton}
          disabled={busy}
          onClick={() => list.onPinToggle(assistant.id, !assistant.pinned)}
          type="button"
        >
          {assistant.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          aria-label={`Use ${assistant.name}`}
          className={useButton}
          disabled={busy || useDisabled}
          onClick={() => list.onUse(assistant.id)}
          type="button"
        >
          Use
        </button>
        {assistant.owned ? (
          <CardMenu assistant={assistant} busy={busy} list={list} />
        ) : (
          <button
            aria-label={`Duplicate ${assistant.name}`}
            className={quietButton}
            disabled={busy}
            onClick={() => list.onDuplicate(assistant.id)}
            type="button"
          >
            Duplicate
          </button>
        )}
      </div>
    </li>
  );
}

function CardMenu({
  assistant,
  busy,
  list
}: {
  assistant: AssistantSummary;
  busy: boolean;
  list: AssistantLibraryListView;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = window.setTimeout(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    }, 0);
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  const closeAnd = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`More actions for ${assistant.name}`}
        className={quietButton}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        More
      </button>
      {open ? (
        <div
          ref={menuRef}
          aria-label={`Actions for ${assistant.name}`}
          className="absolute right-0 top-full z-30 mt-1 w-56 rounded-panel border border-trace-subtle bg-overlay-surface p-1.5 shadow-overlay"
          role="menu"
        >
          <button
            className={menuItem}
            disabled={busy}
            onClick={closeAnd(() => list.onEdit(assistant.id))}
            role="menuitem"
            type="button"
          >
            Edit
          </button>
          <button
            className={menuItem}
            disabled={busy}
            onClick={closeAnd(() => list.onOpenHistory(assistant.id))}
            role="menuitem"
            type="button"
          >
            Version history
          </button>
          <button
            className={menuItem}
            disabled={busy}
            onClick={closeAnd(() => list.onDuplicate(assistant.id))}
            role="menuitem"
            type="button"
          >
            Duplicate
          </button>
          <button
            className={menuItem}
            disabled={busy}
            onClick={closeAnd(() => list.onArchiveToggle(assistant.id, !assistant.archived))}
            role="menuitem"
            type="button"
          >
            {assistant.archived ? "Restore" : "Archive"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EditorGroup({
  children,
  id,
  onToggle,
  open,
  title
}: {
  children: ReactNode;
  id: string;
  onToggle(): void;
  open: boolean;
  title: string;
}) {
  const contentId = `assistant-editor-group-${id}`;
  return (
    <section className="rounded-panel border border-trace-subtle bg-answer-paper">
      <h2 className="min-w-0">
        <button
          aria-controls={open ? contentId : undefined}
          aria-expanded={open}
          className={`flex min-h-touch w-full items-center justify-between gap-2 rounded-panel px-3 text-left text-sm font-semibold text-ink hover:bg-control-hover ${coarsePointerTarget} ${focusRing}`}
          onClick={onToggle}
          type="button"
        >
          {title}
          <ChevronDown
            aria-hidden="true"
            className={`size-4 shrink-0 text-ink-muted ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h2>
      {open ? (
        <div className="space-y-4 border-t border-trace-subtle px-3 py-3" id={contentId}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

function ToggleRow({
  disabled,
  id,
  label,
  onToggle,
  value
}: {
  disabled: boolean;
  id: string;
  label: string;
  onToggle(next: boolean): void;
  value: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-ink-secondary" id={`${id}-label`}>
        {label}
      </span>
      <button
        aria-checked={value}
        aria-labelledby={`${id}-label`}
        className={`inline-flex min-h-touch min-w-touch items-center justify-center rounded-control px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control-sm ${coarsePointerTarget} ${focusRing} ${
          value ? "bg-control-selected text-ink" : "bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink"
        }`}
        disabled={disabled}
        onClick={() => onToggle(!value)}
        role="switch"
        type="button"
      >
        {value ? "On" : "Off"}
      </button>
    </div>
  );
}

function SharingGroup({ editor, locked }: { editor: AssistantEditorView; locked: boolean }) {
  const [publishGroupId, setPublishGroupId] = useState("");
  const publications = editor.publications ?? [];

  return (
    <div className="space-y-4">
      {publications.length === 0 ? (
        <p className="text-metadata text-ink-muted">Not shared yet.</p>
      ) : (
        <ul aria-label="Publications" className="divide-y divide-trace-subtle">
          {publications.map((publication) => {
            const target = publication.scope === "installation"
              ? "Installation"
              : publication.scope === "project"
                ? "Project publication"
                : publication.groupName ?? "Group";
            return (
              <li className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0" key={publication.id}>
                <span className="min-w-0">
                  <span className="block break-words text-xs font-medium text-ink [overflow-wrap:anywhere]">
                    {target}
                  </span>
                  <span className="block text-metadata text-ink-muted">
                    Revision {publication.revisionNumber}{publication.scope === "project" ? " · Project details remain private" : ""}
                  </span>
                </span>
                <button
                  aria-label={`Revoke ${target} publication`}
                  className={quietButton}
                  disabled={locked}
                  onClick={() => editor.onRevokePublication(publication.id)}
                  type="button"
                >
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {editor.publishableGroups.length > 0 ? (
        <div>
          <label className={fieldLabel} htmlFor="assistant-editor-publish-group">
            Publish to a group
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-40 flex-1">
              <select
                className={fieldInput}
                disabled={locked}
                id="assistant-editor-publish-group"
                value={publishGroupId}
                onChange={(event) => setPublishGroupId(event.currentTarget.value)}
              >
                <option value="">Choose a group…</option>
                {editor.publishableGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              className={surfaceButton}
              disabled={locked || !publishGroupId}
              onClick={() => editor.onPublish({ groupId: publishGroupId, scope: "group" })}
              type="button"
            >
              Publish to group
            </button>
          </div>
        </div>
      ) : null}
      {editor.canPublishInstallation ? (
        <button
          className={surfaceButton}
          disabled={locked}
          onClick={() => editor.onPublish({ scope: "installation" })}
          type="button"
        >
          Publish to installation
        </button>
      ) : null}
      <p className="text-metadata leading-5 text-ink-muted">
        Saving a revision never changes what a publication shares. Publish update moves it to the newest revision.
      </p>
    </div>
  );
}

function EditorTask({
  busy,
  editor,
  entryRef,
  notice,
  onDismissNotice,
  onRequestClose
}: {
  busy: boolean;
  editor: AssistantEditorView;
  entryRef: Ref<HTMLButtonElement>;
  notice: LibraryNotice | null;
  onDismissNotice(): void;
  onRequestClose(): void;
}) {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ "run-setup": true });
  const draft = editor.draft;
  const selectedModel = editor.options.models.find((model) => model.id === draft.providerModelId) ?? null;
  const controls = selectedModel?.controls ?? null;
  const mutationLocked = busy || editor.saving;
  const saveDisabled = mutationLocked || !draft.name.trim() || draft.providerModelId === null;
  const title = draft.name.trim() || "New assistant";
  const searchLimitReached = draft.searchOptionIds.length >= MAX_SEARCH_PLAN_OPTIONS;
  const knowledgeLimitReached = draft.knowledgeBaseIds.length >= KNOWLEDGE_PLAN_MAX_BASES;
  const skillLimitReached = draft.skillIds.length >= SKILL_MAX_SELECTED;
  const toolsCaution = selectedModel !== null && !selectedModel.supportsTools && draft.mcpServerIds.length > 0;

  const providerGroups: { models: AssistantEditorView["options"]["models"]; providerLabel: string }[] = [];
  for (const model of editor.options.models) {
    const group = providerGroups.find((candidate) => candidate.providerLabel === model.providerLabel);
    if (group) {
      group.models.push(model);
    } else {
      providerGroups.push({ models: [model], providerLabel: model.providerLabel });
    }
  }

  const toggleGroup = (id: string) =>
    setOpenGroups((groups) => ({ ...groups, [id]: !(groups[id] ?? false) }));

  const toggleSearchOption = (optionId: string, checked: boolean) =>
    editor.onChange({
      searchOptionIds: checked
        ? [...draft.searchOptionIds, optionId]
        : draft.searchOptionIds.filter((id) => id !== optionId)
    });

  const toggleMcpServer = (serverId: string, checked: boolean) =>
    editor.onChange({
      mcpServerIds: checked
        ? [...draft.mcpServerIds, serverId]
        : draft.mcpServerIds.filter((id) => id !== serverId)
    });

  const toggleKnowledgeBase = (baseId: string, checked: boolean) =>
    editor.onChange({
      knowledgeBaseIds: checked
        ? [...draft.knowledgeBaseIds, baseId]
        : draft.knowledgeBaseIds.filter((id) => id !== baseId)
    });

  const toggleSkill = (skillId: string, checked: boolean) =>
    editor.onChange({
      skillIds: checked
        ? [...draft.skillIds, skillId]
        : draft.skillIds.filter((id) => id !== skillId)
    });

  const updateStarter = (index: number, value: string) => {
    const next = [...draft.starterPrompts];
    next[index] = value;
    editor.onChange({ starterPrompts: next });
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="assistant-editor">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-trace-subtle bg-app-canvas px-3 py-3 sm:gap-3 sm:px-6 lg:px-8">
        <button
          ref={entryRef}
          className={quietButton}
          disabled={mutationLocked}
          onClick={onRequestClose}
          type="button"
        >
          <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
          Back to assistants
        </button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight text-ink">{title}</h1>
        <span className="rounded-pill bg-control-surface px-2.5 py-1 text-metadata font-medium text-ink-secondary">
          {editor.revisionNumber === null ? "Draft" : `Revision ${editor.revisionNumber}`}
        </span>
      </header>

      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto grid w-full max-w-6xl items-start gap-8 lg:[@media(min-height:32.01rem)]:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="min-w-0 space-y-8">
            <section aria-labelledby="assistant-identity-heading">
              <h2 className="text-sm font-semibold text-ink" id="assistant-identity-heading">
                Identity
              </h2>
              <div className="mt-3 flex flex-wrap items-start gap-5">
                <div className="flex shrink-0 flex-col items-center gap-2">
                  <AssistantAvatar label="Assistant avatar preview" recipe={draft.avatar} size={96} />
                  <button
                    className={quietButton}
                    disabled={mutationLocked}
                    onClick={editor.onGenerateAvatar}
                    type="button"
                  >
                    Generate another
                  </button>
                </div>
                <div className="min-w-56 flex-1 space-y-4">
                  <div>
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <label className="text-xs font-medium text-ink-secondary" htmlFor="assistant-editor-name">
                        Name
                      </label>
                      <span aria-hidden="true" className="text-metadata text-ink-muted">
                        Required
                      </span>
                    </div>
                    <input
                      aria-required="true"
                      autoComplete="off"
                      className={fieldInput}
                      disabled={mutationLocked}
                      id="assistant-editor-name"
                      maxLength={ASSISTANT_NAME_MAX_LENGTH}
                      placeholder="For example, Release-note writer"
                      type="text"
                      value={draft.name}
                      onChange={(event) => editor.onChange({ name: event.currentTarget.value })}
                    />
                  </div>
                  <div>
                    <label className={fieldLabel} htmlFor="assistant-editor-description">
                      Description
                    </label>
                    <textarea
                      aria-describedby="assistant-editor-description-help"
                      className={fieldTextarea}
                      disabled={mutationLocked}
                      id="assistant-editor-description"
                      maxLength={ASSISTANT_DESCRIPTION_MAX_LENGTH}
                      rows={3}
                      value={draft.description}
                      onChange={(event) => editor.onChange({ description: event.currentTarget.value })}
                    />
                    <p className="mt-1 text-metadata text-ink-muted" id="assistant-editor-description-help">
                      Shown in Assistants and the picker. Never added to the prompt.
                    </p>
                  </div>
                  <div>
                    <label className={fieldLabel} htmlFor="assistant-editor-category">
                      Category
                    </label>
                    <select
                      className={fieldInput}
                      disabled={mutationLocked}
                      id="assistant-editor-category"
                      value={draft.category ?? ""}
                      onChange={(event) =>
                        editor.onChange({
                          category: event.currentTarget.value
                            ? (event.currentTarget.value as AssistantCategory)
                            : null
                        })
                      }
                    >
                      <option value="">All categories</option>
                      {ASSISTANT_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {ASSISTANT_CATEGORY_LABELS[category]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </section>

            <section aria-labelledby="assistant-instructions-heading">
              <h2 className="text-sm font-semibold text-ink" id="assistant-instructions-heading">
                Instructions
              </h2>
              <div className="mt-3 space-y-4">
                <div>
                  <label className={fieldLabel} htmlFor="assistant-editor-system">
                    System prompt
                  </label>
                  <textarea
                    className={fieldTextarea}
                    disabled={mutationLocked}
                    id="assistant-editor-system"
                    maxLength={ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH}
                    placeholder="Define the assistant’s role, priorities, and response style."
                    rows={8}
                    value={draft.systemPrompt}
                    onChange={(event) => editor.onChange({ systemPrompt: event.currentTarget.value })}
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <label className="text-xs font-medium text-ink-secondary" htmlFor="assistant-editor-developer">
                      Developer prompt
                    </label>
                    <span aria-hidden="true" className="text-metadata text-ink-muted">
                      Optional
                    </span>
                  </div>
                  <textarea
                    className={fieldTextarea}
                    disabled={mutationLocked}
                    id="assistant-editor-developer"
                    maxLength={ASSISTANT_DEVELOPER_PROMPT_MAX_LENGTH}
                    rows={4}
                    value={draft.developerPrompt}
                    onChange={(event) => editor.onChange({ developerPrompt: event.currentTarget.value })}
                  />
                </div>
              </div>
            </section>
          </div>

          <div className="min-w-0 space-y-3">
            <EditorGroup
              id="run-setup"
              onToggle={() => toggleGroup("run-setup")}
              open={openGroups["run-setup"] ?? false}
              title="Run setup"
            >
              <div>
                <label className={fieldLabel} htmlFor="assistant-editor-model">
                  Model
                </label>
                <select
                  className={fieldInput}
                  disabled={mutationLocked}
                  id="assistant-editor-model"
                  value={draft.providerModelId ?? ""}
                  onChange={(event) =>
                    editor.onChange({ providerModelId: event.currentTarget.value ? event.currentTarget.value : null })
                  }
                >
                  {draft.providerModelId === null ? <option value="">Choose a model…</option> : null}
                  {providerGroups.map((group) => (
                    <optgroup key={group.providerLabel} label={group.providerLabel}>
                      {group.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              {controls?.reasoningEffort.supported ? (
                <div>
                  <label className={fieldLabel} htmlFor="assistant-editor-reasoning-effort">
                    Reasoning effort
                  </label>
                  <select
                    className={fieldInput}
                    disabled={mutationLocked}
                    id="assistant-editor-reasoning-effort"
                    value={draft.reasoningEffort}
                    onChange={(event) => editor.onChange({ reasoningEffort: event.currentTarget.value })}
                  >
                    {!draft.reasoningEffort ? <option value="">Choose…</option> : null}
                    {draft.reasoningEffort && !controls.reasoningEffort.options.includes(draft.reasoningEffort) ? (
                      <option value={draft.reasoningEffort}>{draft.reasoningEffort}</option>
                    ) : null}
                    {controls.reasoningEffort.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {controls?.reasoningMode?.supported ? (
                <div>
                  <label className={fieldLabel} htmlFor="assistant-editor-reasoning-mode">
                    Reasoning mode
                  </label>
                  <select
                    className={fieldInput}
                    disabled={mutationLocked}
                    id="assistant-editor-reasoning-mode"
                    value={draft.reasoningMode}
                    onChange={(event) => editor.onChange({ reasoningMode: event.currentTarget.value })}
                  >
                    {!draft.reasoningMode ? <option value="">Choose…</option> : null}
                    {draft.reasoningMode && !controls.reasoningMode.options.includes(draft.reasoningMode) ? (
                      <option value={draft.reasoningMode}>{draft.reasoningMode}</option>
                    ) : null}
                    {controls.reasoningMode.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {controls?.temperature.supported ? (
                <div>
                  <label className={fieldLabel} htmlFor="assistant-editor-temperature">
                    Temperature
                  </label>
                  <input
                    className={fieldInput}
                    disabled={mutationLocked}
                    id="assistant-editor-temperature"
                    inputMode="decimal"
                    max={controls.temperature.maxValue}
                    min={controls.temperature.minValue}
                    step={0.1}
                    type="number"
                    value={draft.temperature}
                    onChange={(event) => editor.onChange({ temperature: event.currentTarget.value })}
                  />
                </div>
              ) : null}
              {controls ? (
                <div>
                  <label className={fieldLabel} htmlFor="assistant-editor-max-tokens">
                    Max output tokens
                  </label>
                  <input
                    className={fieldInput}
                    disabled={mutationLocked}
                    id="assistant-editor-max-tokens"
                    inputMode="numeric"
                    max={controls.maxOutputTokens.maxValue}
                    min={1}
                    type="number"
                    value={draft.maxOutputTokens}
                    onChange={(event) => editor.onChange({ maxOutputTokens: event.currentTarget.value })}
                  />
                </div>
              ) : null}
              {controls?.background.supported ? (
                <ToggleRow
                  disabled={mutationLocked}
                  id="assistant-editor-background"
                  label="Background"
                  value={draft.backgroundMode}
                  onToggle={(next) => editor.onChange({ backgroundMode: next })}
                />
              ) : null}
              {controls?.stream.supported ? (
                <ToggleRow
                  disabled={mutationLocked}
                  id="assistant-editor-stream"
                  label="Stream"
                  value={draft.streamMode}
                  onToggle={(next) => editor.onChange({ streamMode: next })}
                />
              ) : null}
              {!controls ? (
                <p className="text-metadata text-ink-muted">
                  Choose a model to set reasoning, sampling, and delivery controls.
                </p>
              ) : null}
            </EditorGroup>

            <EditorGroup
              id="knowledge"
              onToggle={() => toggleGroup("knowledge")}
              open={openGroups.knowledge ?? false}
              title="Knowledge"
            >
              <p className="text-metadata leading-5 text-ink-muted">
                This ordered list is exact. Chat and project defaults are not merged into Assistant runs.
              </p>
              <fieldset>
                <legend className="mb-1.5 text-xs font-medium text-ink-secondary">Knowledge bases</legend>
                <div className="space-y-2">
                  {draft.knowledgeBaseIds
                    .filter((baseId) => !editor.options.knowledgeBases.some((base) => base.id === baseId))
                    .map((baseId) => {
                      const order = draft.knowledgeBaseIds.indexOf(baseId) + 1;
                      return (
                        <label className={checkboxRow} key={baseId}>
                          <input
                            checked
                            className="size-4 shrink-0 accent-proof"
                            disabled={mutationLocked}
                            type="checkbox"
                            onChange={(event) => toggleKnowledgeBase(baseId, event.currentTarget.checked)}
                          />
                          <span className="min-w-0 break-words text-caution [overflow-wrap:anywhere]">
                            Unavailable base · selection retained · order {order}
                          </span>
                        </label>
                      );
                    })}
                  {editor.options.knowledgeBases.map((base) => {
                    const checked = draft.knowledgeBaseIds.includes(base.id);
                    return (
                      <label className={checkboxRow} key={base.id}>
                        <input
                          checked={checked}
                          className="size-4 shrink-0 accent-proof"
                          disabled={mutationLocked || (!checked && (!base.available || knowledgeLimitReached))}
                          type="checkbox"
                          onChange={(event) => toggleKnowledgeBase(base.id, event.currentTarget.checked)}
                        />
                        <span className={`min-w-0 break-words [overflow-wrap:anywhere] ${base.available ? "" : "text-caution"}`}>
                          {base.name}{base.available ? "" : checked ? " · unavailable, retained" : " · unavailable"}
                          {checked ? ` · order ${draft.knowledgeBaseIds.indexOf(base.id) + 1}` : ""}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              {editor.options.knowledgeDataState === "loading" && editor.options.knowledgeBases.length === 0 ? (
                <p className="text-metadata text-ink-muted" role="status">Loading Knowledge bases…</p>
              ) : null}
              {editor.options.knowledgeDataState === "error" ? (
                <div className="rounded-control border border-critical/30 bg-critical/10 p-3 text-metadata text-critical" role="alert">
                  <p>{editor.options.knowledgeDataError ?? "Knowledge bases could not be loaded."}</p>
                  <button
                    className="mt-2 h-touch rounded-control bg-control-surface px-3 font-semibold text-ink outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                    type="button"
                    disabled={mutationLocked}
                    onClick={editor.options.onRetryKnowledge}
                  >
                    Retry Knowledge
                  </button>
                </div>
              ) : null}
              {editor.options.knowledgeDataState === "ready" && editor.options.knowledgeBases.length === 0 && draft.knowledgeBaseIds.length === 0 ? (
                <p className="text-metadata text-ink-muted">No Knowledge bases are available.</p>
              ) : null}
              <p className="text-metadata text-ink-muted">Up to {KNOWLEDGE_PLAN_MAX_BASES} bases per Assistant.</p>
            </EditorGroup>

            <EditorGroup
              id="skills"
              onToggle={() => toggleGroup("skills")}
              open={openGroups.skills ?? false}
              title="Skills"
            >
              <p className="text-metadata leading-5 text-ink-muted">
                Skills run in this order. Their latest text applies to future runs automatically.
              </p>
              <fieldset>
                <legend className="mb-1.5 text-xs font-medium text-ink-secondary">Included Skills</legend>
                <div className="space-y-2">
                  {draft.skillIds
                    .filter((skillId) => !editor.options.skills.some((skill) => skill.id === skillId))
                    .map((skillId) => {
                      const order = draft.skillIds.indexOf(skillId) + 1;
                      return (
                        <label className={checkboxRow} key={skillId}>
                          <input
                            checked
                            className="size-4 shrink-0 accent-proof"
                            disabled={mutationLocked}
                            type="checkbox"
                            onChange={(event) => toggleSkill(skillId, event.currentTarget.checked)}
                          />
                          <span className="min-w-0 break-words text-caution [overflow-wrap:anywhere]">
                            Unavailable Skill · selection retained · order {order}
                          </span>
                        </label>
                      );
                    })}
                  {editor.options.skills.map((skill) => {
                    const checked = draft.skillIds.includes(skill.id);
                    const available = !skill.archived;
                    return (
                      <label className={checkboxRow} key={skill.id}>
                        <input
                          checked={checked}
                          className="size-4 shrink-0 accent-proof"
                          disabled={mutationLocked || (!checked && (!available || skillLimitReached))}
                          type="checkbox"
                          onChange={(event) => toggleSkill(skill.id, event.currentTarget.checked)}
                        />
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                          <span className={available ? "block" : "block text-caution"}>
                            {skill.name}{available ? "" : checked ? " · unavailable, retained" : " · unavailable"}
                            {checked ? ` · order ${draft.skillIds.indexOf(skill.id) + 1}` : ""}
                          </span>
                          <span className="block text-metadata text-ink-muted">
                            {skill.ownerDisplayName} · {skillScopeLabel(skill)}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              {editor.options.skillDataState === "loading" && editor.options.skills.length === 0 ? (
                <p className="text-metadata text-ink-muted" role="status">Loading Skills…</p>
              ) : null}
              {editor.options.skillDataState === "error" ? (
                <div className="rounded-control border border-critical/30 bg-critical/10 p-3 text-metadata text-critical" role="alert">
                  <p>{editor.options.skillDataError ?? "Skills could not be loaded."}</p>
                  <button
                    className="mt-2 h-touch rounded-control bg-control-surface px-3 font-semibold text-ink outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                    type="button"
                    disabled={mutationLocked}
                    onClick={editor.options.onRetrySkills}
                  >
                    Retry Skills
                  </button>
                </div>
              ) : null}
              {editor.options.skillDataState === "ready" && editor.options.skills.length === 0 && draft.skillIds.length === 0 ? (
                <p className="text-metadata text-ink-muted">No Skills are available.</p>
              ) : null}
              <p className="text-metadata text-ink-muted">Up to {SKILL_MAX_SELECTED} Skills per Assistant.</p>
            </EditorGroup>

            <EditorGroup
              id="search"
              onToggle={() => toggleGroup("search")}
              open={openGroups["search"] ?? false}
              title="Search"
            >
              {editor.options.searchOptions.length === 0 ? (
                <p className="text-metadata text-ink-muted">No search sources are available.</p>
              ) : (
                <>
                  <fieldset>
                    <legend className="mb-1.5 text-xs font-medium text-ink-secondary">Search sources</legend>
                    <div className="space-y-2">
                      {editor.options.searchOptions.map((option) => {
                        const checked = draft.searchOptionIds.includes(option.id);
                        return (
                          <label className={checkboxRow} key={option.id}>
                            <input
                              checked={checked}
                              className="size-4 shrink-0 accent-proof"
                              disabled={mutationLocked || (!checked && searchLimitReached)}
                              type="checkbox"
                              onChange={(event) => toggleSearchOption(option.id, event.currentTarget.checked)}
                            />
                            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{option.label}</span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-metadata text-ink-muted">
                      Up to {MAX_SEARCH_PLAN_OPTIONS} sources per assistant.
                    </p>
                  </fieldset>
                  {draft.searchOptionIds.length > 1 ? (
                    <fieldset>
                      <legend className="mb-1.5 text-xs font-medium text-ink-secondary">Search use</legend>
                      <div className="space-y-2">
                        <label className={checkboxRow}>
                          <input
                            checked={draft.searchPlanMode === "all_selected"}
                            className="size-4 shrink-0 accent-proof"
                            disabled={mutationLocked}
                            name="assistant-editor-search-mode"
                            type="radio"
                            onChange={() => editor.onChange({ searchPlanMode: "all_selected" })}
                          />
                          <span>All selected per search</span>
                        </label>
                        <label className={checkboxRow}>
                          <input
                            checked={draft.searchPlanMode === "model_choice"}
                            className="size-4 shrink-0 accent-proof"
                            disabled={mutationLocked}
                            name="assistant-editor-search-mode"
                            type="radio"
                            onChange={() => editor.onChange({ searchPlanMode: "model_choice" })}
                          />
                          <span>Model chooses</span>
                        </label>
                      </div>
                    </fieldset>
                  ) : null}
                </>
              )}
            </EditorGroup>

            <EditorGroup
              id="mcp-tools"
              onToggle={() => toggleGroup("mcp-tools")}
              open={openGroups["mcp-tools"] ?? false}
              title="MCP tools"
            >
              {editor.options.mcpServers.length === 0 ? (
                <p className="text-metadata text-ink-muted">No MCP servers are available.</p>
              ) : (
                <fieldset>
                  <legend className="mb-1.5 text-xs font-medium text-ink-secondary">MCP servers</legend>
                  <div className="space-y-2">
                    {editor.options.mcpServers.map((server) => (
                      <label className={checkboxRow} key={server.id}>
                        <input
                          checked={draft.mcpServerIds.includes(server.id)}
                          className="size-4 shrink-0 accent-proof"
                          disabled={mutationLocked}
                          type="checkbox"
                          onChange={(event) => toggleMcpServer(server.id, event.currentTarget.checked)}
                        />
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{server.name}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              {toolsCaution ? (
                <p className="text-xs font-medium leading-5 text-caution" role="status">
                  This model cannot call tools.
                </p>
              ) : null}
            </EditorGroup>

            <EditorGroup
              id="starter-prompts"
              onToggle={() => toggleGroup("starter-prompts")}
              open={openGroups["starter-prompts"] ?? false}
              title="Starter prompts"
            >
              {draft.starterPrompts.length === 0 ? (
                <p className="text-metadata text-ink-muted">
                  Starters appear as one-tap openers when a chat begins with this assistant.
                </p>
              ) : null}
              <div className="space-y-2">
                {draft.starterPrompts.map((starter, index) => (
                  <div className="flex items-center gap-2" key={index}>
                    <label className="sr-only" htmlFor={`assistant-editor-starter-${index}`}>
                      Starter prompt {index + 1}
                    </label>
                    <input
                      className={fieldInput}
                      disabled={mutationLocked}
                      id={`assistant-editor-starter-${index}`}
                      maxLength={ASSISTANT_STARTER_PROMPT_MAX_LENGTH}
                      type="text"
                      value={starter}
                      onChange={(event) => updateStarter(index, event.currentTarget.value)}
                    />
                    <button
                      aria-label={`Remove starter prompt ${index + 1}`}
                      className={quietButton}
                      disabled={mutationLocked}
                      onClick={() =>
                        editor.onChange({
                          starterPrompts: draft.starterPrompts.filter((_, position) => position !== index)
                        })
                      }
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              {draft.starterPrompts.length < ASSISTANT_MAX_STARTER_PROMPTS ? (
                <button
                  className={surfaceButton}
                  disabled={mutationLocked}
                  onClick={() => editor.onChange({ starterPrompts: [...draft.starterPrompts, ""] })}
                  type="button"
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Add starter
                </button>
              ) : null}
            </EditorGroup>

            {editor.mode === "edit" && editor.publications !== null ? (
              <EditorGroup
                id="sharing"
                onToggle={() => toggleGroup("sharing")}
                open={openGroups["sharing"] ?? false}
                title="Sharing"
              >
                <SharingGroup editor={editor} locked={mutationLocked} />
              </EditorGroup>
            ) : editor.mode === "create" ? (
              <p className="px-1 text-metadata leading-5 text-ink-muted">
                Private after creation. Share from the editor once created.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <footer className="shrink-0 border-t border-trace-subtle bg-app-canvas px-3 py-3 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-6xl">
          {editor.error ? (
            <p
              className="mb-2 break-words text-xs font-medium leading-5 text-critical [overflow-wrap:anywhere]"
              id="assistant-editor-error"
              role="alert"
            >
              {editor.error.text} ({editor.error.code})
            </p>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {editor.dirty ? (
              <p aria-live="polite" className="mr-auto text-xs font-medium text-caution" role="status">
                Unsaved changes
              </p>
            ) : null}
            {editor.onUseInChat ? (
              <button
                className={surfaceButton}
                disabled={mutationLocked || editor.dirty}
                onClick={editor.onUseInChat}
                type="button"
              >
                Use in chat
              </button>
            ) : null}
            <button className={quietButton} disabled={mutationLocked} onClick={onRequestClose} type="button">
              Cancel
            </button>
            <button
              aria-busy={editor.saving || undefined}
              aria-describedby={editor.error ? "assistant-editor-error" : undefined}
              className={primaryButton}
              data-testid="assistant-editor-save"
              disabled={saveDisabled}
              onClick={editor.onSave}
              type="button"
            >
              {editor.saving ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
              {editor.mode === "create" ? "Create assistant" : "Save revision"}
            </button>
          </div>
        </div>
      </footer>
    </section>
  );
}

function HistoryTask({
  busy,
  entryRef,
  history,
  notice,
  onDismissNotice
}: {
  busy: boolean;
  entryRef: Ref<HTMLButtonElement>;
  history: AssistantHistoryView;
  notice: LibraryNotice | null;
  onDismissNotice(): void;
}) {
  const newestRevision = history.entries.reduce((max, entry) => Math.max(max, entry.revisionNumber), 0);
  const viewed = history.viewedRevision;
  const locked = busy || history.restoring;

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="assistant-history">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-trace-subtle bg-app-canvas px-3 py-3 sm:gap-3 sm:px-6 lg:px-8">
        <button ref={entryRef} className={quietButton} disabled={locked} onClick={history.onBack} type="button">
          <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
          Back
        </button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight text-ink">
          Version history · {history.assistantName}
        </h1>
      </header>

      {notice ? <NoticeRow notice={notice} onDismiss={onDismissNotice} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-5 sm:px-6 lg:px-8">
        <div
          className={`mx-auto grid w-full max-w-6xl items-start gap-6 ${
            viewed ? "lg:[@media(min-height:32.01rem)]:grid-cols-2" : ""
          }`}
        >
          <div className="min-w-0">
            {history.loading ? (
              <p className="flex items-center gap-2 text-sm text-ink-muted" role="status">
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-proof" />
                Loading version history…
              </p>
            ) : history.entries.length === 0 ? (
              <p className="text-sm text-ink-muted" role="status">
                No revisions yet.
              </p>
            ) : (
              <ul aria-label="Revisions" className="divide-y divide-trace-subtle border-y border-trace-subtle">
                {history.entries.map((entry) => (
                  <li className="flex min-w-0 flex-wrap items-center gap-2 py-3" key={entry.revisionNumber}>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink">Revision {entry.revisionNumber}</p>
                      <p className="mt-0.5 break-words text-metadata text-ink-muted [overflow-wrap:anywhere]">
                        {entry.authorDisplayName ?? "Unknown author"} · {new Date(entry.createdAt).toLocaleString()}
                      </p>
                      {entry.changedSections.length > 0 ? (
                        <p className="mt-0.5 text-metadata text-ink-muted">
                          Changed: {entry.changedSections.map(historySectionLabel).join(", ")}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        aria-label={`View revision ${entry.revisionNumber}`}
                        className={quietButton}
                        disabled={locked}
                        onClick={() => history.onView(entry.revisionNumber)}
                        type="button"
                      >
                        View
                      </button>
                      {entry.revisionNumber !== newestRevision ? (
                        <button
                          aria-label={`Restore revision ${entry.revisionNumber}`}
                          className={quietButton}
                          disabled={locked}
                          onClick={() => history.onRestore(entry.revisionNumber)}
                          type="button"
                        >
                          Restore
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {viewed ? (
            <section
              aria-label={`Revision ${viewed.revisionNumber} content`}
              className="min-w-0 rounded-panel border border-trace-subtle bg-answer-paper p-4"
            >
              <h2 className="text-sm font-semibold text-ink">Revision {viewed.revisionNumber} · read-only</h2>
              <p className="mt-1 text-metadata text-ink-muted">Restore creates a new revision from this content.</p>
              <div className="mt-3 space-y-3">
                <div>
                  <p className={readOnlyLabel}>Name</p>
                  <p className="break-words text-sm text-ink [overflow-wrap:anywhere]">{viewed.name}</p>
                </div>
                <div>
                  <p className={readOnlyLabel}>Description</p>
                  {viewed.description ? (
                    <p className="break-words text-sm leading-6 text-ink [overflow-wrap:anywhere]">
                      {viewed.description}
                    </p>
                  ) : (
                    <p className="text-sm text-ink-muted">No description.</p>
                  )}
                </div>
                <div>
                  <p className={readOnlyLabel}>System prompt</p>
                  <pre className={promptBlock}>{viewed.systemPrompt || "No system prompt."}</pre>
                </div>
                <div>
                  <p className={readOnlyLabel}>Developer prompt</p>
                  {viewed.developerPrompt ? (
                    <pre className={promptBlock}>{viewed.developerPrompt}</pre>
                  ) : (
                    <p className="text-sm text-ink-muted">No developer prompt.</p>
                  )}
                </div>
                <div>
                  <p className={readOnlyLabel}>Starter prompts</p>
                  {viewed.starterPrompts.length > 0 ? (
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6 text-ink">
                      {viewed.starterPrompts.map((starter, index) => (
                        <li className="break-words [overflow-wrap:anywhere]" key={index}>
                          {starter}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-ink-muted">No starter prompts.</p>
                  )}
                </div>
                <p className="text-metadata text-ink-muted">
                  Search sources: {viewed.searchPlan.optionIds.length} · Knowledge bases: {viewed.knowledgeBaseIds.length} · MCP servers: {viewed.mcpServerIds.length}
                </p>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}
