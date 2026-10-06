"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { UiV2Button, UiV2Chip, UiV2Icon } from "@/components/ui-v2";
import {
  SKILL_LIBRARY_PATH,
  type SkillSaveCard,
  type SkillSaveCardDiff,
  type SkillSaveCardFile,
  type SkillSaveUndoState
} from "@/lib/contracts/skillSaves";
import { readSavedSkillFile, readSkillSaveUndoState, undoSkillSave } from "./skillSaveApi";

const CHANGE_LABELS = { added: "Added", changed: "Changed", removed: "Removed", unchanged: "Unchanged" } as const;
const CHANGE_TONES = { added: "ok", changed: "warn", removed: "danger", unchanged: "neutral" } as const;

function outcomeLine(card: SkillSaveCard): string {
  return card.outcome === "created" ? `Created v${card.toRevision}` : `v${card.fromRevision} → v${card.toRevision}`;
}

function undoMessage(state: SkillSaveUndoState): string | null {
  switch (state.state) {
    case "undone": return state.outcome === "archived"
      ? "Undone: the Skill is archived. You can restore it from the library."
      : `Undone: the previous content is current again${state.revision ? ` as v${state.revision}` : ""}.`;
    case "conflict": return "Undo is not available: the Skill changed after this save, and that change is kept.";
    case "unavailable": return "Undo is not available: this Skill or save no longer exists.";
    default: return null;
  }
}

function DiffV2({ diff }: Readonly<{ diff: SkillSaveCardDiff }>) {
  return (
    <pre className="v2-skill-save-diff" aria-label={`Changes in ${diff.path}`}>
      {diff.lines.map((line, index) => (
        <span key={index} data-kind={line.kind}>
          {line.kind === "gap" ? "⋯" : `${line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "} ${line.text}`}
          {"\n"}
        </span>
      ))}
      {diff.truncated ? <span data-kind="gap">{"⋯ more changes in the saved file\n"}</span> : null}
    </pre>
  );
}

type FileView = Readonly<{ state: "loading" } | { state: "error" } | { state: "ready"; content: string }>;

function FileRowV2({ card, diff, file }: Readonly<{ card: SkillSaveCard; diff?: SkillSaveCardDiff; file: SkillSaveCardFile }>) {
  const [view, setView] = useState<FileView | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function toggle() {
    if (view?.state === "ready" || view?.state === "error") { setView(null); return; }
    if (view?.state === "loading") return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setView({ state: "loading" });
    try {
      const content = await readSavedSkillFile(card.skillId, card.revisionId, file.path, current.signal);
      if (!current.signal.aborted) setView({ state: "ready", content });
    } catch {
      if (!current.signal.aborted) setView({ state: "error" });
    }
  }

  return (
    <li data-change={file.change}>
      <span className="v2-skill-save-file-head">
        <UiV2Chip tone={CHANGE_TONES[file.change]}>{CHANGE_LABELS[file.change]}</UiV2Chip>
        <code title={file.path}>{file.path}</code>
        {file.executable && file.change !== "removed" ? <UiV2Chip>{file.executableChanged ? "Now runs" : "Runs"}</UiV2Chip> : null}
        {!file.executable && file.executableChanged ? <UiV2Chip>No longer runs</UiV2Chip> : null}
        {file.change === "removed" ? null : (
          <button type="button" className="v2-skill-save-file-view v2-focusable" aria-expanded={view?.state === "ready"}
            aria-label={`${view?.state === "ready" ? "Hide" : "View"} saved ${file.path}`} onClick={() => void toggle()}>
            {view?.state === "ready" ? "Hide file" : view?.state === "loading" ? "Opening…" : "View file"}
          </button>
        )}
      </span>
      {diff ? (
        <details className="v2-skill-save-changes">
          <summary>Show changes</summary>
          <DiffV2 diff={diff} />
        </details>
      ) : null}
      {view?.state === "ready" ? <pre className="v2-skill-save-file" aria-label={`Saved ${file.path}`}>{view.content}</pre> : null}
      {view?.state === "error" ? <p className="v2-skill-save-error" role="alert">The saved file could not be opened. Try again.</p> : null}
    </li>
  );
}

