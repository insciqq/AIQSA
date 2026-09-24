import { syntheticImagePlan } from "@/tests/support/imagePlan";
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
import { CODEX_VERSION } from "./codexProfile";
import * as observability from "../observability";
import { prisma } from "../prisma";
import { memoryToolObservations } from "@/tests/support/toolObservations";
import type { ToolExecutionResult } from "../tools/types";

// Text-result contract from the pinned consumer's CallToolResult conversion:
// https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/models.rs#L2129
// Non-null structured content takes precedence over all ordinary text items.
// Pin this harness so an SDK upgrade requires reviewing the actual consumer.
function codexModelOutput(result: {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}) {
  expect(CODEX_VERSION).toBe("0.154.0");
  return {
    body: result.structuredContent != null ? JSON.stringify(result.structuredContent)
      : result.content.map(({ text }) => text ?? "").join("\n"),
    success: !result.isError
  };
}

async function rpcResult(response: Response) {
  const text = await response.text();
  return JSON.parse(text.startsWith("event:") ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text).result;
}

vi.mock("../prisma", () => ({ prisma: { agentMcpTool: { findUnique: vi.fn() } } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("Agent MCP discovery surface", () => {
  it.each(["auto", "all"] as const)("recalls an externalized %s result through a fresh MCP-Off gateway and reauthorizes repeated reads", async mcpMode => {
    const observations = memoryToolObservations();
    const toolId = "fixture_records", toolVersion = "a".repeat(64);
    const snapshot = { version: 1, servers: [{ serverId: "fixture", revisionId: "revision", fingerprint: "b".repeat(64) }],
      tools: [{ serverId: "fixture", namespacedName: toolId, originalName: "records", definitionHash: "c".repeat(64), inputSchema: { type: "object" } }] };
    vi.spyOn(prisma.agentMcpTool, "findUnique").mockResolvedValue({ snapshot } as never);
    const dispatch = vi.fn(async () => ({ text: ["x".repeat(320 * 1024) + "rare_tail=271828"],
      isError: false, unsupportedContentTypes: [] }));
    vi.spyOn(hub, "createMcpToolService").mockReturnValue({ prepareToolCall: async () => ({}),
      dispatchPreparedToolCall: dispatch } as unknown as ReturnType<typeof hub.createMcpToolService>);
    let cached: ToolExecutionResult | undefined;
    const store = { mcpTools: async () => [{ toolId, version: toolVersion }], admitMcpPlan: async () => {},
      toolCall: async () => "business-call", settleTool: vi.fn(),
      claimBuiltinTool: async () => ({ id: "reader-call", claimed: !cached, result: cached }),
      settleBuiltinTool: async (_id: string, result: ToolExecutionResult) => { cached ??= result; }
    } as unknown as ReturnType<typeof createAgentRunStore>;
    const gateway = (mode: "off" | "auto" | "all") => createAgentMcpGateway({
      request: { agent: { mcpMode: mode }, searchPlan: { mode: "all_selected", options: [] }, mcp: snapshot,
        toolObservationVersion: 1 } as unknown as NormalizedRunRequest,
      observations: observations.service(), store, runId: "run", userId: "user",
      signal: new AbortController().signal, onFailure: vi.fn(), onUsage: vi.fn() });
    const rpc = (name: string, args: Record<string, unknown>) => new Request("http://agent.invalid/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const handler = await gateway(mcpMode);
    const initial = await rpcResult(await handler(mcpMode === "auto"
      ? rpc("call_tool", { tool_id: toolId, tool_version: toolVersion, arguments: {} }) : rpc(toolId, {})));
    expect(initial.isError).not.toBe(true);
    const projected = codexModelOutput(initial).body;
    expect(Buffer.byteLength(projected)).toBeLessThan(10 * 1024);
    expect(projected).not.toContain("rare_tail");
    const { observation } = JSON.parse(projected);
    expect(observation.byteSize).toBeGreaterThan(320 * 1024);
    const restarted = await gateway("off");
    const readArgs = { handle: observation.handle, query: "rare_tail", maxBytes: 128 };
    const recalled = await rpcResult(await restarted(rpc("read_tool_result", readArgs)));
    expect(recalled.isError).not.toBe(true);
    expect(codexModelOutput(recalled).body).toContain("rare_tail=271828");
    observations.revoke();
    const denied = await rpcResult(await restarted(rpc("read_tool_result", readArgs)));
    expect(denied.isError).toBe(true);
    expect(codexModelOutput(denied).body).not.toContain("rare_tail=271828");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(observations.rows.size).toBe(1);
  });

  it.each(["missing", "version", "tool_unavailable", "tool_definition_changed", "upstream_unavailable", "execution_outcome_unknown"] as const)(
    "distinguishes %s from a dispatched unknown outcome in both consumer formats", async kind => {
      const version = "a".repeat(64), toolId = "arbitrary_delta";
      const prepare = vi.fn(async () => {
        if (["tool_unavailable", "tool_definition_changed", "upstream_unavailable"].includes(kind)) throw new hub.McpHubServiceError(kind as hub.McpHubServiceErrorCode);
        return {};
      });
      const dispatch = vi.fn(async ({ onDispatch }: { onDispatch(): void }) => {
        onDispatch();
        throw new hub.McpHubServiceError("execution_outcome_unknown");
      });
      vi.spyOn(hub, "createMcpToolService").mockReturnValue({ prepareToolCall: prepare,
        dispatchPreparedToolCall: dispatch } as unknown as ReturnType<typeof hub.createMcpToolService>);
      const logs: { context: unknown; fields: unknown }[] = [];
      vi.spyOn(observability, "logEvent").mockImplementation((_event, fields) => {
        logs.push({ context: observability.getContext(), fields });
      });
      const store = { mcpTools: async () => kind === "missing" ? [] : [{ toolId, version }],
        toolCall: async () => "attempt", settleTool: vi.fn(async () => {}) } as unknown as ReturnType<typeof createAgentRunStore>;
      const handler = await createAgentMcpGateway({ request: { agent: { mcpMode: "auto" },
        searchPlan: { options: [] } } as unknown as NormalizedRunRequest, store, runId: "run", userId: "user",
        signal: new AbortController().signal, onFailure: vi.fn(), onUsage: vi.fn() });
      const response = await handler(new Request("http://agent.invalid/mcp", { method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "call_tool",
          arguments: { tool_id: toolId, tool_version: kind === "version" ? "b".repeat(64) : version,
            arguments: { canary: "PRIVATE_ARGUMENT" } } } }) }));
      const result = await rpcResult(response);
      expect(codexModelOutput(result).body).toMatch(/^\{/u);
      const value = JSON.parse(codexModelOutput(result).body);
      expect(value.code).toBe(kind === "missing" ? "tool_unavailable" : kind === "version" ? "tool_definition_changed" : kind);
      if (kind === "execution_outcome_unknown") {
        expect(value.message).toContain("outcome is unknown");
        expect(value.dispatched).not.toBe(false);
        expect(dispatch).toHaveBeenCalledOnce();
      } else {
        expect(value).toMatchObject({ dispatched: false, recovery: "find_tools" });
        expect(JSON.parse(result.content[0].text)).toEqual(value);
        expect(value.message).toContain("No external tool call was sent");
        expect(value.message).not.toMatch(/interrupted|unknown outcome/u);
        expect(dispatch).not.toHaveBeenCalled();
        if (kind === "missing") expect(value.reason).toBe("discovery_required");
      }
      expect(logs).toContainEqual({ context: expect.objectContaining({ run_id: "run", tool_call_id: "attempt" }),
        fields: expect.objectContaining({ code: value.code, stage: kind === "execution_outcome_unknown" ? "result" : "admission" }) });
      expect(JSON.stringify(logs)).not.toContain("PRIVATE_ARGUMENT");
    });

  it("uses an admission discovered through another gateway handler", async () => {
    const toolId = "arbitrary_delta", version = "a".repeat(64);
    const admitted: { toolId: string; version: string }[] = [];
    const dispatch = vi.fn(async () => ({ text: ["done"], isError: false }));
    vi.spyOn(hub, "createMcpToolService").mockReturnValue({ prepareToolCall: async () => ({}),
      dispatchPreparedToolCall: dispatch } as unknown as ReturnType<typeof hub.createMcpToolService>);
    const store = { mcpTools: async () => [...admitted], toolCall: async () => "call", settleTool: vi.fn() } as unknown as ReturnType<typeof createAgentRunStore>;
    const handler = await createAgentMcpGateway({ request: { agent: { mcpMode: "auto" }, searchPlan: { options: [] } } as unknown as NormalizedRunRequest,
      store, runId: "run", userId: "user", signal: new AbortController().signal, onFailure: vi.fn(), onUsage: vi.fn() });
    admitted.push({ toolId, version });
    const response = await handler(new Request("http://agent.invalid/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "call_tool",
        arguments: { tool_id: toolId, tool_version: version, arguments: {} } } }) }));
    expect((await rpcResult(response)).isError).not.toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it.each(["off", "auto", "all"] as const)("exposes frozen built-in artifacts and images with external MCP %s", async mcpMode => {
    const store = { mcpTools: async () => [], admitMcpPlan: async () => {} } as unknown as ReturnType<typeof createAgentRunStore>;
    const request = { artifactTool: true, artifactToolDescription: "Frozen admitted artifact contract", imagePlan: syntheticImagePlan(),
      agent: { mcpMode }, searchPlan: { mode: "all_selected", options: [] }, mcp: { tools: [], servers: [], version: 1 } } as unknown as NormalizedRunRequest;
    const handler = await createAgentMcpGateway({ request, store, runId: "run", userId: "user",
      signal: new AbortController().signal, onFailure: vi.fn(), onUsage: vi.fn() });
    const response = await handler(new Request("http://agent.invalid/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
    const text = await response.text();
    const body = JSON.parse(text.startsWith("event:") ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text);
    expect(body.result.tools.map((tool: { name: string }) => tool.name).sort())
      .toEqual(mcpMode === "auto" ? ["call_tool", "create_artifact", "find_tools", "generate_image", "read_artifact"] : ["create_artifact", "generate_image", "read_artifact"]);
    expect(body.result.tools.find((tool: { name: string }) => tool.name === "create_artifact").description).toBe(request.artifactToolDescription);
  });
  it.each([false, true])("uses the shared request envelope and safely reports an over-limit body (%s)", async lowerLimit => {
    if (lowerLimit) vi.stubEnv("AIQSA_MCP_REQUEST_MAX_BYTES", "1048576");
    const prepare = vi.fn(async () => ({}));
    const dispatch = vi.fn(async () => ({ text: ["done"], isError: false }));
    vi.spyOn(hub, "createMcpToolService").mockReturnValue({ prepareToolCall: prepare, dispatchPreparedToolCall: dispatch } as unknown as ReturnType<typeof hub.createMcpToolService>);
    const toolId = "fixture_write", toolVersion = "a".repeat(64);
    const store = { mcpTools: async () => [{ toolId, version: toolVersion }], toolCall: async () => "call",
      settleTool: vi.fn() } as unknown as ReturnType<typeof createAgentRunStore>;
    const handler = await createAgentMcpGateway({ request: { agent: { mcpMode: "auto" }, searchPlan: { mode: "all_selected", options: [] } } as unknown as NormalizedRunRequest, store, runId: "run", userId: "user", signal: new AbortController().signal,
      onFailure: vi.fn(), onUsage: vi.fn() });
    const payload = "x".repeat(2 * 1024 * 1024) + "PRIVATE_ARGUMENT_TAIL";
    const response = await handler(new Request("http://agent.invalid/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "call_tool",
        arguments: { tool_id: toolId, tool_version: toolVersion, arguments: { document: payload } } } }) }));
    expect(response.status).toBe(lowerLimit ? 413 : 200);
    if (lowerLimit) {
      const failure = await response.json();
      expect(failure).toMatchObject({ code: "mcp_request_too_large", maxBytes: 1048576 });
      expect(Number(failure.observedBytes)).toBeGreaterThan(1048576);
      expect(JSON.stringify(failure)).not.toContain("PRIVATE_ARGUMENT_TAIL");
      expect(prepare).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ arguments: { document: payload } }));
      expect(dispatch).toHaveBeenCalledOnce();
    }
  });

  it.each(["auto", "all"] as const)("preserves model-facing errors and structured successes in %s mode", async (mcpMode) => {
    const message = "Validation error: Provide either url, or project_id, file_path, and ref PRIVATE_TOOL_PATH";
    expect(codexModelOutput({ content: [{ type: "text", text: message }], structuredContent: {}, isError: true }))
      .toEqual({ body: "{}", success: false });
    for (const isError of [true, false]) for (const structuredContent of [undefined, {}, { code: "missing_project", detail: "PRIVATE_STRUCTURED_DETAIL" }]) {
      for (const text of [[message], [], ...(structuredContent ? [[JSON.stringify(structuredContent)], [message, JSON.stringify(structuredContent, null, 2), "unique after"]] : [])]) {
        const dispatch = vi.fn(async () => ({ text, structuredContent, isError }));
        vi.spyOn(hub, "createMcpToolService").mockReturnValue({
          prepareToolCall: async () => ({}), dispatchPreparedToolCall: dispatch
        } as unknown as ReturnType<typeof hub.createMcpToolService>);
        const settleTool = vi.fn(async () => {}), onFailure = vi.fn();
        const toolId = "fixture_read", toolVersion = "a".repeat(64);
        const store = { mcpTools: async () => [{ toolId, version: toolVersion }],
          admitMcpPlan: async () => {}, toolCall: async () => "call", settleTool } as unknown as ReturnType<typeof createAgentRunStore>;
        const request = { agent: { mcpMode }, searchPlan: { mode: "all_selected", options: [] }, mcp: {
          version: 1, servers: [{ serverId: "fixture", fingerprint: "b".repeat(64) }], tools: [{
            serverId: "fixture", namespacedName: toolId, originalName: "read", definitionHash: "c".repeat(64), inputSchema: { type: "object" }
          }]
        } } as unknown as NormalizedRunRequest;
        const handler = await createAgentMcpGateway({ request, store, runId: "run", userId: "user",
          signal: new AbortController().signal, onFailure, onUsage: async () => {} });
        const response = await handler(new Request("http://agent.invalid/mcp", { method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: mcpMode === "auto"
            ? { name: "call_tool", arguments: { tool_id: toolId, tool_version: toolVersion, arguments: {} } }
            : { name: toolId, arguments: {} } }) }));
        const responseText = await response.text();
        const body = JSON.parse(responseText.startsWith("event:") ? responseText.split("\n").find(line => line.startsWith("data: "))!.slice(6) : responseText);
        const output = codexModelOutput(body.result);
        expect(output.success).toBe(!isError);
        if (text.includes(message)) expect(output.body).toContain(message);
        if (text.includes("unique after")) expect(output.body).toContain("unique after");
        if (structuredContent) {
          const uniqueText = text.filter(value => value === message || value === "unique after");
          expect(body.result).toMatchObject(uniqueText.length
            ? { content: [...uniqueText, JSON.stringify(structuredContent)].map(text => ({ type: "text", text })) }
            : { content: [], structuredContent });
          if (uniqueText.length) expect(body.result.structuredContent).toBeUndefined();
        }
        if (structuredContent && Object.keys(structuredContent).length) {
          expect(output.body).toContain("missing_project");
          expect(output.body).toContain("PRIVATE_STRUCTURED_DETAIL");
          if (!text.length) expect(JSON.parse(output.body)).toEqual(structuredContent);
        }
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(settleTool).toHaveBeenCalledWith("call", isError ? "error" : "complete", { status: isError ? "error" : "complete" });
        expect(JSON.stringify(settleTool.mock.calls)).not.toContain("PRIVATE_");
        expect(onFailure).not.toHaveBeenCalled();
        const decoder = new CodexJsonlDecoder();
        const events = decoder.push(Buffer.from([
          { type: "thread.started", thread_id: "fixture_thread" }, { type: "turn.started" },
          { type: "item.completed", item: {
          id: "call", type: "mcp_tool_call", tool: toolId, status: isError ? "failed" : "completed", result: body.result
        } }].map((item) => JSON.stringify(item)).join("\n") + "\n"));
        expect(JSON.stringify(events)).not.toContain("PRIVATE_");
        expect(events).toContainEqual(expect.objectContaining({ type: "activity", phase: isError ? "failed" : "succeeded" }));
      }
    }
  });

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
