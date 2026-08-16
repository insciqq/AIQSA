import { describe, expect, it, vi } from "vitest";
import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import type { McpRunPlanRecord } from "./runPlan";
import { namespacedMcpToolName, prepareMcpRunPlan } from "./runPlan";

const now = new Date("2026-07-22T18:00:00.000Z");
const hash = "a".repeat(64);

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
