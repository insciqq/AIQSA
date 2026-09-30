import { appendSelectionQuote } from "@/components/chat/renderedMarkdown";

/**
 * Where a comment's fragment sits in its finished message: offsets into the
 * rendered content text and a fingerprint of that text. It only draws the
 * transcript mark; a fragment that no longer matches is simply not marked.
 */
export type PendingCommentAnchor = Readonly<{
  messageId: string;
  start: number;
  end: number;
  fingerprint: string;
}>;

/** A local annotation queued alongside one composer session. */
export type PendingComposerComment = Readonly<{
  id: string;
  quote: string;
  text: string;
  anchor?: PendingCommentAnchor;
}>;

/**
 * Structural bound only (operator, 2026-09-30). Fragments and comments have no
 * separate length limit: their real bound is the stored size of the chat's
 * browser record, enforced by the session store and the draft storage.
 */
export const MAX_PENDING_COMMENTS = 100;
const MAX_COMMENT_ID_CHARS = 128;
const ANCHOR_FINGERPRINT = /^[0-9a-f]{8}$/u;

/** Why a pending comment was not added or changed. Each has its own message. */
export type ComposerCommentRefusal = "count" | "editing" | "empty" | "missing" | "too-large" | "unavailable";
/** start: the Comment control before a form opens; add: saving the form; edit: saving from the list. */
export type ComposerCommentAction = "add" | "edit" | "start";

export function composerCommentRefusalMessage(refusal: ComposerCommentRefusal, action: ComposerCommentAction): string {
  switch (refusal) {
    case "count":
      return `This chat already has ${MAX_PENDING_COMMENTS} pending comments. Send them or delete one before adding another.`;
    case "editing":
      return "Finish or cancel the inline message edit before adding a comment.";
    case "empty":
      return "Write a comment before saving it.";
    case "missing":
      return "This comment was already sent or deleted. Close the list to see the current comments.";
    case "too-large":
      return action === "start"
        ? "This selection is too large to keep with this chat's unsent input. Select less text, or send the pending comments first."
        : action === "edit"
          ? "This edit would make this chat's unsent input too large to keep. Shorten it or the message text, or send the pending comments first."
          : "This comment would make this chat's unsent input too large to keep. Shorten it or the message text, or send the pending comments first.";
    case "unavailable":
      return "Comments are unavailable for this conversation right now. Reopen it and try again.";
  }
}

export function validCommentAnchor(value: unknown): PendingCommentAnchor | null {
  if (!value || typeof value !== "object") return null;
  const { messageId, start, end, fingerprint } = value as Record<string, unknown>;
  if (typeof messageId !== "string" || !messageId || messageId.length > MAX_COMMENT_ID_CHARS) return null;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)) return null;
  if (typeof fingerprint !== "string" || !ANCHOR_FINGERPRINT.test(fingerprint)) return null;
  return { messageId, start: start as number, end: end as number, fingerprint };
}

function validComment(value: unknown): PendingComposerComment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const { id, quote, text } = record;
  if (typeof id !== "string" || typeof quote !== "string" || typeof text !== "string") return null;
  if (!id || id.length > MAX_COMMENT_ID_CHARS || !quote.trim() || !text.trim()) return null;
  // An unusable anchor only loses the transcript mark, never the comment.
  const anchor = validCommentAnchor(record.anchor);
  return anchor ? { id, quote, text, anchor } : { id, quote, text };
}

/**
 * Decode untrusted browser data item by item. An invalid or duplicate entry is
 * dropped alone, so the draft and the other comments survive. Callers bound
 * the raw entry before parsing; only the first MAX_PENDING_COMMENTS items are
 * considered, which no store-written record exceeds.
 */
export function decodeComposerComments(value: unknown): PendingComposerComment[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const decoded: PendingComposerComment[] = [];
  for (const item of value.slice(0, MAX_PENDING_COMMENTS)) {
    const comment = validComment(item);
    if (!comment || seen.has(comment.id)) continue;
    seen.add(comment.id);
    decoded.push(comment);
  }
  return decoded;
}

/**
 * Build the ordinary Markdown message sent for a composer with annotations.
 * Each selection is a block quote followed by its comment, in creation order;
 * the free-form composer text remains the final section byte-for-byte.
 */
export function buildComposerMessage(
  draft: string,
  comments: readonly PendingComposerComment[] = []
): string {
  if (comments.length === 0) return draft;
  const sections = comments.map(comment => {
    return `${appendSelectionQuote("", comment.quote)}${comment.text}`;
  });
  if (!draft) return sections.join("\n\n");
  return `${sections.join("\n\n")}\n\n${draft}`;
}
