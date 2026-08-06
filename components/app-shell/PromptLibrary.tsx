import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { ShellNotice } from "@/components/app-shell/ShellNotice";
import {
  hasPromptEditorChanges,
  type PromptEditorDraft
} from "@/components/app-shell/promptSettingsStore";
import type { Notice, PromptPreset } from "@/components/app-shell/types";
import {
  ArrowLeft,
  Copy,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Save,
  Search,
  Star,
  Trash2
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDialogFocus } from "./useDialogFocus";

type DiscardIntent =
  | { kind: "close" }
  | { kind: "delete"; prompt: PromptPreset }
  | { kind: "duplicate"; prompt: PromptPreset }
  | { kind: "edit"; prompt: PromptPreset }
  | { kind: "library" }
  | { kind: "new" };

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const coarsePointerTarget = "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const quietButton = `inline-flex min-h-touch items-center justify-center gap-2 rounded-control px-3 text-xs font-medium text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`;

function promptPreview(prompt: PromptPreset) {
  return prompt.systemPrompt.trim() || prompt.developerPrompt?.trim() || "No instructions yet.";
}

function matchesPrompt(prompt: PromptPreset, query: string) {
  if (!query) {
    return true;
  }
  return [prompt.name, prompt.systemPrompt, prompt.developerPrompt ?? ""]
    .some((value) => value.toLocaleLowerCase().includes(query));
}

