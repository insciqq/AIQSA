import { describe, expect, it } from "vitest";
import { decodeMcpRunSelection, MCP_RUN_PLAN_LIMITS } from "./mcp";

describe("MCP run selection", () => {
  it("accepts only strict Off, Auto, and non-empty Selected shapes", () => {
    expect(decodeMcpRunSelection({ mode: "auto" })).toEqual({ mode: "auto" });
    expect(decodeMcpRunSelection({ mode: "off" })).toEqual({ mode: "off" });
    expect(decodeMcpRunSelection({ mode: "selected", serverIds: [" server-b ", "server-a"] }))
      .toEqual({ mode: "selected", serverIds: ["server-b", "server-a"] });

    expect(decodeMcpRunSelection({ extra: true, mode: "auto" })).toBeNull();
    expect(decodeMcpRunSelection({ mode: "selected", serverIds: [] })).toBeNull();
    expect(decodeMcpRunSelection({ mode: "selected", serverIds: ["server-a", " server-a "] }))
      .toBeNull();
    expect(decodeMcpRunSelection({
      mode: "selected",
      serverIds: Array.from(
        { length: MCP_RUN_PLAN_LIMITS.maxEnabledServers + 1 },
        (_, index) => `server-${index}`
      )
    })).toBeNull();
  });
});
