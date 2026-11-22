import { describe, expect, it } from "vitest";
import { observedFailureCode } from "../providers/providerObservability";
import { isMcpDispatchError, mcpDispatchError } from "./dispatchStatus";

describe("MCP dispatch causes", () => {
  it.each(["mcp_tool_disabled", "mcp_tool_definition_changed"] as const)(
    "registers %s as an observable code with its own message", (code) => {
      const error = mcpDispatchError(code);
      expect(observedFailureCode(error)).toBe(code);
      expect(error.message).not.toBe(mcpDispatchError("mcp_accepted_generation_changed").message);
      expect(isMcpDispatchError(error, code)).toBe(true);
      expect(isMcpDispatchError(error, "mcp_runtime_unavailable")).toBe(false);
      expect(isMcpDispatchError(Object.assign(new Error("PRIVATE"), { message: code }), code)).toBe(false);
    }
  );
});
