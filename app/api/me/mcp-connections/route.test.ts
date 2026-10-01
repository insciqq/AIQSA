// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPersonalServer: vi.fn(),
  ensureUserServersReady: vi.fn(),
  kick: vi.fn(),
  updateUserServer: vi.fn()
}));

vi.mock("@/lib/server/auth/defaultAuth", () => ({
  resolveRequestAuth: vi.fn(async () => ({ user: { id: "user-1", role: "user", status: "active" }, userId: "user-1" }))
}));
vi.mock("@/lib/server/mcp/defaultMcp", () => ({
  mcpRepository: {
    createPersonalServer: mocks.createPersonalServer,
    listUserServers: vi.fn(async () => []),
    updateUserServer: mocks.updateUserServer
  }
}));
vi.mock("@/lib/server/mcp/defaultRuntime", () => ({
  getDefaultMcpRuntimeCoordinator: () => ({ ensureUserServersReady: mocks.ensureUserServersReady }),
  kickDefaultMcpRuntime: mocks.kick
}));
vi.mock("@/lib/server/mcp/personalOAuthDiscovery", () => ({ preparePersonalMcpOAuthDraft: vi.fn() }));

import { POST } from "./route";
import { PATCH } from "./[serverId]/route";

const server = {
  accountLabel: null, availableTools: [{ description: "Echo", name: "echo" }], description: "", enabled: true, errorCode: null,
  fields: [], id: "personal-1", knownToolCount: 1, name: "Fixture", oauthAvailable: false, oauthState: null, readiness: "idle",
  runtimeGenerationId: null, sourceType: "personal", tools: [], userDisabledToolNames: []
};

beforeEach(() => {
  vi.clearAllMocks();
  // Readiness never settles here: the routes must answer without it.
  mocks.ensureUserServersReady.mockImplementation(() => new Promise<void>(() => undefined));
  mocks.createPersonalServer.mockResolvedValue({ kind: "ok", value: server });
  mocks.updateUserServer.mockResolvedValue({ kind: "ok", value: server });
});

describe("personal MCP connection routes", () => {
  it("creates a connection and starts its runtime in the background without a deadline", async () => {
    const response = await POST(new Request("https://aiqsa.test/api/me/mcp-connections", {
      body: JSON.stringify({ name: "Fixture", url: "https://mcp.example.test/mcp" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));

    expect(response.status).toBe(201);
    expect((await response.json()).server).toMatchObject({ availableTools: [{ name: "echo" }], id: "personal-1" });
    expect(mocks.ensureUserServersReady).toHaveBeenCalledWith("user-1", ["personal-1"]);
    expect(mocks.ensureUserServersReady.mock.calls[0]).toHaveLength(2);
  });

  it("switches a tool and answers before the runtime settles", async () => {
    const response = await PATCH(new Request("https://aiqsa.test/api/me/mcp-connections/personal-1", {
      body: JSON.stringify({ tool: { enabled: false, name: "echo" } }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }), { params: Promise.resolve({ serverId: "personal-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.updateUserServer).toHaveBeenCalledWith({
      personalOnly: true, serverId: "personal-1", tool: { enabled: false, name: "echo" }, userId: "user-1"
    });
    expect(mocks.ensureUserServersReady).toHaveBeenCalledWith("user-1", ["personal-1"]);
    expect(mocks.ensureUserServersReady.mock.calls[0]).toHaveLength(2);
  });
});
