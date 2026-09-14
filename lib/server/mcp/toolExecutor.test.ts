import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithContext } from "../observability";
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
  afterEach(() => vi.restoreAllMocks());

  it("keeps concurrent result failures correlated without leaking tool payloads", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const run = (index: number) => runWithContext({ trace_id: String(index).repeat(32), run_id: `run-${index}`, tool_call_id: `stored-${index}`, execution_index: index }, async () => {
      const result = { isError: index === 1, structuredContent: { token: "PRIVATE_RESULT_CANARY" }, text: ["PRIVATE_TEXT_CANARY"], unsupportedContentTypes: [] };
      const callTool = vi.fn<McpToolRuntimeCall>(async (input) => { await input.beforeDispatch(); await Promise.resolve(); return result; });
      await expect(dispatchMcpTool({ arguments: { title: "PRIVATE_ARGUMENT_CANARY" }, assertCurrent: async () => {}, callTool,
        generationId: "PRIVATE_GENERATION_CANARY", route: { ...resolveMcpRunTool(snapshot, snapshot.tools[0]!.namespacedName)!, originalName: "PRIVATE_NAME_CANARY" }
      })).resolves.toBe(result);
      expect(callTool).toHaveBeenCalledOnce();
    });
    await Promise.all([run(1), run(2)]);
    const records = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(records.filter((entry) => entry.stage === "result")).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool_kind: "mcp", outcome: "failed", trace_id: "1".repeat(32), tool_call_id: "stored-1", execution_index: 1 }),
      expect.objectContaining({ tool_kind: "mcp", outcome: "completed", trace_id: "2".repeat(32), tool_call_id: "stored-2", execution_index: 2 })
    ]));
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

  it("retains the waiting call context when a separate Stop cancels admission", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const callTool = vi.fn<McpToolRuntimeCall>();
    const reason = new Error("PRIVATE_STOP_REASON_CANARY");
    const pending = runWithContext({ trace_id: "1".repeat(32), tool_call_id: "stored-call", execution_index: 4 }, () =>
      dispatchMcpTool({ arguments: {}, assertCurrent: () => gate, callTool, signal: controller.signal,
        generationId: "generation", route: resolveMcpRunTool(snapshot, snapshot.tools[0]!.namespacedName)! })).catch((error: unknown) => error);
    runWithContext({ trace_id: "2".repeat(32) }, () => controller.abort(reason));
    release();
    expect(await pending).toBe(reason);
    expect(callTool).not.toHaveBeenCalled();
    const records = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(records.filter((entry) => entry.event === "nested_abort")).toEqual([
      expect.objectContaining({ layer: "mcp", stage: "delivery", abort_source: "parent_signal", trace_id: "1".repeat(32), tool_call_id: "stored-call", execution_index: 4 })
    ]);
    expect(records).toContainEqual(expect.objectContaining({ stage: "admission", outcome: "cancelled" }));
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

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
