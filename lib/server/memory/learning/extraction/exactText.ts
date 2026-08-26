import type { MemoryExactTextRef } from "./contract";

const controlSyntax = /[\u0000-\u001f\u007f]/u;

export type MemoryExactTextSpan = Readonly<{
  endOffset: number;
  startOffset: number;
  text: string;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeMemoryExactTextRef(
  value: unknown,
  maxLength = 2_000
): MemoryExactTextRef | null {
  if (!record(value) ||
    Object.keys(value).sort().join("\u0000") !== "occurrence_index\u0000text" ||
    typeof value.text !== "string" || !value.text ||
    value.text.length > maxLength || controlSyntax.test(value.text) ||
    !Number.isSafeInteger(value.occurrence_index) ||
    Number(value.occurrence_index) < 0 || Number(value.occurrence_index) > 255) {
    return null;
  }
  return {
    occurrenceIndex: Number(value.occurrence_index),
    text: value.text
  };
}

/** Projects one exact zero-based occurrence. JavaScript indices intentionally
 * preserve the product's UTF-16 offset contract, including emoji and
 * combining sequences without Unicode normalization. */
export function projectMemoryExactTextRef(
  source: string,
  ref: MemoryExactTextRef
): MemoryExactTextSpan | null {
  let startOffset = -1;
  let cursor = 0;
  for (let occurrence = 0; occurrence <= ref.occurrenceIndex; occurrence += 1) {
    startOffset = source.indexOf(ref.text, cursor);
    if (startOffset < 0) return null;
    cursor = startOffset + 1;
  }
  const endOffset = startOffset + ref.text.length;
  return source.slice(startOffset, endOffset) === ref.text
    ? { endOffset, startOffset, text: ref.text }
    : null;
}
