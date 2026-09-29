import { MEMORY_SEARCH_TOOL_NAME } from "../memory/search/contract";
import type { MemorySearchService } from "../memory/search/runtime";
import type { ProviderRunRequest } from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";
import type { PersistedToolLoopCall } from "./toolLoopPersistence";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only the provider envelope, never a tool-supplied body or nested data. */
function resultCallId(value: unknown): string | null {
  if (!record(value)) return null;
  if (value.type === "function_call_output" || value.type === "function_result") {
    return typeof value.call_id === "string" ? value.call_id : null;
  }
  if (value.type === "fake_tool_result") return typeof value.callId === "string" ? value.callId : null;
  if (value.role === "tool") return typeof value.tool_call_id === "string" ? value.tool_call_id : null;
  if (value.role === "user" && Array.isArray(value.content) && value.content.length === 1) {
    const part = value.content[0];
    if (record(part) && part.type === "tool_result" && typeof part.tool_use_id === "string") {
      return part.tool_use_id;
    }
  }
  return null;
}

/** Rebuild only retained Memory result envelopes from freshly authorized receipts. */
export async function revalidateMemorySearchDispatch(input: {
  request: ProviderRunRequest;
  calls: Iterable<PersistedToolLoopCall>;
  bridge?: ProviderToolBridge;
  service?: MemorySearchService;
  runId: string;
  userId: string;
}): Promise<{ request: ProviderRunRequest; deliveredToolCallIds: string[] }> {
  if (!input.request.memorySearch) return { request: input.request, deliveredToolCallIds: [] };
  const calls = new Map([...input.calls].filter(call => call.toolName === MEMORY_SEARCH_TOOL_NAME)
    .map(call => [call.providerCallId, call]));
  const delivered = new Set<string>();
  const messages = [];
  for (const message of input.request.providerToolMessages ?? []) {
    const id = resultCallId(message);
    const persisted = id ? calls.get(id) : undefined;
    if (!persisted) { messages.push(message); continue; }
    if (!input.service || !input.bridge) throw new Error("memory_search_unavailable");
    const result = await input.service.revalidate({ id: persisted.providerCallId,
      name: MEMORY_SEARCH_TOOL_NAME, arguments: persisted.arguments as Record<string, unknown> }, {
      persistedToolCallId: persisted.id, request: input.request, runId: input.runId, userId: input.userId
    });
    messages.push(input.bridge.appendToolResult(undefined, result));
    if (result.status === "complete" && result.content.some(part => part.type === "json" &&
      record(part.value) && typeof part.value.evidence === "string" && part.value.evidence.length > 0)) {
      delivered.add(persisted.id);
    }
  }
  return { request: { ...input.request, previousProviderResponseId: undefined,
    providerToolMessages: messages }, deliveredToolCallIds: [...delivered] };
}
