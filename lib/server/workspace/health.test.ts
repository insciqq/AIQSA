import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRuntime } from "./runtime";
import { createWorkspaceHealthService, sanitizeWorkspaceRuntimeHealth } from "./health";

describe("Workspace runtime health", () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [undefined, true, false],
    ["true", true, false]
  ])("requires explicit Agent readiness and runtime methods (%s, %s)", async (agentReady, methods, expected) => {
    const runtime = {
      health: async () => ({ agentReady, imageReady: true, mcpVersion: "0.6.16",
        runtimeVersion: "0.6.16", state: "ready", virtualizationReady: true }),
      ...(methods ? { startAgent: vi.fn(), pollAgent: vi.fn() } : {})
    } as unknown as WorkspaceRuntime;
    const health = await createWorkspaceHealthService({ runtime }).read();
    expect(health.state).toBe("ready");
    expect(health.agentReady === true).toBe(expected);
    expect(sanitizeWorkspaceRuntimeHealth({ ...health, agentReady: true, imageReady: false }).agentReady)
      .not.toBe(true);
  });

  it("requires exact runtime/MCP versions and complete readiness evidence", () => {
    expect(sanitizeWorkspaceRuntimeHealth({
      imageReady: true,
      mcpVersion: "0.6.16",
      runtimeVersion: "0.6.16",
      state: "ready",
      virtualizationReady: true
    })).toEqual({
      imageReady: true,
      mcpVersion: "0.6.16",
      runtimeVersion: "0.6.16",
      state: "ready",
      virtualizationReady: true
    });
    expect(sanitizeWorkspaceRuntimeHealth({
      imageReady: true,
      mcpVersion: "newer",
      runtimeVersion: "0.6.16",
      state: "ready",
      virtualizationReady: true
    })).toEqual({
      imageReady: true,
      reasonCode: "workspace_runtime_incompatible",
      runtimeVersion: "0.6.16",
      state: "unavailable",
      virtualizationReady: true
    });
  });

  it("deduplicates and briefly caches probes without exposing thrown errors", async () => {
    let now = 1_000;
    const health = vi.fn()
      .mockResolvedValueOnce({
        imageReady: true,
        mcpVersion: "0.6.16",
        runtimeVersion: "0.6.16",
        state: "ready",
        virtualizationReady: true
      })
      .mockRejectedValueOnce(new Error("raw secret failure"));
    const service = createWorkspaceHealthService({
      cacheTtlMs: 50,
      now: () => now,
      runtime: { health } as unknown as WorkspaceRuntime,
      timeoutMs: 100
    });
    const [first, concurrent] = await Promise.all([service.read(), service.read()]);
    expect(first).toEqual(concurrent);
    expect(health).toHaveBeenCalledTimes(1);
    now += 51;
    await expect(service.read()).resolves.toEqual({
      reasonCode: "workspace_runtime_unavailable",
      state: "unavailable"
    });
    expect(health).toHaveBeenCalledTimes(2);
  });
});
