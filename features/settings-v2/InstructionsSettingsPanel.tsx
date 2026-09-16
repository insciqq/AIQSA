"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { UiV2Button } from "@/components/ui-v2";
import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { decodeInstructionPresetDraft, INSTRUCTION_PRESET_MAX_COUNT, INSTRUCTION_PRESET_NAME_MAX_LENGTH,
  SYSTEM_INSTRUCTIONS_MAX_LENGTH, RESPONSE_REMINDER_MAX_LENGTH, instructionPresetErrorMessage,
  type InstructionPreset, type InstructionPresetDraft, type InstructionPresetState, type InstructionPresetSummary } from "@/lib/contracts/instructionPresets";
import { SettingsRowV2 } from "./SettingsV2";
import { SettingsSelectV2 } from "./SettingsSelectV2";
import { InstructionPresetApiError, requestInstructionPreset, requestInstructionPresets } from "./instructionPresetsApi";

const DEFAULT_LABEL = "AIQSA default instructions";
const field = "w-full min-w-0 rounded-lg border border-trace-strong bg-answer-paper px-3 py-2 text-sm leading-6 text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60";
const blank: InstructionPresetDraft = { name: "", systemInstructions: "", responseReminder: "" };
const inertHref = () => "text" as const;
const counter = (value: string, limit: number) => `${value.length.toLocaleString("en-US").replaceAll(",", " ")} / ${limit.toLocaleString("en-US").replaceAll(",", " ")}`;
const values = (preset: InstructionPreset): InstructionPresetDraft => ({ name: preset.name, systemInstructions: preset.systemInstructions, responseReminder: preset.responseReminder });
type Editor = { original: InstructionPreset | null; value: InstructionPresetDraft };

