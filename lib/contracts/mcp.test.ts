import { describe, expect, it } from "vitest";
import { decodeMcpRunSelection, mcpValidationIssue } from "./mcp";

describe("MCP administrator failure projection", () => {
  it("keeps bounded status and stage while excluding URL credentials and arbitrary fields", () => {
    expect(mcpValidationIssue({ code: "mcp_initialize_failed", path: "source", operation: "initialize", httpStatus: 404,
      endpoint: "https://name:password@mcp.example.test/wrong?token=private#secret", body: "private", stack: "private"
    })).toEqual({ code: "mcp_initialize_failed", path: "source", operation: "initialize", httpStatus: 404, endpoint: "https://mcp.example.test/wrong" });
    expect(mcpValidationIssue({ code: "raw upstream response", path: "private/url", operation: "private", httpStatus: 12345, endpoint: "javascript:private" }))
      .toEqual({ code: "mcp_remote_validation_failed", path: "validator" });
  });
});

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
