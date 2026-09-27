import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_INVENTORY_EXCLUSION_LIMIT, MCP_RUN_PLAN_LIMITS, MCP_SERVER_TOOL_LIMIT } from "../../contracts/mcp";
import type { McpRunPlanRecord } from "./runPlan";
import {
  budgetMcpServerInstructions,
  buildMcpCapabilityCatalog,
  isMcpRunPlanRecordStartable,
  MCP_CATALOG_INSTRUCTIONS_BUDGET_CHARS,
  mcpInventoryExclusions,
  namespacedMcpToolName,
  prepareMcpRunPlan,
  projectMcpRunPlanStartability
} from "./runPlan";
import {
  McpRuntimeCoordinator,
  type McpRuntimeCoordinatorRepository,
  type McpRuntimeInventoryTool,
  type McpRuntimeSession
} from "./runtimeCoordinator";

const now = new Date("2026-07-22T18:00:00.000Z");
const hash = "a".repeat(64);
afterEach(() => vi.unstubAllEnvs());

function record(overrides: Partial<McpRunPlanRecord> = {}): McpRunPlanRecord {
  return {
    credentialSources: ["personal"],
    enabled: true,
    errorCode: null,
    externalAccountLabel: null,
    fingerprint: "fingerprint-1",
    generationId: "generation-1",
    inventory: {
      tools: [{
        definitionHash: hash,
        description: "Echo input",
        inputSchema: { properties: { text: { type: "string" } }, type: "object" },
        name: "echo"
      }],
      version: 1
    },
    inventoryUpdatedAt: now,
    namespace: "mcp_example",
    readiness: "ready",
    revisionId: "revision-1",
    serverId: "server-1",
    serverName: "Example",
    ...overrides
  };
}

