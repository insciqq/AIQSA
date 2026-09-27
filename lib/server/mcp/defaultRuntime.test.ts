import { describe, expect, it, vi } from "vitest";
import { getContext, runWithContext, type ObservabilityContext } from "../observability";
import { defaultMcpRunPlan, getDefaultMcpRuntimeCoordinator, kickDefaultMcpRuntime } from "./defaultRuntime";
import type { McpRunPlanRecord } from "./runPlan";
import { namespacedMcpToolName } from "./runPlan";
import { MCP_SERVER_TOOL_LIMIT } from "../../contracts/mcp";
import {
  McpRuntimeCoordinator,
  type McpRuntimeGenerationLaunch,
  type McpRuntimeInventory,
  type McpRuntimeSession
} from "./runtimeCoordinator";

const repository = vi.hoisted(() => ({
  deleteDrainedGeneration: vi.fn(async () => true),
  finalizeDeletedServers: vi.fn(async () => 0),
  listDrainedGenerationIds: vi.fn(async () => []),
  loadAcceptedGeneration: vi.fn(async () => null),
  markFailed: vi.fn(async () => ({ applied: true, retryAt: null })),
  markReady: vi.fn(async (_input: { inventory: unknown }) => true),
  markStarting: vi.fn(async () => true),
  synchronizeDesired: vi.fn(async (_input: { onDemand?: boolean; userId?: string }) => []),
  synchronizeShared: vi.fn(async (_input: { onDemand?: boolean; serverIds?: readonly string[] }): Promise<unknown[]> => []),
  touchLastUsed: vi.fn(async () => undefined)
}));
const sessions = vi.hoisted(() => ({ create: vi.fn() }));
const projectLoader = vi.hoisted(() => vi.fn(async (_userId: string, _serverIds: readonly string[]): Promise<unknown[]> => []));
const personalLoader = vi.hoisted(() => vi.fn(async (_userId: string, _serverIds: readonly string[]): Promise<unknown[]> => []));

