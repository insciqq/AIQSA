import { describe, expect, it, vi } from "vitest";
import { namespacedMcpToolName, type McpCapabilityCatalog, type McpRunPlanResult } from "./runPlan";
import { createMcpHubService, McpHubServiceError, type McpHubServiceDependencies } from "./hubService";

const echoId = namespacedMcpToolName("example", "echo");
const otherId = namespacedMcpToolName("other", "lookup");

function catalog(toolIds: readonly string[] = [echoId]): McpCapabilityCatalog {
  const definitions = [{
    description: "Echo a value",
    namespacedName: echoId,
    originalName: "echo",
    revisionId: "revision-example",
    serverId: "server-example",
    serverName: "Example"
  }, {
    description: "Look up a value",
    namespacedName: otherId,
    originalName: "lookup",
    revisionId: "revision-other",
    serverId: "server-other",
    serverName: "Other"
  }];
  return {
    servers: definitions.filter(({ namespacedName }) => toolIds.includes(namespacedName)).map((tool) => ({
      description: `${tool.serverName} integration`,
      namespace: tool.serverName.toLowerCase(),
      revisionId: tool.revisionId,
      serverId: tool.serverId,
      serverName: tool.serverName,
      tools: [{
        arguments: [{ description: null, name: "value", types: ["string"] }],
        description: tool.description,
        namespacedName: tool.namespacedName,
        originalName: tool.originalName
      }]
    })),
    version: 1
  };
}

function materialized(
  toolId: string,
  generationId = `generation-${toolId}`,
  fingerprint = `fingerprint-${toolId}`,
  definitionHash = "a".repeat(64)
): Extract<McpRunPlanResult, { ok: true }> {
  const selected = catalog([toolId]).servers[0]!;
  const tool = selected.tools[0]!;
  return {
    bindings: [{ fingerprint, runtimeGenerationId: generationId, serverId: selected.serverId }],
    ok: true,
    snapshot: {
      servers: [{
        fingerprint,
        revisionId: selected.revisionId,
        serverId: selected.serverId,
        serverName: selected.serverName
      }],
      tools: [{
        definitionHash,
        description: tool.description,
        inputSchema: {
          additionalProperties: false,
          properties: { value: { type: "string" } },
          required: ["value"],
          type: "object"
        },
        name: tool.originalName,
        namespacedName: tool.namespacedName,
        originalName: tool.originalName,
        serverId: selected.serverId,
        serverName: selected.serverName
      }],
      version: 1
    }
  };
}

function fixture(overrides: Partial<McpHubServiceDependencies> = {}) {
  const dependencies: McpHubServiceDependencies = {
    callRuntimeTool: vi.fn(async () => ({
      isError: false,
      structuredContent: { echoed: true },
      text: ["ok"],
      unsupportedContentTypes: []
    })),
    catalog: vi.fn(async () => catalog()),
    filterTools: vi.fn(async (_userId, tools) => [...tools]),
    materialize: vi.fn(async (_userId, tools) => materialized(tools[0]!.namespacedName)),
    router: {
      route: vi.fn(async ({ catalog: allowedCatalog }) => ({
        toolNames: allowedCatalog.servers.flatMap((server: McpCapabilityCatalog["servers"][number]) =>
          server.tools.map((tool: McpCapabilityCatalog["servers"][number]["tools"][number]) => tool.namespacedName)),
        usageAttribution: null
      }))
    },
    ...overrides
  };
  return { dependencies, service: createMcpHubService(dependencies) };
}

