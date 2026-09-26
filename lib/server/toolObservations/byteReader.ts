import { createHash } from "node:crypto";
import { isUint8Array } from "node:util/types";
import { readStreamWithAbort } from "../http/byteStream";

export const OBSERVATION_READ_LIMITS = Object.freeze({
  fragmentBytes: 6 * 1024,
  queryBytes: 256,
  // The largest accepted MCP wire envelope is 16 MiB. The original's small
  // versioned envelope must also fit, without using the wire cap for Search,
  // Skills or Workspace admission; those owners retain their own bounds.
  documentBytes: 32 * 1024 * 1024,
  searchContextBytes: 256
});

export class ObservationReadError extends Error {
  /** A storage transport failure, hidden behind the same code, rather than
   * bytes that prove the original unavailable. */
  readonly transient: boolean;
  constructor(readonly code: "tool_observation_selector_invalid" | "tool_observation_unavailable",
    options: Readonly<{ transient?: boolean }> = {}) {
    super(code);
    this.name = "ObservationReadError";
    this.transient = options.transient === true;
  }
}

export type ObservationByteSelector = Readonly<{ offset: number; maxBytes: number; query?: string }>;
export type ObservationByteIdentity = Readonly<{ byteSize: number; checksum: string }>;
export type ObservationByteFragment = Readonly<{
  /** A text fragment of the serialized accepted JSON, never a partially parsed
   * JSON value. The tool response encloses it in a valid JSON string. */
  fragment: string;
  offset: number;
  endOffset: number;
  completeDocument: boolean;
  matchOffset: number | null;
  nextOffset: number | null;
}>;

const invalid = () => new ObservationReadError("tool_observation_selector_invalid");
const unavailable = () => new ObservationReadError("tool_observation_unavailable");
const continuationByte = (byte: number) => (byte & 0xc0) === 0x80;

export function validateObservationByteSelector(selector: ObservationByteSelector, identity: ObservationByteIdentity): void {
  if (!Number.isSafeInteger(identity.byteSize) || identity.byteSize < 1 ||
    identity.byteSize > OBSERVATION_READ_LIMITS.documentBytes || !/^[a-f0-9]{64}$/u.test(identity.checksum)) throw unavailable();
  if (!Number.isSafeInteger(selector.offset) || selector.offset < 0 || selector.offset > identity.byteSize ||
    !Number.isSafeInteger(selector.maxBytes) || selector.maxBytes < 4 || selector.maxBytes > OBSERVATION_READ_LIMITS.fragmentBytes ||
    selector.query !== undefined && (typeof selector.query !== "string" || selector.query.length === 0 ||
      Buffer.byteLength(selector.query) > OBSERVATION_READ_LIMITS.queryBytes || /[\ud800-\udfff]/u.test(selector.query))) throw invalid();
  if (selector.query !== undefined && Buffer.byteLength(selector.query) > selector.maxBytes) throw invalid();
}

/** Scan at most one bounded immutable object. Only the requested fragment and
 * a small literal-search overlap survive each stream chunk. Verify the whole
 * checksum even for an early fragment: corruption must never become evidence.
 * Authorization is owned by the caller, before opening and after this read. */
export async function readObservationBytes(input: Readonly<{
  body: ReadableStream<Uint8Array>;
  identity: ObservationByteIdentity;
  selector: ObservationByteSelector;
  signal?: AbortSignal;
}>): Promise<ObservationByteFragment> {
  const { identity, selector, signal } = input;
  validateObservationByteSelector(selector, identity);
  const needle = selector.query === undefined ? null : Buffer.from(selector.query, "utf8");
  const overlapBytes = needle ? needle.length - 1 + OBSERVATION_READ_LIMITS.searchContextBytes : 0;
  let overlap = Buffer.alloc(0);
  let total = 0;
  let matchOffset: number | null = null;
  let start: number | null = needle ? null : selector.offset;
  const fragment = Buffer.alloc(selector.maxBytes + 4);
  let captured = 0;
  const hash = createHash("sha256");
  const reader = input.body.getReader();
  let completed = false;
  try {
    await readStreamWithAbort(async () => {
      for (;;) {
        signal?.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        const bytes = next.value;
        if (!isUint8Array(bytes) || total + bytes.length > identity.byteSize) throw unavailable();
        hash.update(bytes);
        // Backend chunk sizes are not consumer memory policy. Subdivide views,
        // including a backend which hands over its entire already-held Buffer.
        for (let position = 0; position < bytes.length; position += 32 * 1024) {
          const part = bytes.subarray(position, Math.min(bytes.length, position + 32 * 1024));
          const absolute = total + position;
          let selected: Uint8Array = part;
          let selectedOffset = absolute;
          if (needle && start === null) {
            const search = Buffer.concat([overlap, part]);
            const base = absolute - overlap.length;
            const found = search.indexOf(needle, Math.max(0, selector.offset - base));
            if (found >= 0) {
              matchOffset = base + found;
              // Short pages must leave room after the match too: a field name
              // alone is rarely useful without its following value.
              const contextBytes = Math.min(OBSERVATION_READ_LIMITS.searchContextBytes,
                Math.floor((selector.maxBytes - needle.length) / 2));
              let from = Math.max(0, found - contextBytes);
              while (from < found && continuationByte(search[from]!)) from++;
              start = base + from;
              selected = search.subarray(from);
              selectedOffset = start;
            } else {
              // Copy a small tail; do not pin the full backend/search buffer.
              overlap = Buffer.from(search.subarray(Math.max(0, search.length - overlapBytes)));
            }
          }
          if (start !== null && captured < fragment.length) {
            const from = Math.max(0, start + captured - selectedOffset);
            const count = Math.min(fragment.length - captured, selected.length - from);
            if (count > 0) {
              fragment.set(selected.subarray(from, from + count), captured);
              captured += count;
            }
          }
        }
        total += bytes.length;
      }
    }, signal);
    signal?.throwIfAborted();
    if (total !== identity.byteSize || hash.digest("hex") !== identity.checksum) throw unavailable();
    completed = true;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error instanceof ObservationReadError ? error
      : new ObservationReadError("tool_observation_unavailable", { transient: true });
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (start === null) return { fragment: "", offset: total, endOffset: total,
    completeDocument: false, matchOffset: null, nextOffset: null };
  if (captured > 0 && continuationByte(fragment[0]!)) throw invalid();
  let end = Math.min(selector.maxBytes, captured);
  while (end > 0 && end < captured && continuationByte(fragment[end]!)) end--;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(fragment.subarray(0, end)); }
  catch { throw unavailable(); }
  const endOffset = start + end;
  return { fragment: text, offset: start, endOffset, completeDocument: start === 0 && endOffset === total,
    matchOffset, nextOffset: needle && matchOffset !== null
      ? matchOffset + needle.length < total ? matchOffset + needle.length : null
      : endOffset < total ? endOffset : null };
}
