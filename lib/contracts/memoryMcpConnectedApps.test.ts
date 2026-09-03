import { describe, expect, it } from "vitest";
import {
  decodeMemoryMcpConnectedAppResponse,
  decodeMemoryMcpConnectedAppsResponse,
  decodeMemoryMcpConnectionId
} from "./memoryMcpConnectedApps";

const activeApp = {
  connectionId: "grant-1",
  clientName: "Codex CLI",
  clientOrigin: "https://chatgpt.com",
  connectedAt: "2026-09-03T01:00:00.000Z",
  lastUsedAt: "2026-09-03T01:30:00.000Z",
  revokedAt: null,
  state: "ACTIVE"
};

describe("Memory MCP Connected Apps contracts", () => {
  it("accepts the client-safe active and revoked projections", () => {
    expect(decodeMemoryMcpConnectedAppsResponse({ apps: [activeApp] }))
      .toEqual({ apps: [activeApp] });
    expect(decodeMemoryMcpConnectedAppResponse({
      app: {
        ...activeApp,
        revokedAt: "2026-09-03T02:00:00.000Z",
        state: "REVOKED"
      }
    })).not.toBeNull();
    expect(decodeMemoryMcpConnectedAppsResponse({
      apps: [{ ...activeApp, clientOrigin: "com.example.client:" }]
    })).not.toBeNull();
  });

  it("rejects inconsistent states and Memory or owner fields", () => {
    expect(decodeMemoryMcpConnectedAppsResponse({
      apps: [{ ...activeApp, revokedAt: activeApp.connectedAt }]
    })).toBeNull();
    expect(decodeMemoryMcpConnectedAppsResponse({
      apps: [{ ...activeApp, memoryText: "private fact" }]
    })).toBeNull();
    expect(decodeMemoryMcpConnectedAppsResponse({
      apps: [{ ...activeApp, userId: "owner-1" }]
    })).toBeNull();
    expect(decodeMemoryMcpConnectedAppsResponse({
      apps: [{ ...activeApp, clientOrigin: "javascript:" }]
    })).toBeNull();
    expect(decodeMemoryMcpConnectedAppsResponse({
      apps: [{ ...activeApp, clientOrigin: "https:" }]
    })).toBeNull();
    expect(decodeMemoryMcpConnectedAppsResponse({
      apps: [{ ...activeApp, clientOrigin: "com.example.client:/callback" }]
    })).toBeNull();
  });

  it("validates the opaque revoke target", () => {
    expect(decodeMemoryMcpConnectionId("grant-1")).toBe("grant-1");
    expect(decodeMemoryMcpConnectionId("grant 1")).toBeNull();
    expect(decodeMemoryMcpConnectionId("x".repeat(129))).toBeNull();
  });
});
