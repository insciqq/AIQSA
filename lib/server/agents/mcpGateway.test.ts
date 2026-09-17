// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hub from "../mcp/hubService";
import { McpSemanticRouterError } from "../mcp/router";
import type { NormalizedRunRequest } from "../providers/types";
import type { createAgentRunStore } from "./store";
import { createAgentMcpGateway } from "./mcpGateway";
import { AgentExecutionError, agentFailureCode, agentFailureMessage } from "./failures";
import { McpClientSessionError } from "../mcp/clientSession";
import { CodexJsonlDecoder, type CodexEvent } from "./codexProtocol";
import { AgentExecutionOutput } from "./executionOutput";

vi.mock("../prisma", () => ({ prisma: {} }));
afterEach(() => vi.restoreAllMocks());
describe("Agent MCP discovery surface", () => {
  it("delivers a multi-megabyte tool response through the gateway and Codex activity transport", async () => {
    const text = "x".repeat(5 * 1024 * 1024) + "PRIVATE_TOOL_TAIL";
    vi.spyOn(hub, "createMcpToolService").mockReturnValue({
      prepareToolCall: async () => ({}),
      dispatchPreparedToolCall: async () => ({ text: [text], isError: false })
    } as unknown as ReturnType<typeof hub.createMcpToolService>);
    const settleTool = vi.fn(async () => {}), onFailure = vi.fn();
    const toolId = "fixture_read", toolVersion = "a".repeat(64);
    const store = { mcpTools: async () => [{ toolId, version: toolVersion }], toolCall: async () => "call", settleTool } as unknown as ReturnType<typeof createAgentRunStore>;
    const request = { agent: { mcpMode: "auto" }, searchPlan: { mode: "all_selected", options: [] } } as unknown as NormalizedRunRequest;
    const handler = await createAgentMcpGateway({ request, store, runId: "run", userId: "user",
      signal: new AbortController().signal, onFailure, onUsage: async () => {} });
    const response = await handler(new Request("http://agent.invalid/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "call_tool", arguments: { tool_id: toolId, tool_version: toolVersion, arguments: {} } } }) }));
    expect(response.status).toBe(200);
    const responseText = await response.text();
    const body = JSON.parse(responseText.startsWith("event:") ? responseText.split("\n").find(line => line.startsWith("data: "))!.slice(6) : responseText);
    expect(body.result.content[0].text.length).toBe(text.length);
    expect(body.result.content[0].text.endsWith("PRIVATE_TOOL_TAIL")).toBe(true);
    expect(settleTool).toHaveBeenCalledWith("call", "complete", { status: "complete" });
    expect(onFailure).not.toHaveBeenCalled();

    const output = new AgentExecutionOutput(), decoder = new CodexJsonlDecoder();
    output.stdout(Buffer.from([
      { type: "thread.started", thread_id: "fixture_thread" }, { type: "turn.started" },
      { type: "item.completed", item: { id: "call", type: "mcp_tool_call", tool: "call_tool", status: "completed", result: body.result } },
      { type: "turn.completed" }
    ].map(value => JSON.stringify(value)).join("\n") + "\n"));
    output.end(0);
    const events: CodexEvent[] = [];
    let cursor = 0;
    for (;;) {
      const page = output.poll(cursor);
      events.push(...decoder.push(Buffer.from(page.stdoutBase64, "base64")));
      cursor = page.nextCursor;
      if (page.done) { events.push(...decoder.finish(page.exitCode)); break; }
    }
    expect(events).toContainEqual({ type: "activity", id: "call", kind: "mcp", phase: "succeeded", tool: "call_tool" });
    expect(events.at(-1)).toEqual({ type: "turn_completed" });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_TOOL_TAIL");
  });

  it.each(["result_unsupported", "agent_mcp_outcome_unknown"] as const)("explains %s without confusing a rejected response with an unknown action", async (code) => {
    const failure = code === "result_unsupported" ? new hub.McpHubServiceError(code, {
      cause: new McpClientSessionError({ code: "mcp_call_result_too_large", operation: "call_tool" })
    }) : new AgentExecutionError(code);
    vi.spyOn(hub, "createMcpToolService").mockReturnValue({
      prepareToolCall: async () => ({}), dispatchPreparedToolCall: async () => { throw failure; }
    } as unknown as ReturnType<typeof hub.createMcpToolService>);
    const settleTool = vi.fn(async () => {}), onFailure = vi.fn();
    const toolId = "fixture_read", toolVersion = "a".repeat(64);
    const store = { mcpTools: async () => [{ toolId, version: toolVersion }], toolCall: async () => "call", settleTool } as unknown as ReturnType<typeof createAgentRunStore>;
    const request = { agent: { mcpMode: "auto" }, searchPlan: { mode: "all_selected", options: [] } } as unknown as NormalizedRunRequest;
    const handler = await createAgentMcpGateway({ request, store, runId: "run", userId: "user",
      signal: new AbortController().signal, onFailure, onUsage: async () => {} });
    const response = await handler(new Request("http://agent.invalid/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "call_tool", arguments: { tool_id: toolId, tool_version: toolVersion, arguments: {} } } }) }));
    const text = await response.text();
    const body = JSON.parse(text.startsWith("event:") ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text);
    expect(body.result.isError).toBe(true);
    const value = JSON.parse(body.result.content[0].text);
    expect(value.code).toBe(code);
    expect(settleTool).toHaveBeenCalledWith("call", "error", { code, ...(code === "result_unsupported" ? { toolFailure: "mcp_call_result_too_large" } : {}) });
    if (code === "result_unsupported") {
      expect(value.toolFailure).toBe("mcp_call_result_too_large");
      expect(value.message).toContain("MCP tool response exceeded its size limit.");
      expect(body.result.structuredContent.toolFailure).toBe("mcp_call_result_too_large");
      expect(value.message).toContain("request fewer records or fields");
      expect(onFailure).not.toHaveBeenCalled();
    } else {
      expect(agentFailureCode(code)).toBe(code);
      expect(value.message).toBe(agentFailureMessage(code));
      expect(onFailure).toHaveBeenCalledWith(code);
    }
  });

  it("delivers and persists the exact discovery cause without claiming an unknown business outcome", async () => {
    const failure = new hub.McpHubServiceError("discovery_unavailable", {
      cause: new McpSemanticRouterError("mcp_router_output_invalid", null, "mcp_router_unknown_tool", 2)
    });
    vi.spyOn(hub, "createMcpToolService").mockReturnValue({ findTools: async () => { throw failure; } } as unknown as ReturnType<typeof hub.createMcpToolService>);
    const settleTool = vi.fn(async () => {});
    const store = { mcpTools: async () => [], toolCall: async () => "call", settleTool } as unknown as ReturnType<typeof createAgentRunStore>;
    const request = { agent: { mcpMode: "auto" }, searchPlan: { mode: "all_selected", options: [] } } as unknown as NormalizedRunRequest;
    const onFailure = vi.fn();
    const handler = await createAgentMcpGateway({ request, store, runId: "run", userId: "user",
      signal: new AbortController().signal, onFailure, onUsage: async () => {} });
    const response = await handler(new Request("http://agent.invalid/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_tools", arguments: { goal: "Read a record" } } }) }));
    const responseText = await response.text();
    const body = JSON.parse(responseText.startsWith("event:") ? responseText.split("\n").find(line => line.startsWith("data: "))!.slice(6) : responseText);
    expect(body.result.isError).toBe(true);
    const value = body.result.structuredContent;
    expect(value.discoveryFailure).toEqual({ reason: "mcp_router_output_invalid", detail: "mcp_router_unknown_tool", attempt: 2 });
    expect(value.message).toContain("No connected tool was called");
    expect(value.message).toContain("does not establish an authorization failure");
    expect(settleTool).toHaveBeenCalledWith("call", "error", { code: "discovery_unavailable", discoveryFailure: value.discoveryFailure });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it.each(["off", "auto", "all"] as const)("exposes selected Search immediately in MCP %s without loading external tools in Auto", async (mcpMode) => {
    const store = { mcpTools: async () => [], admitMcpPlan: async () => {} } as unknown as ReturnType<typeof createAgentRunStore>;
    const request = { agent: { mcpMode }, searchPlan: { mode: "all_selected", options: [{
      adapterKind: "provider_model_client", config: {}, optionId: "selected", displayName: "Selected source"
    }] }, mcp: { tools: [], servers: [], version: 1 } } as unknown as NormalizedRunRequest;
    const handler = await createAgentMcpGateway({ request, store, runId: "run", userId: "user",
      signal: new AbortController().signal, onFailure: async () => {}, onUsage: async () => {} });
    const response = await handler(new Request("http://agent.invalid/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text.startsWith("event:") ? text.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : text);
    expect(body.result.tools.map((tool: { name: string }) => tool.name).sort())
      .toEqual(mcpMode === "auto" ? ["aiqsa_search", "call_tool", "find_tools"] : ["aiqsa_search"]);
  });
});
