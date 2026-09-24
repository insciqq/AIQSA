// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { restoreAgentMcpTools } from "./mcpResume";
import { defaultMcpRunPlan } from "../mcp/defaultRuntime";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import type { McpCapabilityCatalog, McpRunPlanResult } from "../mcp/runPlan";
import type { ProviderRunRequest } from "../providers/types";
import { MCP_RUN_PLAN_LIMITS } from "@/lib/contracts/mcp";
import type { McpToolIdentity } from "../mcp/toolAccess";

vi.mock("../prisma", () => ({ prisma: {} }));
vi.mock("../observability", () => ({ logEvent: vi.fn(), runWithContext: (_context: unknown, action: () => unknown) => action() }));

function fixture() {
  const catalog: McpCapabilityCatalog = { version: 1, servers: ["quartz", "violet"].map((name) => ({
    serverId: name, revisionId: `${name}-revision`, serverName: name, namespace: name, description: "",
    tools: [{ namespacedName: `${name}_transform`, originalName: "transform", description: null }]
  })) };
  const plans = new Map(catalog.servers.map(server => [server.tools[0]!.namespacedName, {
    ok: true as const, snapshot: { version: 1 as const,
      servers: [{ ...server, fingerprint: `${server.serverId}-fingerprint` }],
      tools: server.tools.map(tool => ({ ...tool, name: tool.originalName, serverId: server.serverId,
        serverName: server.serverName, definitionHash: hashCanonicalMcpValue({ tool: tool.namespacedName }),
        inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } })) },
    bindings: [{ serverId: server.serverId, fingerprint: `${server.serverId}-fingerprint`, runtimeGenerationId: `${server.serverId}-new-generation` }]
  }]));
  const versionOf = (plan: Extract<McpRunPlanResult, { ok: true }>) => hashCanonicalMcpValue({
    definitionHash: plan.snapshot.tools[0]!.definitionHash, effectiveConfiguration: plan.snapshot.servers[0]!.fingerprint,
    toolId: plan.snapshot.tools[0]!.namespacedName
  });
  const candidates = [...plans.entries()].map(([toolId, plan]) => ({ toolId, version: versionOf(plan) }));
  const admitted = new Map<string, string>();
  const store = {
    assertActive: vi.fn(async () => {}), resumedMcpTools: vi.fn(async () => candidates),
    mcpTools: vi.fn(async () => [...admitted.entries()].map(([toolId, version]) => ({ toolId, version }))),
    admitMcpPlan: vi.fn(async (plan: Extract<McpRunPlanResult, { ok: true }>) => {
      admitted.set(plan.snapshot.tools[0]!.namespacedName, versionOf(plan));
    })
  };
  const accessFilter = vi.fn(async (_user: string, tools: readonly McpToolIdentity[]) => [...tools]);
  const runtime = { ...defaultMcpRunPlan,
    catalog: vi.fn(async () => catalog),
    async filterTools<T extends McpToolIdentity>(userId: string, tools: readonly T[]) {
      const allowed = await accessFilter(userId, tools);
      return tools.filter(tool => allowed.includes(tool));
    },
    materialize: vi.fn(async (_user: string, tools: readonly { namespacedName: string }[]) => plans.get(tools[0]!.namespacedName)!)
  };
  const request = { agent: { mcpMode: "auto" }, mcpDiscovery: { catalog } } as unknown as ProviderRunRequest;
  const input = { request, runId: "next-run", userId: "owner", store, signal: new AbortController().signal };
  return { input, runtime, store, plans, candidates, admitted, catalog, accessFilter };
}

