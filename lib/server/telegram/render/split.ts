import type { TelegramInputRichBlock, TelegramInputRichMessage, TelegramRichText } from "../botApi";
import { blockSize, isRichArray, plainBlock, plainText, RICH_LIMITS } from "./richText";

/** A separate first footer on every message after the first; never answer text. */
export const CONTINUATION_MARKER = "(continued)";
const MAX_CONTENT = RICH_LIMITS.characters - CONTINUATION_MARKER.length;
const MAX_BLOCKS = RICH_LIMITS.blocks - 1;

/** Keep delimiters in the preceding chunk and never cut a UTF-16 surrogate pair. */
export function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const paragraph = window.lastIndexOf("\n\n");
      const line = window.lastIndexOf("\n");
      const word = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
      const boundary = paragraph >= 0 ? paragraph + 2 : line >= 0 ? line + 1 : word >= 0 ? word + 1 : 0;
      if (boundary > 0) end = start + boundary;
      if (/[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) end--;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Slice text leaves without losing formatting or manufacturing a partial formula. */
function sliceRichText(text: TelegramRichText, start: number, end: number): TelegramRichText {
  if (typeof text === "string") return text.slice(start, end);
  if (isRichArray(text)) {
    let offset = 0;
    const parts: TelegramRichText[] = [];
    for (const part of text) {
      const length = plainText(part).length;
      if (start < offset + length && end > offset) {
        parts.push(sliceRichText(part, Math.max(0, start - offset), Math.min(length, end - offset)));
      }
      offset += length;
      if (offset >= end) break;
    }
    return parts;
  }
  if (text.type === "mathematical_expression") {
    return start === 0 && end === text.expression.length ? text : text.expression.slice(start, end);
  }
  return { ...text, text: sliceRichText(text.text, start, end) };
}

function splitBlock(block: TelegramInputRichBlock): TelegramInputRichBlock[] {
  const size = blockSize(block);
  if (size.characters <= MAX_CONTENT && size.blocks <= MAX_BLOCKS) return [block];
  // Oversized containers and formulas become readable preformatted text. This
  // preserves item labels and row boundaries without invalid partial structures.
  const leaf = "text" in block ? block : { type: "pre" as const, text: plainBlock(block) };
  let offset = 0;
  return splitText(plainText(leaf.text), MAX_CONTENT).map(chunk => {
    const text = sliceRichText(leaf.text, offset, offset + chunk.length);
    offset += chunk.length;
    return { ...leaf, text };
  });
}

export function packBlocks(blocks: readonly TelegramInputRichBlock[]): TelegramInputRichMessage[] {
  const messages: TelegramInputRichMessage[] = [];
  let current: TelegramInputRichBlock[] = [];
  let characters = 0;
  let count = 0;
  for (const block of blocks.flatMap(splitBlock)) {
    const size = blockSize(block);
    if (current.length && (characters + size.characters > MAX_CONTENT || count + size.blocks > MAX_BLOCKS)) {
      messages.push({ blocks: current, skip_entity_detection: true });
      current = [{ type: "footer", text: CONTINUATION_MARKER }];
      characters = 0;
      count = 0;
    }
    current.push(block);
    characters += size.characters;
    count += size.blocks;
  }
  messages.push({ blocks: current.length ? current : [{ type: "paragraph", text: "" }], skip_entity_detection: true });
  return messages;
}

/** A draft keeps the most recent content; the ellipsis explicitly marks omitted history. */
export function draftMessage(blocks: readonly TelegramInputRichBlock[]): TelegramInputRichMessage {
  const sizes = blocks.map(blockSize);
  if (sizes.reduce((sum, size) => sum + size.characters, 0) <= RICH_LIMITS.characters &&
      sizes.reduce((sum, size) => sum + size.blocks, 0) <= RICH_LIMITS.blocks) {
    return { blocks: blocks.length ? blocks : [{ type: "paragraph", text: "" }], skip_entity_detection: true };
  }
  // Use the same projection as the fallback, retaining readable boundaries when
  // a draft has to drop entire containers or part of a formula.
  const text = blocks.map(block => plainBlock(block)).join("\n\n");
  if (text.length <= RICH_LIMITS.characters) {
    return { blocks: [{ type: "paragraph", text }], skip_entity_detection: true };
  }
  let start = text.length - (RICH_LIMITS.characters - 1);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]) && /[\uD800-\uDBFF]/u.test(text[start - 1])) start++;
  return { blocks: [{ type: "paragraph", text: `…${text.slice(start)}` }], skip_entity_detection: true };
}
