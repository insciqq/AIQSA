import { describe, expect, it, vi } from "vitest";
import type { UserMcpServer } from "@/lib/contracts/mcp";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import type { McpRepository, McpRepositoryResult, McpUserServerState } from "./repositoryContract";
import { createPersonalMcpCreateHandler, createPersonalMcpListHandler, createPersonalMcpUpdateHandler } from "./personalHandlers";

const server: UserMcpServer = {
  accountLabel: null,
  description: "Synthetic personal MCP",
  enabled: true,
  fields: [],
  id: "personal-1",
  knownToolCount: 1,
  name: "Synthetic personal MCP",
  oauthAvailable: false,
  oauthState: null,
  readiness: "idle",
  sourceType: "personal",
  tools: [{ description: "Echo", name: "echo" }]
};

function deps() {
  const createPersonalServer = vi.fn(async () => ({ kind: "ok" as const, value: { ...server, runtimeGenerationId: null, errorCode: null } }));
  const updateUserServer = vi.fn(async (): Promise<McpRepositoryResult<McpUserServerState>> =>
    ({ kind: "ok", value: { ...server, runtimeGenerationId: null, errorCode: null } }));
  const repository = { createPersonalServer, updateUserServer } as unknown as McpRepository;
  const resolveAuth = (async () => ({ userId: "user-1", user: { id: "user-1", role: "user", status: "active" } })) as unknown as RequestAuthResolver;
  return { repository, resolveAuth, createPersonalServer, updateUserServer };
}

