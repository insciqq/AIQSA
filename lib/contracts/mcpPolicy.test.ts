import { describe, expect, it } from "vitest";
import { decodeMcpPolicyResponse } from "./mcpPolicy";

describe("MCP policy wire contract", () => {
  it("accepts exactly a boolean switch and a positive version", () => {
    expect(decodeMcpPolicyResponse({ policy: { personalLocalNetworkEnabled: false, version: 7 } }))
      .toEqual({ personalLocalNetworkEnabled: false, version: 7 });
    for (const policy of [
      { personalLocalNetworkEnabled: "true", version: 7 },
      { personalLocalNetworkEnabled: true, version: 0 },
      { personalLocalNetworkEnabled: true, version: 1.5 },
      { personalLocalNetworkEnabled: true },
      null
    ]) {
      expect(decodeMcpPolicyResponse({ policy })).toBeNull();
    }
    expect(decodeMcpPolicyResponse({ personalLocalNetworkEnabled: true, version: 7 })).toBeNull();
  });

  it("projects only the documented fields", () => {
    expect(decodeMcpPolicyResponse({ policy: { personalLocalNetworkEnabled: true, private: "value", version: 2 } }))
      .toEqual({ personalLocalNetworkEnabled: true, version: 2 });
  });
});
