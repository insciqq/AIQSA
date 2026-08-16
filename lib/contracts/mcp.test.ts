import { describe, expect, it } from "vitest";
import { decodeMcpRunSelection } from "./mcp";

describe("MCP run selection", () => {
  it("accepts only strict Auto, Load all, and Off shapes", () => {
    expect(decodeMcpRunSelection({ mode: "auto" })).toEqual({ mode: "auto" });
    expect(decodeMcpRunSelection({ mode: "load_all" })).toEqual({ mode: "load_all" });
    expect(decodeMcpRunSelection({ mode: "off" })).toEqual({ mode: "off" });

    expect(decodeMcpRunSelection({ extra: true, mode: "auto" })).toBeNull();
    expect(decodeMcpRunSelection({ mode: "load_all", serverIds: ["server-a"] })).toBeNull();
    expect(decodeMcpRunSelection({ mode: "selected", serverIds: ["server-a"] })).toBeNull();
  });
});