describe("MCP Hub shared discovery and dispatch", () => {
  it("returns an empty result without invoking the System Model or runtime", async () => {
    const test = fixture({ catalog: vi.fn(async () => catalog([])) });

    await expect(test.service.findTools({ goal: "find records", userId: "user-1" }))
      .resolves.toEqual({
        incomplete: false,
        message: "No matching enabled MCP tools were found.",
        schema_version: 1,
        tools: []
      });
    expect(test.dependencies.router.route).not.toHaveBeenCalled();
    expect(test.dependencies.materialize).not.toHaveBeenCalled();
  });

  it("returns full versioned schemas for ready matches and marks a partial runtime result", async () => {
    const test = fixture({
      catalog: vi.fn(async () => catalog([echoId, otherId])),
      materialize: vi.fn(async (_userId, tools) => {
        if (tools[0]!.namespacedName === otherId) throw new Error("runtime unavailable");
        return materialized(echoId);
      })
    });

    const result = await test.service.findTools({ goal: "read and echo records", userId: "user-1" });

    expect(result).toMatchObject({
      incomplete: true,
      schema_version: 1,
      tools: [{
        input_schema: expect.objectContaining({ required: ["value"] }),
        name: "echo",
        server_name: "Example",
        tool_id: echoId,
        tool_version: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }]
    });
    expect(test.dependencies.materialize).toHaveBeenCalledTimes(2);
  });

  it("keeps descriptor versions across a cold-start generation change and changes them with definition authority", async () => {
    let generation = "generation-before-restart";
    let fingerprint = "effective-config-1";
    let definitionHash = "a".repeat(64);
    const test = fixture({
      materialize: vi.fn(async (_userId, tools) =>
        materialized(tools[0]!.namespacedName, generation, fingerprint, definitionHash))
    });
    const first = (await test.service.findTools({ goal: "echo", userId: "user-1" })).tools[0]!;
    generation = "generation-after-restart";
    const afterRestart = await test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: first.tool_version, userId: "user-1"
    });
    expect(afterRestart.descriptor.tool_version).toBe(first.tool_version);

    fingerprint = "effective-config-2";
    await expect(test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: first.tool_version, userId: "user-1"
    })).rejects.toMatchObject({ code: "tool_definition_changed" });

    fingerprint = "effective-config-1";
    definitionHash = "b".repeat(64);
    await expect(test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: first.tool_version, userId: "user-1"
    })).rejects.toMatchObject({ code: "tool_definition_changed" });
  });

  it("validates arguments before the durable-dispatch hook or business call", async () => {
    const test = fixture();
    const descriptor = (await test.service.findTools({ goal: "echo", userId: "user-1" })).tools[0]!;

    await expect(test.service.prepareToolCall({
      arguments: {}, toolId: echoId, toolVersion: descriptor.tool_version, userId: "user-1"
    })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(test.dependencies.callRuntimeTool).not.toHaveBeenCalled();
  });

  it("revalidates current catalog and tool policy before marking dispatch", async () => {
    let available = true;
    const beforeDispatch = vi.fn(async () => undefined);
    const test = fixture({ catalog: vi.fn(async () => catalog(available ? [echoId] : [])) });
    const descriptor = (await test.service.findTools({ goal: "echo", userId: "user-1" })).tools[0]!;
    const prepared = await test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version, userId: "user-1"
    });
    available = false;

    await expect(test.service.dispatchPreparedToolCall({
      beforeDispatch, prepared, userId: "user-1"
    })).rejects.toMatchObject({ code: "tool_unavailable" });
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(test.dependencies.callRuntimeTool).not.toHaveBeenCalled();
  });

  it("dispatches exactly once after the hook and preserves text, JSON and isError", async () => {
    const order: string[] = [];
    const callRuntimeTool = vi.fn(async () => {
      order.push("call");
      return {
        isError: true,
        structuredContent: { reason: "denied" },
        text: ["not allowed"],
        unsupportedContentTypes: []
      };
    });
    const test = fixture({ callRuntimeTool });
    const descriptor = (await test.service.findTools({ goal: "echo", userId: "user-1" })).tools[0]!;
    const prepared = await test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version, userId: "user-1"
    });

    await expect(test.service.dispatchPreparedToolCall({
      beforeDispatch: async () => { order.push("persisted-dispatch"); },
      prepared,
      userId: "user-1"
    })).resolves.toEqual({
      isError: true,
      structuredContent: { reason: "denied" },
      text: ["not allowed"],
      unsupportedContentTypes: []
    });
    expect(order).toEqual(["persisted-dispatch", "call"]);
    expect(callRuntimeTool).toHaveBeenCalledOnce();
    expect(callRuntimeTool).toHaveBeenCalledWith(expect.objectContaining({
      generationId: `generation-${echoId}`,
      name: "echo",
      arguments: { value: "x" }
    }));
  });

  it("reports unsupported result content after one call without replaying the operation", async () => {
    const callRuntimeTool = vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: ["partial"],
      unsupportedContentTypes: ["image"]
    }));
    const test = fixture({ callRuntimeTool });
    const descriptor = (await test.service.findTools({ goal: "echo", userId: "user-1" })).tools[0]!;
    const prepared = await test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version, userId: "user-1"
    });

    await expect(test.service.dispatchPreparedToolCall({ prepared, userId: "user-1" }))
      .rejects.toEqual(expect.objectContaining({ code: "result_unsupported" }));
    expect(callRuntimeTool).toHaveBeenCalledOnce();
  });

  it("classifies every post-dispatch transport failure as outcome unknown", async () => {
    const test = fixture({ callRuntimeTool: vi.fn(async () => { throw new Error("network lost"); }) });
    const descriptor = (await test.service.findTools({ goal: "echo", userId: "user-1" })).tools[0]!;
    const prepared = await test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version, userId: "user-1"
    });

    const error = await test.service.dispatchPreparedToolCall({ prepared, userId: "user-1" })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(McpHubServiceError);
    expect(error).toMatchObject({ code: "execution_outcome_unknown" });
  });
});
