import { describe, expect, it } from "vitest";
import { decodeMemorySearchActivity } from "../../contracts/memorySearchActivity";
import { memorySearchActivityEvent, memorySearchActivityFacts, toolActivityDescriptors } from "./activityDescriptors";

describe("native Memory search activity", () => {
  it("publishes only known outcome and call position, never query, evidence or raw failure", () => {
    const result = { name: "memory_search", callId: "private-call", status: "error", content: [{
      type: "json", value: { version: "memory-search-v1", outcome: "cancelled",
        reason: "private-error", query: "private-query", evidence: "private-evidence" }
    }] };
    const event = memorySearchActivityEvent({ ordinal: 2, round: 1, state: "error", result, durationMs: 42 });
    expect(event).toEqual({ type: "artifact", data: { artifactType: "memory_search_activity", payload: {
      call: 3, round: 1, status: "cancelled", outcome: "cancelled", durationMs: 42
    } } });
    if (event.type !== "artifact") throw new Error("expected artifact");
    expect(decodeMemorySearchActivity(event.data.payload)).toEqual(event.data.payload);
    expect(JSON.stringify(event)).not.toContain("private");
    expect(memorySearchActivityFacts("external_memory_search", result, 2)).toEqual({});
    expect(toolActivityDescriptors({}).get("memory_search")).toEqual({
      origin: "memory", serverName: "Memory", toolName: "memory_search"
    });
  });

  it("projects chat System Vision as image analysis and leaves Workspace analysis unchanged", () => {
    const visionAnalysis = { version: 1, available: true };
    expect(toolActivityDescriptors({ visionAnalysis }).get("analyze_image")).toEqual({
      origin: "vision", serverName: "System Vision", toolName: "analyze_image" });
    expect(toolActivityDescriptors({ visionAnalysis, workspace: { enabled: true } }).get("analyze_image")).toBeUndefined();
    expect(toolActivityDescriptors({}).get("analyze_image")).toBeUndefined();
  });

  it("shows a direct view after a reload as the Workspace step the live answer showed", () => {
    expect(toolActivityDescriptors({ workspace: { enabled: true }, workspaceImageView: true }).get("view_workspace_image")).toEqual({
      origin: "workspace", serverName: "Workspace", toolName: "view_workspace_image" });
    expect(toolActivityDescriptors({ workspace: { enabled: true } }).get("view_workspace_image")).toBeUndefined();
  });

  it("names research's tools as their live steps do, on every run, so a reloaded step is the live one", () => {
    const descriptors = toolActivityDescriptors({});
    expect(["start_research", "propose_research_plan", "record_evidence", "change_research_frame", "submit_research_draft"].map((name) =>
      descriptors.get(name))).toEqual(["Started", "Plan", "Recording evidence", "Extending the matrix", "Checking the report"].map((toolName) =>
      ({ origin: "tool", serverName: "Research", toolName })));
  });

  it("does not invent successful recall for an unrecognized completed result", () => {
    expect(memorySearchActivityEvent({ ordinal: 0, round: 1, state: "complete", result: {
      content: [{ type: "json", value: { version: "legacy", outcome: "results" } }]
    } })).toMatchObject({ data: { payload: { status: "error", outcome: "failure" } } });
  });
});
