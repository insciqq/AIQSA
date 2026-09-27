import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import type { McpRunPlanRecord } from "./runPlan";
import {
  isMcpRunPlanRecordStartable,
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
