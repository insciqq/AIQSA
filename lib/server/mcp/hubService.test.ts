import { describe, expect, it, vi } from "vitest";
import { namespacedMcpToolName, type McpCapabilityCatalog, type McpRunPlanResult } from "./runPlan";
import { createMcpHubService, McpHubServiceError, type McpHubAuthority, type McpHubServiceDependencies } from "./hubService";

const authority: McpHubAuthority = {
  assertActive: async () => undefined,
  clientId: "client-1",
  grantId: "grant-1",
  userId: "user-1"
};

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
  const base: McpHubServiceDependencies = {
    callRuntimeTool: vi.fn(async () => ({
      isError: false,
      structuredContent: { echoed: true },
      text: ["ok"],
      unsupportedContentTypes: []
    })),
    catalog: vi.fn(async () => catalog()),
    filterTools: vi.fn(async (_userId, tools) => [...tools]),
    materialize: vi.fn(async (_userId, tools) => materialized(tools[0]!.namespacedName)),
    inspect: vi.fn(async (_userId, tools) => materialized(tools[0]!.namespacedName)),
    recordDispatch: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })),
    recordDiscoveryAttempt: vi.fn(async () => ({ settle: vi.fn(async () => undefined) })),
    router: {
      route: vi.fn(async ({ catalog: allowedCatalog }) => ({
        toolNames: allowedCatalog.servers.flatMap((server: McpCapabilityCatalog["servers"][number]) =>
          server.tools.map((tool: McpCapabilityCatalog["servers"][number]["tools"][number]) => tool.namespacedName)),
        usageAttribution: null
      }))
    },
    ...overrides
  };
  const dependencies: McpHubServiceDependencies = {
    ...base,
    callRuntimeTool: vi.fn(async (input) => {
      await input.beforeDispatch();
      return base.callRuntimeTool(input);
    })
  };
  return { dependencies, service: createMcpHubService(dependencies) };
}

