import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAdmissionService, type WorkspaceAdmissionRepository } from "./admission";
import { getWorkspaceConfig, WORKSPACE_DEFAULT_IMAGE_REF } from "./config";
import { loadPinnedOfficialWorkspaceToolCatalog } from "./microsandboxRuntime";

vi.mock("./microsandboxRuntime", () => ({
  loadPinnedOfficialWorkspaceToolCatalog: vi.fn(async () => ({
    hash: "a".repeat(64), mcpVersion: "0.6.16", runtimeVersion: "0.6.16", tools: []
  }))
}));

type StoredSession = Awaited<ReturnType<WorkspaceAdmissionRepository["findSession"]>>;

function fixture(agentReady?: boolean, internetEnabled = true, session: StoredSession = null) {
  const read = vi.fn(async () => ({ agentReady, state: "ready" as const,
    mcpVersion: "0.6.16", runtimeVersion: "0.6.16" }));
  const service = createWorkspaceAdmissionService({
    config: getWorkspaceConfig({ AIQSA_WORKSPACE_CODE_MCP_MAX_CALLS: "50" }),
    health: { invalidate() {}, read },
    policy: { read: async () => ({ enabled: true, internetEnabled, version: 1 }), update: vi.fn() },
    repository: { findSession: async () => session }
  });
  return { read, service };
}

describe("Workspace guest-code MCP admission", () => {
  it("freezes code-call budgets only for Internet-On, non-Agent runs whose runner relays the gateway", async () => {
    const admitted = await fixture(true).service.prepare(request);
    expect(admitted.ok && admitted.plan.normalized.codeMcp).toEqual({ version: 1, maxCalls: 50, maxConcurrent: 4, maxPerSecond: 10 });
    for (const [agentReady, internetEnabled, agentEnabled] of [[false, true, false], [undefined, true, false], [true, false, false],
      [true, true, true]] as const) {
      const result = await fixture(agentReady, internetEnabled).service.prepare({ ...request, ...(agentEnabled ? { agentEnabled } : {}) });
      expect(result.ok && result.plan.normalized.codeMcp).toBeUndefined();
    }
  });
});

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

describe("Workspace session image at admission", () => {
  const stored = { id: "ws_existing", imageRef: "aiqsa-workspace:0.1.29", internetEnabled: false, sandboxName: "aiqsa-ws-existing" };

  it("starts a new session from the current image", async () => {
    await expect(fixture().service.prepare(request)).resolves.toMatchObject({
      ok: true, plan: { normalized: { imageRef: WORKSPACE_DEFAULT_IMAGE_REF, internetEnabled: true } }
    });
  });

  it("keeps the image a session's guest disk was created from", async () => {
    await expect(fixture(undefined, true, { ...stored, runtimeSandboxId: "runtime-1" }).service.prepare(request)).resolves.toMatchObject({
      ok: true,
      plan: { normalized: { imageRef: stored.imageRef, internetEnabled: false }, sandboxName: stored.sandboxName, sessionId: stored.id }
    });
  });

  it("starts the next guest of a session without a disk from the current image, keeping its frozen network", async () => {
    await expect(fixture(undefined, true, { ...stored, runtimeSandboxId: null }).service.prepare(request)).resolves.toMatchObject({
      ok: true,
      plan: { normalized: { imageRef: WORKSPACE_DEFAULT_IMAGE_REF, internetEnabled: false }, sandboxName: stored.sandboxName, sessionId: stored.id }
    });
  });
});