vi.mock("./runtimeRepository", () => ({ createPrismaMcpRuntimeRepository: () => repository }));
vi.mock("./defaultToolHive", () => ({
  createToolHiveRuntimeLifecycle: () => ({ cleanupOrphans: vi.fn(async () => undefined) }),
  getDefaultToolHiveDriver: () => ({})
}));
vi.mock("./toolhiveSessionFactory", () => ({ createToolHiveMcpSessionFactory: () => sessions }));
vi.mock("./runPlanRepository", () => ({
  createPrismaMcpCapabilityCatalogLoader: () => vi.fn(),
  createPrismaMcpProjectRunPlanLoader: () => projectLoader,
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
  it.each([false, true])("revalidates a selected tool from a 1024-tool inventory (Project: %s)", async (projectScope) => {
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
    projectLoader.mockResolvedValue([record]);
    const start = vi.spyOn(McpRuntimeCoordinator.prototype, "start").mockImplementation(() => undefined);
    const ensurePersonal = vi.spyOn(McpRuntimeCoordinator.prototype, "ensureUserServersReady").mockResolvedValue(undefined);
    const ensureShared = vi.spyOn(McpRuntimeCoordinator.prototype, "ensureSharedServersReady").mockResolvedValue(undefined);
    const isLive = vi.spyOn(McpRuntimeCoordinator.prototype, "hasLiveGeneration").mockReturnValue(true);
    const selected = namespacedMcpToolName(record.namespace, `tool_${MCP_SERVER_TOOL_LIMIT}`);
    const prepare = (allowedToolNames?: readonly string[]) => projectScope
      ? defaultMcpRunPlan.prepareProject("user", [record.serverId], { allowedToolNames })
      : defaultMcpRunPlan.prepare("user", { allowedServerIds: [record.serverId], allowedToolNames });
    try {
      await expect(prepare([selected])).resolves.toMatchObject({
        ok: true, snapshot: { tools: [{ namespacedName: selected }] }
      });
      // The model-facing full-inventory limit stays in force.
      await expect(prepare()).resolves.toMatchObject({ ok: false, code: "mcp_plan_too_large" });
      if (projectScope) {
        expect(ensureShared).toHaveBeenCalledWith([record.serverId]);
        expect(ensurePersonal).not.toHaveBeenCalled();
      } else {
        expect(ensurePersonal).toHaveBeenCalledWith("user", [record.serverId], undefined);
        expect(ensureShared).not.toHaveBeenCalled();
      }
    } finally {
      await (scope.__aiqsaMcpRuntimeCoordinator as McpRuntimeCoordinator | undefined)?.stop();
      delete scope.__aiqsaMcpRuntimeCoordinator;
      if (previous) scope.__aiqsaMcpRuntimeCoordinator = previous;
      start.mockRestore(); ensurePersonal.mockRestore(); ensureShared.mockRestore(); isLive.mockRestore();
      personalLoader.mockClear(); projectLoader.mockClear();
    }
  });
});

describe("default Project MCP plans", () => {
  const tool = { definitionHash: "a".repeat(64), description: "Echo", inputSchema: { type: "object" }, name: "echo" };
  const sharedLaunch: McpRuntimeGenerationLaunch = {
    callTimeoutMs: 1_000,
    fingerprint: "shared-fingerprint",
    generationId: "shared-generation",
    headers: {},
    publishedTools: { kind: "names", names: new Set(["echo"]) },
    redactionValues: [],
    retryAt: null,
    startupTimeoutMs: 1_000,
    url: "https://mcp.example.test/mcp"
  };

  it("starts the shared runtime on a cold coordinator before planning, without any member runtime", async () => {
    const scope = globalThis as typeof globalThis & { __aiqsaMcpRuntimeCoordinator?: McpRuntimeCoordinator };
    const previous = scope.__aiqsaMcpRuntimeCoordinator;
    delete scope.__aiqsaMcpRuntimeCoordinator;
    let persisted: McpRuntimeInventory | null = null;
    const session: McpRuntimeSession = {
      callTool: vi.fn(),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => [tool]),
      ping: vi.fn(async () => undefined)
    };
    repository.synchronizeDesired.mockImplementation(async () => []);
    repository.synchronizeShared.mockImplementation(async (input) => input.onDemand ? [sharedLaunch] : []);
    repository.markReady.mockImplementation(async ({ inventory }) => {
      persisted = inventory as McpRuntimeInventory;
      return true;
    });
    sessions.create.mockImplementation(async () => session);
    projectLoader.mockImplementation(async (): Promise<McpRunPlanRecord[]> => persisted ? [{
      credentialSources: [],
      enabled: true,
      errorCode: null,
      externalAccountLabel: null,
      fingerprint: sharedLaunch.fingerprint,
      generationId: sharedLaunch.generationId,
      inventory: persisted,
      inventoryUpdatedAt: new Date(),
      namespace: "shared_tools",
      readiness: "ready",
      revisionId: "revision-1",
      serverId: "server-1",
      serverName: "Shared tools"
    }] : []);
    try {
      const plan = await defaultMcpRunPlan.prepareProject("member-b", ["server-1"]);

      expect(plan).toMatchObject({
        bindings: [{ fingerprint: "shared-fingerprint", runtimeGenerationId: "shared-generation", serverId: "server-1" }],
        ok: true,
        snapshot: { tools: [{ originalName: "echo" }] }
      });
      expect(repository.synchronizeShared).toHaveBeenCalledWith({
        now: expect.any(Date), onDemand: true, serverIds: ["server-1"]
      });
      // No member's McpUserServer is created, enabled or reconciled for the Project.
      for (const [input] of repository.synchronizeDesired.mock.calls) {
        expect(input).not.toHaveProperty("userId");
        expect(input).not.toHaveProperty("onDemand");
      }
      // The initiator's tool restrictions apply to the shared runtime's projection.
      expect(projectLoader).toHaveBeenCalledWith("member-b", ["server-1"]);
      expect(repository.markReady.mock.invocationCallOrder[0])
        .toBeLessThan(projectLoader.mock.invocationCallOrder[0]!);
    } finally {
      await (scope.__aiqsaMcpRuntimeCoordinator as McpRuntimeCoordinator | undefined)?.stop();
      delete scope.__aiqsaMcpRuntimeCoordinator;
      if (previous) scope.__aiqsaMcpRuntimeCoordinator = previous;
    }
  });
});
