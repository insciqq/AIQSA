import { describe, expect, it } from "vitest";
import type { UserMcpServer } from "@/lib/contracts/mcp";
import {
  hasTransitioningMcpServer,
  isMcpReadinessTransitioning,
  mcpReadinessPresentation
} from "./mcpReadiness";

describe("MCP readiness presentation", () => {
  it("keeps progress, actionable setup, failure, and ready states distinct", () => {
    expect(mcpReadinessPresentation("queued")).toEqual({ kind: "progress", label: "Activating" });
    expect(mcpReadinessPresentation("starting")).toEqual({ kind: "progress", label: "Starting runtime" });
    expect(mcpReadinessPresentation("needs_setup")).toEqual({ kind: "attention", label: "Needs setup" });
    expect(mcpReadinessPresentation("unavailable")).toEqual({ kind: "failed", label: "Activation failed" });
    expect(mcpReadinessPresentation("ready")).toEqual({ kind: "ready", label: "Ready" });
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
