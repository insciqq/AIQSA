import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceConfig } from "./config";
import { createWorkspaceRuntime } from "./defaultRuntime";
import { RemoteWorkspaceRuntime } from "./remoteRuntime";
import { WorkspaceRuntimeError, type WorkspaceRuntimeHealth } from "./runtime";

afterEach(() => vi.restoreAllMocks());

describe("default Workspace lifecycle", () => {
  it("observes the existing health probe result and original rejection without creating additional probes", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
    const probe = vi.spyOn(RemoteWorkspaceRuntime.prototype, "health");
    const runtime = createWorkspaceRuntime({ ...getWorkspaceConfig({ NODE_ENV: "test" }),
      runtimeMode: "remote", runnerUrl: new URL("http://127.0.0.1:4545"), runnerToken: "synthetic-token" });
    expect(probe).not.toHaveBeenCalled();
    const unavailable: WorkspaceRuntimeHealth = { state: "unavailable", reasonCode: "workspace_runtime_unavailable" };
    probe.mockResolvedValue(unavailable);
    for (let index = 0; index < 3; index += 1) await expect(runtime.health()).resolves.toBe(unavailable);
    const original = Object.assign(new WorkspaceRuntimeError("workspace_runtime_unavailable"), { message: "PRIVATE_HEALTH_DETAIL" });
    probe.mockRejectedValue(original);
    await expect(runtime.health()).rejects.toBe(original);
    const ready: WorkspaceRuntimeHealth = { state: "ready" };
    probe.mockResolvedValue(ready);
    await expect(runtime.health()).resolves.toBe(ready);
    await expect(runtime.health()).resolves.toBe(ready);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.event === "subsystem.recovered")).toEqual([
      expect.objectContaining({ subsystem: "workspace", stage: "health" })
    ]);
    expect(records.filter((record) => record.outcome === "failed")).toHaveLength(1);
    expect(probe).toHaveBeenCalledTimes(6);
    expect(lines.join("")).not.toContain("PRIVATE");
  });

  it("keeps the intentionally unconfigured optional runtime quiet", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const runtime = createWorkspaceRuntime(getWorkspaceConfig({ NODE_ENV: "test" }));
    await expect(runtime.health()).resolves.toMatchObject({ state: "unavailable", reasonCode: "workspace_runner_unconfigured" });
    expect(writer).not.toHaveBeenCalled();
  });
});