export function InstructionsSettingsPanel({ onDirtyChange, onBusyChange }: Readonly<{
  onDirtyChange?(value: boolean): void;
  onBusyChange?(value: boolean): void;
}>) {
  const [state, setState] = useState<InstructionPresetState | null>(null);
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<InstructionPreset | null>(null);
  const [deleting, setDeleting] = useState<InstructionPresetSummary | null>(null);
  const [discard, setDiscard] = useState(false);
  const pending = useRef(false);
  const alive = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const manageButton = useRef<HTMLButtonElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const activeBadge = useRef<HTMLSpanElement>(null);
  const focusIntent = useRef<"name" | "new" | "active" | null>(null);
  const dirty = editor !== null && JSON.stringify(editor.value) !== JSON.stringify(editor.original ? values(editor.original) : blank);
  const editorId = editor ? editor.original?.id ?? "new" : null;

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
    const target = focusIntent.current === "name" ? nameInput.current : focusIntent.current === "new" ? newButton.current
      : focusIntent.current === "active" ? activeBadge.current : null;
    if (target) { focusIntent.current = null; target.focus(); }
  }, [busy, editorId, open, deleting?.id, state?.activePresetId]);
  useEffect(() => {
    const input = textInput.current;
    if (input) { input.style.height = "auto"; input.style.height = `${Math.min(Math.max(input.scrollHeight, 220), 440)}px`; }
  }, [editor?.value.systemInstructions, preview]);

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
    focusIntent.current = "new";
    setEditor(null); setLatest(null); setConflict(false); setDiscard(false); setError(null);
  }
  function change(patch: Partial<InstructionPresetDraft>) { setEditor(current => current && { ...current, value: { ...current.value, ...patch } }); }
  function start() { focusIntent.current = "name"; setEditor({ original: null, value: { ...blank } }); setPreview(false); setError(null); setNotice(null); }
  async function edit(preset: InstructionPresetSummary, duplicate = false) {
    await perform(async () => {
      const full = await requestInstructionPreset(preset.id);
      if (!alive.current) return;
      let name = full.name;
      if (duplicate) {
        let index = 1;
        do { const suffix = index === 1 ? " copy" : ` copy ${index}`; name = full.name.slice(0, 80 - suffix.length) + suffix; index++; }
        while (state?.presets.some(row => row.name === name));
      }
      focusIntent.current = "name";
      setEditor({ original: duplicate ? null : full, value: { ...values(full), name } });
      setPreview(false); setLatest(null); setConflict(false);
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
  function select(id: string | null, focusActive = false) {
    if (!state || editor || state.activePresetId === id) return;
    void perform(async () => {
      const next = await requestInstructionPresets({ action: "select", id, selectionVersion: state.selectionVersion });
      if (!alive.current) return;
      if (focusActive) focusIntent.current = "active";
      setState(next); setNotice("Instructions updated for your next reply.");
    });
  }
  const atLimit = (state?.presets.length ?? 0) >= INSTRUCTION_PRESET_MAX_COUNT;
  return <section data-testid="settings-instructions">
    <SettingsRowV2 title="Instructions" description="Built-in AIQSA rules always apply. A preset adds your instructions on top of them, in every personal chat.">
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <SettingsSelectV2 label="Active instructions" disabled={!state || busy || editor !== null} value={state?.activePresetId ?? ""}
          options={[{ label: DEFAULT_LABEL, value: "" }, ...(state?.presets ?? []).map(row => ({ label: row.name, value: row.id }))]}
          onChange={id => select(id || null)} />
        <UiV2Button type="button" ref={manageButton} disabled={busy} onClick={() => setOpen(true)}>Manage presets…</UiV2Button>
      </div>
    </SettingsRowV2>
    <div className="px-4 sm:px-6">
      {error ? <div className="my-3 text-sm text-critical" role="alert"><p>{error}</p>
        {!editor ? <UiV2Button type="button" disabled={busy} onClick={() => void perform(async () => { const next = await requestInstructionPresets(); if (alive.current) setState(next); })}>Reload presets</UiV2Button> : null}
      </div> : null}
      {notice ? <p className="my-3 text-sm text-positive" role="status">{notice}</p> : null}
      {!state && !error ? <p className="py-3 text-sm text-ink-muted" role="status">Loading instructions…</p> : null}
    </div>
    {open ? <div className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-6 sm:px-6">
      <p className="mb-4 text-xs leading-5 text-ink-muted">Applies from the next reply, including existing and temporary personal chats. Assistants use their own instructions. Projects use Project instructions.</p>
      {editor ? <form aria-label={editor.original ? "Edit instruction preset" : "New instruction preset"} onSubmit={submit}
        onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); submit(); } }}>
        <fieldset disabled={busy} className="grid min-w-0 gap-4">
          <label className="grid gap-1.5 text-sm font-medium text-ink">Name
            <input ref={nameInput} className={field} maxLength={INSTRUCTION_PRESET_NAME_MAX_LENGTH} required value={editor.value.name} onChange={event => change({ name: event.target.value })} />
          </label>
          <div className="v2-instruction-editor min-w-0 overflow-hidden rounded-xl border border-trace-strong bg-answer-paper">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-trace-subtle px-3 py-2">
              <label htmlFor="preset-system-instructions" className="text-sm font-medium text-ink">System instructions</label>
              <div role="group" aria-label="Editor mode" className="flex gap-1">
                <UiV2Button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Write</UiV2Button>
                <UiV2Button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</UiV2Button>
              </div>
            </div>
            <p id="preset-system-help" className="px-3 pt-3 text-xs text-ink-muted">Set the role, rules, and response style.</p>
            {preview ? <div role="region" aria-label="Instructions preview" tabIndex={0} className="v2-instruction-editor-content min-h-56 max-h-[28rem] overflow-auto break-words px-3 py-3 text-sm text-ink focus-visible:outline-none">
              {editor.value.systemInstructions ? <MarkdownMessage content={editor.value.systemInstructions} resolveHref={inertHref} /> : <p className="text-ink-muted">Your instructions will appear here.</p>}
            </div> : <textarea id="preset-system-instructions" ref={textInput} aria-describedby="preset-system-help preset-system-count" rows={8}
              className="v2-instruction-editor-content block w-full min-w-0 resize-none overflow-y-auto bg-transparent px-3 py-3 text-sm leading-6 text-ink focus-visible:outline-none"
              maxLength={SYSTEM_INSTRUCTIONS_MAX_LENGTH} value={editor.value.systemInstructions} onChange={event => change({ systemInstructions: event.target.value })} />}
            <p id="preset-system-count" className="border-t border-trace-subtle px-3 py-2 text-right text-xs tabular-nums text-ink-muted">{counter(editor.value.systemInstructions, SYSTEM_INSTRUCTIONS_MAX_LENGTH)}</p>
          </div>
          <details className="rounded-lg border border-trace-subtle p-3">
            <summary className="v2-focusable cursor-pointer text-sm font-medium text-ink">Response reminder (optional)</summary>
            <p id="preset-reminder-help" className="my-2 text-xs leading-5 text-ink-muted">Appended after your latest message, before the model responds. Example: Always answer in Spanish.</p>
            <textarea aria-label="Response reminder" aria-describedby="preset-reminder-help preset-reminder-count" className={field} rows={3} maxLength={RESPONSE_REMINDER_MAX_LENGTH}
              value={editor.value.responseReminder} onChange={event => change({ responseReminder: event.target.value })} />
            <p id="preset-reminder-count" className="mt-1 text-right text-xs tabular-nums text-ink-muted">{counter(editor.value.responseReminder, RESPONSE_REMINDER_MAX_LENGTH)}</p>
          </details>
          {conflict ? <UiV2Button type="button" onClick={() => void perform(async () => {
            if (!editor.original) return; const next = await requestInstructionPreset(editor.original.id);
            if (alive.current) { setLatest(next); setNotice("Latest version loaded. Your unsaved text is still in the editor."); }
          })}>Reload latest version</UiV2Button> : null}
          {latest ? <details className="rounded-lg border border-trace-subtle p-3"><summary className="v2-focusable text-sm text-ink">Latest saved version: {latest.name}</summary>
            <pre className="my-3 max-h-56 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-ink-secondary">{latest.systemInstructions}{latest.responseReminder ? `\n\nResponse reminder:\n${latest.responseReminder}` : ""}</pre>
            <UiV2Button type="button" onClick={() => { setEditor({ original: latest, value: values(latest) }); setLatest(null); setConflict(false); setError(null); }}>Replace draft with latest version</UiV2Button>
          </details> : null}
          {discard ? <div className="rounded-lg border border-trace-subtle p-3" role="alert"><p className="mb-2 text-sm text-ink">Discard your unsaved instructions?</p><div className="flex gap-2">
            <UiV2Button type="button" onClick={closeEditor}>Discard changes</UiV2Button><UiV2Button type="button" onClick={() => setDiscard(false)}>Keep editing</UiV2Button>
          </div></div> : <div className="flex flex-wrap items-center gap-2">
            <UiV2Button type="submit" disabled={!editor.value.name.trim()}>{busy ? "Saving…" : "Save"}</UiV2Button>
            <UiV2Button type="button" onClick={() => dirty ? setDiscard(true) : closeEditor()}>Cancel</UiV2Button>
            <span className="ml-auto text-xs text-ink-muted">Ctrl / ⌘ S to save</span>
          </div>}
        </fieldset>
      </form> : <>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-ink">Instruction presets</h3>
          <div className="flex gap-2"><UiV2Button type="button" ref={newButton} disabled={!state || busy || atLimit} onClick={start}>New preset</UiV2Button>
            <UiV2Button type="button" disabled={busy} onClick={() => { setOpen(false); manageButton.current?.focus(); }}>Done</UiV2Button></div>
        </div>
        <ul className="divide-y divide-trace-subtle rounded-xl border border-trace-subtle">
          <li className="p-3"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm font-medium text-ink">{DEFAULT_LABEL}</strong>{state && !state.activePresetId ? <span ref={activeBadge} tabIndex={-1} className="v2-focusable text-xs text-positive" aria-label={`Active instructions: ${DEFAULT_LABEL}`}>Active</span> : null}</div>
            <p className="mt-1 text-xs text-ink-muted">Built-in AIQSA rules. Always available.</p>
            {state?.activePresetId ? <div className="mt-2"><UiV2Button type="button" disabled={busy} aria-label={`Make active: ${DEFAULT_LABEL}`} onClick={() => select(null, true)}>Make active</UiV2Button></div> : null}
          </li>
          {state?.presets.map(row => <li key={row.id} className="min-w-0 p-3"><div className="flex flex-wrap items-center gap-2"><strong className="min-w-0 break-words text-sm font-medium text-ink">{row.name}</strong>{state.activePresetId === row.id ? <span ref={activeBadge} tabIndex={-1} className="v2-focusable text-xs text-positive" aria-label={`Active instructions: ${row.name}`}>Active</span> : null}</div>
            <p className="mt-1 truncate text-xs text-ink-muted">{row.firstLine || "No system instructions"}</p>
            {deleting?.id === row.id ? <div role="alert" className="mt-3"><p className="mb-2 text-sm text-ink">Delete “{row.name}”?{state.activePresetId === row.id ? " Your chats will use the AIQSA default instructions from the next reply." : " This preset will be removed."}</p><div className="flex gap-2">
              <UiV2Button type="button" disabled={busy} onClick={() => void perform(async () => { const next = await requestInstructionPresets({ action: "delete", id: row.id, revision: row.revision }); if (alive.current) { focusIntent.current = "new"; setState(next); setDeleting(null); } })}>Delete preset</UiV2Button>
              <UiV2Button type="button" disabled={busy} onClick={() => setDeleting(null)}>Keep preset</UiV2Button></div></div>
              : <div className="mt-2 flex flex-wrap gap-1">
                {state.activePresetId !== row.id ? <UiV2Button type="button" disabled={busy} aria-label={`Make active: ${row.name}`} onClick={() => select(row.id, true)}>Make active</UiV2Button> : null}
                <UiV2Button type="button" disabled={busy} aria-label={`Edit ${row.name}`} onClick={() => void edit(row)}>Edit</UiV2Button><UiV2Button type="button" disabled={busy || atLimit} aria-label={`Duplicate ${row.name}`} onClick={() => void edit(row, true)}>Duplicate</UiV2Button><UiV2Button type="button" disabled={busy} aria-label={`Delete ${row.name}`} onClick={() => setDeleting(row)}>Delete</UiV2Button></div>}
          </li>)}
        </ul>
        <p className="mt-2 text-xs text-ink-muted">{state?.presets.length ?? 0} / {INSTRUCTION_PRESET_MAX_COUNT} presets</p>
      </>}
    </div> : null}
  </section>;
}
