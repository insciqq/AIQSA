import { describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { discoverMcpTools, mcpUnavailableServerReason } from "./discoveryService";
import type { McpCapabilityCatalog, McpRunPlanIssue, McpRunPlanResult, McpRunPlanSnapshot } from "./runPlan";

const allowMcpTools: import("./toolAccess").McpToolAccessFilter = async (_userId, tools) => [...tools];

/** Three servers; each tool's name says which server owns it. */
const catalog: McpCapabilityCatalog = {
  servers: ["alpha", "beta", "gamma"].map((name) => ({
    description: `${name} integration`,
    namespace: name,
    revisionId: `revision-${name}`,
    serverId: `server-${name}`,
    serverName: `PRIVATE_NAME_${name}`,
    tools: [1, 2].map((index) => ({
      arguments: [],
      description: `${name} action ${index}`,
      namespacedName: `mcp_${name}_action_${index}`,
      originalName: `action_${index}`
    }))
  })),
  version: 1
};

type SelectedTool = Readonly<{ namespacedName: string; revisionId: string; serverId: string }>;

/** One server's ready plan for exactly the selected tools. */
function plan(tools: readonly SelectedTool[], schemaBytes = 0): McpRunPlanResult {
  const serverId = tools[0]!.serverId;
  const name = serverId.slice("server-".length);
  return {
    bindings: [{ fingerprint: `fingerprint-${name}`, runtimeGenerationId: `generation-${name}`, serverId }],
    ok: true,
    snapshot: {
      servers: [{ fingerprint: `fingerprint-${name}`, revisionId: `revision-${name}`, serverId, serverName: name }],
      tools: tools.map((tool, index) => ({
        definitionHash: String(index).padStart(64, "0"),
        description: null,
        inputSchema: schemaBytes ? { description: "x".repeat(schemaBytes), type: "object" } : { type: "object" },
        name: tool.namespacedName.slice(`mcp_${name}_`.length),
        namespacedName: tool.namespacedName,
        originalName: tool.namespacedName.slice(`mcp_${name}_`.length),
        serverId,
        serverName: name
      })),
      version: 1
    }
  };
}

const notReady = (...issues: McpRunPlanIssue[]): McpRunPlanResult => ({ code: "mcp_not_ready", issues, ok: false });

function discover(materialize: (userId: string, tools: readonly SelectedTool[]) => Promise<McpRunPlanResult>,
  query = "select:mcp_alpha_action_1,mcp_beta_action_1,mcp_alpha_action_2,mcp_gamma_action_1", snapshot?: McpRunPlanSnapshot) {
  return discoverMcpTools({
    catalog,
    filterTools: allowMcpTools,
    materialize,
    partial: "server",
    search: {
      activeToolNames: new Set(snapshot?.tools.map((tool) => tool.namespacedName) ?? []),
      limit: 8,
      query
    },
    ...(snapshot ? { snapshot } : {}),
    userId: "user-1"
  });
}

describe("per-server MCP discovery", () => {
  it.each([
    ["a startup or initialize failure", notReady({ errorCode: "mcp_initialize_failed", name: "A", readiness: "unavailable" }),
      "mcp_server_unavailable"],
    ["a network failure", notReady({ errorCode: "mcp_network_failed", name: "A", readiness: "unavailable" }), "mcp_server_unavailable"],
    ["a runtime in backoff or restarting", notReady({ errorCode: "mcp_runtime_not_live", name: "A", readiness: "restarting" }),
      "mcp_server_unavailable"],
    ["an upstream error", notReady({ errorCode: "mcp_connect_failed", name: "A", readiness: "unavailable" }), "mcp_server_unavailable"],
    ["an administrator's rejected shared credential",
      notReady({ errorCode: "mcp_authorization_required", name: "A", readiness: "unavailable" }), "mcp_server_unavailable"],
    ["a missing installation OAuth connection", notReady({ errorCode: null, name: "A", readiness: "queued", signInRequired: true }),
      "mcp_reauthorization_required"],
    ["a personal connection that needs a new sign-in",
      notReady({ errorCode: "oauth_reauthorization_required", name: "A", readiness: "reauthorization_required" }),
      "mcp_reauthorization_required"],
    ["a never authorized personal connection", notReady({ errorCode: "oauth_required", name: "A", readiness: "needs_authorization" }),
      "mcp_reauthorization_required"],
    ["the user's rejected personal credential", notReady({ errorCode: "mcp_authorization_required", name: "A",
      personalCredentialRejected: true, readiness: "unavailable" }), "mcp_personal_credential_rejected"],
    ["a plan beyond its bounds", { code: "mcp_plan_too_large", issues: [], ok: false } satisfies McpRunPlanResult, "mcp_plan_too_large"]
  ] as const)("classifies %s", (_label, result, reason) => {
    expect(mcpUnavailableServerReason(result as Extract<McpRunPlanResult, { ok: false }>)).toBe(reason);
  });

  it("materializes each selected server once, in rank order, and reports only the ones that cannot run", async () => {
    const observation = await captureRunObservation();
    const materialize = vi.fn(async (_userId: string, tools: readonly SelectedTool[]) =>
      tools[0]!.serverId === "server-beta"
        ? notReady({ errorCode: "mcp_network_failed", name: "PRIVATE_NAME_beta", readiness: "unavailable" })
        : tools[0]!.serverId === "server-gamma"
          ? notReady({ errorCode: null, name: "PRIVATE_NAME_gamma", readiness: "queued", signInRequired: true })
          : plan(tools));

    const discovered = await discover(materialize);

    expect(materialize.mock.calls.map(([, tools]) => tools.map((tool) => tool.namespacedName))).toEqual([
      ["mcp_alpha_action_1", "mcp_alpha_action_2"],
      ["mcp_beta_action_1"],
      ["mcp_gamma_action_1"]
    ]);
    expect(discovered.plans.map((ready) => ready.snapshot.servers.map((server) => server.serverId))).toEqual([["server-alpha"]]);
    expect(discovered.unavailable).toEqual([
      { reason: "mcp_server_unavailable", serverId: "server-beta" },
      { reason: "mcp_reauthorization_required", serverId: "server-gamma" }
    ]);
    const records = observation.records();
    expect(records.filter((record) => record.event === "mcp_discovery_server_unavailable")).toEqual([
      expect.objectContaining({ cause: "mcp_network_failed", code: "mcp_server_unavailable", level: "warn" }),
      expect.objectContaining({ cause: "mcp_not_ready", code: "mcp_reauthorization_required", level: "info" })
    ]);
    expect(records.find((record) => record.event === "mcp_discovery")).toMatchObject({
      loaded_count: 2, outcome: "completed", unavailable_server_count: 2
    });
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_NAME|server-beta|server-gamma|mcp_beta_action/u);
  });

  it("reports a server whose own runtime threw, and fails the call on an internal error", async () => {
    const runtimeFailure = Object.assign(new Error("PRIVATE_ENDPOINT"), { code: "mcp_runtime_fingerprint_collision" });
    await expect(discover(async (_userId, tools) => {
      if (tools[0]!.serverId === "server-alpha") throw runtimeFailure;
      return plan(tools);
    })).resolves.toMatchObject({
      plans: [{ snapshot: { servers: [{ serverId: "server-beta" }] } }, { snapshot: { servers: [{ serverId: "server-gamma" }] } }],
      unavailable: [{ reason: "mcp_server_unavailable", serverId: "server-alpha" }]
    });

    // A database or other internal failure is not one server's availability.
    const internal = Object.assign(new Error("PRIVATE_DATABASE_FAILURE"), { code: "P1001" });
    await expect(discover(async (_userId, tools) => {
      if (tools[0]!.serverId === "server-beta") throw internal;
      return plan(tools);
    })).rejects.toMatchObject({ code: "mcp_materialization_failed", name: "McpDiscoveryError" });
  });

  it("reports a server whose plan does not match the selection", async () => {
    const mismatch = await discover(async (_userId, tools) => tools[0]!.serverId === "server-gamma"
      ? plan([{ ...tools[0]!, namespacedName: "mcp_gamma_action_2" }])
      : plan(tools), "select:mcp_alpha_action_1,mcp_gamma_action_1");
    expect(mismatch.unavailable).toEqual([{ reason: "mcp_server_unavailable", serverId: "server-gamma" }]);
    expect(mismatch.plans).toHaveLength(1);
  });

  it("reports a server whose tools no longer fit the run's snapshot or its accepted binding", async () => {
    vi.stubEnv("AIQSA_MCP_LIST_TOOLS_RESPONSE_MAX_BYTES", String(512 * 1024));
    try {
      const large = await discover(async (_userId, tools) => plan(tools, 300_000), "select:mcp_alpha_action_1,mcp_beta_action_1");
      expect(large.plans.map((ready) => ready.snapshot.servers[0]!.serverId)).toEqual(["server-alpha"]);
      expect(large.unavailable).toEqual([{ reason: "mcp_plan_too_large", serverId: "server-beta" }]);
    } finally {
      vi.unstubAllEnvs();
    }

    // The run accepted alpha with another generation: loading more of it would mix bindings.
    const accepted = plan([{ namespacedName: "mcp_alpha_action_2", revisionId: "revision-alpha", serverId: "server-alpha" }]);
    if (!accepted.ok) throw new Error("expected a ready plan");
    const snapshot: McpRunPlanSnapshot = { ...accepted.snapshot,
      servers: accepted.snapshot.servers.map((server) => ({ ...server, fingerprint: "fingerprint-alpha-earlier" })) };
    const changed = await discover(async (_userId, tools) => plan(tools), "select:mcp_alpha_action_1,mcp_beta_action_1", snapshot);
    expect(changed.unavailable).toEqual([{ reason: "mcp_server_unavailable", serverId: "server-alpha" }]);
    expect(changed.plans.map((ready) => ready.snapshot.servers[0]!.serverId)).toEqual(["server-beta"]);
  });

  it("keeps the MCP Hub's per-tool partial mode", async () => {
    const materialize = vi.fn(async (_userId: string, tools: readonly SelectedTool[]) =>
      tools[0]!.namespacedName === "mcp_alpha_action_2"
        ? notReady({ errorCode: "mcp_network_failed", name: "A", readiness: "unavailable" })
        : plan(tools));
    const discovered = await discoverMcpTools({
      catalog, filterTools: allowMcpTools, materialize, partial: "tool",
      search: { activeToolNames: new Set(), limit: 8, query: "select:mcp_alpha_action_1,mcp_alpha_action_2" },
      userId: "user-1"
    });
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(discovered.plans.map((ready) => ready.snapshot.tools.map((tool) => tool.namespacedName))).toEqual([["mcp_alpha_action_1"]]);
    expect(discovered.unavailable).toEqual([]);
  });
});
