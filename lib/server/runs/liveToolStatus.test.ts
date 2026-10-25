import { describe, expect, it } from "vitest";
import { liveRunPhaseStatus, liveToolCallStatus } from "./liveToolStatus";

describe("live run phase status", () => {
  it("names only the phase, never content or progress counts it cannot prove", () => {
    const payload = (phase: Parameters<typeof liveRunPhaseStatus>[0]["phase"], count?: number) => {
      const event = liveRunPhaseStatus({ phase, ...(count !== undefined ? { count } : {}) });
      return event.type === "artifact" && event.data.artifactType === "summary" ? event.data.payload : null;
    };
    expect(payload("model")).toEqual({ stage: "model", status: "waiting" });
    expect(payload("tools", 2.7)).toEqual({ count: 2, stage: "tools", status: "running" });
    expect(payload("tools", -1)).toEqual({ count: 0, stage: "tools", status: "running" });
    expect(payload("knowledge")).toEqual({ stage: "knowledge", status: "running" });
    expect(payload("files")).toEqual({ stage: "files", status: "running" });
  });
});

describe("live tool call status", () => {
  it("projects origin and readable names without raw call data", () => {
    const event = liveToolCallStatus({
      arguments: { query: "unexposed argument" },
      id: "unexposed call id",
      name: "mcp_repository_search_fixture",
      raw: { message: "unexposed diagnostic" }
    }, { origin: "mcp", round: 2, serverName: "Repository Tools", toolName: "search" });

    expect(event).toEqual({
      data: {
        artifactType: "tool_call",
        payload: { name: "search", origin: "mcp", round: 2, serverName: "Repository Tools", status: "requested" }
      },
      type: "artifact"
    });
    expect(JSON.stringify(event)).not.toMatch(/unexposed|mcp_repository/iu);
  });

  it("settles a call under its requested identity with a whole, non-negative duration", () => {
    const call = { arguments: { query: "unexposed argument" }, id: "unexposed call id", name: "search" };
    const activity = { origin: "mcp" as const, round: 2, serverName: "Repository Tools" };
    const payload = (event: ReturnType<typeof liveToolCallStatus>) =>
      event.type === "artifact" ? event.data.payload : null;
    expect(payload(liveToolCallStatus(call, activity, { ordinal: 3 }))).toEqual({
      name: "search", ordinal: 3, origin: "mcp", round: 2, serverName: "Repository Tools", status: "requested" });
    expect(payload(liveToolCallStatus(call, activity, { ordinal: 3, settled: { durationMs: 1234.6, status: "error" } }))).toEqual({
      durationMs: 1235, name: "search", ordinal: 3, origin: "mcp", round: 2, serverName: "Repository Tools", status: "error" });
    expect(payload(liveToolCallStatus(call, activity, { ordinal: -1, settled: { durationMs: -5, status: "complete" } })))
      .toEqual({ durationMs: 0, name: "search", origin: "mcp", round: 2, serverName: "Repository Tools", status: "complete" });
  });
});
