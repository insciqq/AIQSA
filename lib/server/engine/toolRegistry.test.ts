import { describe, expect, it, vi } from "vitest";
import type { McpRunPlanSnapshot } from "../mcp/runPlan";
import { mcpApprovalAdmission } from "../mcp/writeApproval";
import type { ProviderRunRequest } from "../providers/types";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import {
  buildToolRegistry, engineMcpBindings, engineSnapshotMcpBindings, type EngineMcpBinding, type ToolRegistryInput
} from "./toolRegistry";
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
  it("always offers the saved-result reader, and the plan wherever tools are on", async () => {
    const registry = await buildToolRegistry(input({ request: request() }));
    expect(registry.definitions().map((tool) => tool.name)).toEqual([READ_TOOL_RESULT_NAME, "update_plan"]);
    expect(registry.resolve(READ_TOOL_RESULT_NAME)?.effects).toBe("none");
    const off = await buildToolRegistry(input({ request: request({ toolMode: "none" }) }));
    expect(off.definitions().map((tool) => tool.name)).toEqual([READ_TOOL_RESULT_NAME]);
  });

  it("keeps Memory search results within the run that searched", async () => {
    const memorySearch = { comparisonResultTokens: 12000, destinations: [], maxCalls: 3, memoryGeneration: 1, referenceChatHistory: true,
      resultTokens: 6000, timeoutSeconds: 30, version: "memory-search-v1" } as const;
    const registry = await buildToolRegistry(input({ request: request({ memorySearch }), services: {
      memorySearch: { execute: vi.fn() }, repository: { createSearchRun: vi.fn() } as never, savedResults: { read: vi.fn(async () => null) }
    } }));
    expect(registry.resolve("memory_search")).toMatchObject({ effects: "none", runScopedResult: true });
    expect(registry.resolve(READ_TOOL_RESULT_NAME)?.runScopedResult).toBeUndefined();
  });

  it("reports a write refused before it was sent as not sent, and leaves a failure after dispatch unknown to the batch", async () => {
    const mcpBindings = new Map([["jira", { fingerprint: "fp-1", mcpRunBindingId: "binding-1", runtimeGenerationId: "gen-1" }]]);
    const services = (runtime: unknown) => ({ mcpRuntime: (() => runtime) as never, repository: { createSearchRun: vi.fn() } as never,
      savedResults: { read: vi.fn(async () => null) } });
    const execution = { call: { arguments: { summary: "x" }, id: "c1", name: "mcp_jira_create_issue" }, ordinal: 0,
      persistedToolCallId: "row-1", round: 1, signal: new AbortController().signal };
    const refusing = await buildToolRegistry(input({ mcpBindings, request: request({ mcp: snapshot }),
      services: services({ callTool: vi.fn(), ensureAcceptedGeneration: async () => false }) }));
    await expect(refusing.resolve("mcp_jira_create_issue")!.execute(execution)).resolves.toMatchObject({ status: "error",
      content: [{ type: "json", value: { error: "mcp_runtime_unavailable", message: "Nothing was sent." } }] });
    const callTool = vi.fn(async (call: { beforeDispatch(): Promise<void> }) => {
      await call.beforeDispatch();
      throw new TypeError("fetch failed");
    });
    const failing = await buildToolRegistry(input({ mcpBindings, request: request({ mcp: snapshot }),
      services: services({ callTool, ensureAcceptedGeneration: async () => true }) }));
    await expect(failing.resolve("mcp_jira_create_issue")!.execute(execution)).rejects.toThrow("fetch failed");
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
    // A long result is saved bound to the accepted server, revision and runtime, which the store rechecks (issue #50).
    const result = { callId: "c1", content: [], name: create.definition.name, status: "complete" as const };
    expect(create.observationBinding?.(call(create.definition.name), result)).toEqual({ fingerprint: "fp-1",
      originalName: "create_issue", revisionId: "rev-1", serverId: "jira", source: "mcp", version: 1 });
  });

  it("asks no approval once the user always allows the server, and refuses a call without its runtime binding", async () => {
    const registry = await buildToolRegistry(input({ request: request({ mcp: snapshot, mcpApproval: mcpApprovalAdmission(["jira"]) }) }));
    const create = registry.resolve("mcp_jira_create_issue")!;
    expect(create.approval?.({ arguments: {}, id: "c1", name: create.definition.name })).toBeUndefined();
    expect(create.links?.({ arguments: {}, id: "c1", name: create.definition.name })).toBeNull();
    expect(create.observationBinding?.({ arguments: {}, id: "c1", name: create.definition.name },
      { callId: "c1", content: [], name: create.definition.name, status: "complete" })).toBeUndefined();
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

  it("offers direct view only where admission froze it, the same tool list every turn of a fixed model", async () => {
    const coordinator = { accepts: () => true, execute: vi.fn(), tools: vi.fn(async () => []) } as unknown as WorkspaceCoordinator;
    const workspace = { enabled: true, outputDirectory: "/workspace/output/run" } as ProviderRunRequest["workspace"];
    const captures = vi.fn(async () => { throw new Error("not_called"); });
    const registry = (extra: Partial<ProviderRunRequest>) => buildToolRegistry(input({ request: request({ workspace, ...extra }),
      services: { repository: {} as never, savedResults: { read: vi.fn(async () => null) }, workspace: coordinator,
        workspaceImageCaptures: captures } }));
    const direct = await registry({ workspaceImageView: true });
    expect(direct.resolve("view_workspace_image")).toMatchObject({ effects: "none", definition: { name: "view_workspace_image" } });
    expect(direct.resolve("view_workspace_image")!.activity({ arguments: {}, id: "c1", name: "view_workspace_image" }))
      .toMatchObject({ origin: "workspace", serverName: "Workspace" });
    expect(direct.images).toBeDefined();
    // Another turn of the same chat and model (its own input, an image of its own): byte-identical tools for the prompt cache.
    const later = await registry({ attachments: [{ byteSize: 4, dataUrl: "data:image/png;base64,AAAA", extractedText: null, fileName: "a.png",
      id: "a", kind: "image", metadata: {}, mimeType: "image/png", status: "ready" }], content: { blocks: [{ text: "Next", type: "text" }] },
    workspaceImageView: true });
    expect(JSON.stringify(later.definitions())).toBe(JSON.stringify(direct.definitions()));
    // Not admitted (vision unverified), or tools off: neither the tool nor held previews.
    for (const off of [await registry({}), await registry({ toolMode: "none", workspaceImageView: true })]) {
      expect(off.resolve("view_workspace_image")).toBeUndefined();
      expect(off.images).toBeUndefined();
    }
    expect(captures).not.toHaveBeenCalled();
  });

  it("maps the run's accepted bindings to their rows by server", () => {
    expect(engineMcpBindings([{ fingerprint: "fp-1", runtimeGenerationId: "gen-1", serverId: "jira" },
      { fingerprint: "fp-2", runtimeGenerationId: "gen-2", serverId: "gitlab" }],
    [{ id: "binding-1", runtimeGenerationFingerprint: "fp-1", runtimeGenerationId: "gen-1" },
      { id: "binding-2", runtimeGenerationFingerprint: "fp-2", runtimeGenerationId: null }]))
      .toEqual(new Map([["jira", { fingerprint: "fp-1", mcpRunBindingId: "binding-1", runtimeGenerationId: "gen-1" }]]));
  });

  it("binds the servers Auto loaded from the rows their discovery epoch wrote, matched by fingerprint", () => {
    const loaded: McpRunPlanSnapshot = { servers: [{ fingerprint: "fp-1", revisionId: "rev-1", serverId: "jira", serverName: "Jira" },
      { fingerprint: "fp-2", revisionId: "rev-2", serverId: "gitlab", serverName: "GitLab" },
      { fingerprint: "fp-3", revisionId: "rev-3", serverId: "wiki", serverName: "Wiki" }], tools: [], version: 1 };
    expect(engineSnapshotMcpBindings(loaded, [{ id: "binding-1", runtimeGenerationFingerprint: "fp-1", runtimeGenerationId: "gen-1" },
      { id: "binding-2", runtimeGenerationFingerprint: "fp-2", runtimeGenerationId: null }]))
      .toEqual(new Map([["jira", { fingerprint: "fp-1", mcpRunBindingId: "binding-1", runtimeGenerationId: "gen-1" }]]));
    expect(engineSnapshotMcpBindings(undefined, [])).toEqual(new Map());
  });

  it("keeps a Search result over the durable row bound whole, with its sources and usage settled", async () => {
    const findings = `${"Long verified finding. ".repeat(13_100)}TAIL_OF_FINDINGS`;
    expect(Buffer.byteLength(findings)).toBeGreaterThan(300_000);
    const searchOption = {
      adapterKind: "provider_model_client" as const,
      config: { maxResults: 8, queryMaxCharacters: 100, timeoutMs: 5_000 },
      credentialMode: "provider_model" as const, displayName: "Engine", executionModes: ["all_selected" as const],
      modelId: "engine-model", optionId: "engine", protocol: "openai_responses_web_search" as const, provider: "openai",
      providerModelId: "provider-model", revisionId: "revision", searchStrategyRowId: "integration"
    };
    const createSearchRun = vi.fn(async () => undefined);
    const onUsage = vi.fn();
    const registry = await buildToolRegistry(input({ onUsage, request: request({
      searchPlan: { mode: "all_selected", options: [searchOption] } as ProviderRunRequest["searchPlan"]
    }), services: {
      repository: { createSearchRun } as never, savedResults: { read: vi.fn(async () => null) },
      searchRuntimes: { engine: {
        adapter: { buildRequestPreview: () => ({}), async *stream() { throw new Error("unexpected_answer_dispatch"); } },
        responseTimeoutMs: 300_000,
        searchAdapter: { buildRequestPreview: () => ({}), search: async () => ({
          artifacts: [], findings, finalProviderResponsePreview: {}, requestPreview: {},
          sources: [{ rank: 1, title: "Source", url: "https://example.com/source" }],
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
        }) }
      } }
    } }));
    const search = registry.resolve("search_selected_engines")!;
    const execution = { call: { arguments: { query: "long query" }, id: "c1", name: "search_selected_engines" }, ordinal: 0,
      persistedToolCallId: "row-1", round: 1, signal: new AbortController().signal };
    const result = await search.execute(execution);
    expect(result.status).toBe("complete");
    expect(JSON.stringify(result.content)).toContain("TAIL_OF_FINDINGS");
    expect(JSON.stringify(result.content)).not.toContain("search_result_too_large");
    await search.settled!(execution, result);
    expect(createSearchRun).toHaveBeenCalledWith(expect.objectContaining({ status: "complete",
      artifacts: { sources: [expect.objectContaining({ url: "https://example.com/source" })] } }));
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: "web_search",
      usage: expect.objectContaining({ inputTokens: 2, outputTokens: 3 }) }));
  });
});
