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

  it("does not invent successful recall for an unrecognized completed result", () => {
    expect(memorySearchActivityEvent({ ordinal: 0, round: 1, state: "complete", result: {
      content: [{ type: "json", value: { version: "legacy", outcome: "results" } }]
    } })).toMatchObject({ data: { payload: { status: "error", outcome: "failure" } } });
  });
});
