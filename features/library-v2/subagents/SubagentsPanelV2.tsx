"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { UiV2Button, UiV2IconButton, UiV2MenuItem } from "@/components/ui-v2";
import { MarkdownEditorV2 } from "@/components/ui-v2/MarkdownEditorV2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { SUBAGENT_DEFINITION_LIMITS, SUBAGENT_TOOL_GROUPS, normalizeSubagentName, type SubagentToolGroup } from "@/lib/contracts/subagents";
import {
  SUBAGENT_TOOL_GROUP_LABELS,
  subagentModelLabel,
  type SubagentDefinitionDraft,
  type SubagentDefinitionListResponse,
  type SubagentDefinitionSummary,
  type SubagentDefinitionView,
  type SubagentModelOption
} from "@/lib/contracts/subagentDefinitions";
import { SectionHeading } from "@/features/library-v2/LibraryV2";
import {
  createSubagentDefinition,
  deleteSubagentDefinition,
  getSubagentDefinition,
  listSubagentDefinitions,
  restoreSubagentRevision,
  subagentErrorMessage,
  updateSubagentDefinition
} from "./subagentsApi";

/**
 * Studio > Sub-agents: the user's custom sub-agents (operator decision
 * 2026-10-29, like Claude Code's custom agents). Optional: without one, a
 * sub-agent runs on the chat's model with the chat's tools. Each save is a
 * new version, so the last save offers Undo; deleting asks first and names
 * what it changes. The server owns validation, the model list and the
 * version guard; this view keeps only the draft.
 */

const field = "w-full min-w-0 rounded-lg border border-trace-strong bg-answer-paper px-3 py-2 text-sm leading-6 text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60";
const GROUPS: readonly SubagentToolGroup[] = Object.values(SUBAGENT_TOOL_GROUPS);
const INHERIT = "";

type Draft = {
  name: string;
  description: string;
  instructions: string;
  modelId: string;
  effort: string;
  /** null: every sub-agent tool. */
  tools: SubagentToolGroup[] | null;
};
type Editor = Readonly<{ original: SubagentDefinitionView | null; value: Draft }>;
/** The last save, which Undo reverses while the sub-agent is still at its version. */
type LastSave = Readonly<{ kind: "created" | "updated"; definition: SubagentDefinitionView }>;

const blank: Draft = { description: "", effort: INHERIT, instructions: "", modelId: INHERIT, name: "", tools: null };

function draftOf(definition: SubagentDefinitionView): Draft {
  return { description: definition.description, effort: definition.effort ?? INHERIT, instructions: definition.instructions,
    modelId: definition.modelId ?? INHERIT, name: definition.name, tools: definition.tools === null ? null : [...definition.tools] };
}

function wireDraft(value: Draft): SubagentDefinitionDraft {
  return { description: value.description, effort: value.effort || null, instructions: value.instructions, modelId: value.modelId || null,
    name: value.name.trim().toLowerCase(), tools: value.tools === null ? null : GROUPS.filter((group) => value.tools!.includes(group)) };
}

/** The efforts the draft may choose: its model's, or any of the user's models' when it runs on the chat's model. */
function effortOptions(models: readonly SubagentModelOption[], modelId: string): readonly string[] {
  if (modelId) return models.find((model) => model.modelId === modelId)?.efforts ?? [];
  return [...new Set(models.flatMap((model) => model.efforts))];
}

function modelLine(definition: SubagentDefinitionSummary): string {
  const model = definition.modelId === null ? "Chat's model" : definition.modelDisplayName ?? "Unavailable model";
  const tools = definition.tools === null ? "All tools" : definition.tools.length === 0 ? "No optional tools"
    : definition.tools.length === 1 ? SUBAGENT_TOOL_GROUP_LABELS[definition.tools[0]!] : `${definition.tools.length} tool groups`;
  return [model, definition.effort ? `${definition.effort} effort` : null, tools].filter(Boolean).join(" · ");
}

