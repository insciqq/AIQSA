import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  listUserServers: vi.fn(),
  updateUserServer: vi.fn()
}));
vi.mock("./defaultMcp", () => ({
  defaultMcpDraftValidator: {},
  mcpRepository: { listUserServers: mocks.listUserServers, updateUserServer: mocks.updateUserServer }
}));
vi.mock("./defaultRuntime", () => ({
  getDefaultMcpRuntimeCoordinator: () => ({ ensureUserServersReady: mocks.ensureReady }),
  kickDefaultMcpRuntime: vi.fn()
}));
import { settleDefaultMcpOAuth } from "./defaultActivation";

const input = { configurationIdentity: "revision", purpose: "user" as const, serverId: "personal", userId: "owner" };

describe("personal OAuth settlement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.updateUserServer.mockResolvedValue({ kind: "ok", value: { enabled: true } });
    mocks.ensureReady.mockResolvedValue(undefined);
  });

  it("discovers a newly authorized personal connection before reporting ready", async () => {
    mocks.listUserServers.mockResolvedValueOnce([{ id: "personal", sourceType: "personal", readiness: "starting" }])
      .mockResolvedValueOnce([{ id: "personal", sourceType: "personal", readiness: "ready" }]);
    expect(await settleDefaultMcpOAuth(input)).toEqual({ kind: "ok" });
    expect(mocks.ensureReady).toHaveBeenCalledWith("owner", ["personal"], expect.any(AbortSignal));
  });

  it("does not report success if initial discovery failed", async () => {
    mocks.listUserServers.mockResolvedValue([{ id: "personal", sourceType: "personal", readiness: "unavailable" }]);
    expect(await settleDefaultMcpOAuth(input)).toEqual({ kind: "failed" });
  });

  it("keeps installation-managed connections on the existing settlement path", async () => {
    mocks.listUserServers.mockResolvedValue([{ id: "personal", sourceType: "installation", readiness: "idle" }]);
    expect(await settleDefaultMcpOAuth(input)).toEqual({ kind: "ok" });
    expect(mocks.ensureReady).not.toHaveBeenCalled();
  });
});