describe("Agent MCP resume admission", () => {
  it("freshly binds two arbitrary servers and carries discovery through an idle successor and worker replacement", async () => {
    const f = fixture();
    expect(await restoreAgentMcpTools(f.input, f.runtime)).toEqual(new Map());
    expect(await f.store.mcpTools()).toEqual(f.candidates);
    expect(f.store.admitMcpPlan).toHaveBeenCalledTimes(2);
    expect(f.store.admitMcpPlan.mock.calls.every(([plan]) => plan.bindings[0]!.runtimeGenerationId.endsWith("new-generation"))).toBe(true);
    await restoreAgentMcpTools(f.input, f.runtime);
    expect(f.runtime.materialize).toHaveBeenCalledTimes(2);
    const successor = fixture();
    successor.store.resumedMcpTools.mockResolvedValue(await f.store.mcpTools());
    await restoreAgentMcpTools({ ...successor.input, runId: "third-run" }, successor.runtime);
    expect(await successor.store.mcpTools()).toEqual(f.candidates);
  });

  it.each(["schema", "configuration", "revision"])("rejects changed %s without admitting the replacement, preserving the healthy subset", async change => {
    const f = fixture();
    const plan = f.plans.get(f.candidates[0]!.toolId)!;
    if (change === "schema") plan.snapshot.tools[0]!.definitionHash = "b".repeat(64);
    if (change === "configuration") {
      plan.snapshot.servers[0]!.fingerprint = "different";
      plan.bindings[0]!.fingerprint = "different";
    }
    if (change === "revision") f.runtime.catalog.mockResolvedValue({ ...f.catalog,
      servers: f.catalog.servers.map((server, index) => index ? server : { ...server, revisionId: "different" }) });
    const failures = await restoreAgentMcpTools(f.input, f.runtime);
    expect(failures.get(f.candidates[0]!.toolId)?.code).toBe("tool_definition_changed");
    expect([...f.admitted.keys()]).toEqual([f.candidates[1]!.toolId]);
  });

  it.each(["grant", "disabled", "selection", "runtime"])("does not restore a candidate after %s loss", async change => {
    const f = fixture();
    if (change === "grant") f.accessFilter.mockImplementation(async (_user, tools) => tools.filter(tool => tool.serverId !== "quartz"));
    if (change === "disabled") f.runtime.catalog.mockResolvedValue({ version: 1, servers: [f.catalog.servers[1]!] });
    if (change === "selection") f.input.request = { ...f.input.request, mcpDiscovery: { ...f.input.request.mcpDiscovery!,
      catalog: { version: 1, servers: [f.catalog.servers[1]!] } } };
    if (change === "runtime") f.runtime.materialize.mockRejectedValueOnce(new Error("PRIVATE_RUNTIME_ERROR"));
    const failures = await restoreAgentMcpTools(f.input, f.runtime);
    expect(failures.get(f.candidates[0]!.toolId)?.code).toBe(change === "runtime" ? "upstream_unavailable" : "tool_unavailable");
    expect([...f.admitted.keys()]).toEqual([f.candidates[1]!.toolId]);
    expect(JSON.stringify([...failures.values()])).not.toContain("PRIVATE");
  });

  it("checks authority again after materialization and stops instead of swallowing revocation", async () => {
    const f = fixture();
    f.runtime.materialize.mockImplementationOnce(async (_user, tools) => {
      f.store.assertActive.mockRejectedValue(new Error("agent_authority_expired"));
      return f.plans.get(tools[0]!.namespacedName)!;
    });
    await expect(restoreAgentMcpTools(f.input, f.runtime)).rejects.toThrow("agent_authority_expired");
    expect(f.store.admitMcpPlan).not.toHaveBeenCalled();
  });

  it("never restores with MCP Off and bounds predecessor candidates", async () => {
    const f = fixture();
    await restoreAgentMcpTools({ ...f.input, request: { ...f.input.request,
      agent: { ...f.input.request.agent!, mcpMode: "off" } } }, f.runtime);
    expect(f.store.resumedMcpTools).not.toHaveBeenCalled();
    f.store.resumedMcpTools.mockResolvedValue(Array.from({ length: 2 * MCP_RUN_PLAN_LIMITS.maxTools }, (_, index) => ({
      toolId: `missing-${index}`, version: "a".repeat(64)
    })));
    expect((await restoreAgentMcpTools(f.input, f.runtime)).size).toBe(MCP_RUN_PLAN_LIMITS.maxTools);
    expect(f.runtime.materialize).not.toHaveBeenCalled();
  });
});
