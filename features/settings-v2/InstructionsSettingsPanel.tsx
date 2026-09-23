"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { UiV2Button, UiV2IconButton, UiV2MenuItem } from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { editorCharacterCount } from "@/components/ui-v2/MarkdownEditorV2";
import { InstructionTemplateEditor } from "./InstructionTemplateEditor";
import { InstructionAnswerRules } from "./InstructionAnswerRules";
import { VISIBLE_ANSWER_CONTRACT } from "@/lib/domain/promptTemplates";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { decodeInstructionPresetDraft, INSTRUCTION_PRESET_MAX_COUNT, INSTRUCTION_PRESET_NAME_MAX_LENGTH,
  SYSTEM_INSTRUCTIONS_MAX_LENGTH, RESPONSE_REMINDER_MAX_LENGTH, instructionPresetErrorMessage,
  type InstructionPreset, type InstructionPresetDraft, type InstructionPresetState, type InstructionPresetSummary } from "@/lib/contracts/instructionPresets";
import { SectionHeading } from "@/features/library-v2/LibraryV2";
import type { LibrarySubviewV2 } from "@/features/library-v2/contracts";
import { PlatformInstructionsPreview } from "./PlatformInstructionsPreview";
import { InstructionPresetApiError, requestInstructionPreset, requestInstructionPresets } from "./instructionPresetsApi";

const DEFAULT_LABEL = "AIQSA default instructions";
const field = "w-full min-w-0 rounded-lg border border-trace-strong bg-answer-paper px-3 py-2 text-sm leading-6 text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60";
const blank: InstructionPresetDraft = { name: "", systemInstructions: "", responseReminder: "", answerRules: null };
const values = (preset: InstructionPreset): InstructionPresetDraft => ({ name: preset.name, systemInstructions: preset.systemInstructions, responseReminder: preset.responseReminder, answerRules: preset.answerRules ?? null });
type Editor = { original: InstructionPreset | null; value: InstructionPresetDraft };

