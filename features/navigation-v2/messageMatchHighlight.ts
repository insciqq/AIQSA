export type HighlightSegment = Readonly<{ match: boolean; text: string }>;

/**
 * Splits a plain-text snippet into runs and marks every case-insensitive
 * occurrence of the query. Whitespace in the query matches any whitespace run,
 * as the server collapses it in snippets. The result is rendered as text
 * nodes, never as markup.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const words = query.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [{ match: false, text }];
  const pattern = new RegExp(
    words.map((word) => word.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&")).join("\\s+"),
    "giu"
  );
  const segments: HighlightSegment[] = [];
  let index = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index ?? index;
    if (start > index) segments.push({ match: false, text: text.slice(index, start) });
    segments.push({ match: true, text: found[0] });
    index = start + found[0].length;
  }
  if (index < text.length) segments.push({ match: false, text: text.slice(index) });
  return segments.length > 0 ? segments : [{ match: false, text }];
}
