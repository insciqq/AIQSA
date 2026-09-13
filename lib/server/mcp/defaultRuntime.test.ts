import { describe, expect, it, vi } from "vitest";
import { getContext, runWithContext, type ObservabilityContext } from "../observability";
import { getDefaultMcpRuntimeCoordinator, kickDefaultMcpRuntime } from "./defaultRuntime";
import { McpRuntimeCoordinator } from "./runtimeCoordinator";

const repository = vi.hoisted(() => ({
  deleteDrainedGeneration: vi.fn(async () => true),
  finalizeDeletedServers: vi.fn(async () => 0),
  listDrainedGenerationIds: vi.fn(async () => []),
  loadAcceptedGeneration: vi.fn(async () => null),
  markFailed: vi.fn(async () => ({ applied: true, retryAt: null })),
  markReady: vi.fn(async () => true),
  markStarting: vi.fn(async () => true),
  synchronizeDesired: vi.fn(async () => []),
  touchLastUsed: vi.fn(async () => undefined)
}));

vi.mock("./runtimeRepository", () => ({ createPrismaMcpRuntimeRepository: () => repository }));
vi.mock("./defaultToolHive", () => ({
  createToolHiveRuntimeLifecycle: () => ({ cleanupOrphans: vi.fn(async () => undefined) }),
  getDefaultToolHiveDriver: () => ({})
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
