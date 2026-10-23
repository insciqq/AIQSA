import { describe, expect, it, vi } from "vitest";
import type { McpRunPlanSnapshot } from "../mcp/runPlan";
import { mcpApprovalAdmission } from "../mcp/writeApproval";
import type { ProviderRunRequest } from "../providers/types";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { buildToolRegistry, engineMcpBindings, type EngineMcpBinding, type ToolRegistryInput } from "./toolRegistry";
import { READ_TOOL_RESULT_NAME } from "./toolResults";

const snapshot: McpRunPlanSnapshot = {
  servers: [{ fingerprint: "fp-1", revisionId: "rev-1", serverId: "jira", serverName: "Jira" }],
  tools: [
    { annotations: { readOnlyHint: true }, definitionHash: "a".repeat(64), description: "Read an issue", inputSchema: { type: "object" },
      name: "get_issue", namespacedName: "mcp_jira_get_issue", originalName: "get_issue", serverId: "jira", serverName: "Jira" },
    { definitionHash: "b".repeat(64), description: "Create an issue", inputSchema: { type: "object" },
      name: "create_issue", namespacedName: "mcp_jira_create_issue", originalName: "create_issue", serverId: "jira", serverName: "Jira" }
  ],
  version: 1
};

function request(extra: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [] },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "gpt-6-astra", params: {}, prompt: { developer: null, system: null }, provider: "codex", searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto", ...extra
  };
}

function input(extra: Partial<ToolRegistryInput> & { request: ProviderRunRequest }): ToolRegistryInput {
  return {
    chatId: "chat", followupTexts: () => [], mcpBindings: new Map<string, EngineMcpBinding>(), onEvent: vi.fn(async () => undefined),
    onUsage: vi.fn(), onWorkspaceActivity: vi.fn(async () => undefined), runId: "run", userId: "user",
    services: { repository: { createSearchRun: vi.fn() } as never, savedResults: { read: vi.fn(async () => null) } },
    ...extra
  };
}

describe("native tool registry", () => {
  it("always offers the saved-result reader", async () => {
    const registry = await buildToolRegistry(input({ request: request() }));
    expect(registry.definitions().map((tool) => tool.name)).toEqual([READ_TOOL_RESULT_NAME]);
    expect(registry.resolve(READ_TOOL_RESULT_NAME)?.effects).toBe("none");
  });

  it("declares MCP effects from annotations and asks approval only for a tool that may change data", async () => {
    const registry = await buildToolRegistry(input({
      mcpBindings: new Map([["jira", { fingerprint: "fp-1", mcpRunBindingId: "binding-1", runtimeGenerationId: "gen-1" }]]),
      request: request({ mcp: snapshot, mcpApproval: mcpApprovalAdmission([]) })
    }));
    const read = registry.resolve("mcp_jira_get_issue")!;
    const create = registry.resolve("mcp_jira_create_issue")!;
    expect(read.effects).toBe("none");
    expect(create.effects).toBe("external");
    const call = (name: string) => ({ arguments: { summary: "x" }, id: "c1", name });
    expect(read.approval?.(call(read.definition.name))).toBeUndefined();
    expect(create.approval?.(call(create.definition.name))).toMatchObject({ serverId: "jira", toolName: "mcp_jira_create_issue" });
    expect(create.links?.(call(create.definition.name))).toEqual({ mcpRunBindingId: "binding-1" });
    expect(create.activity(call(create.definition.name))).toMatchObject({ origin: "mcp", serverName: "Jira", toolName: "create_issue" });
  });

  it("asks no approval once the user always allows the server, and refuses a call without its runtime binding", async () => {
    const registry = await buildToolRegistry(input({ request: request({ mcp: snapshot, mcpApproval: mcpApprovalAdmission(["jira"]) }) }));
    const create = registry.resolve("mcp_jira_create_issue")!;
    expect(create.approval?.({ arguments: {}, id: "c1", name: create.definition.name })).toBeUndefined();
    expect(create.links?.({ arguments: {}, id: "c1", name: create.definition.name })).toBeNull();
  });

  it("sends an MCP call through the accepted runtime, starting it on demand", async () => {
    const callTool = vi.fn(async () => ({ isError: false, structuredContent: undefined, text: ["ISSUE-1"], unsupportedContentTypes: [] }));
    const ensureAcceptedGeneration = vi.fn(async () => true);
    const registry = await buildToolRegistry(input({
      mcpBindings: new Map([["jira", { fingerprint: "fp-1", mcpRunBindingId: "binding-1", runtimeGenerationId: "gen-1" }]]),
      request: request({ mcp: snapshot }),
      services: { mcpRuntime: () => ({ callTool, ensureAcceptedGeneration }) as never, repository: {} as never,
        savedResults: { read: vi.fn(async () => null) } }
    }));
    const result = await registry.resolve("mcp_jira_get_issue")!.execute({
      call: { arguments: { key: "A-1" }, id: "c1", name: "mcp_jira_get_issue" }, ordinal: 0, persistedToolCallId: "row-1", round: 1,
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({ status: "complete", content: [{ text: "ISSUE-1", type: "text" }] });
    expect(ensureAcceptedGeneration).toHaveBeenCalledWith("gen-1");
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ generationId: "gen-1", name: "get_issue" }));
  });

  it("registers Workspace tools as external effects bound to the run, without starting the VM", async () => {
    const coordinator = {
      accepts: () => true,
      execute: vi.fn(),
      tools: vi.fn(async () => [{ capability: "workspace" as const, description: "Run a command", inputSchema: { type: "object" },
        name: "workspace_shell" }])
    } as unknown as WorkspaceCoordinator;
    const registry = await buildToolRegistry(input({
      request: request({ workspace: { enabled: true } as ProviderRunRequest["workspace"] }),
      services: { repository: {} as never, savedResults: { read: vi.fn(async () => null) }, workspace: coordinator }
    }));
    const shell = registry.resolve("workspace_shell")!;
    expect(shell.effects).toBe("external");
    expect(shell.links?.({ arguments: {}, id: "c1", name: "workspace_shell" })).toEqual({ workspaceRunBindingId: "run" });
    expect(coordinator.execute).not.toHaveBeenCalled();
  });

  it("maps the run's accepted bindings to their rows by server", () => {
    expect(engineMcpBindings([{ fingerprint: "fp-1", runtimeGenerationId: "gen-1", serverId: "jira" },
      { fingerprint: "fp-2", runtimeGenerationId: "gen-2", serverId: "gitlab" }],
    [{ id: "binding-1", runtimeGenerationFingerprint: "fp-1", runtimeGenerationId: "gen-1" },
      { id: "binding-2", runtimeGenerationFingerprint: "fp-2", runtimeGenerationId: null }]))
      .toEqual(new Map([["jira", { fingerprint: "fp-1", mcpRunBindingId: "binding-1", runtimeGenerationId: "gen-1" }]]));
  });
});
