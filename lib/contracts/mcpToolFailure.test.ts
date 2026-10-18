import { describe, expect, it } from "vitest";
import { isMcpToolFailureMessage, mcpOversizedResponseMessage, mcpToolFailureMessage } from "./mcpToolFailure";

describe("MCP oversized response message", () => {
  it.each([
    [16 * 1_024 * 1_024, "16 MiB"],
    [1_024 * 1_024 + 1, "1 MiB"],
    [1_572_864, "1.5 MiB"],
    [1_024 * 1_023, "1023 KiB"],
    [512, "512 bytes"]
  ])("states the %i-byte bound rounded down, so the claim stays true", (maxBytes, size) => {
    expect(mcpOversizedResponseMessage(maxBytes)).toContain(`its response was larger than ${size} and was not read`);
  });

  it("opens with the closed reason that persisted Agent activity still decodes", () => {
    const message = mcpOversizedResponseMessage();
    expect(message.startsWith(mcpToolFailureMessage("mcp_call_result_too_large"))).toBe(true);
    expect(message).toContain("its response was too large and was not read");
    expect(message).toContain("Do not repeat a write solely because its response could not be read.");
    for (const invalid of [0, -1, 1.5, Number.NaN]) expect(mcpOversizedResponseMessage(invalid)).toBe(message);
    expect(isMcpToolFailureMessage(mcpToolFailureMessage("mcp_call_result_too_large"))).toBe(true);
  });
});
