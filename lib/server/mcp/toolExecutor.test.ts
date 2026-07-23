import { describe, expect, it } from "vitest";
import { mcpRunTools, mcpToolExecutionResult, resolveMcpRunTool } from "./toolExecutor";
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
