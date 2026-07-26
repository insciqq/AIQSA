import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { McpSettingsSection } from "@/components/app-shell/McpSettingsSection";
import { ShellNotice } from "@/components/app-shell/ShellNotice";
import {
  hasPromptEditorChanges,
  type PromptEditorDraft,
  type SettingsSection
} from "@/components/app-shell/promptSettingsStore";
import { AIQSA_THEMES, type ThemeId } from "@/components/app-shell/theme";
import type { Notice, PromptPreset } from "@/components/app-shell/types";
import { Check, ChevronLeft, Copy, FilePlus2, LoaderCircle, Palette, Plus, RotateCcw, Save, Star, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDialogFocus } from "./useDialogFocus";

type DiscardIntent =
  | { kind: "close" }
  | { kind: "delete"; prompt: PromptPreset }
  | { kind: "duplicate"; prompt: PromptPreset }
  | { kind: "edit"; prompt: PromptPreset }
  | { kind: "library" }
  | { kind: "new" }
  | { kind: "section"; section: SettingsSection };

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-proof/55 focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const coarsePointerTarget = "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const quietButton = `inline-flex min-h-touch items-center justify-center gap-2 rounded-control px-3 text-xs font-medium text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`;

function promptPreview(prompt: PromptPreset) {
  return prompt.systemPrompt.trim() || prompt.developerPrompt?.trim() || "No instructions yet.";
}

