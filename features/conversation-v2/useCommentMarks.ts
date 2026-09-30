"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { PendingComposerComment } from "@/components/app-shell/composerComments";
import { rangeContainsPoint, resolveCommentAnchor } from "./commentAnchors";

/** Names of the transcript highlights; `conversation.css` styles them. */
export const COMMENT_MARK = "aiqsa-comment";
export const ACTIVE_COMMENT_MARK = "aiqsa-comment-active";

export type CommentMark = Readonly<{ comment: PendingComposerComment; range: Range; root: HTMLElement }>;

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function" ? CSS.highlights : null;
}

function sameMarks(previous: readonly CommentMark[], next: readonly CommentMark[]): boolean {
  return previous.length === next.length && previous.every((mark, index) => {
    const other = next[index]!;
    return mark.comment === other.comment && mark.range.startContainer === other.range.startContainer &&
      mark.range.startOffset === other.range.startOffset && mark.range.endContainer === other.range.endContainer &&
      mark.range.endOffset === other.range.endOffset;
  });
}

function messageRoot(container: HTMLElement, messageId: string): HTMLElement | null {
  for (const article of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (article.dataset.messageId === messageId) return article.querySelector<HTMLElement>(".v2-conversation-markdown");
  }
  return null;
}

/**
 * Marks pending comments in the transcript and returns a hit test for them.
 * The CSS Custom Highlight API paints the ranges without touching the
 * React-owned DOM; without it, nothing is painted and hit testing still works.
 * Rendering can change a message's text after mount (math, code highlighting),
 * so marks are re-resolved after every transcript mutation.
 */
export function useCommentMarks(
  scrollRef: RefObject<HTMLElement | null>,
  comments: readonly PendingComposerComment[] | undefined,
  activeId: string | null
): (x: number, y: number) => CommentMark | null {
  const marksRef = useRef<readonly CommentMark[]>([]);

  useEffect(() => {
    const container = scrollRef.current;
    const anchored = (comments ?? []).filter(comment => comment.anchor);
    if (!container || anchored.length === 0) { marksRef.current = []; return; }
    const registry = highlightRegistry();
    const owned: Highlight[] = [];
    const paint = (name: string, ranges: readonly Range[]) => {
      const current = registry?.get(name);
      if (current && owned.includes(current)) registry!.delete(name);
      if (!registry || ranges.length === 0) return;
      const highlight = new Highlight(...ranges);
      owned.push(highlight);
      registry.set(name, highlight);
    };
    let frame: number | null = null;
    const resolve = () => {
      frame = null;
      const marks: CommentMark[] = [];
      for (const comment of anchored) {
        const root = messageRoot(container, comment.anchor!.messageId);
        const range = root ? resolveCommentAnchor(root, comment.anchor!) : null;
        if (root && range) marks.push({ comment, range, root });
      }
      if (sameMarks(marksRef.current, marks)) return;
      marksRef.current = marks;
      paint(COMMENT_MARK, marks.filter(mark => mark.comment.id !== activeId).map(mark => mark.range));
      paint(ACTIVE_COMMENT_MARK, marks.filter(mark => mark.comment.id === activeId).map(mark => mark.range));
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(resolve);
    };
    marksRef.current = [];
    resolve();
    const observer = new MutationObserver(schedule);
    observer.observe(container, { characterData: true, childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      paint(COMMENT_MARK, []);
      paint(ACTIVE_COMMENT_MARK, []);
      marksRef.current = [];
    };
  }, [activeId, comments, scrollRef]);

  return useCallback((x: number, y: number) =>
    marksRef.current.find(mark => rangeContainsPoint(mark.range, x, y)) ?? null, []);
}
