import { describe, expect, it, vi } from "vitest";
import { getContext, runWithContext, type ObservabilityContext } from "../observability";
import { defaultMcpRunPlan, getDefaultMcpRuntimeCoordinator, kickDefaultMcpRuntime } from "./defaultRuntime";
import type { McpRunPlanRecord } from "./runPlan";
import { namespacedMcpToolName } from "./runPlan";
import { MCP_SERVER_TOOL_LIMIT } from "../../contracts/mcp";
import { McpRuntimeCoordinator } from "./runtimeCoordinator";

const repository = vi.hoisted(() => ({
  deleteDrainedGeneration: vi.fn(async () => true),
  finalizeDeletedServers: vi.fn(async () => 0),
  listDrainedGenerationIds: vi.fn(async () => []),
  loadAcceptedGeneration: vi.fn(async () => null),
  markFailed: vi.fn(async () => ({ applied: true, retryAt: null })),
  markReady: vi.fn(async (_input: { inventory: unknown }) => true),
  markStarting: vi.fn(async () => true),
  synchronizeDesired: vi.fn(async (_input: { onDemand?: boolean; userId?: string }) => []),
  touchLastUsed: vi.fn(async () => undefined)
}));
const sessions = vi.hoisted(() => ({ create: vi.fn() }));
const personalLoader = vi.hoisted(() => vi.fn(async (_userId: string, _serverIds: readonly string[]): Promise<unknown[]> => []));

const oauthService = vi.hoisted(() => ({
  createRuntimeFetch: vi.fn(),
  reconcileDisconnecting: vi.fn(async () => undefined)
}));

vi.mock("./runtimeRepository", () => ({ createPrismaMcpRuntimeRepository: () => repository }));
// The installation-wide OAuth sweep must never reach a real database here.
vi.mock("./defaultOAuth", () => ({
  createDefaultMcpOAuthRuntimeProvider: vi.fn(),
  mcpOAuthService: oauthService
}));
vi.mock("./clientSessionFactory", () => ({ createMcpClientSessionFactory: () => sessions }));
vi.mock("./runPlanRepository", () => ({
  createPrismaMcpCapabilityCatalogLoader: () => vi.fn(),
  createPrismaMcpCapabilityCatalogWithOmissionsLoader: () => vi.fn(),
  createPrismaMcpRunPlanLoader: () => personalLoader
}));

describe("default MCP runtime startup", () => {
  it("bounds repeated startup failure and emits one recovery on the successful startup", async () => {
    const scope = globalThis as typeof globalThis & { __aiqsaMcpRuntimeCoordinator?: McpRuntimeCoordinator };
    const previous = scope.__aiqsaMcpRuntimeCoordinator;
    delete scope.__aiqsaMcpRuntimeCoordinator;
    const original = Object.assign(new Error("PRIVATE_STARTUP_DETAIL"), { code: "mcp_connect_failed" });
    const lines: string[] = [];
    const writer = vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
    const start = vi.spyOn(McpRuntimeCoordinator.prototype, "start").mockImplementation(() => { throw original; });
    try {
      for (let index = 0; index < 4; index += 1) expect(getDefaultMcpRuntimeCoordinator).toThrow(original);
      start.mockImplementation(() => undefined);
      getDefaultMcpRuntimeCoordinator();
      getDefaultMcpRuntimeCoordinator();
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ event: "runtime_lifecycle", stage: "startup", outcome: "failed", code: "mcp_connect_failed" }),
        expect.objectContaining({ event: "subsystem.recovered", stage: "startup", repeat_count: 3 })
      ]);
      expect(lines.join("")).not.toContain("PRIVATE");
    } finally {
      start.mockRestore(); writer.mockRestore();
      await (scope.__aiqsaMcpRuntimeCoordinator as McpRuntimeCoordinator | undefined)?.stop();
      delete scope.__aiqsaMcpRuntimeCoordinator;
      if (previous) scope.__aiqsaMcpRuntimeCoordinator = previous;
    }
  });

  it("starts and wakes the shared singleton outside the request that first loads it", async () => {
    const scope = globalThis as typeof globalThis & { __aiqsaMcpRuntimeCoordinator?: McpRuntimeCoordinator };
    const previous = scope.__aiqsaMcpRuntimeCoordinator;
    delete scope.__aiqsaMcpRuntimeCoordinator;
    const contexts: Array<ObservabilityContext | undefined> = [];
    repository.synchronizeDesired.mockImplementation(async () => { contexts.push(getContext()); return []; });
    let coordinator: McpRuntimeCoordinator | undefined;
    try {
      coordinator = runWithContext({ trace_id: "5".repeat(32), run_id: "first-run", job_id: "request-job" }, () =>
        getDefaultMcpRuntimeCoordinator()
      );
      await coordinator.reconcileNow();
      runWithContext({ trace_id: "6".repeat(32), run_id: "second-run" }, () => {
        expect(getDefaultMcpRuntimeCoordinator()).toBe(coordinator);
        kickDefaultMcpRuntime();
      });
      await coordinator.reconcileNow();

      // Only the periodic tick, here the startup one, sweeps OAuth revocations.
      await vi.waitFor(() => expect(oauthService.reconcileDisconnecting).toHaveBeenCalledOnce());
      expect(contexts).toHaveLength(2);
      expect(contexts[0]?.trace_id).not.toBe(contexts[1]?.trace_id);
      for (const context of contexts) {
        expect(context).toEqual({ trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u) });
        expect(context?.trace_id).not.toBe("5".repeat(32));
        expect(context?.trace_id).not.toBe("6".repeat(32));
      }
    } finally {
      await coordinator?.stop();
      delete scope.__aiqsaMcpRuntimeCoordinator;
      if (previous) scope.__aiqsaMcpRuntimeCoordinator = previous;
    }
  });
});

