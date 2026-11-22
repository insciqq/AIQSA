"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { MEMORY_NOTE_COPY as copy, memoryNoteDate } from "@/components/app-shell/memoryNoteUiCopy";
import { UiV2Button } from "@/components/ui-v2";
import { SectionHeading } from "@/features/library-v2/LibraryV2";
import {
  MEMORY_NOTE_MAX_CHARACTERS,
  memoryNoteCharacterCount,
  type MemoryLegacySuggestion,
  type MemoryNote,
  type MemorySwitches,
  type MemorySwitchesUpdate
} from "@/lib/contracts/memoryNote";
import {
  actOnMemoryLegacySuggestion,
  MemoryNoteApiError,
  readMemoryLegacySuggestions,
  readMemoryNote,
  readMemorySwitches,
  removeAllMemoryLegacySuggestions,
  saveMemoryNote,
  updateMemorySwitches
} from "./memoryNoteApi";
import { SettingsGroupLabelV2, SettingsRowV2, SettingsSwitchV2 } from "./SettingsV2";

const FIELD = "w-full min-w-0 rounded-lg border border-trace-strong bg-answer-paper px-3 py-2 text-sm leading-6 text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60";

type LoadState = "loading" | "error" | "ready";
type SwitchKey = keyof MemorySwitches;
type Legacy = Readonly<{ items: readonly MemoryLegacySuggestion[]; nextCursor: string | null; state: LoadState }>;
type Conflict = Readonly<{ latest: MemoryNote | null }>;

const SWITCHES: readonly Readonly<{ key: SwitchKey; label: string; description: string }>[] = [
  { key: "memoryEnabled", label: copy.switchMemoryLabel, description: copy.switchMemoryDescription },
  { key: "pastChatSearchEnabled", label: copy.switchSearchLabel, description: copy.switchSearchDescription },
  { key: "memorySuggestionsEnabled", label: copy.switchOffersLabel, description: copy.switchOffersDescription }
];

/** What a refused save says; null: show the conflict state instead. */
function saveErrorCopy(failure: unknown): string | null {
  const code = failure instanceof MemoryNoteApiError ? failure.code : null;
  if (code === "memory_note_conflict") return null;
  if (code === "memory_note_too_long") return copy.tooLong;
  if (code === "memory_note_invalid") return copy.invalid;
  if (code === "memory_disabled") return copy.changeMemoryOff;
  return copy.saveFailed;
}

/**
 * Settings › Memory: the user's one note as plain text with its limit, the three Memory switches, the earlier automatic
 * memories waiting to be kept or removed, and clearing the note. The note is saved whole, guarded by the revision the
 * editor read; when it changed elsewhere (a chat's change, another tab) the save is refused and the editor keeps the
 * user's text beside the saved note.
 */
