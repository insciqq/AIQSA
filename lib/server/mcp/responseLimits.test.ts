import { describe, expect, it } from "vitest";
import { getMcpRequestMaxBytes, mcpRequestSizeFailure } from "./responseLimits";

describe("shared MCP request envelope", () => {
  it("defaults to 8 MiB and permits an explicit larger resource allowance", () => {
    expect(getMcpRequestMaxBytes({})).toBe(8 * 1024 * 1024);
    expect(getMcpRequestMaxBytes({ AIQSA_MCP_REQUEST_MAX_BYTES: "16777216" })).toBe(16 * 1024 * 1024);
    expect(mcpRequestSizeFailure(9000000, 8388608)).toMatchObject({ code: "mcp_request_too_large",
      observedBytes: "9000000", maxBytes: 8388608 });
  });
  it.each(["-1", "0", "NaN", "1.5", "999999999999999999"])("rejects invalid configuration %s", value => {
    expect(() => getMcpRequestMaxBytes({ AIQSA_MCP_REQUEST_MAX_BYTES: value })).toThrow("mcp_request_limit_config_invalid");
  });
});
