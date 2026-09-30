"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { isImeCompositionEvent } from "@/components/keyboard";
import type { PendingComposerComment } from "@/components/app-shell/composerComments";

type ComposerCommentsProps = Readonly<{
  comments: readonly PendingComposerComment[];
  /** Returns the refusal message, or null when the comment was changed. */
  onUpdate?(id: string, text: string): string | null;
  onRemove?(id: string): void;
}>;

export function ComposerCommentsV2(props: ComposerCommentsProps) {
  return props.comments.length ? <ComposerCommentsListV2 {...props} /> : null;
}

function ComposerCommentsListV2({ comments, onUpdate, onRemove }: ComposerCommentsProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 8, bottom: 8, maxHeight: 512 });
  const trigger = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  const close = useCallback(() => { setOpen(false); setEditing(null); setError(null); }, []);
  const { dialogRef, initialFocusRef, onDialogKeyDown } = useModalLayerV2({ enabled: open && comments.length > 0,
    onClose: close, restoreFocus: () => trigger.current ?? document.querySelector<HTMLTextAreaElement>(".v2-composer-input") });
  /** Like the comment form: leaving the list keeps typed text. An empty or
   * unchanged edit leaves the comment as it was; a refused one stays open. */
  const saveAndClose = () => {
    const original = editing && comments.find(comment => comment.id === editing.id);
    if (editing && original && editing.text.trim() && editing.text !== original.text) {
      const refusal = onUpdate ? onUpdate(editing.id, editing.text) : "Comments cannot be changed here.";
      if (refusal) { setError(refusal); editor.current?.focus({ preventScroll: true }); return; }
    }
    close();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(box?.left ?? 8, window.innerWidth - 392)),
        bottom: Math.max(8, window.innerHeight - (box?.top ?? window.innerHeight - 16) + 8),
        maxHeight: Math.max(96, Math.min(512, (box?.top ?? window.innerHeight) - 16)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  const editingId = editing?.id;
  useLayoutEffect(() => { if (editingId) editor.current?.focus({ preventScroll: true }); }, [editingId]);
  const finishEditing = () => {
    setEditing(null); setError(null);
    queueMicrotask(() => initialFocusRef.current?.focus({ preventScroll: true }));
  };
  const save = () => {
    if (!editing?.text.trim()) return;
    const refusal = onUpdate ? onUpdate(editing.id, editing.text) : "Comments cannot be changed here.";
    if (refusal) { setError(refusal); return; }
    finishEditing();
  };
  const count = comments.length;
  const label = `${count} ${count === 1 ? "comment" : "comments"}`;
  return <>
    <button ref={trigger} className="v2-composer-indicator v2-focusable" type="button" data-glyph="chat" data-comment-count={count}
      aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="v2-composer-indicator-face" aria-hidden="true"><span className="v2-composer-indicator-icon">
        <UiV2Icon className="v2-composer-indicator-glyph" name="chat" />
      </span><span className="v2-composer-indicator-label">{label}</span><span className="v2-composer-indicator-count">{count}</span></span>
    </button>
    {open ? createPortal(<div className="v2-composer-comments-overlay">
      <button aria-label="Close comments" className="v2-composer-comments-scrim" tabIndex={-1} onClick={saveAndClose} />
      <section className="v2-composer-comments-panel" role="dialog" aria-modal="true" aria-label="Comments"
        ref={dialogRef} tabIndex={-1} onKeyDown={event => {
          if (isImeCompositionEvent(event)) { event.stopPropagation(); return; }
          if (editing && event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); finishEditing(); return;
          }
          onDialogKeyDown(event);
        }} style={position}>
        <header><strong>{label}</strong><UiV2IconButton ref={initialFocusRef} icon="close" label="Close comments" onClick={saveAndClose} /></header>
        <ol className="v2-composer-comments-list">
          {comments.map((comment, index) => <li key={comment.id}>
            <p className="v2-composer-comment-quote">{comment.quote}</p>
            {editing?.id === comment.id ? <>
              <textarea ref={editor} aria-label="Comment" rows={3} value={editing.text}
                aria-describedby={error ? errorId : undefined} aria-invalid={error ? true : undefined}
                onChange={event => { setEditing({ id: comment.id, text: event.target.value }); setError(null); }}
                onKeyDown={event => { if (!isImeCompositionEvent(event) && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); save(); } }} />
              <div className="v2-composer-comment-actions">
                <UiV2Button onClick={finishEditing}>Cancel</UiV2Button>
                <UiV2Button tone="primary" disabled={!editing.text.trim()} onClick={save}>Save</UiV2Button>
              </div>
            </> : <>
              <p className="v2-composer-comment-text">{comment.text}</p>
              <div className="v2-composer-comment-actions">
                <UiV2Button aria-label={`Edit comment ${index + 1}`} onClick={() => setEditing({ id: comment.id, text: comment.text })}>Edit</UiV2Button>
                <UiV2Button aria-label={`Delete comment ${index + 1}`} onClick={() => {
                  if (comments.length === 1) close();
                  onRemove?.(comment.id);
                  if (comments.length > 1) queueMicrotask(() => initialFocusRef.current?.focus({ preventScroll: true }));
                }}>Delete</UiV2Button>
              </div>
            </>}
          </li>)}
        </ol>
        {error ? <p id={errorId} role="alert">{error}</p> : null}
      </section>
    </div>, document.body) : null}
  </>;
}
