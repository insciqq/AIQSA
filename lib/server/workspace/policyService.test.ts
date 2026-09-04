import { describe, expect, it } from "vitest";
import { createWorkspacePolicyService, WorkspacePolicyServiceError } from "./policyService";

const ready = {
  imageReady: true,
  mcpVersion: "0.6.16",
  runtimeVersion: "0.6.16",
  state: "ready" as const,
  virtualizationReady: true
};

describe("Workspace policy service", () => {
  it("returns runtime readiness beside persisted policy and maps stale writes", async () => {
    const service = createWorkspacePolicyService({
      health: { invalidate() {}, async read() { return ready; } },
      repository: {
        async read() { return { enabled: false, internetEnabled: true, version: 1 }; },
        async update() { return { kind: "stale" }; }
      }
    });
    await expect(service.read()).resolves.toEqual({
      enabled: false,
      internetEnabled: true,
      runtime: ready,
      version: 1
    });
    await expect(service.update({ enabled: true, expectedVersion: 1, userId: "admin-1" }))
      .rejects.toEqual(new WorkspacePolicyServiceError("workspace_policy_stale"));
  });
});