export function PromptLibrary({
  defaultPromptId,
  editor,
  nestedDialogOpen = false,
  notice = null,
  promptCatalogError = null,
  promptCatalogState = "ready",
  onClose,
  onCreatePrompt,
  onDeletePrompt,
  onDuplicatePrompt,
  onEditPrompt,
  onEditorChange,
  onNewPrompt,
  onRetryCatalog,
  onDismissNotice,
  onSetDefaultPrompt,
  onUpdatePrompt,
  prompts,
  saving
}: {
  defaultPromptId: string | null;
  editor: PromptEditorDraft;
  nestedDialogOpen?: boolean;
  notice?: Notice | null;
  promptCatalogError?: string | null;
  promptCatalogState?: "error" | "loading" | "ready";
  onClose(): void;
  onCreatePrompt(): void;
  onDeletePrompt(prompt: PromptPreset): void;
  onDuplicatePrompt(prompt: PromptPreset): void;
  onEditPrompt(prompt: PromptPreset): void;
  onEditorChange(draft: PromptEditorDraft): void;
  onNewPrompt(): void;
  onRetryCatalog?(): void;
  onDismissNotice?(): void;
  onSetDefaultPrompt(promptId: string): void;
  onUpdatePrompt(): void;
  prompts: PromptPreset[];
  saving: boolean;
}) {
  const [compactPane, setCompactPane] = useState<"editor" | "library">("library");
  const [discardIntent, setDiscardIntent] = useState<DiscardIntent | null>(null);
  const [promptActionsOpen, setPromptActionsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const promptCatalogHeadingRef = useRef<HTMLHeadingElement>(null);
  const promptLibraryHeadingRef = useRef<HTMLHeadingElement>(null);
  const promptNameRef = useRef<HTMLInputElement>(null);
  const promptEditorBodyRef = useRef<HTMLDivElement>(null);
  const promptActionRegionRef = useRef<HTMLDivElement>(null);
  const promptActionsRef = useRef<HTMLDivElement>(null);
  const promptActionsMenuRef = useRef<HTMLDivElement>(null);
  const promptActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const promptRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastPromptRowIdRef = useRef<string | null>(editor.id);
  const promptReadyEntryFocusedRef = useRef(false);
  const editingPrompt = prompts.find((prompt) => prompt.id === editor.id) ?? null;
  const defaultPrompt = prompts.find((prompt) => prompt.id === defaultPromptId) ?? null;
  const dirty = hasPromptEditorChanges(editor, prompts);
  const nameMissing = !editor.name.trim();
  const systemMissing = !editor.systemPrompt.trim();
  const nameInvalid = dirty && nameMissing;
  const systemInvalid = dirty && systemMissing;
  const valid = !nameMissing && !systemMissing;
  const canSave = dirty && valid && !saving;
  const canDelete = Boolean(editingPrompt && editingPrompt.id !== defaultPromptId && !saving);
  const discardConfirmationOpen = discardIntent !== null;
  const childDialogOpen = discardConfirmationOpen || nestedDialogOpen;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredPrompts = prompts.filter((prompt) => matchesPrompt(prompt, normalizedQuery));

  const requestClose = () => {
    if (saving) {
      return;
    }
    if (dirty) {
      setDiscardIntent({ kind: "close" });
      return;
    }
    onClose();
  };

  const libraryDialogRef = useDialogFocus<HTMLDivElement>({
    autoFocus: false,
    closeOnEscape: !childDialogOpen && !promptActionsOpen,
    containFocus: !childDialogOpen,
    onClose: requestClose
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (promptCatalogState === "ready") {
        if (!promptReadyEntryFocusedRef.current) {
          promptLibraryHeadingRef.current?.focus({ preventScroll: true });
          promptReadyEntryFocusedRef.current = true;
          return;
        }
        const splitLayout =
          typeof window.matchMedia === "function" &&
          window.matchMedia("(min-width: 1024px) and (min-height: 32.01rem)").matches;
        if (!splitLayout && compactPane === "library") {
          const rowId = editor.id ?? lastPromptRowIdRef.current;
          const row = rowId ? promptRowRefs.current.get(rowId) : null;
          (row ?? promptLibraryHeadingRef.current)?.focus({ preventScroll: true });
        } else {
          if (promptEditorBodyRef.current) {
            promptEditorBodyRef.current.scrollTop = 0;
          }
          promptNameRef.current?.focus({ preventScroll: true });
        }
      } else {
        promptCatalogHeadingRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [compactPane, editor.id, promptCatalogState]);

  useEffect(() => {
    if (!promptActionsOpen) {
      return;
    }
    const timer = window.setTimeout(() => {
      promptActionsMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [promptActionsOpen]);

  useEffect(() => {
    if (promptCatalogState !== "ready" || notice?.kind !== "error") {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const region = promptActionRegionRef.current;
      if (region && typeof region.scrollIntoView === "function") {
        region.scrollIntoView({ block: "nearest" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [notice, promptCatalogState]);

  function closePromptActions({ restoreFocus = false } = {}) {
    setPromptActionsOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => promptActionsTriggerRef.current?.focus(), 0);
    }
  }

  function resetEditor() {
    if (editingPrompt) {
      onEditPrompt(editingPrompt);
    } else {
      onNewPrompt();
    }
  }

  function requestNewPrompt() {
    if (saving) {
      return;
    }
    closePromptActions();
    if (dirty) {
      setDiscardIntent({ kind: "new" });
      return;
    }
    onNewPrompt();
    setCompactPane("editor");
  }

  function requestEditPrompt(prompt: PromptPreset) {
    if (saving) {
      return;
    }
    closePromptActions();
    lastPromptRowIdRef.current = prompt.id;
    if (prompt.id === editor.id) {
      setCompactPane("editor");
      return;
    }
    if (dirty) {
      setDiscardIntent({ kind: "edit", prompt });
      return;
    }
    onEditPrompt(prompt);
    setCompactPane("editor");
  }

  function requestDuplicatePrompt(prompt: PromptPreset) {
    if (saving) {
      return;
    }
    closePromptActions();
    if (dirty) {
      setDiscardIntent({ kind: "duplicate", prompt });
      return;
    }
    onDuplicatePrompt(prompt);
    setCompactPane("editor");
  }

  function requestDeletePrompt(prompt: PromptPreset) {
    if (saving) {
      return;
    }
    closePromptActions();
    if (dirty && prompt.id === editor.id) {
      setDiscardIntent({ kind: "delete", prompt });
      return;
    }
    onDeletePrompt(prompt);
  }

  function requestLibrary() {
    if (saving) {
      return;
    }
    closePromptActions();
    if (dirty) {
      setDiscardIntent({ kind: "library" });
      return;
    }
    setCompactPane("library");
  }

  function confirmDiscard() {
    const intent = discardIntent;
    setDiscardIntent(null);
    if (!intent) {
      return;
    }
    if (intent.kind === "close") {
      onClose();
    } else if (intent.kind === "edit") {
      onEditPrompt(intent.prompt);
      setCompactPane("editor");
    } else if (intent.kind === "new") {
      onNewPrompt();
      setCompactPane("editor");
    } else {
      resetEditor();
      if (intent.kind === "duplicate") {
        onDuplicatePrompt(intent.prompt);
        setCompactPane("editor");
      } else if (intent.kind === "library") {
        setCompactPane("library");
      } else {
        window.setTimeout(() => onDeletePrompt(intent.prompt), 0);
      }
    }
  }

  function handleLibraryDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && promptActionsOpen) {
      event.preventDefault();
      event.stopPropagation();
      closePromptActions({ restoreFocus: true });
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "s") {
      event.preventDefault();
      if (canSave) {
        (editor.id ? onUpdatePrompt : onCreatePrompt)();
      }
    }
  }

  const saveStatus = saving
    ? "Saving prompt…"
    : dirty && !valid
      ? "Complete the required fields to save."
      : dirty
        ? "Unsaved changes"
        : editor.id
          ? "Saved"
          : "New prompt not saved";

  const saveButton = (
    <button
      className={[
        `inline-flex min-h-touch w-full items-center justify-center gap-2 rounded-control px-4 text-sm font-semibold disabled:cursor-not-allowed sm:min-h-control sm:w-auto ${coarsePointerTarget} ${focusRing}`,
        canSave || saving
          ? "bg-proof text-proof-contrast hover:bg-proof-hover"
          : "bg-control-surface text-ink-disabled"
      ].join(" ")}
      type="button"
      aria-label={editor.id ? "Save changes" : "Create prompt"}
      disabled={!canSave}
      onClick={editor.id ? onUpdatePrompt : onCreatePrompt}
    >
      {saving ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Save className="size-4" aria-hidden="true" />
      )}
      {saving ? "Saving…" : editor.id ? "Save changes" : "Create prompt"}
    </button>
  );

  return (
    <>
      <div
        ref={libraryDialogRef}
        className="fixed inset-0 z-50 grid h-[100dvh] w-full grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden bg-overlay-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-ink"
        role="dialog"
        aria-modal="true"
        aria-hidden={childDialogOpen || undefined}
        aria-label="Prompt library"
        aria-busy={saving}
        data-presentation="library"
        data-testid="prompt-library"
        inert={childDialogOpen || undefined}
        onKeyDown={handleLibraryDialogKeyDown}
        onPointerDownCapture={(event) => {
          if (
            promptActionsOpen &&
            event.target instanceof Node &&
            !promptActionsRef.current?.contains(event.target)
          ) {
            closePromptActions();
          }
        }}
      >
      <header
        className={[
          "min-h-16 shrink-0 grid-cols-[auto_minmax(0,1fr)] items-center border-b border-trace-subtle bg-overlay-surface [@media(max-height:32rem)]:!min-h-12 lg:[@media(min-height:32.01rem)]:grid-cols-[20rem_minmax(0,1fr)] xl:[@media(min-height:32.01rem)]:grid-cols-[22.5rem_minmax(0,1fr)]",
          compactPane === "editor" ? "hidden lg:[@media(min-height:32.01rem)]:grid" : "grid"
        ].join(" ")}
        data-testid="prompt-library-header"
      >
        <div className="flex min-w-0 items-center px-2 sm:px-4 lg:px-5">
          <button
            className={`inline-flex min-h-touch min-w-0 items-center gap-2 rounded-control px-2 text-sm font-medium text-ink-secondary hover:bg-control-hover hover:text-ink sm:min-h-control ${coarsePointerTarget} ${focusRing}`}
            type="button"
            aria-label="Back to chat"
            aria-describedby={saving ? "prompt-save-status" : undefined}
            disabled={saving}
            title={saving ? "Wait for the prompt save to finish" : "Back to chat"}
            onClick={requestClose}
          >
            <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Back to chat</span>
          </button>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-4 px-3 sm:px-5 lg:px-8">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold tracking-tight text-ink">Prompt library</h2>
            <p className="mt-0.5 hidden truncate text-xs text-ink-muted sm:block [@media(max-height:32rem)]:!hidden">
              Reusable instructions for model runs
            </p>
          </div>
          <p className="hidden shrink-0 text-xs text-ink-muted xl:[@media(min-height:32.01rem)]:block">
            Choose a prompt for each run in the composer
          </p>
        </div>
      </header>

      {notice ? (
        <div
          className="relative z-20 row-start-2 flex shrink-0 justify-center border-b border-trace-subtle bg-overlay-surface px-3 py-2"
          data-testid="prompt-library-notice-region"
        >
          <ShellNotice notice={notice} onDismiss={onDismissNotice ?? (() => undefined)} />
        </div>
      ) : null}

      {promptCatalogState !== "ready" ? (
        <section
          className="row-start-3 grid min-h-0 place-items-center overflow-y-auto px-4 py-8"
          data-testid="prompt-library-catalog-state"
          aria-labelledby="prompt-library-catalog-heading"
        >
          <div className="w-full max-w-sm text-center">
            {promptCatalogState === "loading" ? (
              <LoaderCircle className="mx-auto size-6 animate-spin text-proof" aria-hidden="true" />
            ) : (
              <RotateCcw className="mx-auto size-6 text-critical" aria-hidden="true" />
            )}
            <h3
              ref={promptCatalogHeadingRef}
              className="mt-3 text-base font-semibold text-ink focus:outline-none"
              id="prompt-library-catalog-heading"
              tabIndex={-1}
            >
              {promptCatalogState === "loading" ? "Loading prompt library…" : "Prompt library didn’t load"}
            </h3>
            <p className="mt-2 text-sm leading-6 text-ink-secondary">
              {promptCatalogState === "loading"
                ? "The library will open when models and prompt presets finish loading."
                : promptCatalogError ?? "Try loading models and prompt presets again."}
            </p>
            {promptCatalogState === "error" ? (
              <button
                className={`mt-4 inline-flex min-h-touch items-center justify-center gap-2 rounded-control bg-control-surface px-4 text-sm font-medium text-ink hover:bg-control-hover sm:min-h-control ${coarsePointerTarget} ${focusRing}`}
                type="button"
                aria-label="Retry loading prompt library"
                onClick={onRetryCatalog}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Retry
              </button>
            ) : null}
          </div>
        </section>
      ) : (
        <div
          className="row-start-3 grid min-h-0 grid-cols-1 overflow-hidden lg:[@media(min-height:32.01rem)]:grid-cols-[20rem_minmax(0,1fr)] xl:[@media(min-height:32.01rem)]:grid-cols-[22.5rem_minmax(0,1fr)]"
          data-testid="prompt-library-body"
        >
          <section
            className={[
              "min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] bg-workspace-rail lg:[@media(min-height:32.01rem)]:!grid lg:[@media(min-height:32.01rem)]:border-r lg:[@media(min-height:32.01rem)]:border-trace-subtle",
              compactPane === "library" ? "grid" : "hidden"
            ].join(" ")}
            aria-labelledby="prompt-library-heading"
            data-testid="prompt-library-pane"
          >
            <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-5 sm:px-5">
              <div className="min-w-0">
                <h3
                  ref={promptLibraryHeadingRef}
                  className="text-xl font-semibold tracking-tight text-ink focus:outline-none"
                  id="prompt-library-heading"
                  tabIndex={-1}
                >
                  Prompts
                </h3>
                <p className="mt-1 text-xs text-ink-muted">
                  {prompts.length} saved {prompts.length === 1 ? "prompt" : "prompts"}
                </p>
              </div>
              <button
                className={`inline-flex min-h-touch shrink-0 items-center gap-2 rounded-control bg-control-surface px-3 text-xs font-medium text-ink hover:bg-control-hover sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`}
                type="button"
                aria-label="New prompt"
                disabled={saving}
                onClick={requestNewPrompt}
              >
                <Plus className="size-4" aria-hidden="true" />
                New prompt
              </button>
            </div>

            <div className="px-4 pb-4 sm:px-5">
              <label className="relative block" htmlFor="prompt-library-search">
                <span className="sr-only">Search prompts</span>
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
                  aria-hidden="true"
                />
                <input
                  className={`h-touch w-full rounded-control border border-control-boundary bg-answer-paper pl-9 pr-3 text-sm text-ink placeholder:text-ink-muted sm:h-control ${focusRing}`}
                  id="prompt-library-search"
                  type="search"
                  autoComplete="off"
                  placeholder="Search prompts"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query) {
                      event.preventDefault();
                      event.stopPropagation();
                      setQuery("");
                    }
                  }}
                />
              </label>
              <p className="mt-2 text-metadata text-ink-muted lg:[@media(min-height:32.01rem)]:hidden">
                Manage prompts here. Choose one for a run in Run setup.
              </p>
            </div>

            <div
              className="min-h-0 overflow-y-auto overscroll-contain border-t border-trace-subtle"
              data-testid="prompt-library-scroll-region"
            >
              {prompts.length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <p className="text-sm font-medium text-ink">No prompts yet</p>
                  <p className="mt-1 text-xs leading-5 text-ink-muted">
                    Create one to reuse instructions across conversations.
                  </p>
                  <button
                    className={`mt-4 inline-flex min-h-touch items-center gap-2 rounded-control bg-control-surface px-3 text-sm font-medium text-ink hover:bg-control-hover sm:min-h-control ${coarsePointerTarget} ${focusRing}`}
                    type="button"
                    disabled={saving}
                    onClick={requestNewPrompt}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    Create your first prompt
                  </button>
                </div>
              ) : filteredPrompts.length === 0 ? (
                <div className="px-5 py-8 text-center" role="status">
                  <p className="text-sm font-medium text-ink">No matching prompts</p>
                  <p className="mt-1 text-xs leading-5 text-ink-muted">Try another name or instruction phrase.</p>
                  <button
                    className={`mt-3 inline-flex min-h-touch items-center rounded-control px-3 text-xs font-medium text-ink-secondary hover:bg-control-hover hover:text-ink sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`}
                    type="button"
                    onClick={() => setQuery("")}
                  >
                    Clear search
                  </button>
                </div>
              ) : (
                <ul className="divide-y divide-trace-subtle" aria-label="Prompts">
                  {filteredPrompts.map((prompt) => {
                    const editing = prompt.id === editor.id;
                    const isDefault = prompt.id === defaultPromptId;
                    return (
                      <li
                        className={[
                          "relative min-w-0",
                          editing
                            ? "bg-control-selected before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-proof"
                            : "hover:bg-control-hover"
                        ].join(" ")}
                        key={prompt.id}
                      >
                        <button
                          ref={(node) => {
                            if (node) {
                              promptRowRefs.current.set(prompt.id, node);
                            } else {
                              promptRowRefs.current.delete(prompt.id);
                            }
                          }}
                          className={`block w-full min-w-0 px-5 py-4 text-left ${coarsePointerTarget} ${focusRing}`}
                          type="button"
                          aria-label={`Edit prompt ${prompt.name}`}
                          aria-current={editing ? "true" : undefined}
                          disabled={saving}
                          onClick={() => requestEditPrompt(prompt)}
                        >
                          <span className="flex min-w-0 items-start gap-3">
                            <span className="min-w-0 flex-1">
                              <span className="block break-words text-sm font-semibold leading-5 text-ink [overflow-wrap:anywhere]">
                                {prompt.name}
                              </span>
                              <span className="mt-1 block overflow-hidden text-xs leading-5 text-ink-muted [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow-wrap:anywhere]">
                                {promptPreview(prompt)}
                              </span>
                            </span>
                            {isDefault ? (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-pill border border-proof/35 px-2 py-0.5 text-metadata font-semibold uppercase tracking-[0.05em] text-proof">
                                <Star className="size-3" aria-hidden="true" />
                                Default
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          <section
            className={[
              "min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-overlay-surface lg:[@media(min-height:32.01rem)]:!grid",
              compactPane === "editor" ? "grid" : "hidden"
            ].join(" ")}
            aria-labelledby="prompt-editor-heading"
            data-testid="prompt-editor-pane"
          >
            <header className="border-b border-trace-subtle bg-overlay-surface px-4 py-3 sm:px-6 lg:px-8 [@media(max-height:32rem)]:!py-2">
              <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                  <button
                    className={`grid size-11 shrink-0 place-items-center rounded-control text-ink-secondary hover:bg-control-hover hover:text-ink lg:[@media(min-height:32.01rem)]:hidden ${focusRing}`}
                    disabled={saving}
                    onClick={requestLibrary}
                    type="button"
                    aria-label="Back to prompts"
                  >
                    <ArrowLeft className="size-4" aria-hidden="true" />
                  </button>
                  <div className="min-w-0">
                    <h3 className="truncate text-lg font-semibold tracking-tight text-ink" id="prompt-editor-heading">
                      {editor.id ? (editingPrompt?.name ?? editor.name) || "Untitled prompt" : editor.name || "New prompt"}
                    </h3>
                    <p
                      className={[
                        "mt-0.5 flex items-center gap-1.5 text-xs font-medium",
                        saving ? "text-proof" : dirty ? "text-caution" : "text-ink-muted"
                      ].join(" ")}
                      role="status"
                      id="prompt-save-status"
                      aria-live="polite"
                    >
                      <span
                        className={[
                          "size-1.5 rounded-pill",
                          saving
                            ? "bg-proof"
                            : dirty
                              ? "bg-caution"
                              : editor.id
                                ? "bg-positive"
                                : "bg-ink-muted"
                        ].join(" ")}
                        aria-hidden="true"
                      />
                      {saveStatus}
                    </p>
                  </div>
                </div>
                {editingPrompt ? (
                  <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                    <button
                      className={`${quietButton} px-2 sm:px-3`}
                      type="button"
                      aria-label="Duplicate selected prompt"
                      disabled={saving}
                      title="Duplicate prompt"
                      onClick={() => requestDuplicatePrompt(editingPrompt)}
                    >
                      <Copy className="size-4" aria-hidden="true" />
                      <span className="hidden sm:inline">Duplicate</span>
                    </button>
                    <div className="relative" ref={promptActionsRef}>
                      <button
                        ref={promptActionsTriggerRef}
                        className={`grid size-11 place-items-center rounded-control text-ink-secondary hover:bg-control-hover hover:text-ink sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11 ${focusRing}`}
                        type="button"
                        aria-label="Prompt actions"
                        aria-haspopup="menu"
                        aria-expanded={promptActionsOpen}
                        disabled={saving}
                        onClick={() => setPromptActionsOpen((open) => !open)}
                      >
                        <MoreHorizontal className="size-4" aria-hidden="true" />
                      </button>
                      {promptActionsOpen ? (
                        <div
                          ref={promptActionsMenuRef}
                          className="absolute right-0 top-12 z-30 max-h-[calc(100dvh-8rem)] w-64 overflow-y-auto overscroll-contain rounded-panel border border-trace-subtle bg-overlay-surface p-1.5 shadow-overlay [@media(max-height:32rem)]:fixed [@media(max-height:32rem)]:right-[max(.5rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:top-[max(3.5rem,env(safe-area-inset-top))] [@media(max-height:32rem)]:max-h-[calc(100dvh-4rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]"
                          role="menu"
                          aria-label="Prompt actions menu"
                        >
                          <button
                            className={`${quietButton} w-full justify-start text-critical hover:bg-critical/10 hover:text-critical`}
                            type="button"
                            role="menuitem"
                            aria-label="Delete selected prompt"
                            aria-describedby={editingPrompt.id === defaultPromptId ? "default-delete-protection" : undefined}
                            disabled={!canDelete}
                            onClick={() => requestDeletePrompt(editingPrompt)}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                            Delete prompt
                          </button>
                          {editingPrompt.id === defaultPromptId ? (
                            <p className="px-3 pb-2 pt-1 text-metadata text-ink-muted" id="default-delete-protection">
                              Make another prompt the default before deleting this one.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </header>

            <div
              ref={promptEditorBodyRef}
              className="min-h-0 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6 sm:py-6 lg:px-8 [@media(max-height:32rem)]:!py-3"
              data-testid="prompt-editor-scroll-region"
            >
              <div className="mx-auto w-full max-w-4xl pb-4">
                {editingPrompt ? (
                  <section
                    className="flex min-w-0 flex-col gap-3 rounded-panel border border-trace-subtle bg-control-surface px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4"
                    aria-labelledby="prompt-default-heading"
                    data-testid="prompt-default-control"
                  >
                    <div className="flex min-w-0 items-start gap-2.5">
                      <span className="grid size-9 shrink-0 place-items-center rounded-control bg-control-selected text-proof">
                        <Star className="size-4" aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <h4 className="text-xs font-semibold text-ink" id="prompt-default-heading">Default for new chats</h4>
                        <p className="mt-0.5 break-words text-xs leading-5 text-ink-muted [overflow-wrap:anywhere]">
                          {editingPrompt.id === defaultPromptId
                            ? "This prompt starts every new conversation."
                            : `Currently: ${defaultPrompt?.name ?? "No default set"}.`}
                        </p>
                      </div>
                    </div>
                    <button
                      className={`${quietButton} ml-11 self-start sm:ml-0 sm:self-auto`}
                      type="button"
                      aria-label="Set selected prompt as default"
                      disabled={editingPrompt.id === defaultPromptId || saving}
                      onClick={() => onSetDefaultPrompt(editingPrompt.id)}
                    >
                      {editingPrompt.id === defaultPromptId ? "Default" : "Make default"}
                    </button>
                  </section>
                ) : null}

                <section className="mt-6" aria-labelledby="prompt-name-heading">
                  <div className="mb-2 flex min-w-0 items-baseline gap-2">
                    <h4 className="text-sm font-semibold text-ink" id="prompt-name-heading">Name</h4>
                    <span
                      className={`text-xs ${nameInvalid ? "text-critical" : "text-ink-muted"}`}
                      aria-hidden="true"
                      data-testid="prompt-name-required-indicator"
                    >
                      Required
                    </span>
                  </div>
                  <label className="block" htmlFor="prompt-library-name">
                    <span className="sr-only">Prompt name</span>
                    <input
                      ref={promptNameRef}
                      className={`h-touch w-full rounded-control border border-control-boundary bg-answer-paper px-3 text-sm text-ink placeholder:text-ink-muted aria-[invalid=true]:border-critical disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch ${focusRing}`}
                      id="prompt-library-name"
                      type="text"
                      aria-label="Prompt name"
                      aria-describedby="prompt-library-name-guidance"
                      aria-invalid={nameInvalid}
                      autoComplete="off"
                      disabled={saving}
                      placeholder="For example, Code reviewer"
                      value={editor.name}
                      onChange={(event) => onEditorChange({ ...editor, name: event.target.value })}
                    />
                  </label>
                  <p
                    className={`mt-2 text-xs leading-5 ${nameInvalid ? "text-critical" : "text-ink-muted"}`}
                    id="prompt-library-name-guidance"
                  >
                    {nameInvalid ? "Enter a prompt name." : "Visible in the library, Run setup, and command palette."}
                  </p>
                </section>

                <div
                  className="relative mt-7 space-y-7 sm:pl-12 sm:before:absolute sm:before:bottom-5 sm:before:left-[0.9375rem] sm:before:top-5 sm:before:w-px sm:before:bg-trace-subtle"
                  data-testid="prompt-instruction-stack"
                >
                  <section className="relative" aria-labelledby="prompt-system-heading">
                    <span className="absolute -left-12 top-0 hidden size-8 place-items-center rounded-control border border-proof/45 bg-overlay-surface text-incidental font-semibold tracking-[0.08em] text-proof sm:grid" aria-hidden="true">
                      S
                    </span>
                    <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="inline-flex rounded-control border border-proof/35 px-1.5 py-0.5 text-incidental font-semibold tracking-[0.08em] text-proof sm:hidden" aria-hidden="true">SYSTEM</span>
                      <h4 className="whitespace-nowrap text-sm font-semibold text-ink" id="prompt-system-heading">System instructions</h4>
                      <span
                        className={`basis-full text-xs sm:basis-auto ${systemInvalid ? "text-critical" : "text-ink-muted"}`}
                        aria-hidden="true"
                        data-testid="system-prompt-required-indicator"
                      >
                        Required · highest priority
                      </span>
                    </div>
                    <label className="block" htmlFor="prompt-library-system">
                      <span className="sr-only">System instructions</span>
                      <textarea
                        className={`min-h-48 w-full resize-y rounded-control border border-control-boundary bg-answer-paper px-3 py-3 text-sm leading-6 text-ink placeholder:text-ink-muted aria-[invalid=true]:border-critical disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled ${focusRing}`}
                        id="prompt-library-system"
                        aria-label="System instructions"
                        aria-describedby="prompt-library-system-guidance"
                        aria-invalid={systemInvalid}
                        disabled={saving}
                        placeholder="Define the assistant’s role, priorities, and response style."
                        value={editor.systemPrompt}
                        onChange={(event) => onEditorChange({ ...editor, systemPrompt: event.target.value })}
                      />
                    </label>
                    <p
                      className={`mt-2 text-xs leading-5 ${systemInvalid ? "text-critical" : "text-ink-muted"}`}
                      id="prompt-library-system-guidance"
                    >
                      {systemInvalid ? "Enter system instructions." : "Primary instructions sent whenever this prompt is used."}
                    </p>
                  </section>

                  <section className="relative" aria-labelledby="prompt-developer-heading">
                    <span className="absolute -left-12 top-0 hidden size-8 place-items-center rounded-control border border-trace-subtle bg-overlay-surface text-incidental font-semibold tracking-[0.08em] text-ink-muted sm:grid" aria-hidden="true">
                      D
                    </span>
                    <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="inline-flex rounded-control border border-trace-subtle px-1.5 py-0.5 text-incidental font-semibold tracking-[0.08em] text-ink-muted sm:hidden" aria-hidden="true">DEVELOPER</span>
                      <h4 className="whitespace-nowrap text-sm font-semibold text-ink" id="prompt-developer-heading">Developer instructions</h4>
                      <span className="basis-full text-xs text-ink-muted sm:basis-auto">Optional · implementation guidance</span>
                    </div>
                    <label className="block" htmlFor="prompt-library-developer">
                      <span className="sr-only">Developer instructions</span>
                      <textarea
                        className={`min-h-32 w-full resize-y rounded-control border border-control-boundary bg-answer-paper px-3 py-3 text-sm leading-6 text-ink placeholder:text-ink-muted disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled ${focusRing}`}
                        id="prompt-library-developer"
                        aria-label="Developer instructions"
                        aria-describedby="prompt-library-developer-help"
                        disabled={saving}
                        placeholder="Add implementation constraints or provider-specific guidance."
                        value={editor.developerPrompt}
                        onChange={(event) => onEditorChange({ ...editor, developerPrompt: event.target.value })}
                      />
                    </label>
                    <p className="mt-2 text-xs leading-5 text-ink-muted" id="prompt-library-developer-help">
                      Additional guidance kept separate from the system instructions.
                    </p>
                  </section>
                </div>
              </div>
            </div>

            <footer
              ref={promptActionRegionRef}
              className="border-t border-trace-subtle bg-overlay-surface px-4 py-3 sm:px-6 lg:px-8 [@media(max-height:32rem)]:!py-2"
              data-testid="prompt-action-region"
            >
              <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-ink-muted">
                  Saved edits are used next time this prompt is selected. Existing messages stay unchanged.
                </p>
                {saveButton}
              </div>
            </footer>
          </section>
        </div>
      )}

      </div>

      {discardConfirmationOpen ? (
        <DiscardChangesConfirmationDialog
          label="prompt"
          onCancel={() => setDiscardIntent(null)}
          onConfirm={confirmDiscard}
        />
      ) : null}
    </>
  );
}
