"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { UiV2Button } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { isImeCompositionEvent } from "@/components/keyboard";
import { serializeRenderedMarkdownSelection } from "@/components/chat/renderedMarkdown";
import type { PendingCommentAnchor, PendingComposerComment } from "@/components/app-shell/composerComments";
import { captureCommentAnchor } from "./commentAnchors";
import { useCommentMarks, type CommentMark } from "./useCommentMarks";

export type ConversationQuoteV2 = Readonly<{
  /** Pending comments of this conversation; anchored ones are marked in the transcript. */
  comments?: readonly PendingComposerComment[];
  disabled?: boolean;
  dockRef?: RefObject<HTMLElement | null>;
  /** Saves a comment; returns the refusal message, or null when saved. */
  onComment?(markdown: string, text: string, touch: boolean, anchor?: PendingCommentAnchor): string | null;
  /** Returns why no comment on this fragment could be saved now; no form opens then. */
  onCommentStart?(markdown: string, anchor?: PendingCommentAnchor): string | null;
  /** Changes a pending comment opened from its mark; returns the refusal message, or null when changed. */
  onCommentUpdate?(id: string, text: string): string | null;
  onCommentRemove?(id: string): void;
  onQuote(markdown: string, touch: boolean): string | null;
  scopeKey: string;
}>;

type CapturedSelection = Readonly<{ markdown: string; range: Range; root: HTMLElement; scopeKey: string }>;
/** The fragment the comment form is open for: a new selection, or the mark of the pending comment `editId`. */
type CommentTarget = CapturedSelection & Readonly<{ anchor?: PendingCommentAnchor; editId?: string }>;

/** A click on these keeps its own action even inside a mark. */
const INTERACTIVE = "a, button, input, textarea, select, summary, label, [role='button'], [contenteditable='true']";

function elementAt(node: Node) {
  return node instanceof Element ? node : node.parentElement;
}

export function captureConversationSelection(container: HTMLElement, selection: Selection | null, scopeKey: string): CapturedSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || container.querySelector("[data-editing='true']")) return null;
  const range = selection.getRangeAt(0);
  const start = elementAt(range.startContainer)?.closest<HTMLElement>(".v2-conversation-markdown[data-quote-eligible='true']");
  const end = elementAt(range.endContainer)?.closest(".v2-conversation-markdown[data-quote-eligible='true']");
  if (!start || start !== end || !container.contains(start)) return null;
  const markdown = serializeRenderedMarkdownSelection(range, start);
  return markdown.trim() ? { markdown, range: range.cloneRange(), root: start, scopeKey } : null;
}

/** Selection is transient reading state; only the captured Markdown crosses into a draft. */
export function ConversationSelectionV2({ quote, scrollRef }: Readonly<{
  quote: ConversationQuoteV2;
  scrollRef: RefObject<HTMLDivElement | null>;
}>) {
  return <ConversationSelectionScopeV2 key={`${quote.scopeKey}:${Boolean(quote.disabled)}`} quote={quote} scrollRef={scrollRef} />;
}

