import { createHash } from "node:crypto";
import { isUint8Array } from "node:util/types";
import { readStreamWithAbort } from "../http/byteStream";
import { compactSearchToolExecutionResult } from "../search/toolResult";
import type { ToolExecutionResult } from "../tools/types";
import { ObservationStoreError, type ToolObservationDescriptor } from "./contract";

// Three Search engines, each with independently bounded findings and at most
// twenty normalized source records. Never use the MCP wire cap for this owner.
export const SEARCH_OBSERVATION_MAX_BYTES = 8 * 1024 * 1024;
const unavailable = () => new ObservationStoreError("tool_observation_unavailable");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The retained Search original is exactly the model-facing canonical text
 * Off delivers (findings, numbered sources and engine notices), unbounded.
 * Invocation, revision, usage and cost live only in the accounting receipt,
 * so the reader can never expose them. */
export type SearchObservationOriginal = Readonly<{
  status: "complete" | "error";
  content: readonly [Readonly<{ type: "text"; text: string }>];
}>;

export function searchObservationOriginal(result: ToolExecutionResult): SearchObservationOriginal | null {
  // A versioned result must carry exactly its Search owner's canonical text.
  if (!compactSearchToolExecutionResult(result)) return null;
  const [part] = result.content;
  if (result.content.length !== 1 || part?.type !== "text") return null;
  return { status: result.status, content: [{ type: "text", text: part.text }] };
}

function decodeSearchObservationOriginal(value: unknown): SearchObservationOriginal | null {
  if (!record(value) || Object.keys(value).sort().join(",") !== "content,status" ||
    value.status !== "complete" && value.status !== "error" || !Array.isArray(value.content) || value.content.length !== 1) return null;
  const [part] = value.content as unknown[];
  if (!record(part) || Object.keys(part).sort().join(",") !== "text,type" || part.type !== "text" ||
    typeof part.text !== "string") return null;
  return { status: value.status, content: [{ type: "text", text: part.text }] };
}

/** The complete retained Search original, checksum-verified. Private restore
 * consumer only; never a model reader or an unbounded storage fallback. */
export async function readSearchOriginal(input: Readonly<{
  body: ReadableStream<Uint8Array>; identity: ToolObservationDescriptor; signal: AbortSignal;
}>): Promise<SearchObservationOriginal> {
  const { identity, signal } = input;
  if (identity.source !== "search" || identity.byteSize > SEARCH_OBSERVATION_MAX_BYTES) throw unavailable();
  const bytes = Buffer.alloc(identity.byteSize);
  const reader = input.body.getReader();
  const hash = createHash("sha256");
  let total = 0;
  let complete = false;
  try {
    await readStreamWithAbort(async () => {
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        if (!isUint8Array(next.value) || total + next.value.length > bytes.length) throw unavailable();
        hash.update(next.value);
        bytes.set(next.value, total);
        total += next.value.length;
      }
    }, signal);
    signal.throwIfAborted();
    if (total !== bytes.length || hash.digest("hex") !== identity.checksum) throw unavailable();
    complete = true;
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw unavailable(); }
    const original = decodeSearchObservationOriginal(parsed);
    if (!original) throw unavailable();
    return original;
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
}
