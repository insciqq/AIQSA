import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { ShellNotice } from "@/components/app-shell/ShellNotice";
import { hasPromptEditorChanges, type PromptEditorDraft } from "@/components/app-shell/promptSettingsStore";
import { AIQSA_THEMES, type ThemeId } from "@/components/app-shell/theme";
import type { Notice, PromptPreset } from "@/components/app-shell/types";
import { Check, Copy, FilePlus2, LoaderCircle, Palette, Plus, RotateCcw, Save, Star, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDialogFocus } from "./useDialogFocus";

type SettingsSection = "appearance" | "prompts";

type DiscardIntent =
  | { kind: "close" }
  | { kind: "delete"; prompt: PromptPreset }
  | { kind: "duplicate"; prompt: PromptPreset }
  | { kind: "edit"; prompt: PromptPreset }
  | { kind: "new" }
  | { kind: "section"; section: SettingsSection };

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-overlay";
const coarsePointerTarget = "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
const quietButton = `inline-flex min-h-touch items-center justify-center gap-2 rounded-control px-3 text-xs font-medium text-content-secondary hover:bg-surface-hover hover:text-content-primary disabled:cursor-not-allowed disabled:text-content-disabled disabled:opacity-60 sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`;

function promptPreview(prompt: PromptPreset) {
  return prompt.systemPrompt.trim() || prompt.developerPrompt?.trim() || "No instructions yet.";
}