describe("MCP run plans", () => {
  it("materializes large schemas up to the configured inventory budget", async () => {
    const tools = Array.from({ length: 8 }, (_, index) => ({ name: `tool_${index}`, definitionHash: hash,
      description: null, inputSchema: { type: "object", description: "x".repeat(96 * 1024) } }));
    const prepare = () => prepareMcpRunPlan({ isGenerationLive: () => true, now: () => now,
      load: async () => [record({ inventory: { tools, version: 1 } })] });
    const result = await prepare();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.tools).toHaveLength(8);
    vi.stubEnv("AIQSA_MCP_LIST_TOOLS_RESPONSE_MAX_BYTES", String(512 * 1024));
    await expect(prepare()).resolves.toMatchObject({ ok: false, code: "mcp_plan_too_large" });
  });

  it.each(["idle", "queued", "starting", "ready", "restarting"] as const)(
    "recognizes enabled %s records as startable on demand",
    (readiness) => {
      expect(isMcpRunPlanRecordStartable(record({ readiness }))).toBe(true);
    }
  );

  it.each([
    "authorizing",
    "disabled",
    "needs_authorization",
    "needs_setup",
    "reauthorization_required",
    "unavailable"
  ] as const)("rejects enabled %s records from startable availability", (readiness) => {
    expect(isMcpRunPlanRecordStartable(record({ readiness }))).toBe(false);
  });

  it("requires the user's server preference to remain enabled", () => {
    expect(isMcpRunPlanRecordStartable(record({ enabled: false }))).toBe(false);
  });

  it("overlays configuration-aware readiness and fails closed without it", () => {
    const queued = record({ generationId: null, readiness: "queued" });

    expect(projectMcpRunPlanStartability([queued], [{
      enabled: true,
      errorCode: "configuration_required",
      id: queued.serverId,
      readiness: "needs_setup"
    }])).toEqual([expect.objectContaining({
      enabled: true,
      errorCode: "configuration_required",
      readiness: "needs_setup"
    })]);
    expect(projectMcpRunPlanStartability([queued], [])).toEqual([expect.objectContaining({
      enabled: false,
      errorCode: "mcp_startability_unknown",
      readiness: "unavailable"
    })]);
  });

  it("keeps an all-disabled ready server while contributing zero run tools", async () => {
    const result = await prepareMcpRunPlan({
      isGenerationLive: () => true,
      load: async () => [record({ inventory: { tools: [], version: 1 } })],
      now: () => now
    });

    expect(result).toMatchObject({
      bindings: [{ runtimeGenerationId: "generation-1", serverId: "server-1" }],
      ok: true,
      snapshot: { servers: [{ serverId: "server-1" }], tools: [] }
    });
  });

  it("snapshots every enabled ready server/tool and creates stable collision-safe names", async () => {
    const result = await prepareMcpRunPlan({
      isGenerationLive: () => true,
      load: async () => [record()],
      now: () => now
    });
    expect(result).toMatchObject({
      bindings: [{ fingerprint: "fingerprint-1", runtimeGenerationId: "generation-1" }],
      ok: true,
      snapshot: {
        servers: [{
          credentialSources: ["personal"],
          externalAccountLabel: null,
          revisionId: "revision-1",
          serverId: "server-1"
        }],
        tools: [{ originalName: "echo", serverId: "server-1" }],
        version: 1
      }
    });
    if (result.ok) {
      expect(result.snapshot.tools[0]?.namespacedName).toMatch(/^mcp_mcp_example_echo_[a-f0-9]{10}$/u);
    }
    expect(namespacedMcpToolName("mcp_example", "equal name"))
      .not.toBe(namespacedMcpToolName("mcp_other", "equal name"));
  });

  it("materializes one requested tool without charging the server's full inventory", async () => {
    const inventory = Array.from(
      { length: MCP_RUN_PLAN_LIMITS.maxTools + 1 },
      (_, index) => ({
        definitionHash: index.toString(16).padStart(64, "0"),
        description: `Tool ${index}`,
        inputSchema: { properties: { value: { type: "string" } }, type: "object" },
        name: `tool_${index}`
      })
    );
    const selectedName = namespacedMcpToolName("mcp_example", "tool_0");
    const result = await prepareMcpRunPlan({
      allowedServerIds: ["server-1"],
      allowedToolNames: [selectedName],
      isGenerationLive: () => true,
      load: async () => [record({ inventory: { tools: inventory, version: 1 } })],
      now: () => now
    });

    expect(result).toMatchObject({
      bindings: [{ serverId: "server-1" }],
      ok: true,
      snapshot: { tools: [{ namespacedName: selectedName }] }
    });
    if (result.ok) expect(result.snapshot.tools).toHaveLength(1);
  });

  it("admits a 64-server plan and a maximal server's selected tool, and rejects the 65th server", async () => {
    const records = (count: number) => Array.from({ length: count }, (_, index) => record({
      fingerprint: `fingerprint-${index}`,
      generationId: `generation-${index}`,
      namespace: `mcp_server_${index}`,
      serverId: `server-${index}`,
      serverName: `Server ${index}`
    }));
    const admitted = await prepareMcpRunPlan({ isGenerationLive: () => true, load: async () => records(64), now: () => now });
    expect(admitted.ok && admitted.snapshot.servers).toHaveLength(MCP_RUN_PLAN_LIMITS.maxEnabledServers);
    await expect(prepareMcpRunPlan({ isGenerationLive: () => true, load: async () => records(65), now: () => now }))
      .resolves.toMatchObject({ code: "mcp_plan_too_large", ok: false });

    const inventory = Array.from({ length: MCP_SERVER_TOOL_LIMIT }, (_, index) => ({
      definitionHash: hash, description: null, inputSchema: { type: "object" }, name: `tool_${index}`
    }));
    const selected = namespacedMcpToolName("mcp_example", `tool_${MCP_SERVER_TOOL_LIMIT - 1}`);
    await expect(prepareMcpRunPlan({
      allowedToolNames: [selected],
      isGenerationLive: () => true,
      load: async () => [record({ inventory: { tools: inventory, version: 1 } })],
      now: () => now
    })).resolves.toMatchObject({ ok: true, snapshot: { tools: [{ namespacedName: selected }] } });
    await expect(prepareMcpRunPlan({
      allowedToolNames: [selected],
      isGenerationLive: () => true,
      load: async () => [record({ inventory: { tools: [...inventory, { ...inventory[0]!, name: "extra" }], version: 1 } })],
      now: () => now
    })).resolves.toMatchObject({ code: "mcp_not_ready", issues: [{ errorCode: "mcp_inventory_invalid" }], ok: false });
  });

  it("never silently omits an enabled unavailable server and reconciles once", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce([record({ generationId: null, readiness: "queued" })])
      .mockResolvedValueOnce([record()]);
    const reconcile = vi.fn(async () => undefined);
    const result = await prepareMcpRunPlan({
      isGenerationLive: () => true,
      load,
      now: () => now,
      reconcile
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it("reconciles a persisted ready generation that is not live in this process", async () => {
    let live = false;
    const load = vi.fn(async () => [record()]);
    const reconcile = vi.fn(async () => {
      live = true;
    });

    const result = await prepareMcpRunPlan({
      isGenerationLive: () => live,
      load,
      now: () => now,
      reconcile
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it("does not accept persisted ready state when reconciliation leaves no live session", async () => {
    const result = await prepareMcpRunPlan({
      isGenerationLive: () => false,
      load: async () => [record()],
      now: () => now,
      reconcile: async () => undefined
    });

    expect(result).toEqual({
      code: "mcp_not_ready",
      issues: [{
        errorCode: "mcp_runtime_not_live",
        name: "Example",
        readiness: "restarting"
      }],
      ok: false
    });
  });

  it("returns actionable server identity when reconciliation cannot make it ready", async () => {
    const result = await prepareMcpRunPlan({
      isGenerationLive: () => true,
      load: async () => [record({ errorCode: "mcp_connect_failed", readiness: "unavailable" })],
      now: () => now,
      reconcile: async () => undefined
    });
    expect(result).toEqual({
      code: "mcp_not_ready",
      issues: [{ errorCode: "mcp_connect_failed", name: "Example", readiness: "unavailable" }],
      ok: false
    });
  });

  it("treats stale or malformed inventory as unavailable", async () => {
    await expect(prepareMcpRunPlan({
      isGenerationLive: () => true,
      load: async () => [record({ inventoryUpdatedAt: new Date(now.getTime() - 6 * 60_000) })],
      now: () => now
    })).resolves.toMatchObject({ code: "mcp_not_ready", ok: false });
    await expect(prepareMcpRunPlan({
      isGenerationLive: () => true,
      load: async () => [record({ inventory: { tools: [{ name: "bad" }], version: 1 } })],
      now: () => now
    })).resolves.toEqual({
      code: "mcp_not_ready",
      issues: [{ errorCode: "mcp_inventory_invalid", name: "Example", readiness: "unavailable" }],
      ok: false
    });
  });
});

describe("MCP run plans over the runtime's admitted inventory", () => {
  const HASHES = {
    changed: "4".repeat(64),
    delete_repo: "5".repeat(64),
    echo: "1".repeat(64),
    large: "2".repeat(64),
    slow: "3".repeat(64)
  } as const;

  function upstreamTool(name: string, definitionHash: string): McpRuntimeInventoryTool {
    return { definitionHash, description: `${name} tool`, inputSchema: { type: "object" }, name };
  }

  /** A real coordinator over a published revision {echo, large, slow} and a changed upstream server. */
  async function admittedRuntime() {
    const persisted = new Map<string, unknown>();
    const session: McpRuntimeSession = {
      callTool: vi.fn(async () => ({ isError: false, structuredContent: null, text: [], unsupportedContentTypes: [] })),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => [
        upstreamTool("echo", HASHES.changed),
        upstreamTool("large", HASHES.large),
        upstreamTool("delete_repo", HASHES.delete_repo)
      ]),
      ping: vi.fn(async () => undefined)
    };
    const repository: McpRuntimeCoordinatorRepository = {
      deleteDrainedGeneration: vi.fn(async () => true),
      finalizeDeletedServers: vi.fn(async () => 0),
      listDrainedGenerationIds: vi.fn(async () => []),
      loadAcceptedGeneration: vi.fn(async () => null),
      markFailed: vi.fn(async () => ({ applied: true, retryAt: null })),
      markReady: vi.fn(async ({ generationId, inventory }) => {
        persisted.set(generationId, JSON.parse(JSON.stringify(inventory)));
        return true;
      }),
      markStarting: vi.fn(async () => true),
      synchronizeDesired: vi.fn(async () => [{
        callTimeoutMs: 1_000,
        fingerprint: "fingerprint-1",
        generationId: "generation-1",
        headers: {},
        publishedTools: {
          hashes: new Map([["echo", HASHES.echo], ["large", HASHES.large], ["slow", HASHES.slow]]),
          kind: "definitions" as const
        },
        redactionValues: [],
        retryAt: null,
        startupTimeoutMs: 1_000,
        url: "https://mcp.example.test/mcp"
      }]),
      touchLastUsed: vi.fn(async () => undefined)
    };
    const coordinator = new McpRuntimeCoordinator({ now: () => now, repository, sessions: { create: async () => session } });
    await coordinator.reconcileNow();
    return { coordinator, record: record({ inventory: persisted.get("generation-1") }), session };
  }

  it("keeps additions and changed definitions out of load_all, Assistant and Project plans", async () => {
    const { coordinator, record: admitted } = await admittedRuntime();
    const isGenerationLive = (generationId: string) => coordinator.hasLiveGeneration(generationId);
    expect(mcpInventoryExclusions(admitted.inventory)).toEqual([
      { name: "delete_repo", reason: "unpublished_addition" },
      { name: "echo", reason: "definition_drift" },
      { name: "slow", reason: "missing_upstream" }
    ]);

    const plans = await Promise.all([
      prepareMcpRunPlan({ isGenerationLive, load: async () => [admitted], now: () => now }),
      prepareMcpRunPlan({ allowedServerIds: ["server-1"], isGenerationLive, load: async () => [admitted], now: () => now }),
      prepareMcpRunPlan({
        allowedServerIds: ["server-1"],
        isGenerationLive,
        load: async () => [{ ...admitted, credentialSources: ["shared"] }],
        now: () => now
      })
    ]);
    for (const plan of plans) {
      expect(plan.ok).toBe(true);
      if (plan.ok) expect(plan.snapshot.tools.map(({ originalName }) => originalName)).toEqual(["large"]);
    }
    await coordinator.stop();
  });

  it("fails an Auto selection of a held-back tool closed instead of substituting its runtime schema", async () => {
    const { coordinator, record: admitted, session } = await admittedRuntime();
    const select = (name: string) => prepareMcpRunPlan({
      allowedServerIds: ["server-1"],
      allowedToolNames: [namespacedMcpToolName(admitted.namespace, name)],
      isGenerationLive: (generationId) => coordinator.hasLiveGeneration(generationId),
      load: async () => [admitted],
      now: () => now
    });

    for (const name of ["delete_repo", "echo", "slow"]) {
      await expect(select(name)).resolves.toEqual({
        code: "mcp_not_ready",
        issues: [{ errorCode: "mcp_tool_not_available", name: "Selected MCP tool", readiness: "unavailable" }],
        ok: false
      });
    }
    await expect(select("large")).resolves.toMatchObject({ ok: true, snapshot: { tools: [{ originalName: "large" }] } });
    expect(session.callTool).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("bounds held-back names by one runtime inventory's exclusion limit", () => {
    const exclusions = (count: number) => Array.from({ length: count }, (_, index) => ({
      name: `tool_${index}`, reason: index % 2 ? "unpublished_addition" : "missing_upstream"
    }));
    expect(mcpInventoryExclusions({ exclusions: exclusions(MCP_INVENTORY_EXCLUSION_LIMIT), tools: [], version: 1 }))
      .toHaveLength(MCP_INVENTORY_EXCLUSION_LIMIT);
    expect(mcpInventoryExclusions({ exclusions: exclusions(MCP_INVENTORY_EXCLUSION_LIMIT + 1), tools: [], version: 1 }))
      .toBeNull();
  });

  it("treats malformed held-back names as an invalid inventory and accepts inventories recorded before them", async () => {
    const tools = [{ definitionHash: hash, description: null, inputSchema: { type: "object" }, name: "echo" }];
    for (const exclusions of [
      [{ name: "delete_repo", reason: "other" }],
      [{ name: "not a tool", reason: "unpublished_addition" }],
      [{ name: "echo", reason: "definition_drift" }],
      [{ name: "a", reason: "missing_upstream" }, { name: "a", reason: "missing_upstream" }],
      { name: "delete_repo", reason: "unpublished_addition" }
    ]) {
      await expect(prepareMcpRunPlan({
        isGenerationLive: () => true,
        load: async () => [record({ inventory: { exclusions, tools, version: 1 } })],
        now: () => now
      })).resolves.toEqual({
        code: "mcp_not_ready",
        issues: [{ errorCode: "mcp_inventory_invalid", name: "Example", readiness: "unavailable" }],
        ok: false
      });
    }
    await expect(prepareMcpRunPlan({
      isGenerationLive: () => true,
      load: async () => [record({ inventory: { tools, version: 1 } })],
      now: () => now
    })).resolves.toMatchObject({ ok: true, snapshot: { tools: [{ originalName: "echo" }] } });
  });
});

describe("MCP Auto catalog server instructions", () => {
  const catalogRecord = (index: number, serverInstructions: string) => record({
    catalogTools: [{ description: null, name: "echo" }],
    namespace: `mcp_server_${index}`,
    serverId: `server-${index}`,
    serverInstructions,
    serverName: `Server ${String(index).padStart(2, "0")}`
  });

  it("carries one server's instructions whole beyond the former 8,192-character filter", () => {
    const instructions = `${"Use scoped reads. ".repeat(1_000)}\u754c`;
    expect(instructions.length).toBeGreaterThan(8_192);
    expect(buildMcpCapabilityCatalog([catalogRecord(0, instructions)]).servers[0]?.instructions).toBe(instructions);
  });

  it("shares one visible budget across servers instead of dropping any", () => {
    const short = "Prefer project-scoped operations.";
    const long = (index: number) => `${index}:${"x".repeat(MCP_CATALOG_INSTRUCTIONS_BUDGET_CHARS)}`;
    const catalog = buildMcpCapabilityCatalog([
      catalogRecord(0, short),
      ...Array.from({ length: 63 }, (_, index) => catalogRecord(index + 1, long(index + 1)))
    ]);
    const texts = catalog.servers.map((server) => server.instructions ?? "");
    expect(texts).toHaveLength(64);
    expect(texts[0]).toBe(short);
    expect(texts.join("").length).toBeLessThanOrEqual(MCP_CATALOG_INSTRUCTIONS_BUDGET_CHARS);
    for (const [index, text] of texts.slice(1).entries()) {
      expect(text.startsWith(`${index + 1}:x`)).toBe(true);
      expect(text).toMatch(/\n\[Server instructions truncated: \d+ of \d+ characters shown\.\]$/u);
    }
  });

  it("never splits a surrogate pair at the truncation boundary", () => {
    const [text] = budgetMcpServerInstructions(["\u{1F600}".repeat(200)], 120);
    const shown = text!.slice(0, text!.indexOf("\n[Server instructions truncated"));
    expect(shown.length % 2).toBe(0);
    expect([...shown].every((character) => character === "\u{1F600}")).toBe(true);
    expect(text!.length).toBeLessThanOrEqual(120);
    expect(budgetMcpServerInstructions(["", "within"], 120)).toEqual(["", "within"]);
  });
});
