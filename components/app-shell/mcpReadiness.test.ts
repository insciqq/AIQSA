import { describe, expect, it } from "vitest";
import type { UserMcpServer } from "@/lib/contracts/mcp";
import {
  hasTransitioningMcpServer,
  isMcpReadinessTransitioning,
  mcpSetupAttention,
  mcpReadinessPresentation
} from "./mcpReadiness";

describe("MCP readiness presentation", () => {
  it("surfaces initial setup and expired OAuth even before a server is enabled", () => {
    const server: Pick<UserMcpServer, "fields" | "oauthState" | "readiness"> = { fields: [], oauthState: null, readiness: "disabled" };
    expect(mcpSetupAttention(server)).toBeNull();
    expect(mcpSetupAttention({ ...server, fields: [{ configured: false } as UserMcpServer["fields"][number]] })).toBe("needs_setup");
    expect(mcpSetupAttention({ ...server, oauthState: "disconnected" })).toBe("needs_authorization");
    expect(mcpSetupAttention({ ...server, oauthState: "reauthorization_required" })).toBe("reauthorization_required");
    expect(mcpSetupAttention({ ...server, oauthState: "ready", readiness: "idle" })).toBeNull();
    expect(mcpSetupAttention({ ...server, readiness: "starting" })).toBeNull();
    expect(mcpSetupAttention({ ...server, readiness: "unavailable" })).toBe("unavailable");
  });
  it("keeps progress, actionable setup, failure, and ready states distinct", () => {
    expect(mcpReadinessPresentation("queued")).toEqual({ kind: "progress", label: "Activating" });
    expect(mcpReadinessPresentation("starting")).toEqual({ kind: "progress", label: "Starting runtime" });
    expect(mcpReadinessPresentation("needs_setup")).toEqual({ kind: "attention", label: "Needs setup" });
    expect(mcpReadinessPresentation("unavailable")).toEqual({ kind: "failed", label: "Runtime unavailable" });
    expect(mcpReadinessPresentation("unavailable", "mcp_health_check_failed")).toMatchObject({ kind: "failed", label: expect.stringContaining("health check failed") });
    expect(mcpReadinessPresentation("ready")).toEqual({ kind: "ready", label: "Ready" });
    expect(mcpReadinessPresentation("idle")).toEqual({ kind: "ready", label: "Available on demand" });
  });

  it("names the registry runtime codes before and after the shared contract carries them", () => {
    expect(mcpReadinessPresentation("unavailable", "mcp_internal_address_forbidden")).toEqual({
      kind: "failed", label: "This address belongs to AIQSA itself, so MCP cannot use it."
    });
    expect(mcpReadinessPresentation("unavailable", "mcp_local_network_disabled").label).toMatch(/local network/);
    expect(mcpReadinessPresentation("unavailable", "mcp_tool_disabled").label).toMatch(/switched off/);
    expect(mcpReadinessPresentation("unavailable", "mcp_tool_definition_changed").label).toMatch(/tool changed/);
  });

  it("polls only enabled servers in a transient readiness state", () => {
    const server = {
      enabled: true,
      readiness: "queued"
    } as UserMcpServer;

    expect(isMcpReadinessTransitioning("queued")).toBe(true);
    expect(isMcpReadinessTransitioning("needs_setup")).toBe(false);
    expect(hasTransitioningMcpServer([server])).toBe(true);
    expect(hasTransitioningMcpServer([{ ...server, enabled: false }])).toBe(false);
    expect(hasTransitioningMcpServer([{ ...server, readiness: "unavailable" }])).toBe(false);
  });
});