function ConversationSelectionScopeV2({ quote, scrollRef }: Readonly<{
  quote: ConversationQuoteV2;
  scrollRef: RefObject<HTMLDivElement | null>;
}>) {
  const [captured, setCaptured] = useState<CapturedSelection | null>(null);
  const [commenting, setCommenting] = useState<CommentTarget | null>(null);
  const [commentText, setCommentText] = useState("");
  const [touch, setTouch] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string; scopeKey: string } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const commentSourceRef = useRef<HTMLElement | null>(null);
  const feedbackId = useId();
  const current = captured?.scopeKey === quote.scopeKey && captured.root.isConnected && !quote.disabled ? captured : null;
  const editedComment = commenting?.editId ? quote.comments?.find(comment => comment.id === commenting.editId) ?? null : null;
  // An edited comment that was sent or deleted elsewhere closes its form.
  const activeComment = commenting?.scopeKey === quote.scopeKey && commenting.root.isConnected && !quote.disabled &&
    (!commenting.editId || editedComment) ? commenting : null;
  const markAt = useCommentMarks(scrollRef, quote.comments, activeComment?.editId ?? null);
  const feedback = notice?.scopeKey === quote.scopeKey ? notice : null;
  const closeComment = useCallback(() => {
    setCommenting(null);
    setCommentText("");
    setCaptured(null);
    setNotice(null);
  }, []);
  const saveComment = useCallback(() => {
    if (!activeComment) return;
    if (!commentText.trim()) { closeComment(); return; }
    if (activeComment.editId) {
      // Like the composer list: an unchanged edit leaves the comment as it was.
      if (commentText === editedComment?.text) { closeComment(); return; }
      const refusal = quote.onCommentUpdate ? quote.onCommentUpdate(activeComment.editId, commentText) : "Comments cannot be changed here.";
      if (refusal) { setNotice({ error: true, text: refusal, scopeKey: quote.scopeKey }); return; }
      closeComment();
      return;
    }
    const error = quote.onComment
      ? quote.onComment(activeComment.markdown, commentText, touch, activeComment.anchor)
      : "Comments are unavailable right now.";
    if (error) {
      setNotice({ error: true, text: error, scopeKey: quote.scopeKey });
      return;
    }
    closeComment();
    window.getSelection()?.removeAllRanges();
  }, [activeComment, closeComment, commentText, editedComment, quote, touch]);
  const removeComment = useCallback(() => {
    if (!activeComment?.editId) return;
    quote.onCommentRemove?.(activeComment.editId);
    closeComment();
  }, [activeComment, closeComment, quote]);
  const openMark = useCallback((mark: CommentMark) => {
    mark.root.setAttribute("tabindex", "-1");
    commentSourceRef.current = mark.root;
    setCommenting({ markdown: mark.comment.quote, range: mark.range.cloneRange(), root: mark.root,
      scopeKey: quote.scopeKey, editId: mark.comment.id });
    setCommentText(mark.comment.text);
    setCaptured(null);
    setNotice(null);
  }, [quote.scopeKey]);

  const { dialogRef, onDialogKeyDown } = useModalLayerV2({
    enabled: Boolean(activeComment), onClose: closeComment,
    restoreFocus: () => commentSourceRef.current?.isConnected ? commentSourceRef.current : scrollRef.current
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(hover: none), (pointer: coarse)");
    const narrow = window.matchMedia("(max-width: 840px), (max-height: 32rem)");
    const update = () => { setTouch(media.matches); setSheet(narrow.matches); };
    update();
    media.addEventListener("change", update);
    narrow.addEventListener("change", update);
    return () => { media.removeEventListener("change", update); narrow.removeEventListener("change", update); };
  }, []);

  useEffect(() => {
    const changed = () => {
      const container = scrollRef.current;
      const next = !quote.disabled && container ? captureConversationSelection(container, window.getSelection(), quote.scopeKey) : null;
      setCaptured(next);
      if (next) setNotice(null);
    };
    const dismiss = () => setCaptured(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { dismiss(); setNotice(null); }
    };
    document.addEventListener("selectionchange", changed);
    document.addEventListener("keydown", escape);
    // Scrolling includes the transcript, a table, code, or a surrounding panel.
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [quote.disabled, quote.scopeKey, scrollRef]);

  useEffect(() => {
    if (!activeComment) return;
    const onOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || surfaceRef.current?.contains(target)) return;
      saveComment();
    };
    document.addEventListener("pointerdown", onOutside);
    return () => document.removeEventListener("pointerdown", onOutside);
  }, [activeComment, saveComment]);

  useLayoutEffect(() => {
    if (!activeComment) return;
    const field = surfaceRef.current?.querySelector<HTMLTextAreaElement>("textarea");
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [activeComment]);

  // A mark opens its comment. Clicks that finish a text selection or hit a
  // link or button inside the mark keep their ordinary behavior.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || quote.disabled || !quote.onCommentUpdate || !quote.comments?.some(comment => comment.anchor)) return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
      const mark = markAt(event.clientX, event.clientY);
      if (!mark) return;
      event.preventDefault();
      event.stopPropagation();
      openMark(mark);
    };
    let frame: number | null = null;
    const onPointerMove = (event: PointerEvent) => {
      if (frame !== null) return;
      const { clientX, clientY } = event;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        container.toggleAttribute("data-comment-hover", markAt(clientX, clientY) !== null);
      });
    };
    const onPointerLeave = () => container.removeAttribute("data-comment-hover");
    container.addEventListener("click", onClick, true);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", onPointerLeave);
    return () => {
      container.removeEventListener("click", onClick, true);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
      if (frame !== null) window.cancelAnimationFrame(frame);
      container.removeAttribute("data-comment-hover");
    };
  }, [markAt, openMark, quote.comments, quote.disabled, quote.onCommentUpdate, scrollRef]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 7000 : 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useLayoutEffect(() => {
    if (!current && !activeComment && !feedback) return;
    const place = () => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const margin = 8, gap = 8;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const bounds = surface.getBoundingClientRect();
      const dock = quote.dockRef?.current?.getBoundingClientRect();
      const selection = (current ?? activeComment)?.range.getBoundingClientRect?.();
      const aboveDock = touch || (!current && !activeComment);
      const left = aboveDock && dock ? dock.left + (dock.width - bounds.width) / 2 : selection?.left ?? margin;
      const top = aboveDock ? (dock?.top ?? viewportBottom - 80) - bounds.height - gap
        : selection && selection.top - bounds.height - gap >= viewportTop + margin ? selection.top - bounds.height - gap
        : (selection?.bottom ?? viewportTop) + gap;
      setPosition({
        left: Math.max(viewportLeft + margin, Math.min(left, viewportLeft + viewportWidth - bounds.width - margin)),
        top: Math.max(viewportTop + margin, Math.min(top, viewportBottom - bounds.height - margin))
      });
    };
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (quote.dockRef?.current) observer?.observe(quote.dockRef.current);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [activeComment, current, feedback, quote.dockRef, sheet, touch]);

  if (!current && !activeComment && !feedback) return null;
  if (activeComment) return createPortal(
    <div className="v2-selection-comment-layer" data-layout={sheet ? "sheet" : "popover"}>
      <button className="v2-selection-comment-scrim" aria-label="Save and close comment" tabIndex={-1} type="button" onClick={saveComment} />
      <section className="v2-selection-comment-form" ref={element => { dialogRef.current = element; surfaceRef.current = element; }}
        role="dialog" aria-modal="true" aria-label={activeComment.editId ? "Edit comment" : "Add comment"} onKeyDown={event => {
          if (isImeCompositionEvent(event)) { event.stopPropagation(); return; }
          onDialogKeyDown(event);
        }}
        style={sheet ? undefined : { left: position?.left ?? 8, top: position?.top ?? 8 }}>
        <strong>{activeComment.editId ? "Edit comment" : "Add comment"}</strong>
        <p className="v2-selection-comment-quote">{activeComment.markdown}</p>
        <textarea aria-label="Comment" value={commentText} rows={3} placeholder="Write a comment…"
          aria-describedby={feedback ? feedbackId : undefined} aria-invalid={feedback?.error || undefined}
          onChange={event => setCommentText(event.target.value)}
          onKeyDown={event => {
            if (isImeCompositionEvent(event)) return;
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); saveComment(); }
          }} />
        <p className="v2-selection-comment-hint">Enter saves · Shift+Enter adds a line</p>
        {feedback ? <span id={feedbackId} role="alert">{feedback.text}</span> : null}
        <div className="v2-selection-comment-actions">
          {activeComment.editId && quote.onCommentRemove ? <UiV2Button type="button" tone="destructive"
            className="v2-selection-comment-delete" onClick={removeComment}>Delete</UiV2Button> : null}
          <UiV2Button type="button" onClick={closeComment}>Cancel</UiV2Button>
          <UiV2Button type="button" tone="primary" disabled={!commentText.trim()} onClick={saveComment}>Save</UiV2Button>
        </div>
      </section>
    </div>, document.body
  );
  return createPortal(
    <div className="v2-selection-quote" data-touch={touch || undefined} ref={element => { surfaceRef.current = element; }}
      style={{ left: position?.left ?? 8, top: position?.top ?? 8, visibility: position ? "visible" : "hidden" }}>
      {current && !activeComment ? <UiV2Button type="button" className="v2-selection-quote-button" onPointerDown={event => event.preventDefault()}
        onMouseDown={event => event.preventDefault()} onClick={() => {
          // Clicking may change the native Selection. The captured text owns this action.
          if (!scrollRef.current?.contains(current.root) || !current.root.matches("[data-quote-eligible='true']") ||
            scrollRef.current.querySelector("[data-editing='true']")) { setCaptured(null); return; }
          const error = quote.onQuote(current.markdown, touch);
          setCaptured(null);
          if (!error) window.getSelection()?.removeAllRanges();
          setNotice(error || touch ? { error: Boolean(error), text: error ?? "Quoted", scopeKey: quote.scopeKey } : null);
        }}>Quote</UiV2Button> : null}
      {current && !activeComment && quote.onComment ? <UiV2Button type="button" className="v2-selection-quote-button"
        onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()}
        onClick={event => {
          if (!scrollRef.current?.contains(current.root) || !current.root.matches("[data-quote-eligible='true']") ||
            scrollRef.current.querySelector("[data-editing='true']")) { setCaptured(null); return; }
          const anchor = captureCommentAnchor(current.range, current.root) ?? undefined;
          // Never open a form whose Save is already known to fail.
          const refusal = quote.onCommentStart?.(current.markdown, anchor) ?? null;
          if (refusal) {
            setCaptured(null);
            setNotice({ error: true, text: refusal, scopeKey: quote.scopeKey });
            return;
          }
          event.currentTarget.focus();
          current.root.setAttribute("tabindex", "-1");
          commentSourceRef.current = current.root;
          setCommenting({ ...current, anchor }); setCommentText(""); setCaptured(null);
        }}>Comment</UiV2Button> : null}
      {feedback ? <span className="v2-selection-quote-notice" role={feedback.error ? "alert" : "status"}>{feedback.text}</span> : null}
    </div>, document.body
  );
}
