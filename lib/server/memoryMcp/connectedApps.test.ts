import { describe, expect, it, vi } from "vitest";
import {
  createListMemoryMcpConnectedAppsHandler,
  createRevokeMemoryMcpConnectedAppHandler
} from "./connectedApps";

const connectedAt = new Date("2026-09-03T01:00:00.000Z");
const lastUsedAt = new Date("2026-09-03T01:30:00.000Z");

function session(userId = "owner-1") {
  return {
    expiresAt: new Date("2026-09-04T01:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Owner",
      email: "owner@example.test",
      id: userId,
      role: "user",
      status: "active"
    },
    userId
  };
}

function activeApp() {
  return {
    clientName: "Codex CLI",
    clientOrigin: "https://chatgpt.com",
    connectedAt,
    grantId: "grant-1",
    lastUsedAt,
    revokedAt: null,
    state: "ACTIVE" as const
  };
}

describe("Memory MCP Connected Apps handlers", () => {
  it("lists only the authenticated owner's client-safe grant projection", async () => {
    const service = {
      listConnectedApps: vi.fn(async () => [activeApp()]),
      revokeConnectedApp: vi.fn(async () => false)
    };
    const GET = createListMemoryMcpConnectedAppsHandler({
      resolveAuth: async () => session(),
      service
    });
    const response = await GET(new Request("https://aiqsa.example/api/me/connected-apps"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      apps: [{
        connectionId: "grant-1",
        clientName: "Codex CLI",
        clientOrigin: "https://chatgpt.com",
        connectedAt: connectedAt.toISOString(),
        lastUsedAt: lastUsedAt.toISOString(),
        revokedAt: null,
        state: "ACTIVE"
      }]
    });
    expect(service.listConnectedApps).toHaveBeenCalledWith("owner-1");
  });

  it("revokes one owned grant and returns its terminal server state", async () => {
    const revokedAt = new Date("2026-09-03T02:00:00.000Z");
    const service = {
      listConnectedApps: vi.fn(async () => [{
        ...activeApp(),
        revokedAt,
        state: "REVOKED" as const
      }]),
      revokeConnectedApp: vi.fn(async () => true)
    };
    const DELETE = createRevokeMemoryMcpConnectedAppHandler({
      resolveAuth: async () => session(),
      service
    });
    const response = await DELETE(
      new Request("https://aiqsa.example/api/me/connected-apps/grant-1", {
        method: "DELETE"
      }),
      { params: { connectionId: "grant-1" } }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      app: { connectionId: "grant-1", revokedAt: revokedAt.toISOString(), state: "REVOKED" }
    });
    expect(service.revokeConnectedApp).toHaveBeenCalledWith("owner-1", "grant-1");
  });

  it("fails closed for anonymous, foreign, malformed, and failed requests", async () => {
    const service = {
      listConnectedApps: vi.fn(async () => [activeApp()]),
      revokeConnectedApp: vi.fn(async () => false)
    };
    const anonymous = createListMemoryMcpConnectedAppsHandler({
      resolveAuth: async () => null,
      service
    });
    expect((await anonymous(new Request(
      "https://aiqsa.example/api/me/connected-apps"
    ))).status).toBe(401);
    expect(service.listConnectedApps).not.toHaveBeenCalled();

    const DELETE = createRevokeMemoryMcpConnectedAppHandler({
      resolveAuth: async () => session("other-owner"),
      service
    });
    const foreign = await DELETE(
      new Request("https://aiqsa.example/api/me/connected-apps/grant-1", {
        method: "DELETE"
      }),
      { params: Promise.resolve({ connectionId: "grant-1" }) }
    );
    expect(foreign.status).toBe(404);
    expect(service.listConnectedApps).not.toHaveBeenCalled();

    const malformed = await DELETE(
      new Request("https://aiqsa.example/api/me/connected-apps/bad", {
        method: "DELETE"
      }),
      { params: { connectionId: "bad id" } }
    );
    expect(malformed.status).toBe(400);
    expect(service.revokeConnectedApp).toHaveBeenCalledTimes(1);
  });
});