export function SettingsDialog({
  currentPromptId,
  defaultPromptId,
  editor,
  initialSection = "prompts",
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
  onThemeChange,
  onUpdatePrompt,
  onUsePrompt,
  prompts,
  saving,
  themeId
}: {
  currentPromptId: string | null;
  defaultPromptId: string | null;
  editor: PromptEditorDraft;
  initialSection?: SettingsSection;
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
  onThemeChange(themeId: ThemeId): void;
  onUpdatePrompt(): void;
  onUsePrompt(promptId: string): void;
  prompts: PromptPreset[];
  saving: boolean;
  themeId: ThemeId;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  const [compactPromptPane, setCompactPromptPane] = useState<"editor" | "library">("library");
  const [discardIntent, setDiscardIntent] = useState<DiscardIntent | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpDirty, setMcpDirty] = useState(false);
  const promptCatalogHeadingRef = useRef<HTMLHeadingElement>(null);
  const promptLibraryHeadingRef = useRef<HTMLHeadingElement>(null);
  const promptNameRef = useRef<HTMLInputElement>(null);
  const promptActionRegionRef = useRef<HTMLDivElement>(null);
  const promptReadyEntryFocusedRef = useRef(false);
  const themeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const editingPrompt = prompts.find((prompt) => prompt.id === editor.id) ?? null;
  const currentPrompt = prompts.find((prompt) => prompt.id === currentPromptId) ?? null;
  const defaultPrompt = prompts.find((prompt) => prompt.id === defaultPromptId) ?? null;
  const dirty = hasPromptEditorChanges(editor, prompts);
  const nameMissing = !editor.name.trim();
  const systemMissing = !editor.systemPrompt.trim();
  const valid = !nameMissing && !systemMissing;
  const canSave = dirty && valid && !saving;
  const canDelete = Boolean(editingPrompt && editingPrompt.id !== defaultPromptId && !saving);
  const discardConfirmationOpen = discardIntent !== null;
  const childDialogOpen = discardConfirmationOpen || nestedDialogOpen;
  const settingsDirty = activeSection === "prompts" ? dirty : activeSection === "mcp" ? mcpDirty : false;
  const settingsBusy = saving || mcpBusy;

  const requestClose = () => {
    if (settingsBusy) {
      return;
    }
    if (settingsDirty) {
      setDiscardIntent({ kind: "close" });
      return;
    }
    onClose();
  };
  const dialogRef = useDialogFocus<HTMLDivElement>({
    autoFocus: false,
    closeOnEscape: !childDialogOpen,
    containFocus: !childDialogOpen,
    onClose: requestClose
  });

  useEffect(() => {
    if (activeSection !== "prompts") {
      promptReadyEntryFocusedRef.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      if (promptCatalogState === "ready") {
        const narrowLayout =
          typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1023px)").matches;
        if (narrowLayout && compactPromptPane === "library") {
          promptLibraryHeadingRef.current?.focus({ preventScroll: true });
        } else {
          promptNameRef.current?.focus({ preventScroll: true });
        }
        promptReadyEntryFocusedRef.current = true;
      } else {
        promptCatalogHeadingRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSection, compactPromptPane, editor.id, promptCatalogState]);

  useEffect(() => {
    if (activeSection !== "prompts" || promptCatalogState !== "ready" || notice?.kind !== "error") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const region = promptActionRegionRef.current;
      if (region && typeof region.scrollIntoView === "function") {
        region.scrollIntoView({ block: "nearest" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, notice, promptCatalogState]);

  function resetEditor() {
    if (editingPrompt) {
      onEditPrompt(editingPrompt);
    } else {
      onNewPrompt();
    }
  }

  function requestSection(section: SettingsSection) {
    if (settingsBusy || section === activeSection) {
      return;
    }
    if ((activeSection === "prompts" && dirty) || (activeSection === "mcp" && mcpDirty)) {
      setDiscardIntent({ kind: "section", section });
      return;
    }
    setActiveSection(section);
  }

  function requestNewPrompt() {
    if (saving) {
      return;
    }
    if (dirty) {
      setDiscardIntent({ kind: "new" });
      return;
    }
    onNewPrompt();
    setCompactPromptPane("editor");
  }

  function requestEditPrompt(prompt: PromptPreset) {
    if (saving) {
      return;
    }
    if (prompt.id === editor.id) {
      setCompactPromptPane("editor");
      return;
    }
    if (dirty) {
      setDiscardIntent({ kind: "edit", prompt });
      return;
    }
    onEditPrompt(prompt);
    setCompactPromptPane("editor");
  }

  function requestDuplicatePrompt(prompt: PromptPreset) {
    if (saving) {
      return;
    }
    if (dirty) {
      setDiscardIntent({ kind: "duplicate", prompt });
      return;
    }
    onDuplicatePrompt(prompt);
    setCompactPromptPane("editor");
  }

  function requestDeletePrompt(prompt: PromptPreset) {
    if (saving) {
      return;
    }
    if (dirty && prompt.id === editor.id) {
      setDiscardIntent({ kind: "delete", prompt });
      return;
    }
    onDeletePrompt(prompt);
  }

  function confirmDiscard() {
    const intent = discardIntent;
    setDiscardIntent(null);
    if (!intent) {
      return;
    }

    if (intent.kind === "close") {
      onClose();
      return;
    }
    if (intent.kind === "edit") {
      onEditPrompt(intent.prompt);
      setCompactPromptPane("editor");
      return;
    }
    if (intent.kind === "new") {
      onNewPrompt();
      setCompactPromptPane("editor");
      return;
    }

    if (activeSection === "prompts") {
      resetEditor();
    }
    if (intent.kind === "section") {
      if (activeSection === "mcp") {
        setMcpDirty(false);
      }
      setActiveSection(intent.section);
    } else if (intent.kind === "duplicate") {
      onDuplicatePrompt(intent.prompt);
      setCompactPromptPane("editor");
    } else if (intent.kind === "library") {
      setCompactPromptPane("library");
    } else {
      window.setTimeout(() => onDeletePrompt(intent.prompt), 0);
    }
  }

  function requestPromptLibrary() {
    if (saving) {
      return;
    }
    if (dirty) {
      setDiscardIntent({ kind: "library" });
      return;
    }
    setCompactPromptPane("library");
  }

  function handleThemeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (index + 1) % AIQSA_THEMES.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + AIQSA_THEMES.length) % AIQSA_THEMES.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = AIQSA_THEMES.length - 1;
    }

    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const theme = AIQSA_THEMES[nextIndex];
    onThemeChange(theme.id);
    themeRefs.current[nextIndex]?.focus();
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/65 sm:items-center sm:pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(1.25rem,env(safe-area-inset-right))] sm:pt-[max(1.25rem,env(safe-area-inset-top))] [@media(max-height:32rem)]:!pb-[max(.5rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!pl-[max(.5rem,env(safe-area-inset-left))] [@media(max-height:32rem)]:!pr-[max(.5rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!pt-[max(.5rem,env(safe-area-inset-top))]"
      data-testid="settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          requestClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="pop-enter flex h-[100dvh] w-full max-w-5xl flex-col overflow-hidden bg-overlay-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-ink shadow-overlay sm:h-[min(48rem,calc(100dvh-2.5rem))] sm:rounded-panel sm:border sm:border-trace-subtle sm:p-0 [@media(max-height:32rem)]:!h-full [@media(max-height:32rem)]:!max-h-full"
        role="dialog"
        aria-modal="true"
        aria-hidden={childDialogOpen || undefined}
        aria-label="Settings"
        aria-busy={settingsBusy}
        data-testid="settings-dialog"
        inert={childDialogOpen || undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="relative z-10 flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-trace-subtle bg-overlay-surface px-4 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-ink">Settings</h2>
            <p className="mt-0.5 truncate text-xs text-ink-muted">Prompts, tools, and this browser’s appearance</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {mcpBusy || (!saving && settingsDirty) ? (
              <span className="hidden text-xs font-medium text-caution sm:inline" role="status">
                {mcpBusy
                  ? "Updating MCP settings…"
                  : activeSection === "mcp" ? "Unsaved MCP values" : "Unsaved prompt edits"}
              </span>
            ) : null}
            <button
              className={`grid size-11 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11 ${focusRing}`}
              type="button"
              aria-label="Close settings"
              aria-describedby={saving ? "settings-save-status" : undefined}
              disabled={settingsBusy}
              title={mcpBusy ? "Wait for the MCP update to finish" : saving ? "Wait for the prompt save to finish" : "Close settings"}
              onClick={requestClose}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <nav
          className="relative z-10 flex shrink-0 gap-1 overflow-x-auto border-b border-trace-subtle bg-overlay-surface px-2 py-2 sm:px-4"
          aria-label="Settings sections"
        >
          <button
            className={[
              `flex min-h-touch min-w-0 flex-1 items-center justify-center gap-2 rounded-control px-3 text-sm font-medium disabled:cursor-not-allowed disabled:text-ink-disabled sm:min-h-control sm:flex-none sm:justify-start ${coarsePointerTarget} ${focusRing}`,
              activeSection === "prompts"
                ? "bg-control-selected text-ink"
                : "text-ink-secondary hover:bg-control-hover hover:text-ink"
            ].join(" ")}
            type="button"
            aria-current={activeSection === "prompts" ? "page" : undefined}
            disabled={settingsBusy && activeSection !== "prompts"}
            onClick={() => requestSection("prompts")}
          >
            <FilePlus2 className="size-4 text-ink-muted" aria-hidden="true" />
            Prompts
            {dirty ? <span className="text-xs text-caution">Unsaved</span> : null}
          </button>
          <button
            className={[
              `flex min-h-touch min-w-0 flex-1 items-center justify-center gap-2 rounded-control px-3 text-sm font-medium disabled:cursor-not-allowed disabled:text-ink-disabled sm:min-h-control sm:flex-none sm:justify-start ${coarsePointerTarget} ${focusRing}`,
              activeSection === "appearance"
                ? "bg-control-selected text-ink"
                : "text-ink-secondary hover:bg-control-hover hover:text-ink"
            ].join(" ")}
            type="button"
            aria-current={activeSection === "appearance" ? "page" : undefined}
            disabled={settingsBusy && activeSection !== "appearance"}
            onClick={() => requestSection("appearance")}
          >
            <Palette className="size-4 text-ink-muted" aria-hidden="true" />
            Appearance
          </button>
          <button
            className={[
              `flex min-h-touch min-w-0 flex-1 items-center justify-center gap-2 rounded-control px-3 text-sm font-medium disabled:cursor-not-allowed disabled:text-ink-disabled sm:min-h-control sm:flex-none sm:justify-start ${coarsePointerTarget} ${focusRing}`,
              activeSection === "mcp"
                ? "bg-control-selected text-ink"
                : "text-ink-secondary hover:bg-control-hover hover:text-ink"
            ].join(" ")}
            type="button"
            aria-current={activeSection === "mcp" ? "page" : undefined}
            disabled={settingsBusy && activeSection !== "mcp"}
            onClick={() => requestSection("mcp")}
          >
            <Wrench className="size-4 text-ink-muted" aria-hidden="true" />
            MCP &amp; tools
          </button>
        </nav>

        {notice ? (
          <div
            className="relative z-10 flex shrink-0 justify-center border-b border-trace-subtle bg-overlay-surface px-3 py-2"
            data-testid="settings-notice-region"
          >
            <ShellNotice notice={notice} onDismiss={onDismissNotice ?? (() => undefined)} />
          </div>
        ) : null}

        {activeSection === "prompts" ? (
          promptCatalogState !== "ready" ? (
            <section
              className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-4 py-8"
              data-testid="settings-prompts-catalog-state"
              aria-labelledby="settings-prompts-catalog-heading"
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
                  id="settings-prompts-catalog-heading"
                  tabIndex={-1}
                >
                  {promptCatalogState === "loading" ? "Loading prompt library…" : "Prompt library didn’t load"}
                </h3>
                <p className="mt-2 text-sm leading-6 text-ink-secondary">
                  {promptCatalogState === "loading"
                    ? "Appearance remains available while models and prompt presets load."
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
            className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]"
            data-testid="settings-prompts-scroll"
          >
            <section
              className={[
                "order-2 min-h-0 min-w-0 overflow-y-auto overscroll-contain px-4 py-5 lg:order-2 lg:block lg:px-6",
                compactPromptPane === "editor" ? "block" : "hidden"
              ].join(" ")}
              aria-labelledby="prompt-editor-heading"
              data-testid="settings-prompt-editor-pane"
            >
              <div className="mx-auto max-w-3xl">
                <button
                  className={`mb-4 inline-flex min-h-touch items-center gap-2 rounded-control px-2 text-sm font-medium text-ink-secondary hover:bg-control-hover hover:text-ink lg:hidden ${coarsePointerTarget} ${focusRing}`}
                  disabled={saving}
                  onClick={requestPromptLibrary}
                  type="button"
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                  Back to prompts
                </button>
                <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-base font-semibold text-ink" id="prompt-editor-heading">
                      {editor.id ? (editingPrompt?.name ?? editor.name) || "Edit prompt" : "Create a prompt"}
                    </h3>
                    <p
                      className={[
                        "mt-1 text-xs font-medium",
                        saving ? "text-proof" : dirty ? "text-caution" : "text-ink-muted"
                      ].join(" ")}
                      role="status"
                      id="settings-save-status"
                      aria-live="polite"
                    >
                      {saveStatus}
                    </p>
                  </div>
                  {editingPrompt ? (
                    <div className="text-right text-xs leading-5 text-ink-muted">
                      {editingPrompt.id === currentPromptId ? <div className="text-proof">Used for next run</div> : null}
                      {editingPrompt.id === defaultPromptId ? <div>User default</div> : null}
                    </div>
                  ) : null}
                </div>

                <div className="space-y-5">
                  <div>
                    <label className="block" htmlFor="settings-prompt-name">
                      <span className="text-xs font-medium text-ink-secondary">Name</span>
                      <span
                        className={`ml-1 text-xs ${nameMissing ? "text-critical" : "text-ink-muted"}`}
                        aria-hidden="true"
                        data-testid="prompt-name-required-indicator"
                      >
                        Required
                      </span>
                      <input
                        ref={promptNameRef}
                        className={`mt-1.5 h-touch w-full rounded-control border border-trace-subtle bg-answer-paper px-3 text-sm text-ink placeholder:text-ink-muted disabled:cursor-not-allowed disabled:text-ink-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch ${focusRing}`}
                        id="settings-prompt-name"
                        type="text"
                        aria-label="Prompt name"
                        aria-describedby="settings-prompt-name-help settings-prompt-name-error"
                        aria-invalid={nameMissing}
                        autoComplete="off"
                        disabled={saving}
                        placeholder="For example, Research analyst"
                        value={editor.name}
                        onChange={(event) => onEditorChange({ ...editor, name: event.target.value })}
                      />
                    </label>
                    <p className="mt-2 text-xs leading-5 text-ink-muted" id="settings-prompt-name-help">
                      This name appears in the composer, command palette, and Settings.
                    </p>
                    <p className="mt-1 min-h-5 text-xs text-critical" id="settings-prompt-name-error">
                      {nameMissing ? "Enter a prompt name." : null}
                    </p>
                  </div>

                  <div>
                    <label className="block" htmlFor="settings-system-prompt">
                      <span className="text-xs font-medium text-ink-secondary">System instructions</span>
                      <span
                        className={`ml-1 text-xs ${systemMissing ? "text-critical" : "text-ink-muted"}`}
                        aria-hidden="true"
                        data-testid="system-prompt-required-indicator"
                      >
                        Required
                      </span>
                      <textarea
                        className={`mt-1.5 min-h-48 w-full resize-y rounded-control border border-trace-subtle bg-answer-paper px-3 py-2.5 text-sm leading-6 text-ink placeholder:text-ink-muted disabled:cursor-not-allowed disabled:text-ink-disabled ${focusRing}`}
                        id="settings-system-prompt"
                        aria-label="Settings system prompt"
                        aria-describedby="settings-system-prompt-help settings-system-prompt-error"
                        aria-invalid={systemMissing}
                        disabled={saving}
                        placeholder="Define the assistant’s role, priorities, and response style."
                        value={editor.systemPrompt}
                        onChange={(event) => onEditorChange({ ...editor, systemPrompt: event.target.value })}
                      />
                    </label>
                    <p className="mt-2 text-xs leading-5 text-ink-muted" id="settings-system-prompt-help">
                      Primary instructions sent whenever this preset is used.
                    </p>
                    <p className="mt-1 min-h-5 text-xs text-critical" id="settings-system-prompt-error">
                      {systemMissing ? "Enter system instructions." : null}
                    </p>
                  </div>

                  <div>
                    <label className="block" htmlFor="settings-developer-prompt">
                      <span className="text-xs font-medium text-ink-secondary">Developer instructions</span>
                      <span className="ml-1 text-xs text-ink-muted">Optional</span>
                      <textarea
                        className={`mt-1.5 min-h-36 w-full resize-y rounded-control border border-trace-subtle bg-answer-paper px-3 py-2.5 text-sm leading-6 text-ink placeholder:text-ink-muted disabled:cursor-not-allowed disabled:text-ink-disabled ${focusRing}`}
                        id="settings-developer-prompt"
                        aria-label="Developer prompt"
                        aria-describedby="settings-developer-prompt-help"
                        disabled={saving}
                        placeholder="Add implementation constraints or provider-specific guidance."
                        value={editor.developerPrompt}
                        onChange={(event) => onEditorChange({ ...editor, developerPrompt: event.target.value })}
                      />
                    </label>
                    <p className="mt-2 text-xs leading-5 text-ink-muted" id="settings-developer-prompt-help">
                      Additional guidance kept separate from the system instructions.
                    </p>
                  </div>
                </div>

                <div ref={promptActionRegionRef} className="mt-6 border-t border-trace-subtle pt-4" data-testid="prompt-action-region">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className={`inline-flex min-h-touch items-center justify-center gap-2 rounded-control bg-proof px-4 text-sm font-semibold text-proof-contrast hover:bg-proof-hover disabled:cursor-not-allowed disabled:opacity-55 sm:min-h-control ${coarsePointerTarget} ${focusRing}`}
                      type="button"
                      aria-label={editor.id ? "Update prompt" : "Create prompt"}
                      disabled={!canSave}
                      onClick={editor.id ? onUpdatePrompt : onCreatePrompt}
                    >
                      <Save className="size-4" aria-hidden="true" />
                      {saving ? "Saving…" : editor.id ? "Save changes" : "Create prompt"}
                    </button>
                    {editingPrompt ? (
                      <>
                        <button
                          className={quietButton}
                          type="button"
                          aria-label="Use selected prompt for next run"
                          aria-pressed={editingPrompt.id === currentPromptId}
                          disabled={saving}
                          onClick={() => onUsePrompt(editingPrompt.id)}
                        >
                          <Check className="size-4" aria-hidden="true" />
                          {editingPrompt.id === currentPromptId ? "Selected for next run" : "Use for next run"}
                        </button>
                        <button
                          className={quietButton}
                          type="button"
                          aria-label="Set selected prompt as default"
                          disabled={editingPrompt.id === defaultPromptId || saving}
                          onClick={() => onSetDefaultPrompt(editingPrompt.id)}
                        >
                          <Star className="size-4" aria-hidden="true" />
                          {editingPrompt.id === defaultPromptId ? "User default" : "Make default"}
                        </button>
                        <button
                          className={`${quietButton} text-critical hover:bg-critical/10 hover:text-critical`}
                          type="button"
                          aria-label="Delete selected prompt"
                          aria-describedby={editingPrompt.id === defaultPromptId ? "default-delete-protection" : undefined}
                          disabled={!canDelete}
                          onClick={() => requestDeletePrompt(editingPrompt)}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                          Delete
                        </button>
                      </>
                    ) : null}
                  </div>
                  {editingPrompt?.id === defaultPromptId ? (
                    <p className="mt-3 text-xs leading-5 text-ink-muted" id="default-delete-protection">
                      The user default is protected. Make another prompt the default before deleting this one.
                    </p>
                  ) : null}
                  <p className="mt-3 text-xs leading-5 text-ink-muted">
                    Save errors appear above in Settings; your draft stays available so you can try again.
                  </p>
                </div>
              </div>
            </section>

            <section
              className={[
                "order-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-answer-paper px-3 py-5 lg:order-1 lg:block lg:border-r lg:border-trace-subtle",
                compactPromptPane === "library" ? "block" : "hidden"
              ].join(" ")}
              aria-labelledby="prompt-library-heading"
              data-testid="settings-prompt-library-pane"
            >
              <div className="mb-4 flex items-start justify-between gap-3 px-1">
                <div className="min-w-0">
                  <h3
                    ref={promptLibraryHeadingRef}
                    className="text-sm font-semibold text-ink focus:outline-none"
                    id="prompt-library-heading"
                    tabIndex={-1}
                  >
                    Prompt library
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-ink-muted">Choose a prompt to inspect or edit. Selection alone does not change the next run.</p>
                </div>
                <button
                  className={`inline-flex min-h-touch shrink-0 items-center gap-2 rounded-control bg-control-surface px-3 text-xs font-medium text-ink hover:bg-control-hover sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`}
                  type="button"
                  aria-label="New prompt"
                  disabled={saving}
                  onClick={requestNewPrompt}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  New
                </button>
              </div>

              <div className="mb-4 border-y border-trace-subtle py-3 text-xs leading-5 text-ink-secondary">
                <div className="flex items-start gap-2">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-proof" aria-hidden="true" />
                  <span><strong className="font-semibold text-ink">Next run:</strong> {currentPrompt?.name ?? "No prompt selected"}. This changes only the next-message choice.</span>
                </div>
                <div className="mt-2 flex items-start gap-2">
                  <Star className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                  <span><strong className="font-semibold text-ink">User default:</strong> {defaultPrompt?.name ?? "No default set"}. Used as the startup choice for new chats.</span>
                </div>
              </div>

              {prompts.length ? (
                <ul className="space-y-1" aria-label="Prompt presets">
                  {prompts.map((prompt) => {
                    const editing = prompt.id === editor.id;
                    const current = prompt.id === currentPromptId;
                    const isDefault = prompt.id === defaultPromptId;

                    return (
                      <li
                        className={[
                          "rounded-control px-2 py-2.5",
                          editing ? "bg-control-selected" : "hover:bg-control-hover"
                        ].join(" ")}
                        key={prompt.id}
                      >
                        <button
                          className={`block w-full rounded-control px-1 text-left ${coarsePointerTarget} ${focusRing}`}
                          type="button"
                          aria-label={`Edit prompt ${prompt.name}`}
                          aria-current={editing ? "true" : undefined}
                          disabled={saving}
                          onClick={() => requestEditPrompt(prompt)}
                        >
                          <span className="block break-words text-sm font-semibold leading-5 text-ink [overflow-wrap:anywhere]">
                            {prompt.name}
                          </span>
                          <span className="mt-1 block overflow-hidden text-xs leading-5 text-ink-muted [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow-wrap:anywhere]">
                            {promptPreview(prompt)}
                          </span>
                        </button>

                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs">
                          {current ? <span className="font-medium text-proof">Next run</span> : null}
                          {isDefault ? <span className="text-ink-secondary">User default</span> : null}
                          {!current && !isDefault ? <span className="text-ink-muted">Available preset</span> : null}
                        </div>

                        <div className="mt-2 grid grid-cols-2 gap-1 sm:flex sm:flex-wrap">
                          <button
                            className={quietButton}
                            type="button"
                            aria-label={`Use prompt ${prompt.name} for next run`}
                            aria-pressed={current}
                            disabled={saving}
                            onClick={() => onUsePrompt(prompt.id)}
                          >
                            <Check className="size-3.5" aria-hidden="true" />
                            {current ? "Next run selected" : "Use next run"}
                          </button>
                          <button
                            className={quietButton}
                            type="button"
                            aria-label={`Set prompt ${prompt.name} as default`}
                            disabled={isDefault || saving}
                            onClick={() => onSetDefaultPrompt(prompt.id)}
                          >
                            <Star className="size-3.5" aria-hidden="true" />
                            {isDefault ? "Default" : "Make default"}
                          </button>
                          <button
                            className={quietButton}
                            type="button"
                            aria-label={`Duplicate prompt ${prompt.name}`}
                            disabled={saving}
                            onClick={() => requestDuplicatePrompt(prompt)}
                          >
                            <Copy className="size-3.5" aria-hidden="true" />
                            Duplicate
                          </button>
                          <button
                            className={`${quietButton} text-critical hover:bg-critical/10 hover:text-critical`}
                            type="button"
                            aria-label={`Delete prompt ${prompt.name}`}
                            aria-describedby={isDefault ? `default-protection-${prompt.id}` : undefined}
                            disabled={isDefault || saving}
                            onClick={() => requestDeletePrompt(prompt)}
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                            Delete
                          </button>
                        </div>
                        {isDefault ? (
                          <p className="mt-2 px-1 text-xs leading-5 text-ink-muted" id={`default-protection-${prompt.id}`}>
                            Protected while this is the user default.
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="border-y border-trace-subtle px-4 py-6 text-center">
                  <p className="text-sm font-medium text-ink">No prompt presets yet</p>
                  <p className="mt-1 text-xs leading-5 text-ink-muted">Create one to reuse instructions across conversations.</p>
                  <button
                    className={`mt-3 inline-flex min-h-touch items-center gap-2 rounded-control bg-control-surface px-3 text-sm font-medium text-ink sm:min-h-control ${coarsePointerTarget} ${focusRing}`}
                    type="button"
                    disabled={saving}
                    onClick={requestNewPrompt}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    Create your first prompt
                  </button>
                </div>
              )}
            </section>
          </div>
          )
        ) : activeSection === "mcp" ? (
          <McpSettingsSection onBusyChange={setMcpBusy} onDirtyChange={setMcpDirty} />
        ) : (
          <section
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6"
            aria-labelledby="appearance-heading"
            data-testid="settings-appearance-scroll"
          >
            <div className="mx-auto max-w-3xl">
              <h3 className="text-base font-semibold text-ink" id="appearance-heading">Appearance</h3>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
                Choose an AIQSA palette. The change applies immediately across this browser.
              </p>
              <p className="mt-2 max-w-2xl text-xs leading-5 text-ink-muted">
                This theme is saved only in this browser and does not follow your account.
              </p>

              <div className="mt-6 divide-y divide-trace-subtle border-y border-trace-subtle" role="radiogroup" aria-label="Theme">
                {AIQSA_THEMES.map((theme, index) => {
                  const selected = theme.id === themeId;

                  return (
                    <button
                      ref={(node) => {
                        themeRefs.current[index] = node;
                      }}
                      key={theme.id}
                      className={[
                        `grid min-h-touch w-full min-w-0 grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-3 px-2 py-3 text-left ${focusRing}`,
                        selected
                          ? "bg-control-selected text-ink"
                          : "text-ink-secondary hover:bg-control-hover hover:text-ink"
                      ].join(" ")}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={`Use ${theme.name} theme, ${theme.description}`}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => onThemeChange(theme.id)}
                      onKeyDown={(event) => handleThemeKeyDown(event, index)}
                    >
                      <span
                        className="block h-14 overflow-hidden rounded-control border border-trace-subtle bg-research-canvas p-1.5"
                        data-theme={theme.id}
                        aria-hidden="true"
                      >
                        <span className="flex h-3 items-center justify-between rounded-control bg-workspace-rail px-1">
                          <span className="h-1 w-6 rounded-pill bg-ink-muted/60" />
                          <span className="size-1 rounded-pill bg-proof" />
                        </span>
                        <span className="mt-1.5 grid h-8 grid-cols-[1.25rem_minmax(0,1fr)] gap-1">
                          <span className="rounded-control bg-workspace-rail" />
                          <span className="rounded-control bg-answer-paper p-1">
                            <span className="block h-1 w-4/5 rounded-pill bg-ink-muted/45" />
                            <span className="mt-1 block h-3 rounded-control bg-control-surface" />
                            <span className="mt-1 block h-1 w-1/2 rounded-pill bg-proof/75" />
                          </span>
                        </span>
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-ink">{theme.name}</span>
                        <span className="mt-0.5 block text-xs leading-5 text-ink-muted">{theme.description} · {theme.accentLabel} accent</span>
                      </span>
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${selected ? "text-proof" : "text-ink-muted"}`}>
                        {selected ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
                        <span className="hidden sm:inline">{selected ? "Current" : "Select"}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        )}
      </div>

      {discardConfirmationOpen ? (
        <DiscardChangesConfirmationDialog
          label={activeSection === "mcp" ? "MCP settings" : "prompt"}
          onCancel={() => setDiscardIntent(null)}
          onConfirm={confirmDiscard}
        />
      ) : null}
    </div>
  );
}