describe("default MCP dispatch tool selection", () => {
  it("revalidates a selected tool from a 1024-tool inventory", async () => {
    const scope = globalThis as typeof globalThis & { __aiqsaMcpRuntimeCoordinator?: McpRuntimeCoordinator };
    const previous = scope.__aiqsaMcpRuntimeCoordinator;
    delete scope.__aiqsaMcpRuntimeCoordinator;
    const inventory = Array.from({ length: MCP_SERVER_TOOL_LIMIT }, (_, index) => ({
      definitionHash: "a".repeat(64), description: null, inputSchema: { type: "object" }, name: `tool_${index + 1}`
    }));
    const record: McpRunPlanRecord = {
      credentialSources: [], enabled: true, errorCode: null, externalAccountLabel: null,
      fingerprint: "fingerprint", generationId: "generation", inventory: { tools: inventory, version: 1 },
      inventoryUpdatedAt: new Date(), namespace: "large_inventory", readiness: "ready",
      revisionId: "revision", serverId: "server", serverName: "Large inventory"
    };
    personalLoader.mockResolvedValue([record]);
    const start = vi.spyOn(McpRuntimeCoordinator.prototype, "start").mockImplementation(() => undefined);
    const ensurePersonal = vi.spyOn(McpRuntimeCoordinator.prototype, "ensureUserServersReady").mockResolvedValue(undefined);
    const isLive = vi.spyOn(McpRuntimeCoordinator.prototype, "hasLiveGeneration").mockReturnValue(true);
    const selected = namespacedMcpToolName(record.namespace, `tool_${MCP_SERVER_TOOL_LIMIT}`);
    const prepare = (allowedToolNames?: readonly string[]) =>
      defaultMcpRunPlan.prepare("user", { allowedServerIds: [record.serverId], allowedToolNames });
    try {
      await expect(prepare([selected])).resolves.toMatchObject({
        ok: true, snapshot: { tools: [{ namespacedName: selected }] }
      });
      // The model-facing full-inventory limit stays in force.
      await expect(prepare()).resolves.toMatchObject({ ok: false, code: "mcp_plan_too_large" });
      expect(ensurePersonal).toHaveBeenCalledWith("user", [record.serverId], undefined);
    } finally {
      await (scope.__aiqsaMcpRuntimeCoordinator as McpRuntimeCoordinator | undefined)?.stop();
      delete scope.__aiqsaMcpRuntimeCoordinator;
      if (previous) scope.__aiqsaMcpRuntimeCoordinator = previous;
      start.mockRestore(); ensurePersonal.mockRestore(); isLive.mockRestore();
      personalLoader.mockClear();
    }
  });
});
