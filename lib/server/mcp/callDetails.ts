import type { McpCallDetails, McpCallDisplaySection } from "@/lib/contracts/mcpCallDetails";
import { MCP_CALL_DISPLAY_BYTES } from "@/lib/contracts/mcpCallDetails";
import type { ToolObservation } from "@prisma/client";
import { parsePersistedToolExecutionResult } from "../runs/toolExecutionPersistence";
import { snapshotToolLoopJson, toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { redactMcpDisplayValue } from "./resultRedaction";
import { mcpDetailRecord as record } from "./callDetailsAuthority";
import { mcpRuntimeErrorCode, mcpRuntimeErrorMessage } from "@/lib/contracts/mcp";

export type McpCallDetailsKey = Readonly<{ runId: string; roundIndex: number; ordinal: number; userId: string }>;
export type McpCallDetailRecord = Readonly<{
  id: string; toolName: string; providerCallId: string; state: string; arguments: unknown; result: unknown;
  values: readonly string[]; observation: ToolObservation | null;
  unavailable: boolean; revision: string;
}>;
export type McpCallDetailsRepository = Readonly<{
  read(key: McpCallDetailsKey): Promise<McpCallDetailRecord | null>;
}>;

const contentUnavailable = (row: McpCallDetailRecord) => row.unavailable ||
  row.result === null && record(row.arguments) && row.arguments.deleted === true && Object.keys(row.arguments).length === 1 ||
  record(row.result) && row.result.error === "temporary_retention_expired";

export function mcpDisplaySection(text: string): McpCallDisplaySection {
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.length, MCP_CALL_DISPLAY_BYTES);
  if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), byteSize: bytes.length, truncated: end < bytes.length };
}

/** Only text/structured content and known safe error metadata leave storage.
 * Stored arguments are always shown, redacted by the values known now. */
export function projectMcpCallDetails(row: McpCallDetailRecord): McpCallDetails {
  const unavailable = contentUnavailable(row);
  const request = unavailable ? null : mcpDisplaySection(JSON.stringify(redactMcpDisplayValue(row.arguments, row.values), null, 2));
  const base = { request, requestState: request ? "available" as const : "unavailable" as const,
    response: null, isError: row.state === "error", unsupportedContentTypes: [] as string[] };
  if (unavailable) return { ...base, responseState: "unavailable" };
  if (row.state === "pending" || row.state === "running") return { ...base, responseState: "pending" };
  if (row.state === "cancelled") return { ...base, responseState: "cancelled" };
  const result = parsePersistedToolExecutionResult({ id: row.providerCallId, name: row.toolName },
    snapshotToolLoopJson(row.result, toolLoopPersistenceLimits.resultBytes));
  if (!result) return { ...base, responseState: "unavailable" };
  const failure = record(result.rawPreview?.finalProviderResponsePreview) ? result.rawPreview.finalProviderResponsePreview.error : null;
  if (record(failure) && failure.code === "tool_result_too_large") return { ...base, responseState: "too_large" };
  if (record(failure) && failure.code === "tool_result_unpersistable") return { ...base, responseState: "unavailable" };
  if (result.observation) return { ...base, responseState: "unavailable" };
  if (result.status === "error" && failure !== null && result.rawPreview?.isError === undefined) {
    // Execution failures are server-owned receipts. Keep only their safe code
    // and message, never requestPreview or arbitrary persisted exception prose.
    let stored: unknown;
    try { stored = JSON.parse(result.content.find(part => part.type === "text")?.text ?? "null"); } catch { stored = null; }
    const code = record(stored) && record(stored.error) && typeof stored.error.code === "string" ? stored.error.code : "tool_call_failed";
    const known = mcpRuntimeErrorCode(code) === code;
    return { ...base, responseState: "available", response: mcpDisplaySection(JSON.stringify({
      error: { code: known ? code : "tool_call_failed", message: known ? mcpRuntimeErrorMessage(code) : "The tool call failed." }
    }, null, 2)) };
  }
  const projected = result.content.flatMap(part => {
    if (part.type === "text") return [redactMcpDisplayValue(part.text, row.values) as string];
    if (part.type !== "json") return [];
    return [JSON.stringify(redactMcpDisplayValue(part.value, row.values), null, 2)];
  });
  const unsupportedContentTypes = Array.isArray(result.rawPreview?.unsupportedContentTypes)
    ? [...new Set(result.rawPreview.unsupportedContentTypes.map(value => redactMcpDisplayValue(value, row.values))
      .filter((value): value is string => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(value)))]
      .slice(0, 16) : [];
  return { ...base, response: mcpDisplaySection(projected.join("\n\n")), responseState: "available",
    isError: result.rawPreview?.isError === true || result.status === "error", unsupportedContentTypes };
}

export function createMcpCallDetailsService(input: Readonly<{
  repository: McpCallDetailsRepository;
  readObservation(row: McpCallDetailRecord, signal?: AbortSignal): Promise<Pick<McpCallDetails, "response" | "isError" | "unsupportedContentTypes"> | null>;
}>) {
  return async (key: McpCallDetailsKey, signal?: AbortSignal): Promise<McpCallDetails | null> => {
    const row = await input.repository.read(key);
    if (!row) return null;
    let details = projectMcpCallDetails(row);
    if (!contentUnavailable(row) && row.observation && ["complete", "error"].includes(row.state)) {
      const original = await input.readObservation(row, signal);
      details = original ? { ...details, ...original, responseState: "available" } : { ...details, response: null, responseState: "unavailable" };
    }
    signal?.throwIfAborted();
    const after = await input.repository.read(key);
    if (!after || after.revision !== row.revision) return null;
    return details;
  };
}
