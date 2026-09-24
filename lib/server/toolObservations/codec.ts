import { createHash } from "node:crypto";

export const OBSERVATION_ENCODING = "json-utf8-v1" as const;
const CHUNK_BYTES = 32 * 1024;
const STRING_CHARACTERS = 4096;
const MAX_DEPTH = 128;

export class ObservationEncodingError extends Error {
  constructor(readonly code: "tool_observation_invalid" | "tool_observation_too_large") {
    super(code);
    this.name = "ObservationEncodingError";
  }
}

const invalid = () => new ObservationEncodingError("tool_observation_invalid");

/** Serialize the accepted JSON value without building another complete JSON
 * string or Buffer. Object key order, scalar values and every string survive;
 * this is not the provider-facing normalization/projection. */
export function* encodeObservationJson(value: unknown, maxBytes: number): Generator<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw invalid();
  const ancestors = new Set<object>();
  let nodes = 0;

  function* string(text: string): Generator<string> {
    yield '"';
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + STRING_CHARACTERS, text.length);
      // JSON.stringify must see a surrogate pair together, including at the
      // internal chunk boundary. Lone surrogates remain JSON escape sequences.
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end++;
      yield JSON.stringify(text.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
  }

  function* visit(current: unknown, depth: number): Generator<string> {
    if (++nodes > maxBytes) throw new ObservationEncodingError("tool_observation_too_large");
    if (depth > MAX_DEPTH) throw invalid();
    if (current === null) { yield "null"; return; }
    if (typeof current === "string") { yield* string(current); return; }
    if (typeof current === "boolean" || typeof current === "number" && Number.isFinite(current)) {
      yield JSON.stringify(current);
      return;
    }
    if (typeof current !== "object" || ancestors.has(current)) throw invalid();
    const array = Array.isArray(current);
    if (!array && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) throw invalid();
    if (Object.getOwnPropertySymbols(current).length) throw invalid();
    ancestors.add(current);
    try {
      const keys = Object.keys(current);
      if (array && keys.length !== current.length) throw invalid();
      yield array ? "[" : "{";
      for (let index = 0; index < keys.length; index++) {
        const key = array ? String(index) : keys[index]!;
        const property = Object.getOwnPropertyDescriptor(current, key);
        if (!property || !property.enumerable || !Object.hasOwn(property, "value")) throw invalid();
        if (index) yield ",";
        if (!array) { yield* string(key); yield ":"; }
        yield* visit(property.value, depth + 1);
      }
      yield array ? "]" : "}";
    } finally {
      ancestors.delete(current);
    }
  }

  let chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let used = 0;
  let total = 0;
  for (const part of visit(value, 0)) {
    const bytes = Buffer.from(part, "utf8");
    total += bytes.byteLength;
    if (total > maxBytes) throw new ObservationEncodingError("tool_observation_too_large");
    for (let offset = 0; offset < bytes.length;) {
      const count = Math.min(CHUNK_BYTES - used, bytes.length - offset);
      chunk.set(bytes.subarray(offset, offset + count), used);
      offset += count;
      used += count;
      if (used === CHUNK_BYTES) {
        yield chunk;
        chunk = Buffer.allocUnsafe(CHUNK_BYTES);
        used = 0;
      }
    }
  }
  if (used) yield chunk.subarray(0, used);
}

/** Only a small inline candidate is retained. A large original is scanned to
 * determine its immutable identity, then streamed to the existing backend. */
export function measureObservationJson(value: unknown, maxBytes: number, inlineBytes: number) {
  if (!Number.isSafeInteger(inlineBytes) || inlineBytes < 0 || inlineBytes > maxBytes) throw invalid();
  const hash = createHash("sha256");
  let byteSize = 0;
  let inline: Buffer[] | null = [];
  for (const bytes of encodeObservationJson(value, maxBytes)) {
    byteSize += bytes.byteLength;
    hash.update(bytes);
    if (byteSize > inlineBytes) inline = null;
    else inline?.push(Buffer.from(bytes));
  }
  return { byteSize, checksum: hash.digest("hex"), encoding: OBSERVATION_ENCODING,
    inline: inline ? Buffer.concat(inline).toString("utf8") : null };
}

export function observationJsonStream(value: unknown, maxBytes: number): ReadableStream<Uint8Array> {
  const chunks = encodeObservationJson(value, maxBytes);
  return new ReadableStream({
    pull(controller) {
      try {
        const next = chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        chunks.return(undefined);
        controller.error(error);
      }
    },
    cancel() { chunks.return(undefined); }
  }, { highWaterMark: 1 });
}
