import { describe, expect, it } from "vitest";
import { prepareMcpRunPlan, type McpRunPlanRecord } from "./runPlan";

function record(overrides: Partial<McpRunPlanRecord> = {}): McpRunPlanRecord {
  const serverId = overrides.serverId ?? "server-1";
  return {
    credentialSources: [],
    enabled: true,
    errorCode: null,
    externalAccountLabel: null,
    fingerprint: `fingerprint-${serverId}`,
    generationId: `generation-${serverId}`,
    inventory: {
      tools: [
        {
          definitionHash: "a".repeat(64),
          description: null,
          inputSchema: { type: "object" },
          name: "lookup"
        }
      ],
      version: 1
    },
    inventoryUpdatedAt: new Date(),
    namespace: serverId,
    readiness: "ready",
    revisionId: `revision-${serverId}`,
    serverId,
    serverName: serverId,
    ...overrides
  };
}

describe("assistant exact MCP subset", () => {
  it("selects only the requested ready servers and excludes unrelated enabled ones", async () => {
    const plan = await prepareMcpRunPlan({
      allowedServerIds: ["server-1"],
      isGenerationLive: () => true,
      load: async () => [record({ serverId: "server-1" }), record({ serverId: "server-2" })]
    });

    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.snapshot.servers.map((server) => server.serverId)).toEqual(["server-1"]);
      expect(plan.bindings.map((binding) => binding.serverId)).toEqual(["server-1"]);
    }
  });

  it("fails closed when a requested server has no record at all", async () => {
    const plan = await prepareMcpRunPlan({
      allowedServerIds: ["server-1", "server-missing"],
      isGenerationLive: () => true,
      load: async () => [record({ serverId: "server-1" })]
    });

    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("mcp_not_ready");
      expect(plan.issues).toHaveLength(1);
      expect(plan.issues[0]!.name).toBe("Required MCP server");
    }
  });

  it("fails closed when a requested server is disabled by the runner", async () => {
    const plan = await prepareMcpRunPlan({
      allowedServerIds: ["server-1"],
      isGenerationLive: () => true,
      load: async () => [record({ enabled: false, serverId: "server-1" })]
    });

    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("mcp_not_ready");
    }
  });

  it("fails closed when a requested server is not ready instead of omitting it", async () => {
    const plan = await prepareMcpRunPlan({
      allowedServerIds: ["server-1", "server-2"],
      isGenerationLive: () => true,
      load: async () => [
        record({ serverId: "server-1" }),
        record({
          errorCode: "mcp_runtime_unavailable",
          readiness: "unavailable",
          serverId: "server-2"
        })
      ]
    });

    expect(plan.ok).toBe(false);
  });

  it("keeps the full-plan behavior when no subset is requested", async () => {
    const plan = await prepareMcpRunPlan({
      isGenerationLive: () => true,
      load: async () => [record({ serverId: "server-1" }), record({ serverId: "server-2" })]
    });

    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.snapshot.servers).toHaveLength(2);
    }
  });
});
