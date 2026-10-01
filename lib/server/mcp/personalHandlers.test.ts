import { describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration, UserMcpServer } from "@/lib/contracts/mcp";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import type { McpRepository } from "./repositoryContract";
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
  const updateUserServer = vi.fn(async () => ({ kind: "ok" as const, value: { ...server, runtimeGenerationId: null, errorCode: null } }));
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

  it("updates one selected tool through the owner-bound connection", async () => {
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

  it("awaits mutation startup and returns safe refreshed state without internal identifiers", async () => {
    const input = deps();
    const listUserServers = vi.fn(async () => [{ ...server, errorCode: "private diagnostic", runtimeGenerationId: "private-generation", readiness: "ready" as const }]);
    input.repository.listUserServers = listUserServers;
    const onConnectionChanged = vi.fn(async () => undefined);
    const response = await createPersonalMcpUpdateHandler({ ...input, onConnectionChanged })(new Request("https://aiqsa.test/api/me/mcp-connections/personal-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true })
    }), { params: { connectionId: "personal-1" } });
    expect(onConnectionChanged).toHaveBeenCalledWith("user-1", "personal-1");
    expect(listUserServers).toHaveBeenCalledWith("user-1");
    const body = await response.json();
    expect(body.server).toMatchObject({ readiness: "ready" });
    expect(body.server).not.toHaveProperty("runtimeGenerationId");
    expect(body.server).not.toHaveProperty("errorCode");
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("never wakes runtimes from settings reads", async () => {
    const input = deps();
    input.repository.listUserServers = vi.fn(async () => [{ ...server, errorCode: null, runtimeGenerationId: null }]);
    const onConnectionChanged = vi.fn(async () => undefined);
    const response = await createPersonalMcpListHandler({ ...input, onConnectionChanged })(new Request("https://aiqsa.test/api/me/mcp-connections"));
    expect(response.status).toBe(200);
    expect(onConnectionChanged).not.toHaveBeenCalled();
  });

  it.each(["personal_mcp_limit_reached", "mcp_enabled_server_limit_reached"] as const)(
    "refuses %s before any OAuth discovery or validation request",
    async (limit) => {
      const input = deps();
      const personalCreationLimit = vi.fn(async () => limit);
      const prepareOAuthDraft = vi.fn(async (draft: McpDraftConfiguration) => draft);
      input.repository.personalCreationLimit = personalCreationLimit;
      const response = await createPersonalMcpCreateHandler({ ...input, prepareOAuthDraft })(new Request("https://aiqsa.test/api/me/mcp-connections", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Fixture", url: "https://mcp.example.test/mcp", auth: { mode: "oauth" } })
      }));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: limit });
      expect(personalCreationLimit).toHaveBeenCalledWith("user-1");
      expect(prepareOAuthDraft).not.toHaveBeenCalled();
      expect(input.createPersonalServer).not.toHaveBeenCalled();
    }
  );

  it.each(["personal_mcp_limit_reached", "mcp_enabled_server_limit_reached"] as const)(
    "maps the authoritative %s from creation to 409",
    async (limit) => {
      const input = deps();
      input.createPersonalServer.mockResolvedValueOnce({ kind: limit } as never);
      const response = await createPersonalMcpCreateHandler(input)(new Request("https://aiqsa.test/api/me/mcp-connections", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Fixture", url: "https://mcp.example.test/mcp" })
      }));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: limit });
    }
  );

  it("maps an enable past the enabled-server limit to 409", async () => {
    const input = deps();
    input.updateUserServer.mockResolvedValueOnce({ kind: "mcp_enabled_server_limit_reached" } as never);
    const response = await createPersonalMcpUpdateHandler(input)(new Request("https://aiqsa.test/api/me/mcp-connections/personal-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true })
    }), { params: { connectionId: "personal-1" } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "mcp_enabled_server_limit_reached" });
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
