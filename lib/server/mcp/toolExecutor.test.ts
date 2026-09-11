import { describe, expect, it, vi } from "vitest";
import { dispatchMcpTool, mcpRunTools, mcpToolExecutionResult, resolveMcpRunTool, type McpToolRuntimeCall } from "./toolExecutor";
import type { McpRunPlanSnapshot } from "./runPlan";

const snapshot: McpRunPlanSnapshot = {
  servers: [{
    fingerprint: "fingerprint-1",
    revisionId: "revision-1",
    serverId: "server-1",
    serverName: "Tasks"
  }],
  tools: [{
    definitionHash: "a".repeat(64),
    description: null,
    inputSchema: { properties: { title: { type: "string" } }, type: "object" },
    name: "create_task",
    namespacedName: "mcp_tasks_create_task_123",
    originalName: "create_task",
    serverId: "server-1",
    serverName: "Tasks",
    title: "Create task"
  }],
  version: 1
};

describe("MCP run tool executor helpers", () => {
  it("blocks a revoked grant after asynchronous runtime preparation and never repeats dispatch", async () => {
    let granted = true;
    const effect = vi.fn();
    const assertCurrent = vi.fn(async () => { if (!granted) throw new Error("access_revoked"); });
    const callTool = vi.fn<McpToolRuntimeCall>(async (input) => {
      granted = false;
      await input.beforeDispatch();
      effect();
      return { isError: false, structuredContent: null, text: [], unsupportedContentTypes: [] };
    });
    await expect(dispatchMcpTool({ arguments: { title: "Ship" }, assertCurrent, callTool,
      generationId: "generation-1", route: resolveMcpRunTool(snapshot, snapshot.tools[0]!.namespacedName)!
    })).rejects.toThrow("access_revoked");
    expect(callTool).toHaveBeenCalledOnce();
    expect(effect).not.toHaveBeenCalled();
    granted = true;
    await expect(callTool.mock.calls[0]![0].beforeDispatch()).rejects.toThrow("mcp_call_already_dispatched");
  });

  it("rejects arguments before runtime dispatch and preserves a known upstream error without retry", async () => {
    const error = { isError: true, structuredContent: null, text: ["Operation refused"], unsupportedContentTypes: [] };
    const callTool = vi.fn<McpToolRuntimeCall>(async (input) => { await input.beforeDispatch(); return error; });
    const input = { assertCurrent: async () => {}, callTool, generationId: "generation-1",
      route: resolveMcpRunTool(snapshot, snapshot.tools[0]!.namespacedName)! };
    await expect(dispatchMcpTool({ ...input, arguments: { title: 12 } })).rejects.toThrow();
    expect(callTool).not.toHaveBeenCalled();
    await expect(dispatchMcpTool({ ...input, arguments: { title: "Ship" } })).resolves.toBe(error);
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("exposes only immutable namespaced snapshot tools and exact routes", () => {
    expect(mcpRunTools(snapshot)).toEqual([{
      capability: "mcp",
      description: "Create task",
      inputSchema: snapshot.tools[0]?.inputSchema,
      name: "mcp_tasks_create_task_123",
      strict: false
    }]);
    expect(resolveMcpRunTool(snapshot, "mcp_tasks_create_task_123")).toMatchObject({
      fingerprint: "fingerprint-1",
      originalName: "create_task",
      serverId: "server-1"
    });
    expect(resolveMcpRunTool(snapshot, "create_task")).toBeNull();
  });

  it("normalizes bounded MCP text/structured results without exposing runtime details", () => {
    expect(mcpToolExecutionResult({
      arguments: { title: "Ship" },
      id: "call-1",
      name: "mcp_tasks_create_task_123"
    }, {
      isError: false,
      structuredContent: { id: "task-1" },
      text: ["created"],
      unsupportedContentTypes: ["image"]
    })).toEqual({
      callId: "call-1",
      content: [
        { text: "created", type: "text" },
        { type: "json", value: { id: "task-1" } }
      ],
      name: "mcp_tasks_create_task_123",
      rawPreview: { isError: false, unsupportedContentTypes: ["image"] },
      status: "complete"
    });
  });
});
