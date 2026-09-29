import { describe, expect, it, vi } from "vitest";
import { revalidateMemorySearchDispatch } from "./memorySearchDispatch";
import { fakeProviderToolBridge, openAIResponsesToolBridge, openRouterChatToolBridge,
  anthropicMessagesToolBridge, geminiInteractionsToolBridge } from "../tools/bridges";
import type { MemorySearchService } from "../memory/search/runtime";
import type { ProviderRunRequest } from "../providers/types";
import type { ToolExecutionResult } from "../tools/types";
import type { PersistedToolLoopCall } from "./toolLoopPersistence";

const call = { id: "private-call", providerCallId: "model-call", toolName: "memory_search",
  arguments: { query: "earlier note", comparison: false } } as unknown as PersistedToolLoopCall;
const result: ToolExecutionResult = { callId: "model-call", name: "memory_search", status: "complete",
  content: [{ type: "json", value: { version: "memory-search-v1", outcome: "results", evidence: "current safe evidence" } }] };

describe("Memory result disclosure", () => {
  it.each([fakeProviderToolBridge, openAIResponsesToolBridge, openRouterChatToolBridge,
    anthropicMessagesToolBridge, geminiInteractionsToolBridge])("revalidates the retained $provider result before dispatch", async bridge => {
    const revalidate = vi.fn(async () => result);
    const stale = { ...result, content: [{ type: "text" as const, text: "stale deleted evidence" }] };
    const request = { memorySearch: {}, providerToolMessages: [bridge.appendToolResult(undefined, stale)] } as ProviderRunRequest;
    const prepared = await revalidateMemorySearchDispatch({ request, calls: [call], bridge,
      service: { revalidate } as unknown as MemorySearchService, runId: "run", userId: "owner" });
    expect(prepared.request.providerToolMessages).toEqual([bridge.appendToolResult(undefined, result)]);
    expect(JSON.stringify(prepared.request)).not.toContain("stale deleted evidence");
    expect(prepared.deliveredToolCallIds).toEqual(["private-call"]);
    expect(revalidate).toHaveBeenCalledOnce();
  });

  it("does not mark removed, failed, or model-invented result identities as delivered", async () => {
    const bridge = fakeProviderToolBridge;
    const revalidate = vi.fn(async () => ({ ...result, status: "error" as const,
      content: [{ type: "json" as const, value: { outcome: "failure", evidence: null } }] }));
    const request = { memorySearch: {}, providerToolMessages: [
      { type: "fake_assistant_tool_calls", calls: [{ id: "model-call", name: "memory_search" }] },
      bridge.appendToolResult(undefined, result),
      bridge.appendToolResult(undefined, { ...result, callId: "unowned" })
    ] } as ProviderRunRequest;
    const output = await revalidateMemorySearchDispatch({ request, calls: [call], bridge,
      service: { revalidate } as unknown as MemorySearchService, runId: "run", userId: "owner" });
    expect(output.deliveredToolCallIds).toEqual([]);
    expect(revalidate).toHaveBeenCalledOnce();
    const removed = await revalidateMemorySearchDispatch({ request: { ...request, providerToolMessages: [] },
      calls: [call], bridge, service: { revalidate } as unknown as MemorySearchService, runId: "run", userId: "owner" });
    expect(removed.deliveredToolCallIds).toEqual([]);
    expect(revalidate).toHaveBeenCalledOnce();
  });
});