export function SubagentsPanelV2({ onBusyChange, onDirtyChange }: Readonly<{
  onBusyChange?(value: boolean): void;
  onDirtyChange?(value: boolean): void;
}>) {
  const [state, setState] = useState<SubagentDefinitionListResponse | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastSave, setLastSave] = useState<LastSave | null>(null);
  const [deleting, setDeleting] = useState<SubagentDefinitionSummary | null>(null);
  const [discard, setDiscard] = useState(false);
  const panelId = useId();
  const pending = useRef(false);
  const alive = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusIntent = useRef<string | null>(null);
  const dirty = editor !== null && JSON.stringify(editor.value) !== JSON.stringify(editor.original ? draftOf(editor.original) : blank);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    listSubagentDefinitions(controller.signal).then((next) => { if (!controller.signal.aborted) setState(next); })
      .catch(() => { if (!controller.signal.aborted) setError("Your sub-agents could not be loaded."); });
    return () => { alive.current = false; controller.abort(); };
  }, []);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (busy) return;
    const intent = focusIntent.current;
    const target = intent === "name" ? nameInput.current : intent === "new" ? newButton.current : intent ? editButtons.current.get(intent) : null;
    if (target) {
      focusIntent.current = null;
      target.focus({ preventScroll: true });
    }
  }, [busy, editor, state, deleting]);

  async function perform(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await action(); }
    catch (failure) { if (alive.current) setError(subagentErrorMessage(failure)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function reload() {
    const next = await listSubagentDefinitions();
    if (alive.current) setState(next);
  }
  function closeEditor(returnTo: string | null) {
    focusIntent.current = returnTo ?? "new";
    setEditor(null); setDiscard(false); setError(null);
  }
  function requestClose() {
    if (pending.current || !editor) return;
    if (dirty) setDiscard(true);
    else closeEditor(editor.original?.id ?? null);
  }
  function change(patch: Partial<Draft>) {
    setEditor((current) => current && { ...current, value: { ...current.value, ...patch } });
  }
  function start() {
    focusIntent.current = "name"; setLastSave(null); setDeleting(null);
    setEditor({ original: null, value: { ...blank } }); setNotice(null); setError(null);
  }
  function edit(row: SubagentDefinitionSummary) {
    void perform(async () => {
      const full = await getSubagentDefinition(row.id);
      if (!alive.current) return;
      focusIntent.current = "name"; setLastSave(null); setDeleting(null);
      setEditor({ original: full, value: draftOf(full) });
    });
  }
  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!editor || busy) return;
    const value = wireDraft(editor.value);
    void perform(async () => {
      const saved = editor.original
        ? await updateSubagentDefinition(editor.original.id, editor.original.version, value)
        : await createSubagentDefinition(value);
      if (!alive.current) return;
      await reload();
      closeEditor(saved.id);
      // A save that changed nothing (the server compares after normalizing) leaves the version as it was: there is
      // nothing to undo, and restoring the previous revision would reverse the last real edit.
      const unchanged = editor.original !== null && saved.version === editor.original.version;
      setLastSave(unchanged ? null : { definition: saved, kind: editor.original ? "updated" : "created" });
      setNotice(unchanged ? `Saved “${saved.name}”. Nothing changed.` : editor.original ? `Saved “${saved.name}”.`
        : `Created “${saved.name}”. Ask the agent to use it by name.`);
    });
  }
  function undo() {
    if (!lastSave) return;
    const { definition, kind } = lastSave;
    void perform(async () => {
      if (kind === "created") await deleteSubagentDefinition(definition.id, definition.version);
      else if (definition.previousRevisionId) await restoreSubagentRevision(definition.id, definition.version, definition.previousRevisionId);
      if (!alive.current) return;
      setLastSave(null);
      await reload();
      focusIntent.current = kind === "created" ? "new" : definition.id;
      setNotice(kind === "created" ? `Undone: “${definition.name}” is deleted.` : `Undone: “${definition.name}” is back to its previous version.`);
    });
  }
  function remove(row: SubagentDefinitionSummary) {
    void perform(async () => {
      await deleteSubagentDefinition(row.id, row.version);
      if (!alive.current) return;
      setDeleting(null); setLastSave(null);
      await reload();
      focusIntent.current = "new";
      setNotice(`Deleted “${row.name}”.`);
    });
  }

  const models = state?.models ?? [];
  const atLimit = (state?.definitions.length ?? 0) >= (state?.limit ?? SUBAGENT_DEFINITION_LIMITS.perUser);
  const messages = <>
    {error ? <div className="my-3 text-sm text-critical" role="alert"><p>{error}</p>
      {!editor ? <UiV2Button type="button" disabled={busy} onClick={() => void perform(reload)}>Reload sub-agents</UiV2Button> : null}
    </div> : null}
    {notice ? <div className="my-3 flex flex-wrap items-center gap-2 text-sm text-positive" role="status"><span>{notice}</span>
      {lastSave && (lastSave.kind === "created" || lastSave.definition.previousRevisionId)
        ? <UiV2Button type="button" icon="history" disabled={busy} onClick={undo}>Undo</UiV2Button> : null}
    </div> : null}
  </>;

  if (editor) {
    const value = editor.value;
    const efforts = effortOptions(models, value.modelId);
    const unknownModel = value.modelId !== INHERIT && !models.some((model) => model.modelId === value.modelId);
    const normalizedName = normalizeSubagentName(value.name);
    const canSave = Boolean(normalizedName && value.description.trim() && value.instructions.trim());
    return <section className="v2-studio-settings-page v2-instructions-editor-page" data-testid="studio-subagents">
      <form className="v2-instructions-form" aria-label={editor.original ? `Edit sub-agent ${editor.original.name}` : "New sub-agent"} onSubmit={submit}
        onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}>
        <fieldset disabled={busy} className="v2-instructions-fields">
          <label className="v2-instructions-name grid gap-1.5 text-sm font-medium text-ink">Name
            <input ref={nameInput} className={field} maxLength={SUBAGENT_DEFINITION_LIMITS.nameCharacters} required value={value.name}
              aria-describedby={`${panelId}-name-help`} autoCapitalize="none" autoCorrect="off" spellCheck={false}
              onChange={(event) => change({ name: event.target.value })} />
            <span id={`${panelId}-name-help`} className="text-xs font-normal text-ink-muted">Lowercase letters, digits, hyphens and underscores, for example “browser”. The agent starts it by this name.</span>
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-ink">Description
            <textarea className={field} rows={2} required maxLength={SUBAGENT_DEFINITION_LIMITS.descriptionCharacters} value={value.description}
              aria-describedby={`${panelId}-description-help`} onChange={(event) => change({ description: event.target.value })} />
            <span id={`${panelId}-description-help`} className="text-xs font-normal text-ink-muted">When the agent should use it. The agent sees this in every chat.</span>
          </label>
          {messages}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium text-ink">Model
              <select className={field} value={value.modelId} onChange={(event) => {
                const modelId = event.currentTarget.value;
                change({ modelId, effort: effortOptions(models, modelId).includes(value.effort) ? value.effort : INHERIT });
              }}>
                <option value={INHERIT}>Same as the chat</option>
                {unknownModel ? <option value={value.modelId}>Unavailable model</option> : null}
                {models.map((model) => <option key={model.modelId} value={model.modelId}>{subagentModelLabel(model)}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-ink">Reasoning effort
              <select className={field} value={value.effort} disabled={efforts.length === 0 && !value.effort} onChange={(event) => change({ effort: event.currentTarget.value })}>
                <option value={INHERIT}>{value.modelId ? "Model default" : "Same as the chat"}</option>
                {value.effort && !efforts.includes(value.effort) ? <option value={value.effort}>{value.effort} (not supported)</option> : null}
                {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
          </div>
          {unknownModel ? <p className="text-sm text-critical" role="note">This model is no longer available to you, so the agent cannot start this sub-agent. Choose another model.</p> : null}
          <fieldset className="grid gap-2 text-sm text-ink" aria-describedby={`${panelId}-tools-help`}>
            <legend className="font-medium">Tools</legend>
            <span id={`${panelId}-tools-help`} className="text-xs text-ink-muted">A sub-agent never changes your resources or starts other sub-agents, whatever you choose.</span>
            <label className="flex items-center gap-2"><input type="radio" name={`${panelId}-tools`} checked={value.tools === null}
              onChange={() => change({ tools: null })} />All sub-agent tools</label>
            <label className="flex items-center gap-2"><input type="radio" name={`${panelId}-tools`} checked={value.tools !== null}
              onChange={() => change({ tools: value.tools ?? [] })} />Only the tools I choose</label>
            {value.tools !== null ? <div className="grid gap-2 pl-6 sm:grid-cols-2" role="group" aria-label="Tools it may use">
              {GROUPS.map((group) => <label key={group} className="flex items-center gap-2">
                <input type="checkbox" checked={value.tools!.includes(group)} onChange={(event) => change({
                  tools: event.currentTarget.checked ? [...value.tools!, group] : value.tools!.filter((entry) => entry !== group)
                })} />{SUBAGENT_TOOL_GROUP_LABELS[group]}
              </label>)}
            </div> : null}
          </fieldset>
          <MarkdownEditorV2 key={editor.original?.id ?? "new"} label="Instructions" previewLabel="Instructions preview"
            help="Its standing instructions: how to work and what to report back." maxLength={SUBAGENT_DEFINITION_LIMITS.instructionsCharacters}
            disabled={busy} value={value.instructions} onChange={(instructions) => change({ instructions })} />
          {discard ? <div className="rounded-lg border border-trace-subtle p-3" role="alert"><p className="mb-2 text-sm text-ink">Discard your unsaved changes to this sub-agent?</p><div className="flex gap-2">
            <UiV2Button type="button" onClick={() => closeEditor(editor.original?.id ?? null)}>Discard changes</UiV2Button>
            <UiV2Button type="button" onClick={() => { setDiscard(false); focusIntent.current = "name"; }}>Keep editing</UiV2Button>
          </div></div> : null}
          <footer className="v2-instructions-footer">
            <span>Ctrl / ⌘ S to save</span>
            <UiV2Button type="button" onClick={requestClose}>Cancel</UiV2Button>
            <UiV2Button type="submit" tone="primary" disabled={!canSave}>{busy ? "Saving…" : "Save"}</UiV2Button>
          </footer>
        </fieldset>
      </form>
    </section>;
  }

  return <section className="v2-studio-settings-page" data-testid="studio-subagents">
    <SectionHeading description="Optional helpers the agent can start for long or separate work, each with its own model, instructions and tools. Without them, sub-agents run on the chat's model with the chat's tools."
      action={<UiV2Button type="button" tone="primary" icon="plus" ref={newButton} disabled={!state || busy || atLimit}
        aria-describedby={atLimit ? `${panelId}-limit` : undefined} onClick={start}>New sub-agent</UiV2Button>}>Sub-agents</SectionHeading>
    {messages}
    {atLimit ? <p id={`${panelId}-limit`} className="my-3 text-sm text-ink-muted">You have reached the limit of {state?.limit} sub-agents. Delete one to add another.</p> : null}
    {!state && !error ? <p className="py-3 text-sm text-ink-muted" role="status">Loading sub-agents…</p> : null}
    {state && state.definitions.length === 0 ? <p className="py-3 text-sm text-ink-muted">No custom sub-agents yet. Create one here, or ask the agent in a chat, for example “create a browser sub-agent on a cheaper model”.</p> : null}
    {state && state.definitions.length > 0 ? <ul className="v2-instructions-list" aria-label="Your sub-agents">
      {state.definitions.map((row) => <li className="v2-instructions-row" key={row.id}>
        <span className="v2-instructions-copy">
          <span className="v2-instructions-title"><strong>{row.name}</strong></span>
          <span className="v2-instructions-description" title={row.description}>{row.description}</span>
          <span className="v2-instructions-description">{modelLine(row)}</span>
          {!row.modelAvailable ? <span className="text-xs text-critical">Its model is no longer available to you; the agent cannot start it until you choose another.</span> : null}
        </span>
        <UiV2Button type="button" className="v2-instructions-row-action" disabled={busy} aria-label={`Edit ${row.name}`}
          ref={(node) => { if (node) editButtons.current.set(row.id, node); else editButtons.current.delete(row.id); }}
          onClick={() => edit(row)}>Edit</UiV2Button>
        <RowMenu name={row.name} busy={busy} onDelete={() => { setDeleting(row); setNotice(null); setLastSave(null); }} />
        {deleting?.id === row.id ? <div role="alert" className="v2-instructions-delete">
          <p className="mb-2 text-sm text-ink">Delete “{row.name}” with all its versions? The agent can no longer start it, and sub-agents already started as it in your chats keep their work but cannot be continued. This cannot be undone.</p>
          <div className="flex gap-2">
            <UiV2Button type="button" tone="destructive" disabled={busy} onClick={() => remove(row)}>Delete sub-agent</UiV2Button>
            <UiV2Button type="button" disabled={busy} onClick={() => { focusIntent.current = row.id; setDeleting(null); }}>Keep sub-agent</UiV2Button>
          </div>
        </div> : null}
      </li>)}
    </ul> : null}
    {state ? <p className="mt-3 text-xs text-ink-muted">{state.definitions.length} of {state.limit} sub-agents. Changes apply to sub-agents the agent starts from now on; running ones keep what they started with.</p> : null}
  </section>;
}

function RowMenu({ name, busy, onDelete }: Readonly<{ name: string; busy: boolean; onDelete(): void }>) {
  const [open, setOpen] = useState(false);
  const { triggerRef, menuRef, closeForAction } = useMenuDismissalV2({ open, onClose: () => setOpen(false) });
  return <span className="v2-instructions-menu">
    <UiV2IconButton ref={triggerRef} icon="more" label={`More actions for ${name}`} disabled={busy} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen((value) => !value)} />
    {open ? <UiV2ResponsiveMenu anchorRef={triggerRef} menuRef={menuRef} label={`Actions for ${name}`} onClose={() => setOpen(false)}>
      <UiV2MenuItem tone="destructive" onClick={() => { closeForAction(); onDelete(); }}>Delete</UiV2MenuItem>
    </UiV2ResponsiveMenu> : null}
  </span>;
}