export function InstructionsSettingsPanel({ onDirtyChange, onBusyChange, onSubviewChange, onRequestExit }: Readonly<{
  onDirtyChange?(value: boolean): void;
  onBusyChange?(value: boolean): void;
  onSubviewChange?(value: LibrarySubviewV2 | null): void;
  onRequestExit?(proceed: () => void): void;
}>) {
  const [state, setState] = useState<InstructionPresetState | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<InstructionPreset | null>(null);
  const [deleting, setDeleting] = useState<InstructionPresetSummary | null>(null);
  const [discard, setDiscard] = useState(false);
  const [platformPreviewOpen, setPlatformPreviewOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const panelId = useId();
  const pending = useRef(false);
  const alive = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const viewButton = useRef<HTMLButtonElement>(null);
  const keepEditingButton = useRef<HTMLButtonElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const radios = useRef(new Map<string, HTMLInputElement>());
  const returnTarget = useRef("new");
  const focusIntent = useRef<string | null>(null);
  const dirty = editor !== null && JSON.stringify(editor.value) !== JSON.stringify(editor.original ? values(editor.original) : blank);
  const editorId = editor ? editor.original?.id ?? "new" : null;
  const subviewLabel = platformPreviewOpen ? DEFAULT_LABEL : editor ? editor.value.name.trim() || "New preset" : null;

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    requestInstructionPresets(undefined, controller.signal).then(next => {
      if (!controller.signal.aborted) setState(next);
    }).catch(() => { if (!controller.signal.aborted) setError(instructionPresetErrorMessage(null)); });
    return () => { alive.current = false; controller.abort(); };
  }, []);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (busy) return;
    const intent = focusIntent.current;
    const target = intent === "name" ? nameInput.current : intent === "new" ? newButton.current
      : intent === "view" ? viewButton.current : intent === "keep" ? keepEditingButton.current
      : intent?.startsWith("radio:") ? radios.current.get(intent.slice(6)) : intent ? rowButtons.current.get(intent) : null;
    if (target) {
      focusIntent.current = null;
      target.focus({ preventScroll: true });
      // The closing modal restores its opener in a microtask. The resource
      // owns the destination after leaving the editor, including that case.
      if (intent !== "name" && intent !== "keep" && !intent?.startsWith("radio:")) {
        const frame = window.requestAnimationFrame(() => { if (target.isConnected) target.focus({ preventScroll: true }); });
        return () => window.cancelAnimationFrame(frame);
      }
    }
  }, [busy, editorId, discard, platformPreviewOpen, deleting?.id, state]);

  async function perform(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (failure) { if (alive.current) {
      setError(failure instanceof InstructionPresetApiError ? failure.message : instructionPresetErrorMessage(null));
      setConflict(failure instanceof InstructionPresetApiError && failure.code === "instruction_preset_conflict");
    } } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  function closeEditor() {
    focusIntent.current = returnTarget.current;
    setEditor(null); setLatest(null); setConflict(false); setDiscard(false); setError(null);
  }
  const requestCloseEditor = useEventCallback(() => {
    if (pending.current) return;
    if (platformPreviewOpen) { focusIntent.current = "view"; setPlatformPreviewOpen(false); return; }
    if (onRequestExit) { onRequestExit(closeEditor); return; }
    if (dirty) { focusIntent.current = "keep"; setDiscard(true); }
    else closeEditor();
  });
  useEffect(() => {
    onSubviewChange?.(subviewLabel === null ? null : {
      key: platformPreviewOpen ? "instruction-platform-preview" : `instruction-editor-${editorId}`,
      label: subviewLabel, backLabel: "Back to Instructions", busy, focus: "resource", onBack: requestCloseEditor
    });
  }, [busy, editorId, onSubviewChange, platformPreviewOpen, requestCloseEditor, subviewLabel]);
  useEffect(() => () => onSubviewChange?.(null), [onSubviewChange]);

  function change(patch: Partial<InstructionPresetDraft>) { setEditor(current => current && { ...current, value: { ...current.value, ...patch } }); }
  function start() {
    returnTarget.current = "new"; focusIntent.current = "name";
    setEditor({ original: null, value: { ...blank } }); setReminderOpen(false); setError(null); setNotice(null); setConflict(false);
  }
  async function edit(preset: InstructionPresetSummary, duplicate = false) {
    await perform(async () => {
      const full = await requestInstructionPreset(preset.id);
      if (!alive.current) return;
      let name = full.name;
      if (duplicate) {
        let index = 1;
        do { const suffix = index === 1 ? " copy" : ` copy ${index}`; name = full.name.slice(0, INSTRUCTION_PRESET_NAME_MAX_LENGTH - suffix.length) + suffix; index++; }
        while (state?.presets.some(row => row.name === name));
      }
      returnTarget.current = preset.id; focusIntent.current = "name";
      setEditor({ original: duplicate ? null : full, value: { ...values(full), name } });
      setReminderOpen(Boolean(full.responseReminder)); setLatest(null); setConflict(false);
    });
  }
  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!editor || busy) return;
    const value = decodeInstructionPresetDraft(editor.value);
    if (!value) { setError(instructionPresetErrorMessage("instruction_preset_invalid")); return; }
    void perform(async () => {
      const next = await requestInstructionPresets(editor.original
        ? { action: "update", id: editor.original.id, revision: editor.original.revision, value }
        : { action: "create", value });
      if (!alive.current) return;
      setState(next); closeEditor(); setNotice("Preset saved. Select it to use it in your personal chats.");
    });
  }
  function select(id: string | null) {
    if (!state || editor || pending.current || state.activePresetId === id) return;
    focusIntent.current = `radio:${id ?? "default"}`;
    void perform(async () => {
      const next = await requestInstructionPresets({ action: "select", id, selectionVersion: state.selectionVersion });
      if (!alive.current) return;
      setState(next); setNotice("Instructions updated for your next reply.");
    });
  }
  const atLimit = (state?.presets.length ?? 0) >= INSTRUCTION_PRESET_MAX_COUNT;
  const messages = <>
    {error ? <div className="my-3 text-sm text-critical" role="alert"><p>{error}</p>
      {!editor ? <UiV2Button type="button" disabled={busy} onClick={() => void perform(async () => { const next = await requestInstructionPresets(); if (alive.current) setState(next); })}>Reload presets</UiV2Button> : null}
    </div> : null}
    {notice ? <p className="my-3 text-sm text-positive" role="status">{notice}</p> : null}
  </>;
  return <section className={`v2-studio-settings-page${editor ? " v2-instructions-editor-page" : ""}`} data-testid="settings-instructions">
    {platformPreviewOpen ? <PlatformInstructionsPreview onClose={onSubviewChange ? undefined : requestCloseEditor} /> : editor ? <form className="v2-instructions-form" aria-label={editor.original ? "Edit instruction preset" : "New instruction preset"} onSubmit={submit}
      onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}>
      <fieldset disabled={busy} className="v2-instructions-fields">
        <label className="v2-instructions-name grid gap-1.5 text-sm font-medium text-ink">Name
          <input ref={nameInput} className={field} maxLength={INSTRUCTION_PRESET_NAME_MAX_LENGTH} required value={editor.value.name} onChange={event => change({ name: event.target.value })} />
        </label>
        {messages}
        <InstructionTemplateEditor key={editorId} label="System instructions" previewLabel="Instructions preview" maxLength={SYSTEM_INSTRUCTIONS_MAX_LENGTH}
          disabled={busy} value={editor.value.systemInstructions} onChange={value => change({ systemInstructions: value })} />
        <InstructionAnswerRules value={editor.value.answerRules ?? null} disabled={busy} onChange={answerRules => change({ answerRules })} />
        <details className="v2-instructions-reminder" open={reminderOpen} onToggle={event => setReminderOpen(event.currentTarget.open)}>
          <summary className="v2-focusable cursor-pointer text-sm font-medium text-ink">Response reminder (optional)</summary>
          <p id={`${panelId}-reminder-help`} className="my-2 text-xs leading-5 text-ink-muted">Appended after your latest message, before the model responds. Example: Always answer in Spanish. You can use {"{local_date}"} and {"{local_time}"} here too.</p>
          <textarea aria-label="Response reminder" aria-describedby={`${panelId}-reminder-help ${panelId}-reminder-count`} className={field} rows={3} maxLength={RESPONSE_REMINDER_MAX_LENGTH}
            value={editor.value.responseReminder} onChange={event => change({ responseReminder: event.target.value })} />
          <p id={`${panelId}-reminder-count`} className="mt-1 text-right text-xs tabular-nums text-ink-muted">{editorCharacterCount(editor.value.responseReminder, RESPONSE_REMINDER_MAX_LENGTH)}</p>
        </details>
        {conflict ? <UiV2Button type="button" onClick={() => void perform(async () => {
          if (!editor.original) return; const next = await requestInstructionPreset(editor.original.id);
          if (alive.current) { setLatest(next); setNotice("Latest version loaded. Your unsaved text is still in the editor."); }
        })}>Reload latest version</UiV2Button> : null}
        {latest ? <details className="rounded-lg border border-trace-subtle p-3"><summary className="v2-focusable text-sm text-ink">Latest saved version: {latest.name}</summary>
          <pre className="my-3 max-h-56 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-ink-secondary">{latest.systemInstructions}{latest.answerRules != null ? `\n\nAnswer rules:\n${latest.answerRules}` : ""}{latest.responseReminder ? `\n\nResponse reminder:\n${latest.responseReminder}` : ""}</pre>
          <UiV2Button type="button" onClick={() => { setEditor({ original: latest, value: values(latest) }); setReminderOpen(Boolean(latest.responseReminder)); setLatest(null); setConflict(false); setError(null); }}>Replace draft with latest version</UiV2Button>
        </details> : null}
        {discard ? <div className="rounded-lg border border-trace-subtle p-3" role="alert"><p className="mb-2 text-sm text-ink">Discard your unsaved instructions?</p><div className="flex gap-2">
          <UiV2Button type="button" onClick={closeEditor}>Discard changes</UiV2Button><UiV2Button type="button" ref={keepEditingButton} onClick={() => { setDiscard(false); focusIntent.current = "name"; }}>Keep editing</UiV2Button>
        </div></div> : null}
        <footer className="v2-instructions-footer">
          <span>Ctrl / ⌘ S to save</span>
          <UiV2Button type="button" onClick={requestCloseEditor}>Cancel</UiV2Button>
          <UiV2Button type="submit" tone="primary" disabled={!editor.value.name.trim()}>{busy ? "Saving…" : "Save"}</UiV2Button>
        </footer>
      </fieldset>
    </form> : <>
      <SectionHeading description="The active preset adds instructions to your personal chats without an Assistant, from the next reply. Each preset can also customize the standard answer rules."
        action={<UiV2Button type="button" tone="primary" icon="plus" ref={newButton} disabled={!state || busy || atLimit}
          aria-describedby={atLimit ? `${panelId}-limit` : undefined} onClick={start}>New preset</UiV2Button>}>Instructions</SectionHeading>
      {messages}
      <details className="v2-instructions-reminder my-3">
        <summary className="v2-focusable cursor-pointer text-sm font-medium text-ink">AIQSA standard answer rules</summary>
        <p className="my-2 text-xs leading-5 text-ink-muted">Used in chats, Projects and Assistants. A personal preset can replace these rules for personal chats in its Answer rules section.</p>
        <p className="whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{VISIBLE_ANSWER_CONTRACT}</p>
      </details>
      {atLimit ? <p id={`${panelId}-limit`} className="my-3 text-sm text-ink-muted">{instructionPresetErrorMessage("instruction_preset_limit")}</p> : null}
      {!state && !error ? <p className="py-3 text-sm text-ink-muted" role="status">Loading instructions…</p> : null}
      <div className="v2-instructions-list" role="radiogroup" aria-label="Active instructions">
        {[{ id: null, name: DEFAULT_LABEL, firstLine: "Built-in AIQSA rules. Always available." }, ...(state?.presets ?? [])].map(row => <div className="v2-instructions-row" key={row.id ?? "default"}>
          <label className="v2-instructions-choice">
            <input type="radio" name={`${panelId}-active`} aria-label={row.name} aria-describedby={`${panelId}-${row.id ?? "default"}-description`}
              ref={node => { const key = row.id ?? "default"; if (node) radios.current.set(key, node); else radios.current.delete(key); }}
              disabled={!state || busy} checked={Boolean(state && state.activePresetId === row.id)} onChange={() => select(row.id)} />
            <span className="v2-instructions-copy"><span className="v2-instructions-title"><strong>{row.name}</strong>
              {state && state.activePresetId === row.id ? <span className="v2-instructions-active" aria-label={`Active instructions: ${row.name}`}>Active</span> : null}
            </span><span id={`${panelId}-${row.id ?? "default"}-description`} className="v2-instructions-description">{row.firstLine || "No system instructions"}</span></span>
          </label>
          {row.id === null ? <><UiV2Button type="button" ref={viewButton} className="v2-instructions-row-action" disabled={busy} onClick={() => { setNotice(null); setPlatformPreviewOpen(true); }}>View</UiV2Button><span className="v2-instructions-menu-spacer" aria-hidden="true" /></>
            : <><UiV2Button type="button" className="v2-instructions-row-action" ref={node => { if (node) rowButtons.current.set(row.id, node); else rowButtons.current.delete(row.id); }}
              disabled={busy} aria-label={`Edit ${row.name}`} onClick={() => void edit(row)}>Edit</UiV2Button>
              <PresetMenu name={row.name} busy={busy} atLimit={atLimit} onDuplicate={() => void edit(row, true)} onDelete={() => setDeleting(row)} /></>}
          {row.id !== null && deleting?.id === row.id ? <div role="alert" className="v2-instructions-delete"><p className="mb-2 text-sm text-ink">Delete “{row.name}”?{state?.activePresetId === row.id ? " Your chats will use the AIQSA default instructions from the next reply." : " This preset will be removed."}</p><div className="flex gap-2">
            <UiV2Button type="button" disabled={busy} onClick={() => void perform(async () => { const next = await requestInstructionPresets({ action: "delete", id: row.id, revision: row.revision }); if (alive.current) { focusIntent.current = "new"; setState(next); setDeleting(null); } })}>Delete preset</UiV2Button>
            <UiV2Button type="button" disabled={busy} onClick={() => { focusIntent.current = row.id; setDeleting(null); }}>Keep preset</UiV2Button></div></div> : null}
        </div>)}
      </div>
      <p className="mt-3 text-xs text-ink-muted">{state?.presets.length ?? 0} of {INSTRUCTION_PRESET_MAX_COUNT} presets.</p>
      <p className="mt-2 text-xs leading-5 text-ink-muted">Applies from the next reply, including existing and temporary personal chats. Assistants use their own instructions. Projects use Project instructions.</p>
    </>}
  </section>;
}

function PresetMenu({ name, busy, atLimit, onDuplicate, onDelete }: Readonly<{
  name: string; busy: boolean; atLimit: boolean; onDuplicate(): void; onDelete(): void;
}>) {
  const [open, setOpen] = useState(false);
  const { triggerRef, menuRef, closeForAction } = useMenuDismissalV2({ open, onClose: () => setOpen(false) });
  return <span className="v2-instructions-menu">
    <UiV2IconButton ref={triggerRef} icon="more" label={`More actions for ${name}`} disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} />
    {open ? <UiV2ResponsiveMenu anchorRef={triggerRef} menuRef={menuRef} label={`Actions for ${name}`} onClose={() => setOpen(false)}>
      <UiV2MenuItem disabled={atLimit} onClick={() => { closeForAction(); onDuplicate(); }}>Duplicate</UiV2MenuItem>
      <UiV2MenuItem onClick={() => { closeForAction(); onDelete(); }}>Delete</UiV2MenuItem>
    </UiV2ResponsiveMenu> : null}
  </span>;
}