describe("MCP Hub shared discovery and dispatch", () => {
  it("bounds the complete discovery response by omitting whole schemas", async () => {
    const description = '"'.repeat(40_000);
    const load: McpHubServiceDependencies["materialize"] = async (_user, tools) => {
      const result = materialized(tools[0]!.namespacedName);
      result.snapshot.tools[0]!.inputSchema = {
        type: "object", properties: { value: { type: "string", description } }, required: ["value"], additionalProperties: false
      };
      return result;
    };
    const test = fixture({ catalog: async () => catalog([echoId, otherId]), materialize: load, inspect: load });
    const result = await test.service.findTools({ authority, goal: "Echo and look up a value" });
    expect(result.incomplete).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.input_schema).toMatchObject({ properties: { value: { description } } });
    expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result })))
      .toBeLessThan(512 * 1_024);
  });

  it("returns an empty result without invoking the System Model or runtime", async () => {
    const test = fixture({ catalog: vi.fn(async () => catalog([])) });

    await expect(test.service.findTools({ goal: "find records", authority }))
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

    const result = await test.service.findTools({ goal: "read and echo records", authority });

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
        materialized(tools[0]!.namespacedName, generation, fingerprint, definitionHash)),
      inspect: vi.fn(async (_userId, tools) =>
        materialized(tools[0]!.namespacedName, generation, fingerprint, definitionHash))
    });
    const first = (await test.service.findTools({ goal: "echo", authority })).tools[0]!;
    generation = "generation-after-restart";
    const afterRestart = await test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: first.tool_version, authority
    });
    expect(afterRestart.descriptor.tool_version).toBe(first.tool_version);

    fingerprint = "effective-config-2";
    await expect(test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: first.tool_version, authority
    })).rejects.toMatchObject({ code: "tool_definition_changed" });

    fingerprint = "effective-config-1";
    definitionHash = "b".repeat(64);
    await expect(test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: first.tool_version, authority
    })).rejects.toMatchObject({ code: "tool_definition_changed" });
  });

  it("validates arguments before the durable-dispatch hook or business call", async () => {
    const test = fixture();
    const descriptor = (await test.service.findTools({ goal: "echo", authority })).tools[0]!;

    await expect(test.service.prepareToolCall({
      arguments: {}, toolId: echoId, toolVersion: descriptor.tool_version, authority
    })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(test.dependencies.callRuntimeTool).not.toHaveBeenCalled();
  });

  it("revalidates current catalog and tool policy before marking dispatch", async () => {
    let available = true;
    const test = fixture({ catalog: vi.fn(async () => catalog(available ? [echoId] : [])) });
    const descriptor = (await test.service.findTools({ goal: "echo", authority })).tools[0]!;
    const prepared = await test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version, authority
    });
    available = false;

    await expect(test.service.dispatchPreparedToolCall({
      prepared, authority
    })).rejects.toMatchObject({ code: "tool_unavailable" });
    expect(test.dependencies.recordDispatch).not.toHaveBeenCalled();
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
    const test = fixture({ callRuntimeTool, recordDispatch: vi.fn(async () => {
      order.push("persisted-dispatch");
      return { settle: async () => undefined };
    }) });
    const descriptor = (await test.service.findTools({ goal: "echo", authority })).tools[0]!;
    const prepared = await test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version, authority
    });

    await expect(test.service.dispatchPreparedToolCall({
      prepared,
      authority
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
    const descriptor = (await test.service.findTools({ goal: "echo", authority })).tools[0]!;
    const prepared = await test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version, authority
    });

    await expect(test.service.dispatchPreparedToolCall({ prepared, authority }))
      .rejects.toEqual(expect.objectContaining({ code: "result_unsupported" }));
    expect(callRuntimeTool).toHaveBeenCalledOnce();
  });

  it("classifies every post-dispatch transport failure as outcome unknown", async () => {
    const test = fixture({ callRuntimeTool: vi.fn(async () => { throw new Error("network lost"); }) });
    const descriptor = (await test.service.findTools({ goal: "echo", authority })).tools[0]!;
    const prepared = await test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version, authority
    });

    const error = await test.service.dispatchPreparedToolCall({ prepared, authority })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(McpHubServiceError);
    expect(error).toMatchObject({ code: "execution_outcome_unknown" });
  });

  it("settles a durable dispatch receipt exactly once after the single upstream call", async () => {
    const settle = vi.fn(async () => undefined);
    const recordDispatch = vi.fn(async () => ({ settle }));
    const test = fixture({ recordDispatch });
    const descriptor = (await test.service.findTools({ goal: "echo", authority })).tools[0]!;
    const prepared = await test.service.prepareToolCall({
      arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version, authority
    });

    await test.service.dispatchPreparedToolCall({
      prepared, authority
    });
    expect(recordDispatch).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-1", grantId: "grant-1", resourcePath: "/mcp/hub", toolId: echoId,
      userId: "user-1"
    }));
    expect(settle).toHaveBeenCalledWith("COMPLETE", undefined);
    expect(settle).toHaveBeenCalledOnce();
  });

  it("rejects inactive request authority before reading a catalog or calling a model", async () => {
    const denied = { ...authority, assertActive: async () => { throw new McpHubServiceError("authorization_required"); } };
    const test = fixture();
    await expect(test.service.findTools({ authority: denied, goal: "echo" }))
      .rejects.toMatchObject({ code: "authorization_required" });
    expect(test.dependencies.catalog).not.toHaveBeenCalled();
    expect(test.dependencies.router.route).not.toHaveBeenCalled();
  });

  it.each(["routing", "preparation", "dispatch_record", "result", "settlement"] as const)(
    "withholds protected data when OAuth is revoked during %s", async (barrier) => {
      let active = true;
      let armed = false;
      const principal = {
        ...authority,
        assertActive: async () => { if (!active) throw new McpHubServiceError("authorization_required"); }
      };
      const settle = vi.fn(async () => { if (armed && barrier === "settlement") active = false; });
      const test = fixture({
        router: { route: vi.fn(async () => {
          if (armed && barrier === "routing") active = false;
          return { toolNames: [echoId], usageAttribution: null };
        }) },
        materialize: vi.fn(async () => {
          if (armed && barrier === "preparation") active = false;
          return materialized(echoId);
        }),
        recordDispatch: vi.fn(async () => {
          if (armed && barrier === "dispatch_record") active = false;
          return { settle };
        }),
        callRuntimeTool: vi.fn(async () => {
          if (armed && barrier === "result") active = false;
          return { isError: false, structuredContent: null, text: ["private result"], unsupportedContentTypes: [] };
        })
      });
      if (barrier === "routing" || barrier === "preparation") {
        armed = true;
        await expect(test.service.findTools({ authority: principal, goal: "echo" }))
          .rejects.toMatchObject({ code: "authorization_required" });
      } else {
        const descriptor = (await test.service.findTools({ authority: principal, goal: "echo" })).tools[0]!;
        const prepared = await test.service.prepareToolCall({
          authority: principal, arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version
        });
        armed = true;
        await expect(test.service.dispatchPreparedToolCall({ authority: principal, prepared }))
          .rejects.toMatchObject({ code: "authorization_required" });
        expect(settle).toHaveBeenCalledOnce();
      }
      expect(test.dependencies.callRuntimeTool).toHaveBeenCalledTimes(barrier === "result" || barrier === "settlement" ? 1 : 0);
    }
  );

  it.each(["preparation", "dispatch_record", "result"] as const)(
    "rechecks server and exact-tool access after %s", async (barrier) => {
      let visible = true;
      let armed = false;
      const test = fixture({
        catalog: vi.fn(async () => catalog(visible ? [echoId] : [])),
        materialize: vi.fn(async () => {
          if (armed && barrier === "preparation") visible = false;
          return materialized(echoId);
        }),
        recordDispatch: vi.fn(async () => {
          if (armed && barrier === "dispatch_record") visible = false;
          return { settle: async () => undefined };
        }),
        callRuntimeTool: vi.fn(async () => {
          if (armed && barrier === "result") visible = false;
          return { isError: false, structuredContent: null, text: ["private result"], unsupportedContentTypes: [] };
        })
      });
      const descriptor = (await test.service.findTools({ authority, goal: "echo" })).tools[0]!;
      armed = true;
      const operation = async () => {
        const prepared = await test.service.prepareToolCall({
          authority, arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version
        });
        return test.service.dispatchPreparedToolCall({ authority, prepared });
      };
      await expect(operation()).rejects.toMatchObject({ code: "tool_unavailable" });
      expect(test.dependencies.callRuntimeTool).toHaveBeenCalledTimes(barrier === "result" ? 1 : 0);
    }
  );

  it.each(["dispatch_record", "settlement"] as const)("does not replay after a failed %s write", async (barrier) => {
    const settle = vi.fn(async () => { throw new Error("private database failure"); });
    const test = fixture({ recordDispatch: vi.fn(async () => {
      if (barrier === "dispatch_record") throw new Error("private database failure");
      return { settle };
    }) });
    const descriptor = (await test.service.findTools({ authority, goal: "echo" })).tools[0]!;
    const prepared = await test.service.prepareToolCall({
      authority, arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version
    });
    await expect(test.service.dispatchPreparedToolCall({ authority, prepared }))
      .rejects.toMatchObject({ code: barrier === "settlement" ? "execution_outcome_unknown" : "upstream_unavailable" });
    await expect(test.service.dispatchPreparedToolCall({ authority, prepared }))
      .rejects.toMatchObject({ code: "tool_unavailable" });
    expect(test.dependencies.callRuntimeTool).toHaveBeenCalledTimes(barrier === "settlement" ? 1 : 0);
    expect(settle).toHaveBeenCalledTimes(barrier === "settlement" ? 1 : 0);
  });

  it("does not transfer a prepared call to another OAuth principal", async () => {
    const test = fixture();
    const descriptor = (await test.service.findTools({ authority, goal: "echo" })).tools[0]!;
    const prepared = await test.service.prepareToolCall({
      authority, arguments: { value: "x" }, toolId: echoId, toolVersion: descriptor.tool_version
    });
    await expect(test.service.dispatchPreparedToolCall({ authority: { ...authority, userId: "user-2" }, prepared }))
      .rejects.toMatchObject({ code: "tool_unavailable" });
    expect(test.dependencies.recordDispatch).not.toHaveBeenCalled();
    expect(test.dependencies.callRuntimeTool).not.toHaveBeenCalled();
  });

  it("rejects invented router selections before preparing any runtime", async () => {
    const test = fixture({ router: { route: vi.fn(async () => ({ toolNames: [otherId], usageAttribution: null })) } });
    await expect(test.service.findTools({ authority, goal: "echo" }))
      .rejects.toMatchObject({ code: "discovery_unavailable" });
    expect(test.dependencies.materialize).not.toHaveBeenCalled();
  });
});
