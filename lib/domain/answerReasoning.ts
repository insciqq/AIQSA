import { THREAD_REASONING_MAX_CHARACTERS, boundThreadReasoningText } from "../contracts/chats";
import { storableUtf16Text, takeUtf16SafePrefix } from "./utf16";

/**
 * One durable reasoning record, and the live stream shape of the same output.
 * Streamed thinking is merged before publication: a record starts a shown
 * entry or continues the previous record with its exact text, so one thinking
 * block is a few bounded records instead of one row per provider delta. A
 * complete provider item (a summary, a final reasoning value) starts an entry.
 */
export type ReasoningRecord = Readonly<{
  entry: "continue" | "start";
  text: string;
  /** The provider value did not fit one record; its remainder is missing. */
  truncated?: true;
}>;

/** Rows written before merging carry only `{ text }` (or an older raw value). */
export type ReasoningFoldItem =
  | Readonly<{ kind: "legacy"; text: string }>
  | Readonly<{ kind: "other" }>
  | Readonly<{ kind: "record"; record: ReasoningRecord }>;

/** One record never needs more than a reader can be shown. */
export const REASONING_RECORD_MAX_CHARACTERS = THREAD_REASONING_MAX_CHARACTERS;
/** Streamed thinking is published in fragments of this size, so Stop or a
 * provider failure loses at most one unpublished fragment of a block. */
export const REASONING_STREAM_FRAGMENT_CHARACTERS = 4_000;

const readableReasoningKeys = ["delta", "summary", "reasoning", "text", "content"] as const;
const readableReasoningNodeLimit = 10_000;
const readableReasoningDepthLimit = 12;
/**
 * Pre-merge rows lost the whitespace around each provider delta, which
 * cannot be restored. Adjacent rows (no other output between them) are one
 * streamed block: they rejoin with one space, or with a paragraph break when
 * the next row opens a Markdown block (heading, list, quote, fence, bold title).
 */
const legacyBlockStart = /^(?:#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>|```|~~~|\*\*[^*\n]+\*\*(?:\n|$))/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Readable text of a complete provider reasoning value: known text fields
 * only, never serialized opaque parts. A value too large or too deep to read
 * whole is marked instead of silently cut.
 */
function readableReasoning(value: unknown): Readonly<{ text: string; truncated: boolean }> {
  const parts: string[] = [];
  let characters = 0;
  let visited = 0;
  let truncated = false;
  const visit = (candidate: unknown, depth: number): void => {
    if (truncated) return;
    if (visited >= readableReasoningNodeLimit || depth > readableReasoningDepthLimit) {
      truncated = true;
      return;
    }
    visited += 1;
    if (typeof candidate === "string") {
      const text = candidate.trim();
      if (!text) return;
      parts.push(text);
      characters += text.length;
      truncated = characters > REASONING_RECORD_MAX_CHARACTERS;
      return;
    }
    if (Array.isArray(candidate)) {
      for (const part of candidate) visit(part, depth + 1);
      return;
    }
    if (!isRecord(candidate)) return;
    const key = readableReasoningKeys.find((name) => name in candidate);
    if (key) visit(candidate[key], depth + 1);
  };
  visit(value, 0);
  return { text: storableUtf16Text(parts.join("\n\n")).trim(), truncated };
}

/**
 * Projects a provider reasoning value, a streamed fragment, or an already
 * durable record into one storable record. Fragment text stays exact; a
 * complete item joins its readable parts as paragraphs.
 */
export function projectReasoningRecord(value: unknown): ReasoningRecord | null {
  if (isRecord(value) && (value.entry === "start" || value.entry === "continue") &&
    typeof value.text === "string") {
    const text = storableUtf16Text(value.text);
    const kept = takeUtf16SafePrefix(text, REASONING_RECORD_MAX_CHARACTERS);
    // Whitespace alone may join two fragments of an entry, never start one.
    if (!kept || value.entry === "start" && !kept.trim()) return null;
    return {
      entry: value.entry,
      text: kept,
      ...(value.truncated === true || kept.length < text.length ? { truncated: true as const } : {})
    };
  }
  const readable = readableReasoning(value);
  if (!readable.text) return null;
  const kept = takeUtf16SafePrefix(readable.text, REASONING_RECORD_MAX_CHARACTERS).trimEnd();
  return {
    entry: "start",
    text: kept,
    ...(readable.truncated || kept.length < readable.text.length ? { truncated: true as const } : {})
  };
}

/** Reads one stored reasoning payload; a row without `entry` predates merging. */
export function storedReasoningFoldItem(payload: unknown): ReasoningFoldItem {
  if (isRecord(payload) && payload.entry !== undefined) {
    const record = projectReasoningRecord(payload);
    return record ? { kind: "record", record } : { kind: "other" };
  }
  const text = readableReasoning(payload).text;
  return text ? { kind: "legacy", text } : { kind: "other" };
}

/** Reads one live provider reasoning payload the way it will be stored. */
export function streamedReasoningFoldItem(payload: unknown): ReasoningFoldItem {
  const record = projectReasoningRecord(payload);
  return record ? { kind: "record", record } : { kind: "other" };
}

/**
 * Folds reasoning records in event order into shown entries: `continue`
 * appends exactly, adjacent pre-merge rows rejoin by the legacy rule, and the
 * reader bound applies once. Stored rows are never rewritten.
 */
export function foldReasoningEntries(
  items: readonly ReasoningFoldItem[]
): Readonly<{ entries: string[]; truncated: boolean }> {
  const blocks: string[] = [];
  let truncated = false;
  let legacyBlockOpen = false;
  for (const item of items) {
    if (item.kind === "other") {
      legacyBlockOpen = false;
      continue;
    }
    const last = blocks.length - 1;
    if (item.kind === "legacy") {
      if (legacyBlockOpen && last >= 0) {
        blocks[last] += (legacyBlockStart.test(item.text) ? "\n\n" : " ") + item.text;
      } else {
        blocks.push(item.text);
      }
      legacyBlockOpen = true;
      continue;
    }
    legacyBlockOpen = false;
    truncated ||= item.record.truncated === true;
    if (item.record.entry === "continue" && last >= 0) blocks[last] += item.record.text;
    else blocks.push(item.record.text);
  }
  const bounded = boundThreadReasoningText(
    blocks.map((block) => block.trim()).filter((block) => block.length > 0)
  );
  return { entries: bounded.reasoningText, truncated: truncated || bounded.truncated };
}

/**
 * Buffers one streamed thinking block and releases it as exact fragments of
 * at most `fragmentCharacters`, never between the halves of a UTF-16 pair.
 * Blank text before the entry starts or after it ends carries nothing.
 */
export function createReasoningFragmentBuffer(
  fragmentCharacters = REASONING_STREAM_FRAGMENT_CHARACTERS
): Readonly<{ append(text: string): ReasoningRecord[]; finish(): ReasoningRecord[] }> {
  const size = Math.max(2, Math.min(fragmentCharacters, REASONING_RECORD_MAX_CHARACTERS));
  let pending = "";
  let started = false;
  const take = (finished: boolean): ReasoningRecord[] => {
    const records: ReasoningRecord[] = [];
    while (pending && (finished || pending.length >= size)) {
      const text = takeUtf16SafePrefix(pending, size);
      pending = pending.slice(text.length);
      if (!text.trim() && (!started || finished && !pending)) continue;
      records.push({ entry: started ? "continue" : "start", text });
      started = true;
    }
    return records;
  };
  return {
    append(text) {
      pending += text;
      return take(false);
    },
    finish() {
      return take(true);
    }
  };
}
