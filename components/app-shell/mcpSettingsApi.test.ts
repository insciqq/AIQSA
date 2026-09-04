import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disconnectUserMcpServer,
  loadUserMcpServers,
  updateUserMcpServer,
  userMcpOAuthAction
} from "./mcpSettingsApi";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

const server = {
  accountLabel: null,
  description: "Team memory",
  enabled: true,
  operationalStatus: "inactive" as const,
  fields: [{
    configured: false,
    description: "Personal token",
    label: "API key",
    maxLength: 128,
    minLength: 8,
    sensitive: true,
    slotKey: "api_key",
    source: "missing",
    valueType: "secret"
  }],
  id: "server-1",
  knownToolCount: 1,
  name: "Mem0",
  oauthAvailable: false,
  oauthState: null,
  readiness: "needs_setup",
  tools: [{ description: "Remember a fact", name: "remember" }]
};

describe("MCP settings API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes the entitled user catalog without exposing secret values", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ servers: [server] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadUserMcpServers()).resolves.toEqual([server]);
    expect(fetchMock).toHaveBeenCalledWith("/api/me/mcp", expect.objectContaining({ cache: "no-store" }));
  });

  it("updates one server independently and supports OAuth disconnect", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ server: { ...server, enabled: false, readiness: "disabled" } }))
      .mockResolvedValueOnce(jsonResponse({ status: "disconnected" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateUserMcpServer("server/1", { enabled: false })).resolves.toMatchObject({ enabled: false });
    await expect(disconnectUserMcpServer("server/1")).resolves.toBe("disconnected");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/me/mcp/server%2F1");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/me/mcp/server%2F1/oauth/disconnect");
  });

  it("drops internal diagnostics and rejects absent or inconsistent operational status", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ servers: [{
      ...server, errorCode: "mcp_artifact_missing", runtimeGenerationId: "private-generation"
    }] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadUserMcpServers()).toEqual([server]);
    for (const operationalStatus of [undefined, "ready", "active"]) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ servers: [{ ...server, operationalStatus }] }));
      await expect(loadUserMcpServers()).rejects.toThrow();
    }
  });

  it("returns stable coded errors with bounded setup issues and OAuth actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: "invalid_mcp_values",
      issues: [{ code: "oauth_required", path: "oauth" }]
    }, 400)));

    await expect(updateUserMcpServer("server-1", { values: { api_key: "short" } })).rejects.toMatchObject({
      code: "invalid_mcp_values",
      issues: [{ code: "oauth_required", path: "oauth" }],
      status: 400
    });
    expect(userMcpOAuthAction("server/1", false)).toBe("/api/me/mcp/server%2F1/oauth/connect");
    expect(userMcpOAuthAction("server/1", true)).toBe("/api/me/mcp/server%2F1/oauth/reconnect");
  });
});
