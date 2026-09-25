import { createHash } from "node:crypto";
import { isUint8Array } from "node:util/types";
import { readStreamWithAbort } from "../http/byteStream";
import { isToolLoopJsonValue } from "../runs/toolLoopPersistence";
import { parsePersistedToolExecutionResult } from "../runs/toolExecutionPersistence";
import { searchExecutionPreviewCount, searchExecutionsFromToolResult } from "../search/toolResult";
import { ObservationStoreError } from "./contract";
import type { ToolObservationDescriptor } from "./contract";
import type { ToolExecutionResult } from "../tools/types";

// Three Search engines, each with independently bounded findings and at most
// twenty normalized source records. Never use the MCP wire cap for this owner.
export const SEARCH_OBSERVATION_MAX_BYTES = 8 * 1024 * 1024;
const unavailable = () => new ObservationStoreError("tool_observation_unavailable");

/** The complete retained Search result, checksum-verified and parsed by its
 * persistence owner (which rehydrates the canonical text). Private recovery
 * and accounting consumer only; never a model reader or unbounded fallback. */
export async function readSearchOriginal(input: Readonly<{
  body: ReadableStream<Uint8Array>; identity: ToolObservationDescriptor; signal: AbortSignal;
}>): Promise<ToolExecutionResult> {
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
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || !("callId" in value) || !("name" in value) ||
      typeof value.callId !== "string" || typeof value.name !== "string" || !isToolLoopJsonValue(value)) throw unavailable();
    const result = parsePersistedToolExecutionResult({ id: value.callId, name: value.name }, value);
    if (!result) throw unavailable();
    return result;
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
}

/** Private accounting hydration. Only a canonical Search receipt is accepted;
 * findings are dropped before returning accounting/source facts to the
 * existing run owner. */
export async function readSearchAccounting(input: Readonly<{
  body: ReadableStream<Uint8Array>; identity: ToolObservationDescriptor; signal: AbortSignal;
}>) {
  const result = await readSearchOriginal(input);
  const executions = searchExecutionsFromToolResult(result);
  if (!executions.length || executions.length !== searchExecutionPreviewCount(result)) throw unavailable();
  return executions.map(execution => {
    const accounting = { ...execution };
    delete accounting.findings;
    return accounting;
  });
}
