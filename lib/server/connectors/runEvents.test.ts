import { describe, expect, it } from "vitest";
import { connectorRunEvent } from "./runEvents";

describe("connector run events", () => {
  it("names a live tool call by its display facts only, and hosted Search and compaction by their kind", () => {
    expect(connectorRunEvent({ data: { artifactType: "tool_call", payload: {
      arguments: { query: "private" }, name: "search_issues", ordinal: 0, origin: "mcp", serverName: "Tracker", status: "requested"
    } }, type: "artifact" })).toEqual({ origin: "mcp", serverName: "Tracker", settled: false, toolName: "search_issues", type: "toolActivity" });
    expect(connectorRunEvent({ data: { artifactType: "tool_call", payload: { name: "fetch_url", origin: "web_fetch", status: "complete" } }, type: "artifact" }))
      .toEqual({ origin: "web_fetch", serverName: null, settled: true, toolName: "fetch_url", type: "toolActivity" });
    expect(connectorRunEvent({ data: { artifactType: "tool_call", payload: null }, type: "artifact" })).toBeNull();
    expect(connectorRunEvent({ data: { artifactType: "search_activity", payload: { engines: [] } }, type: "artifact" })).toEqual({ type: "searchActivity" });
    expect(connectorRunEvent({ data: { artifactType: "context_compaction", payload: { cycle: 1 } }, type: "artifact" })).toEqual({ type: "compaction" });
    expect(connectorRunEvent({ data: { artifactType: "citation", payload: {} }, type: "artifact" })).toBeNull();
  });
});
