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

  it("reports connected once consent is stored and enabled while the runtime is still starting", async () => {
    mocks.listUserServers.mockResolvedValue([{ id: "personal", sourceType: "personal", readiness: "starting" }]);
    // A slow runtime never settles within the callback.
    mocks.ensureReady.mockReturnValue(new Promise(() => undefined));
    expect(await settleDefaultMcpOAuth(input)).toEqual({ kind: "ok" });
    expect(mocks.updateUserServer).toHaveBeenCalledWith({ enabled: true, serverId: "personal", userId: "owner" });
    expect(mocks.ensureReady).toHaveBeenCalledWith("owner", ["personal"], expect.any(AbortSignal));
  });

  it("keeps the connected outcome when the background warm-up fails", async () => {
    mocks.listUserServers.mockResolvedValue([{ id: "personal", sourceType: "personal", readiness: "unavailable" }]);
    mocks.ensureReady.mockRejectedValue(new Error("runtime unavailable"));
    expect(await settleDefaultMcpOAuth(input)).toEqual({ kind: "ok" });
  });

  it("reports failed when the enable step fails", async () => {
    mocks.updateUserServer.mockResolvedValue({ kind: "invalid_values", issues: [] });
    expect(await settleDefaultMcpOAuth(input)).toEqual({ kind: "failed" });
    expect(mocks.ensureReady).not.toHaveBeenCalled();
  });

  it("keeps installation-managed connections on the existing settlement path", async () => {
    mocks.listUserServers.mockResolvedValue([{ id: "personal", sourceType: "installation", readiness: "idle" }]);
    expect(await settleDefaultMcpOAuth(input)).toEqual({ kind: "ok" });
    expect(mocks.ensureReady).not.toHaveBeenCalled();
  });
});
