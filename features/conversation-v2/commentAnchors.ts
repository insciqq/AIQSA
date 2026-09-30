import type { PendingCommentAnchor } from "@/components/app-shell/composerComments";

/**
 * Offsets count the message's content text only. Buttons and Markdown chrome
 * change at runtime (a code block's Copy/Copied label), so they are skipped:
 * a mark after a code block must not move when its label changes.
 */
const SKIPPED = "button, [data-markdown-chrome]";

function contentTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      const skipped = node.parentElement?.closest(SKIPPED);
      return skipped && root.contains(skipped) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/** FNV-1a over UTF-16 code units: a cheap check that the marked text is unchanged. */
export function commentTextFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Content-text offset of a boundary point; a point inside skipped chrome counts the text before it. */
function offsetAt(nodes: readonly Text[], container: Node, offset: number): number {
  const point = container.ownerDocument!.createRange();
  point.setStart(container, offset);
  let total = 0;
  for (const node of nodes) {
    if (node === container) return total + offset;
    if (point.comparePoint(node, 0) > 0) break;
    total += node.data.length;
  }
  return total;
}

function textBetween(nodes: readonly Text[], start: number, end: number): string {
  let text = "";
  let offset = 0;
  for (const node of nodes) {
    const next = offset + node.data.length;
    if (next > start && offset < end) text += node.data.slice(Math.max(0, start - offset), Math.min(node.data.length, end - offset));
    if (next >= end) break;
    offset = next;
  }
  return text;
}

/** Anchors a selection inside one finished message's rendered content, or null when it has no content text. */
export function captureCommentAnchor(range: Range, root: HTMLElement): PendingCommentAnchor | null {
  const messageId = root.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
  if (!messageId || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const nodes = contentTextNodes(root);
  const start = offsetAt(nodes, range.startContainer, range.startOffset);
  const end = offsetAt(nodes, range.endContainer, range.endOffset);
  if (end <= start) return null;
  const text = textBetween(nodes, start, end);
  if (!text.trim()) return null;
  return { messageId, start, end, fingerprint: commentTextFingerprint(text) };
}

/** The live Range for an anchor, or null when the message is absent or its text no longer matches. */
export function resolveCommentAnchor(root: HTMLElement, anchor: PendingCommentAnchor): Range | null {
  const nodes = contentTextNodes(root);
  let offset = 0;
  let start: { node: Text; offset: number } | null = null;
  let end: { node: Text; offset: number } | null = null;
  for (const node of nodes) {
    const next = offset + node.data.length;
    // A start on a node boundary belongs to the next node, an end to the previous one.
    if (!start && anchor.start < next) start = { node, offset: anchor.start - offset };
    if (start && anchor.end <= next) { end = { node, offset: anchor.end - offset }; break; }
    offset = next;
  }
  if (!start || !end) return null;
  if (commentTextFingerprint(textBetween(nodes, anchor.start, anchor.end)) !== anchor.fingerprint) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/** Whether a viewport point lies on the rendered text of a Range. */
export function rangeContainsPoint(range: Range, x: number, y: number): boolean {
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}