describe("personal MCP handlers", () => {
  it("requires explicit acknowledgement for plain HTTP", async () => {
    const input = deps();
    const handler = createPersonalMcpCreateHandler(input);
    const response = await handler(new Request("http://aiqsa.test/api/me/mcp-connections", {
      body: JSON.stringify({ name: "Local", url: "http://127.0.0.1:8787/mcp", auth: { mode: "none" } }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(422);
    expect(input.createPersonalServer).not.toHaveBeenCalled();
  });

  it("passes an explicitly acknowledged HTTP endpoint to the owner-bound repository", async () => {
    const input = deps();
    const handler = createPersonalMcpCreateHandler(input);
    const response = await handler(new Request("http://aiqsa.test/api/me/mcp-connections", {
      body: JSON.stringify({ insecureHttpAcknowledged: true, name: "Local", url: "http://127.0.0.1:8787/mcp", auth: { mode: "none" } }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(201);
    expect(input.createPersonalServer).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ source: { kind: "remote", url: "http://127.0.0.1:8787/mcp" } }),
      userId: "user-1"
    }));
  });

  it("switches one tool through the owner-bound connection", async () => {
    const input = deps();
    const handler = createPersonalMcpUpdateHandler(input);
    const response = await handler(new Request("http://aiqsa.test/api/me/mcp-connections/personal-1", {
      body: JSON.stringify({ tool: { enabled: false, name: "echo" } }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }), { params: { connectionId: "personal-1" } });
    expect(response.status).toBe(200);
    expect(input.updateUserServer).toHaveBeenCalledWith({
      personalOnly: true,
      serverId: "personal-1",
      tool: { enabled: false, name: "echo" },
      userId: "user-1"
    });
  });

  it.each([
    { auth: { mode: "static", headerName: "Cookie" }, values: { authorization: "fixture-key" } },
    { auth: { mode: "static", headerName: "Authorization\r\nHost" }, values: { authorization: "fixture-key" } },
    { auth: { mode: "static" }, values: { authorization: "fixture\r\nInjected: true" } },
    { auth: { mode: "static" }, values: { authorization: 42 } },
    { auth: { mode: "none" }, values: { authorization: "unexpected-key" } },
    { auth: "oauth" }
  ])("rejects malformed authentication before repository mutation", async (auth) => {
    const input = deps();
    const response = await createPersonalMcpCreateHandler(input)(new Request("https://aiqsa.test/api/me/mcp-connections", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fixture", url: "https://mcp.example.test/mcp", ...auth })
    }));
    expect(response.status).toBe(422);
    expect(input.createPersonalServer).not.toHaveBeenCalled();
  });

  it("starts runtime preparation without waiting for it and returns the safe persisted state", async () => {
    const input = deps();
    input.updateUserServer.mockResolvedValueOnce({ kind: "ok", value: {
      ...server, errorCode: "private diagnostic", runtimeGenerationId: "private-generation", userDisabledToolNames: ["echo"]
    } });
    const listUserServers = vi.fn(async () => [{ ...server, errorCode: null, runtimeGenerationId: null }]);
    input.repository.listUserServers = listUserServers;
    // Readiness never settles here: the request must not wait for it.
    const onConnectionChanged = vi.fn(() => new Promise<void>(() => undefined));
    const response = await createPersonalMcpUpdateHandler({ ...input, onConnectionChanged })(new Request("https://aiqsa.test/api/me/mcp-connections/personal-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true })
    }), { params: { connectionId: "personal-1" } });
    expect(response.status).toBe(200);
    expect(onConnectionChanged).toHaveBeenCalledWith("user-1", "personal-1");
    expect(listUserServers).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.server).toMatchObject({ readiness: "idle", userDisabledToolNames: ["echo"] });
    expect(body.server).not.toHaveProperty("runtimeGenerationId");
    expect(body.server).not.toHaveProperty("errorCode");
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("creates a connection without waiting for its runtime and ignores a legacy tool selection", async () => {
    const input = deps();
    let failPreparation!: (error: Error) => void;
    const onConnectionChanged = vi.fn(() => new Promise<void>((_resolve, reject) => { failPreparation = reject; }));
    const response = await createPersonalMcpCreateHandler({ ...input, onConnectionChanged })(new Request("https://aiqsa.test/api/me/mcp-connections", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fixture", selectedToolNames: ["echo"], url: "https://mcp.example.test/mcp" })
    }));
    expect(response.status).toBe(201);
    expect(onConnectionChanged).toHaveBeenCalledWith("user-1", "personal-1");
    expect(input.createPersonalServer).toHaveBeenCalledWith(expect.not.objectContaining({ selectedToolNames: expect.anything() }));
    // A later preparation failure stays in the background.
    failPreparation(new Error("runtime unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await response.json()).server).toMatchObject({ id: "personal-1", tools: [{ name: "echo" }] });
  });

  it("does not start a runtime for a disabled connection or one awaiting OAuth", async () => {
    for (const value of [{ ...server, enabled: false }, { ...server, oauthAvailable: true, oauthState: "disconnected" as const }]) {
      const input = deps();
      input.updateUserServer.mockResolvedValueOnce({ kind: "ok", value: { ...value, errorCode: null, runtimeGenerationId: null } });
      const onConnectionChanged = vi.fn(async () => undefined);
      const response = await createPersonalMcpUpdateHandler({ ...input, onConnectionChanged })(new Request("https://aiqsa.test/api/me/mcp-connections/personal-1", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: value.enabled })
      }), { params: { connectionId: "personal-1" } });
      expect(response.status).toBe(200);
      expect(onConnectionChanged).not.toHaveBeenCalled();
    }
  });

  it("never wakes runtimes from settings reads", async () => {
    const input = deps();
    input.repository.listUserServers = vi.fn(async () => [{ ...server, errorCode: null, runtimeGenerationId: null }]);
    const onConnectionChanged = vi.fn(async () => undefined);
    const response = await createPersonalMcpListHandler({ ...input, onConnectionChanged })(new Request("https://aiqsa.test/api/me/mcp-connections"));
    expect(response.status).toBe(200);
    expect(onConnectionChanged).not.toHaveBeenCalled();
  });

  it.each([{}, { enabled: "yes" }, { tool: { name: "", enabled: true } }])("rejects invalid empty updates", async (body) => {
    const input = deps();
    const response = await createPersonalMcpUpdateHandler(input)(new Request("https://aiqsa.test/api/me/mcp-connections/personal-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }), { params: { connectionId: "personal-1" } });
    expect(response.status).toBe(400);
    expect(input.updateUserServer).not.toHaveBeenCalled();
  });
});