export function MemoryNoteSettingsV2({ onBusyChange, onDirtyChange }: Readonly<{
  onBusyChange?(busy: boolean): void;
  onDirtyChange?(dirty: boolean): void;
}> = {}) {
  const [note, setNote] = useState<MemoryNote | null>(null);
  const [noteState, setNoteState] = useState<LoadState>("loading");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [switches, setSwitches] = useState<MemorySwitches | null>(null);
  const [switchState, setSwitchState] = useState<LoadState>("loading");
  const [switchBusy, setSwitchBusy] = useState<SwitchKey | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<Legacy>({ items: [], nextCursor: null, state: "loading" });
  const [legacyBusy, setLegacyBusy] = useState<string | null>(null);
  const [legacyError, setLegacyError] = useState<Readonly<{ id: string | null; message: string }> | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [removeAllOpen, setRemoveAllOpen] = useState(false);
  const alive = useRef(true);
  const pending = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const clearTriggerRef = useRef<HTMLButtonElement>(null);
  const removeAllTriggerRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const counterId = `${ids}-counter`;
  const hintId = `${ids}-hint`;

  const dirty = note !== null && draft !== note.text;
  const busy = saving || switchBusy !== null || legacyBusy !== null;
  const count = memoryNoteCharacterCount(draft);
  const over = count > MEMORY_NOTE_MAX_CHARACTERS;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  // The loaders set state only when their read settles; a retry marks itself loading first.
  function loadNote(signal?: AbortSignal) {
    readMemoryNote(signal).then((next) => {
      if (signal?.aborted || !alive.current) return;
      setNote(next);
      setDraft(next.text);
      setNoteState("ready");
    }, () => { if (!signal?.aborted && alive.current) setNoteState("error"); });
  }
  function loadSwitches(signal?: AbortSignal) {
    readMemorySwitches(signal).then((next) => {
      if (signal?.aborted || !alive.current) return;
      setSwitches(next);
      setSwitchState("ready");
    }, () => { if (!signal?.aborted && alive.current) setSwitchState("error"); });
  }
  function loadLegacy(cursor: string | null, signal?: AbortSignal) {
    readMemoryLegacySuggestions(cursor, signal).then((page) => {
      if (signal?.aborted || !alive.current) return;
      setLegacy((current) => {
        const known = new Set(current.items.map((item) => item.id));
        const items = cursor ? [...current.items, ...page.suggestions.filter((item) => !known.has(item.id))] : page.suggestions;
        return { items, nextCursor: page.nextCursor, state: "ready" };
      });
    }, () => { if (!signal?.aborted && alive.current) setLegacy((current) => ({ ...current, state: "error" })); });
  }

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    loadNote(controller.signal);
    loadSwitches(controller.signal);
    loadLegacy(null, controller.signal);
    return () => { alive.current = false; controller.abort(); };
  }, []);

  function loadMoreLegacy(cursor: string) {
    setLegacy((current) => ({ ...current, state: "loading" }));
    loadLegacy(cursor);
  }

  /** One note request at a time; its failure decides between an error and the conflict state. */
  async function writeNote(text: string, revision: number, done: string) {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await saveMemoryNote({ text, revision });
      if (!alive.current) return;
      setNote(next);
      setDraft(next.text);
      setConflict(null);
      setNotice(done);
    } catch (failure) {
      if (!alive.current) return;
      const message = saveErrorCopy(failure);
      if (message) {
        setError(message);
        return;
      }
      // The note moved on: show the saved one beside the user's text, which stays in the editor.
      setConflict({ latest: null });
      const latest = await readMemoryNote().catch(() => null);
      if (alive.current) setConflict({ latest });
    } finally {
      pending.current = false;
      if (alive.current) setSaving(false);
    }
  }

  function save(event?: FormEvent) {
    event?.preventDefault();
    if (!note || saving || over || (!dirty && !conflict)) return;
    void writeNote(draft, note.revision, copy.saved);
  }
  function keepMine() {
    const latest = conflict?.latest;
    if (!latest) return;
    void writeNote(draft, latest.revision, copy.saved);
  }
  function takeLatest() {
    const latest = conflict?.latest;
    if (!latest) return;
    setNote(latest);
    setDraft(latest.text);
    setConflict(null);
    setError(null);
    queueMicrotask(() => editorRef.current?.focus());
  }
  function editorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      save();
    }
  }

  function toggle(key: SwitchKey, value: boolean) {
    if (switchBusy) return;
    setSwitchBusy(key);
    setSwitchError(null);
    const update: MemorySwitchesUpdate = {};
    update[key] = value;
    updateMemorySwitches(update).then((next) => { if (alive.current) setSwitches(next); },
      () => { if (alive.current) setSwitchError(copy.switchFailed); })
      .finally(() => { if (alive.current) setSwitchBusy(null); });
  }

  function legacyAction(item: MemoryLegacySuggestion, action: "keep" | "remove") {
    if (legacyBusy) return;
    setLegacyBusy(item.id);
    setLegacyError(null);
    setNotice(null);
    actOnMemoryLegacySuggestion(item.id, action).then((kept) => {
      if (!alive.current) return;
      // Keep is offered only while the editor holds the saved note, so the note it returns replaces nothing typed.
      if (kept) {
        setNote(kept);
        setDraft(kept.text);
      }
      dropLegacy(item.id);
    }, (failure: unknown) => {
      if (!alive.current) return;
      const code = failure instanceof MemoryNoteApiError ? failure.code : null;
      if (code === "memory_legacy_suggestion_not_found") dropLegacy(item.id);
      else setLegacyError({ id: item.id, message: code === "memory_note_too_long" ? copy.legacyTooLong
        : code === "memory_disabled" ? copy.changeMemoryOff : copy.legacyFailed });
    }).finally(() => { if (alive.current) setLegacyBusy(null); });
  }
  function dropLegacy(id: string) {
    const items = legacy.items.filter((item) => item.id !== id);
    setLegacy({ ...legacy, items });
    // The list emptied while more wait: read them, so the section does not vanish with suggestions left.
    if (items.length === 0 && legacy.nextCursor) loadMoreLegacy(legacy.nextCursor);
  }
  function removeAll() {
    if (legacyBusy) return;
    setLegacyBusy("all");
    setLegacyError(null);
    removeAllMemoryLegacySuggestions().then(() => {
      if (!alive.current) return;
      setLegacy({ items: [], nextCursor: null, state: "ready" });
      setRemoveAllOpen(false);
    }, () => {
      if (!alive.current) return;
      setRemoveAllOpen(false);
      setLegacyError({ id: null, message: copy.legacyFailed });
    }).finally(() => { if (alive.current) setLegacyBusy(null); });
  }

  function clearNote() {
    if (!note) return;
    void writeNote("", note.revision, copy.cleared).then(() => { if (alive.current) setClearOpen(false); });
  }

  const memoryOn = switches?.memoryEnabled ?? true;
  const legacyShown = legacy.items.length > 0;
  const changedLine = note && note.revision > 0 && note.updatedAt
    ? `${note.lastChangedBy === "agent" ? copy.lastChangedByAgent : copy.lastChangedByUser} · ${memoryNoteDate(note.updatedAt)}` : null;

  return (
    <section className="v2-studio-settings-page v2-memory-note-page" data-testid="settings-memory">
      <SectionHeading description={copy.description}>{copy.heading}</SectionHeading>

      {noteState === "error" && !note ? (
        <div className="v2-settings-note" data-testid="memory-note-reload">
          <span>{copy.loadFailed}</span>
          <UiV2Button type="button" onClick={() => { setNoteState("loading"); loadNote(); }}>{copy.reload}</UiV2Button>
        </div>
      ) : !note ? (
        <p className="v2-settings-note" role="status">{copy.loading}</p>
      ) : (
        <form className="v2-memory-note" aria-label={copy.editorLabel} onSubmit={save}>
          {!memoryOn ? <p className="v2-memory-note-off" role="status">{copy.memoryOff}</p> : null}
          <label className="v2-memory-note-label" htmlFor={`${ids}-editor`}>{copy.editorLabel}</label>
          {draft.length === 0 ? <p className="v2-memory-note-hint" id={hintId}>{copy.emptyHint}</p> : null}
          <textarea
            ref={editorRef}
            id={`${ids}-editor`}
            className={`${FIELD} v2-memory-note-editor`}
            data-testid="memory-note-editor"
            aria-describedby={[draft.length === 0 ? hintId : null, counterId].filter(Boolean).join(" ")}
            aria-invalid={over || undefined}
            readOnly={saving}
            rows={12}
            spellCheck
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setNotice(null); }}
            onKeyDown={editorKeyDown}
          />
          <div className="v2-memory-note-footer">
            <span className="v2-memory-note-meta">
              <span id={counterId} className="v2-memory-note-counter" data-over={over || undefined} data-testid="memory-note-counter">
                {`${count.toLocaleString("en-US")} / ${MEMORY_NOTE_MAX_CHARACTERS.toLocaleString("en-US")} characters`}
              </span>
              {changedLine ? <span>{changedLine}</span> : null}
            </span>
            <UiV2Button busy={saving} disabled={over || (!dirty && !conflict)} tone="primary" type="submit">{copy.save}</UiV2Button>
          </div>
          {over ? <p className="v2-memory-note-error" role="alert">{copy.tooLong}</p> : null}
          {error ? <p className="v2-memory-note-error" role="alert">{error}</p> : null}
          {notice ? <p className="v2-memory-note-notice" role="status">{notice}</p> : null}
          {conflict ? (
            <div className="v2-memory-note-conflict" data-testid="memory-note-conflict" role="alert">
              <p>{copy.conflict}</p>
              {conflict.latest ? (
                <>
                  <details>
                    <summary className="v2-focusable">{copy.conflictLatest}</summary>
                    <pre aria-label={copy.conflictLatest}>{conflict.latest.text || "—"}</pre>
                  </details>
                  <span className="v2-memory-note-conflict-actions">
                    <UiV2Button disabled={saving} type="button" onClick={takeLatest}>{copy.conflictReplace}</UiV2Button>
                    <UiV2Button busy={saving} disabled={over} type="button" onClick={keepMine}>{copy.conflictKeep}</UiV2Button>
                  </span>
                </>
              ) : (
                <UiV2Button disabled={saving} type="button" onClick={() => {
                  void readMemoryNote().then((latest) => { if (alive.current) setConflict({ latest }); }, () => undefined);
                }}>{copy.conflictReload}</UiV2Button>
              )}
            </div>
          ) : null}
        </form>
      )}

      <SettingsGroupLabelV2>{copy.switchesHeading}</SettingsGroupLabelV2>
      {switchState === "error" && !switches ? (
        <div className="v2-settings-note">
          <span>{copy.loadFailed}</span>
          <UiV2Button type="button" onClick={() => { setSwitchState("loading"); loadSwitches(); }}>{copy.reload}</UiV2Button>
        </div>
      ) : SWITCHES.map((row) => {
        const value = switches?.[row.key] ?? false;
        const dependent = row.key !== "memoryEnabled";
        return (
          <SettingsRowV2 description={row.description} key={row.key} testId={`memory-switch-${row.key}`} title={row.label}>
            <SettingsSwitchV2 checked={value} disabled={!switches || switchBusy !== null || (dependent && !memoryOn)}
              label={row.label} onChange={(next) => toggle(row.key, next)} />
          </SettingsRowV2>
        );
      })}
      {switchError ? <p className="v2-memory-note-error" role="alert">{switchError}</p> : null}
      <p className="v2-memory-note-temporary">{copy.temporary}</p>

      {!legacyShown && legacy.state === "error" ? (
        <div className="v2-settings-note" data-testid="memory-legacy-reload">
          <span>{copy.legacyLoadFailed}</span>
          <UiV2Button type="button" onClick={() => { setLegacy({ items: [], nextCursor: null, state: "loading" }); loadLegacy(null); }}>
            {copy.reload}
          </UiV2Button>
        </div>
      ) : null}
      {legacyShown ? (
        <section className="v2-memory-legacy" aria-labelledby={`${ids}-legacy`} data-testid="memory-legacy-suggestions">
          <header className="v2-memory-legacy-heading">
            <div>
              <h3 id={`${ids}-legacy`}>{copy.legacyHeading(legacy.items.length, legacy.nextCursor !== null)}</h3>
              <p>{copy.legacyDescription}</p>
            </div>
            <UiV2Button ref={removeAllTriggerRef} disabled={legacyBusy !== null} tone="destructive" type="button"
              onClick={() => setRemoveAllOpen(true)}>{copy.legacyRemoveAll}</UiV2Button>
          </header>
          {legacyError && legacyError.id === null ? <p className="v2-memory-note-error" role="alert">{legacyError.message}</p> : null}
          <ul>
            {legacy.items.map((item) => (
              <li className="v2-memory-legacy-row" data-testid="memory-legacy-row" key={item.id}>
                <p>{item.text}</p>
                <span className="v2-memory-legacy-actions">
                  <UiV2Button aria-label={copy.legacyKeepLabel(item.text)} busy={legacyBusy === item.id}
                    disabled={legacyBusy !== null || dirty || saving || !note} type="button"
                    onClick={() => legacyAction(item, "keep")}>{copy.legacyKeep}</UiV2Button>
                  <UiV2Button aria-label={copy.legacyRemoveLabel(item.text)} disabled={legacyBusy !== null} type="button"
                    onClick={() => legacyAction(item, "remove")}>{copy.legacyRemove}</UiV2Button>
                </span>
                {legacyError?.id === item.id ? <p className="v2-memory-note-error" role="alert">{legacyError.message}</p> : null}
              </li>
            ))}
          </ul>
          {legacy.nextCursor ? (
            <UiV2Button busy={legacy.state === "loading"} disabled={legacyBusy !== null} type="button"
              onClick={() => { if (legacy.nextCursor) loadMoreLegacy(legacy.nextCursor); }}>{copy.legacyLoadMore}</UiV2Button>
          ) : null}
        </section>
      ) : null}

      <SettingsGroupLabelV2 tone="danger">{copy.dangerZone}</SettingsGroupLabelV2>
      <SettingsRowV2 description={copy.clearDescription} testId="settings-memory-clear" title={copy.clearTitle} tone="danger">
        <UiV2Button ref={clearTriggerRef} disabled={!note || note.text === "" || saving} tone="destructive" type="button"
          onClick={() => setClearOpen(true)}>{copy.clearAction}</UiV2Button>
      </SettingsRowV2>

      {clearOpen ? (
        <ConfirmationDialog busy={saving} portal confirmLabel={copy.clearConfirm} dialogLabel={copy.clearConfirmTitle}
          restoreFocus={() => clearTriggerRef.current} testId="memory-note-clear-confirmation" title={copy.clearConfirmTitle}
          onCancel={() => setClearOpen(false)} onConfirm={clearNote}>{copy.clearConfirmBody}</ConfirmationDialog>
      ) : null}
      {removeAllOpen ? (
        <ConfirmationDialog busy={legacyBusy === "all"} portal confirmLabel={copy.legacyRemoveAllConfirm} dialogLabel={copy.legacyRemoveAllTitle}
          restoreFocus={() => removeAllTriggerRef.current} testId="memory-legacy-remove-all-confirmation" title={copy.legacyRemoveAllTitle}
          onCancel={() => setRemoveAllOpen(false)} onConfirm={removeAll}>{copy.legacyRemoveAllBody}</ConfirmationDialog>
      ) : null}
    </section>
  );
}