function SkillSaveCardV2({ card, live }: Readonly<{ card: SkillSaveCard; live: boolean }>) {
  const headingId = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [undo, setUndo] = useState<SkillSaveUndoState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A settled answer asks the server whether Undo is still possible; a
  // failed read keeps the button, whose own request then decides.
  useEffect(() => {
    if (live) return;
    const controller = new AbortController();
    readSkillSaveUndoState(card.skillId, card.saveId, controller.signal)
      .then((state) => { if (!controller.signal.aborted) setUndo(state); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [card.saveId, card.skillId, live]);

  async function runUndo() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setUndo(await undoSkillSave(card.skillId, card.saveId));
      queueMicrotask(() => statusRef.current?.focus());
    } catch {
      setError("Undo failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const changed = card.files.filter((file) => file.change !== "unchanged");
  const unchanged = card.files.length - changed.length;
  const diffs = new Map(card.diffs.map((diff) => [diff.path, diff]));
  const message = undo ? undoMessage(undo) : null;
  const canUndo = !undo || undo.state === "available";
  return (
    <li className="v2-skill-save-card" data-outcome={card.outcome} data-undo={undo?.state ?? "unknown"} data-testid="skill-save-card"
      aria-labelledby={headingId}>
      <div className="v2-skill-save-card-top">
        <span className="v2-skill-save-card-tile" aria-hidden="true"><UiV2Icon name="wand" /></span>
        <div className="v2-skill-save-card-copy">
          <p className="v2-skill-save-card-heading" id={headingId}>
            {card.outcome === "created" ? "Skill saved" : "Skill updated"} · {outcomeLine(card)}
          </p>
          <strong title={card.name}>{card.name}</strong>
          {card.changeNote ? <small>{card.changeNote}</small> : null}
          {card.copiedFrom ? <small>Your own copy of “{card.copiedFrom}”; the original is unchanged.</small> : null}
          {card.published ? <small>Colleagues keep the published version until you share this Skill again.</small> : null}
        </div>
      </div>
      {card.scheduledTasks.length ? (
        <p className="v2-skill-save-card-warning" role="note">
          <UiV2Icon name="clock" />
          <span>
            Used by scheduled tasks: {card.scheduledTasks.map((task) => `“${task.title}”`).join(", ")}
            {card.scheduledTasksTruncated ? " and more" : ""}. Their next run uses this version.
          </span>
        </p>
      ) : null}
      <ul className="v2-skill-save-files" aria-label={`Files of ${card.name}`}>
        {changed.map((file) => <FileRowV2 key={file.path} card={card} file={file} diff={diffs.get(file.path)} />)}
      </ul>
      {unchanged > 0 ? <small className="v2-skill-save-unchanged">{unchanged} unchanged {unchanged === 1 ? "file" : "files"}</small> : null}
      <div className="v2-skill-save-card-actions">
        {canUndo ? (
          <UiV2Button busy={busy} icon="history" type="button" aria-label={`Undo saving ${card.name}`} onClick={() => void runUndo()}>
            Undo
          </UiV2Button>
        ) : null}
        <Link className="v2-skill-save-library v2-focusable" href={SKILL_LIBRARY_PATH}>
          <UiV2Icon name="library" />
          <span>Open library</span>
        </Link>
      </div>
      {message ? <p className="v2-skill-save-status" ref={statusRef} tabIndex={-1} role="status">{message}</p> : null}
      {error ? <p className="v2-skill-save-error" role="alert">{error}</p> : null}
    </li>
  );
}

/**
 * Skills the answer saved through `save_skill`, after the fact: outcome,
 * changed files with executable markers, bounded diffs, the immutable saved
 * files, the change note, scheduled tasks that use the Skill, Undo and the
 * library. `live`: the answer is still running; the save already happened.
 */
export function SkillSaveCardsV2({ cards, live = false }: Readonly<{ cards: readonly SkillSaveCard[]; live?: boolean }>) {
  if (cards.length === 0) return null;
  return (
    <section className="v2-skill-save-cards" aria-label="Saved Skills">
      <ul>{cards.map((card) => <SkillSaveCardV2 key={card.saveId} card={card} live={live} />)}</ul>
    </section>
  );
}
