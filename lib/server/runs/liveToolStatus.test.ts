import { describe, expect, it } from "vitest";
import { liveToolCallStatus } from "./liveToolStatus";

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
});
