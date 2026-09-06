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
    expect(mcpReadinessPresentation("unavailable")).toEqual({ kind: "failed", label: "Activation failed" });
    expect(mcpReadinessPresentation("ready")).toEqual({ kind: "ready", label: "Ready" });
    expect(mcpReadinessPresentation("idle")).toEqual({ kind: "ready", label: "Available on demand" });
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
