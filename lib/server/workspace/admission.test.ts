import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAdmissionService } from "./admission";
import { getWorkspaceConfig } from "./config";
import { loadPinnedOfficialWorkspaceToolCatalog } from "./microsandboxRuntime";

vi.mock("./microsandboxRuntime", () => ({
  loadPinnedOfficialWorkspaceToolCatalog: vi.fn(async () => ({
    hash: "a".repeat(64), mcpVersion: "0.6.16", runtimeVersion: "0.6.16", tools: []
  }))
}));

function fixture(agentReady?: boolean) {
  const read = vi.fn(async () => ({ agentReady, state: "ready" as const,
    mcpVersion: "0.6.16", runtimeVersion: "0.6.16" }));
  const service = createWorkspaceAdmissionService({
    config: getWorkspaceConfig({}),
    health: { invalidate() {}, read },
    policy: { read: async () => ({ enabled: true, internetEnabled: true, version: 1 }), update: vi.fn() },
    repository: { findSession: async () => null }
  });
  return { read, service };
}

const request = { assistantMessageId: "answer", chatId: "chat", enabled: true,
  modelSupportsTools: true, runId: "run", userMessageId: "question" };

describe("Workspace Agent admission", () => {
  it.each([false, undefined])("rejects unsupported Agent before binding a session or loading tools: %s", async (agentReady) => {
    vi.mocked(loadPinnedOfficialWorkspaceToolCatalog).mockClear();
    const { read, service } = fixture(agentReady);
    await expect(service.prepare({ ...request, agentEnabled: true })).resolves.toEqual({
      code: "agent_unavailable", ok: false, status: 503
    });
    expect(read).toHaveBeenCalledWith({ fresh: true });
    expect(loadPinnedOfficialWorkspaceToolCatalog).not.toHaveBeenCalled();
  });

  it("admits ordinary Workspace without Agent support and Agent with explicit support", async () => {
    await expect(fixture(false).service.prepare(request)).resolves.toMatchObject({ ok: true });
    await expect(fixture(true).service.prepare({ ...request, agentEnabled: true })).resolves.toMatchObject({ ok: true });
  });
});