export function SettingsDialog({
  currentPromptId,
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
  const [activeSection, setActiveSection] = useState<SettingsSection>("prompts");
  const [discardIntent, setDiscardIntent] = useState<DiscardIntent | null>(null);
  const promptCatalogHeadingRef = useRef<HTMLHeadingElement>(null);
  const promptNameRef = useRef<HTMLInputElement>(null);
  const promptActionRegionRef = useRef<HTMLDivElement>(null);
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
  const dialogRef = useDialogFocus<HTMLDivElement>({
    autoFocus: false,
    closeOnEscape: !childDialogOpen,
    containFocus: !childDialogOpen,
    onClose: requestClose
  });

  useEffect(() => {
    if (activeSection !== "prompts") {
      return;
    }

    const timer = window.setTimeout(() => {
      if (promptCatalogState === "ready") {
        promptNameRef.current?.focus();
      } else {
        promptCatalogHeadingRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSection, editor.id, promptCatalogState]);

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
    if (saving || section === activeSection) {
      return;
    }
    if (activeSection === "prompts" && dirty) {
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
  }

  function requestEditPrompt(prompt: PromptPreset) {
    if (saving || prompt.id === editor.id) {
      return;
    }
    if (dirty) {
      setDiscardIntent({ kind: "edit", prompt });
      return;
    }
    onEditPrompt(prompt);
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
      return;
    }
    if (intent.kind === "new") {
      onNewPrompt();
      return;
    }

    resetEditor();
    if (intent.kind === "section") {
      setActiveSection(intent.section);
    } else if (intent.kind === "duplicate") {
      onDuplicatePrompt(intent.prompt);
    } else {
      window.setTimeout(() => onDeletePrompt(intent.prompt), 0);
    }
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
        className="pop-enter flex h-[100dvh] w-full max-w-5xl flex-col overflow-hidden bg-surface-overlay pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] shadow-overlay sm:h-[min(48rem,calc(100dvh-2.5rem))] sm:rounded-panel sm:border sm:border-separator-subtle sm:p-0 [@media(max-height:32rem)]:!h-full [@media(max-height:32rem)]:!max-h-full"
        role="dialog"
        aria-modal="true"
        aria-hidden={childDialogOpen || undefined}
        aria-label="Settings"
        aria-busy={saving}
        data-testid="settings-dialog"
        inert={childDialogOpen || undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="relative z-10 flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-separator-subtle bg-surface-overlay px-4 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content-primary">Settings</h2>
            <p className="mt-0.5 truncate text-xs text-content-muted">Prompt presets and local appearance</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {dirty ? (
              <span className="hidden text-xs font-medium text-accent-amber sm:inline" role="status">
                Unsaved prompt edits
              </span>
            ) : null}
            <button
              className={`grid size-11 place-items-center rounded-control text-content-muted hover:bg-surface-hover hover:text-content-primary sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11 ${focusRing}`}
              type="button"
              aria-label="Close settings"
              aria-describedby={saving ? "settings-save-status" : undefined}
              disabled={saving}
              title={saving ? "Wait for the prompt save to finish" : "Close settings"}
              onClick={requestClose}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <nav
          className="relative z-10 flex shrink-0 gap-1 border-b border-separator-subtle bg-surface-overlay px-2 py-2 sm:px-4"
          aria-label="Settings sections"
        >
          <button
            className={[
              `flex min-h-touch min-w-0 flex-1 items-center justify-center gap-2 rounded-control px-3 text-sm font-medium disabled:cursor-not-allowed disabled:text-content-disabled sm:min-h-control sm:flex-none sm:justify-start ${coarsePointerTarget} ${focusRing}`,
              activeSection === "prompts"
                ? "bg-surface-selected text-content-primary"
                : "text-content-secondary hover:bg-surface-hover hover:text-content-primary"
            ].join(" ")}
            type="button"
            aria-current={activeSection === "prompts" ? "page" : undefined}
            disabled={saving && activeSection !== "prompts"}
            onClick={() => requestSection("prompts")}
          >
            <FilePlus2 className="size-4 text-content-muted" aria-hidden="true" />
            Prompts
            {dirty ? <span className="text-xs text-accent-amber">Unsaved</span> : null}
          </button>
          <button
            className={[
              `flex min-h-touch min-w-0 flex-1 items-center justify-center gap-2 rounded-control px-3 text-sm font-medium disabled:cursor-not-allowed disabled:text-content-disabled sm:min-h-control sm:flex-none sm:justify-start ${coarsePointerTarget} ${focusRing}`,
              activeSection === "appearance"
                ? "bg-surface-selected text-content-primary"
                : "text-content-secondary hover:bg-surface-hover hover:text-content-primary"
            ].join(" ")}
            type="button"
            aria-current={activeSection === "appearance" ? "page" : undefined}
            disabled={saving && activeSection !== "appearance"}
            onClick={() => requestSection("appearance")}
          >
            <Palette className="size-4 text-content-muted" aria-hidden="true" />
            Appearance
          </button>
        </nav>

        {notice ? (
          <div
            className="relative z-10 flex shrink-0 justify-center border-b border-separator-subtle bg-surface-overlay px-3 py-2"
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
                  <LoaderCircle className="mx-auto size-6 animate-spin text-accent-cyan" aria-hidden="true" />
                ) : (
                  <RotateCcw className="mx-auto size-6 text-accent-rose" aria-hidden="true" />
                )}
                <h3
                  ref={promptCatalogHeadingRef}
                  className="mt-3 text-base font-semibold text-content-primary focus:outline-none"
                  id="settings-prompts-catalog-heading"
                  tabIndex={-1}
                >
                  {promptCatalogState === "loading" ? "Loading prompt library…" : "Prompt library didn’t load"}
                </h3>
                <p className="mt-2 text-sm leading-6 text-content-secondary">
                  {promptCatalogState === "loading"
                    ? "Appearance remains available while models and prompt presets load."
                    : promptCatalogError ?? "Try loading models and prompt presets again."}
                </p>
                {promptCatalogState === "error" ? (
                  <button
                    className={`mt-4 inline-flex min-h-touch items-center justify-center gap-2 rounded-control bg-surface-raised px-4 text-sm font-medium text-content-primary hover:bg-surface-hover sm:min-h-control ${coarsePointerTarget} ${focusRing}`}
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
            className="grid min-h-0 flex-1 overflow-y-auto overscroll-contain lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)] lg:overflow-hidden"
            data-testid="settings-prompts-scroll"
          >
            <section
              className="order-1 min-w-0 px-4 py-5 lg:order-2 lg:min-h-0 lg:overflow-y-auto lg:px-6"
              aria-labelledby="prompt-editor-heading"
            >
              <div className="mx-auto max-w-3xl">
                <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-base font-semibold text-content-primary" id="prompt-editor-heading">
                      {editor.id ? (editingPrompt?.name ?? editor.name) || "Edit prompt" : "Create a prompt"}
                    </h3>
                    <p
                      className={[
                        "mt-1 text-xs font-medium",
                        saving ? "text-accent-cyan" : dirty ? "text-accent-amber" : "text-content-muted"
                      ].join(" ")}
                      role="status"
                      id="settings-save-status"
                      aria-live="polite"
                    >
                      {saveStatus}
                    </p>
                  </div>
                  {editingPrompt ? (
                    <div className="text-right text-xs leading-5 text-content-muted">
                      {editingPrompt.id === currentPromptId ? <div className="text-accent-cyan">Used for next run</div> : null}
                      {editingPrompt.id === defaultPromptId ? <div>User default</div> : null}
                    </div>
                  ) : null}
                </div>

                <div className="space-y-5">
                  <label className="block" htmlFor="settings-prompt-name">
                    <span className="text-xs font-medium text-content-secondary">Name</span>
                    <span
                      className={`ml-1 text-xs ${nameMissing ? "text-accent-rose" : "text-content-muted"}`}
                      aria-hidden="true"
                      data-testid="prompt-name-required-indicator"
                    >
                      Required
                    </span>
                    <input
                      ref={promptNameRef}
                      className={`mt-1.5 h-touch w-full rounded-control border border-separator-subtle bg-surface-thread px-3 text-sm text-content-primary placeholder:text-content-muted disabled:cursor-not-allowed disabled:text-content-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch ${focusRing}`}
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
                  <div className="-mt-3 text-xs leading-5 text-content-muted" id="settings-prompt-name-help">
                    This name appears in the composer, command palette, and Settings.
                  </div>
                  <div className="-mt-4 min-h-5 text-xs text-accent-rose" id="settings-prompt-name-error">
                    {nameMissing ? "Enter a prompt name." : null}
                  </div>

                  <label className="block" htmlFor="settings-system-prompt">
                    <span className="text-xs font-medium text-content-secondary">System instructions</span>
                    <span
                      className={`ml-1 text-xs ${systemMissing ? "text-accent-rose" : "text-content-muted"}`}
                      aria-hidden="true"
                      data-testid="system-prompt-required-indicator"
                    >
                      Required
                    </span>
                    <textarea
                      className={`mt-1.5 min-h-48 w-full resize-y rounded-control border border-separator-subtle bg-surface-thread px-3 py-2.5 text-sm leading-6 text-content-primary placeholder:text-content-muted disabled:cursor-not-allowed disabled:text-content-disabled ${focusRing}`}
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
                  <div className="-mt-3 text-xs leading-5 text-content-muted" id="settings-system-prompt-help">
                    Primary instructions sent whenever this preset is used.
                  </div>
                  <div className="-mt-4 min-h-5 text-xs text-accent-rose" id="settings-system-prompt-error">
                    {systemMissing ? "Enter system instructions." : null}
                  </div>

                  <label className="block" htmlFor="settings-developer-prompt">
                    <span className="text-xs font-medium text-content-secondary">Developer instructions</span>
                    <span className="ml-1 text-xs text-content-muted">Optional</span>
                    <textarea
                      className={`mt-1.5 min-h-36 w-full resize-y rounded-control border border-separator-subtle bg-surface-thread px-3 py-2.5 text-sm leading-6 text-content-primary placeholder:text-content-muted disabled:cursor-not-allowed disabled:text-content-disabled ${focusRing}`}
                      id="settings-developer-prompt"
                      aria-label="Developer prompt"
                      aria-describedby="settings-developer-prompt-help"
                      disabled={saving}
                      placeholder="Add implementation constraints or provider-specific guidance."
                      value={editor.developerPrompt}
                      onChange={(event) => onEditorChange({ ...editor, developerPrompt: event.target.value })}
                    />
                  </label>
                  <div className="-mt-3 text-xs leading-5 text-content-muted" id="settings-developer-prompt-help">
                    Additional guidance kept separate from the system instructions.
                  </div>
                </div>

                <div ref={promptActionRegionRef} className="mt-6 border-t border-separator-subtle pt-4" data-testid="prompt-action-region">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className={`inline-flex min-h-touch items-center justify-center gap-2 rounded-control bg-accent-cyan px-4 text-sm font-semibold text-surface-canvas hover:bg-accent-cyan/90 disabled:cursor-not-allowed disabled:opacity-55 sm:min-h-control ${coarsePointerTarget} ${focusRing}`}
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
                          className={`${quietButton} text-accent-rose hover:bg-accent-rose/10 hover:text-accent-rose`}
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
                    <p className="mt-3 text-xs leading-5 text-content-muted" id="default-delete-protection">
                      The user default is protected. Make another prompt the default before deleting this one.
                    </p>
                  ) : null}
                  <p className="mt-3 text-xs leading-5 text-content-muted">
                    Save errors appear above in Settings; your draft stays available so you can try again.
                  </p>
                </div>
              </div>
            </section>

            <section
              className="order-2 min-w-0 border-t border-separator-subtle bg-surface-thread px-3 py-5 lg:order-1 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-t-0"
              aria-labelledby="prompt-library-heading"
            >
              <div className="mb-4 flex items-start justify-between gap-3 px-1">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-content-primary" id="prompt-library-heading">Prompt library</h3>
                  <p className="mt-1 text-xs leading-5 text-content-muted">Select a prompt to edit it. Selection alone does not change the next run.</p>
                </div>
                <button
                  className={`inline-flex min-h-touch shrink-0 items-center gap-2 rounded-control bg-surface-raised px-3 text-xs font-medium text-content-primary hover:bg-surface-hover sm:min-h-control-sm ${coarsePointerTarget} ${focusRing}`}
                  type="button"
                  aria-label="New prompt"
                  disabled={saving}
                  onClick={requestNewPrompt}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  New
                </button>
              </div>

              <div className="mb-4 rounded-control bg-surface-raised px-3 py-3 text-xs leading-5 text-content-secondary">
                <div className="flex items-start gap-2">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-accent-cyan" aria-hidden="true" />
                  <span><strong className="font-semibold text-content-primary">Next run:</strong> {currentPrompt?.name ?? "No prompt selected"}. This changes only the next-message choice.</span>
                </div>
                <div className="mt-2 flex items-start gap-2">
                  <Star className="mt-0.5 size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
                  <span><strong className="font-semibold text-content-primary">User default:</strong> {defaultPrompt?.name ?? "No default set"}. Used as the startup choice for new chats.</span>
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
                          editing ? "bg-surface-selected" : "hover:bg-surface-hover"
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
                          <span className="block break-words text-sm font-semibold leading-5 text-content-primary [overflow-wrap:anywhere]">
                            {prompt.name}
                          </span>
                          <span className="mt-1 block overflow-hidden text-xs leading-5 text-content-muted [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [overflow-wrap:anywhere]">
                            {promptPreview(prompt)}
                          </span>
                        </button>

                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs">
                          {current ? <span className="font-medium text-accent-cyan">Next run</span> : null}
                          {isDefault ? <span className="text-content-secondary">User default</span> : null}
                          {!current && !isDefault ? <span className="text-content-muted">Available preset</span> : null}
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
                            className={`${quietButton} text-accent-rose hover:bg-accent-rose/10 hover:text-accent-rose`}
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
                          <p className="mt-2 px-1 text-xs leading-5 text-content-muted" id={`default-protection-${prompt.id}`}>
                            Protected while this is the user default.
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-control border border-dashed border-separator-subtle px-4 py-6 text-center">
                  <p className="text-sm font-medium text-content-primary">No prompt presets yet</p>
                  <p className="mt-1 text-xs leading-5 text-content-muted">Create one to reuse instructions across conversations.</p>
                  <button
                    className={`mt-3 inline-flex min-h-touch items-center gap-2 rounded-control bg-surface-raised px-3 text-sm font-medium text-content-primary sm:min-h-control ${coarsePointerTarget} ${focusRing}`}
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
        ) : (
          <section
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6"
            aria-labelledby="appearance-heading"
            data-testid="settings-appearance-scroll"
          >
            <div className="mx-auto max-w-4xl">
              <h3 className="text-base font-semibold text-content-primary" id="appearance-heading">Appearance</h3>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-content-secondary">
                Choose an AIQSA palette. The change applies immediately across this browser.
              </p>
              <p className="mt-2 max-w-2xl text-xs leading-5 text-content-muted">
                Theme is a local UI preference saved in this browser and mirrored to a same-site cookie for first paint. It is not synced to your account or conversations.
              </p>

              <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" role="radiogroup" aria-label="Theme">
                {AIQSA_THEMES.map((theme, index) => {
                  const selected = theme.id === themeId;

                  return (
                    <button
                      ref={(node) => {
                        themeRefs.current[index] = node;
                      }}
                      key={theme.id}
                      className={[
                        `min-h-touch min-w-0 rounded-panel p-3 text-left ${focusRing}`,
                        selected
                          ? "bg-surface-selected text-content-primary"
                          : "bg-surface-thread text-content-secondary hover:bg-surface-hover hover:text-content-primary"
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
                        className="block h-24 overflow-hidden rounded-control bg-surface-canvas p-2"
                        data-theme={theme.id}
                        aria-hidden="true"
                      >
                        <span className="flex h-4 items-center justify-between rounded-control bg-surface-navigation px-1.5">
                          <span className="h-1.5 w-8 rounded-pill bg-content-muted/60" />
                          <span className="size-1.5 rounded-pill bg-accent-cyan" />
                        </span>
                        <span className="mt-2 grid h-[3.75rem] grid-cols-[2rem_minmax(0,1fr)] gap-1.5">
                          <span className="rounded-control bg-surface-navigation" />
                          <span className="rounded-control bg-surface-thread p-1.5">
                            <span className="block h-1.5 w-4/5 rounded-pill bg-content-muted/45" />
                            <span className="mt-1.5 block h-5 rounded-control bg-surface-raised" />
                            <span className="mt-1.5 block h-1.5 w-1/2 rounded-pill bg-accent-cyan/75" />
                          </span>
                        </span>
                      </span>
                      <span className="mt-3 flex items-start justify-between gap-2">
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-content-primary">{theme.name}</span>
                          <span className="mt-0.5 block text-xs leading-5 text-content-muted">{theme.description} · {theme.accentLabel} accent</span>
                        </span>
                        {selected ? <Check className="mt-0.5 size-4 shrink-0 text-accent-cyan" aria-hidden="true" /> : null}
                      </span>
                      <span className={`mt-2 block text-xs font-medium ${selected ? "text-accent-cyan" : "text-content-muted"}`}>
                        {selected ? "Current palette" : "Select palette"}
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
          label="prompt"
          onCancel={() => setDiscardIntent(null)}
          onConfirm={confirmDiscard}
        />
      ) : null}
    </div>
  );
}
